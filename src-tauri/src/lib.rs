use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportMediaRequest {
    input_path: String,
    output_path: String,
    mode: String,
    ratio: String,
    anchor: String,
    scale: f64,
    image_format: Option<String>,
    image_quality: Option<u8>,
    video_start_seconds: Option<f64>,
    video_duration_seconds: Option<f64>,
    crop_rect: Option<CropRectRequest>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CropRectRequest {
    x: u64,
    y: u64,
    width: u64,
    height: u64,
}

#[derive(Serialize)]
struct ProbeResult {
    media_kind: String,
    format_name: Option<String>,
    codec_name: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    duration_seconds: Option<f64>,
    bit_rate: Option<u64>,
    raw: Value,
}

#[derive(Serialize)]
struct ExportResult {
    output_path: String,
    applied_filter: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDataUrlResult {
    data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewVideoAssetResult {
    file_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgressEvent {
    phase: String,
    percent: f64,
    current_seconds: Option<f64>,
    total_seconds: Option<f64>,
    message: Option<String>,
}

struct CropRect {
    width: u64,
    height: u64,
    x: u64,
    y: u64,
}

fn parse_number_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.to_string()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn parse_optional_u64(value: Option<&Value>) -> Option<u64> {
    parse_number_string(value).and_then(|text| text.parse::<u64>().ok())
}

fn parse_optional_f64(value: Option<&Value>) -> Option<f64> {
    parse_number_string(value).and_then(|text| text.parse::<f64>().ok())
}

fn parse_ratio_value(ratio: &str) -> Option<f64> {
    if ratio == "free" {
        return None;
    }

    let mut parts = ratio.split(':');
    let width = parts.next()?.parse::<f64>().ok()?;
    let height = parts.next()?.parse::<f64>().ok()?;
    if width > 0.0 && height > 0.0 {
        Some(width / height)
    } else {
        None
    }
}

fn clamp_scale(scale: f64) -> f64 {
    if scale.is_finite() {
        scale.clamp(0.1, 1.0)
    } else {
        1.0
    }
}

fn round_crop_value(value: f64, keep_even: bool) -> u64 {
    let mut rounded = value.floor().max(1.0) as u64;
    if keep_even && rounded > 2 && rounded % 2 == 1 {
        rounded -= 1;
    }
    rounded.max(if keep_even { 2 } else { 1 })
}

fn anchor_offset(total: u64, crop: u64, anchor: &str, axis: char) -> u64 {
    let remaining = total.saturating_sub(crop);
    match (axis, anchor) {
        ('x', "lt") | ('x', "left") | ('x', "lb") => 0,
        ('x', "rt") | ('x', "right") | ('x', "rb") => remaining,
        ('y', "lt") | ('y', "top") | ('y', "rt") => 0,
        ('y', "lb") | ('y', "bottom") | ('y', "rb") => remaining,
        _ => remaining / 2,
    }
}

fn compute_crop_rect(
    source_width: u64,
    source_height: u64,
    ratio: &str,
    anchor: &str,
    scale: f64,
    keep_even: bool,
) -> Result<CropRect, String> {
    if source_width == 0 || source_height == 0 {
        return Err("源媒体尺寸无效".to_string());
    }

    let source_width_f = source_width as f64;
    let source_height_f = source_height as f64;
    let target_ratio = parse_ratio_value(ratio);
    let scale = clamp_scale(scale);

    let (fit_width, fit_height) = match target_ratio {
        Some(ratio_value) => {
            let source_ratio = source_width_f / source_height_f;
            if source_ratio > ratio_value {
                (source_height_f * ratio_value, source_height_f)
            } else {
                (source_width_f, source_width_f / ratio_value)
            }
        }
        None => (source_width_f, source_height_f),
    };

    let crop_width = round_crop_value(fit_width * scale, keep_even).min(source_width);
    let crop_height = round_crop_value(fit_height * scale, keep_even).min(source_height);
    let x = anchor_offset(source_width, crop_width, anchor, 'x');
    let y = anchor_offset(source_height, crop_height, anchor, 'y');

    Ok(CropRect {
        width: crop_width,
        height: crop_height,
        x,
        y,
    })
}

fn make_crop_filter(rect: &CropRect) -> String {
    format!("crop={}:{}:{}:{}", rect.width, rect.height, rect.x, rect.y)
}

fn normalize_crop_rect(
    rect: &CropRectRequest,
    source_width: u64,
    source_height: u64,
    keep_even: bool,
) -> Result<CropRect, String> {
    if source_width == 0 || source_height == 0 {
        return Err("源媒体尺寸无效".to_string());
    }

    let even_min = if keep_even { 2 } else { 1 };
    let x = rect.x.min(source_width.saturating_sub(even_min));
    let y = rect.y.min(source_height.saturating_sub(even_min));
    let max_width = source_width.saturating_sub(x).max(even_min);
    let max_height = source_height.saturating_sub(y).max(even_min);
    let mut width = rect.width.clamp(even_min, max_width);
    let mut height = rect.height.clamp(even_min, max_height);

    if keep_even {
        width = round_crop_value(width as f64, true).min(max_width);
        height = round_crop_value(height as f64, true).min(max_height);
    }

    let mut normalized_x = x;
    let mut normalized_y = y;

    if keep_even {
        if normalized_x % 2 == 1 && normalized_x > 0 {
            normalized_x -= 1;
        }
        if normalized_y % 2 == 1 && normalized_y > 0 {
            normalized_y -= 1;
        }
    }

    Ok(CropRect {
        width,
        height,
        x: normalized_x,
        y: normalized_y,
    })
}

fn emit_export_progress(
    window: Option<&tauri::Window>,
    phase: &str,
    percent: f64,
    current_seconds: Option<f64>,
    total_seconds: Option<f64>,
    message: Option<String>,
) {
    if let Some(window) = window {
        let _ = window.emit(
            "export-progress",
            ExportProgressEvent {
                phase: phase.to_string(),
                percent: percent.clamp(0.0, 100.0),
                current_seconds,
                total_seconds,
                message,
            },
        );
    }
}

fn sidecar_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn find_ffmpeg() -> PathBuf {
    let dir = sidecar_dir();
    // bundled .app: plain name
    let bundled = dir.join("ffmpeg");
    if bundled.exists() {
        return bundled;
    }
    // dev sidecar with target triple
    let sidecar = dir.join(format!("ffmpeg-{}-apple-darwin", std::env::consts::ARCH));
    if sidecar.exists() {
        return sidecar;
    }
    PathBuf::from("ffmpeg") // fallback to PATH
}

fn find_ffprobe() -> PathBuf {
    let dir = sidecar_dir();
    let bundled = dir.join("ffprobe");
    if bundled.exists() {
        return bundled;
    }
    let sidecar = dir.join(format!("ffprobe-{}-apple-darwin", std::env::consts::ARCH));
    if sidecar.exists() {
        return sidecar;
    }
    PathBuf::from("ffprobe") // fallback to PATH
}

fn detect_media_kind(raw: &Value, duration_seconds: Option<f64>) -> String {
    let format_name = raw["format"]
        .get("format_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();

    if format_name.contains("image") || format_name.contains("png_pipe") || format_name.contains("jpeg_pipe") {
        return "image".to_string();
    }

    if duration_seconds.unwrap_or_default() > 0.0 {
        return "video".to_string();
    }

    "image".to_string()
}

fn unique_temp_path(prefix: &str, extension: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    env::temp_dir().join(format!("media-cropper-{prefix}-{timestamp}.{extension}"))
}

#[tauri::command]
fn probe_media(input_path: String) -> Result<ProbeResult, String> {
    let output = Command::new(find_ffprobe())
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &input_path,
        ])
        .output()
        .map_err(|error| format!("ffprobe 启动失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let raw: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("ffprobe 输出解析失败: {error}"))?;

    let video_stream = raw["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|stream| stream["codec_type"] == "video"));

    let duration_seconds = parse_optional_f64(raw["format"].get("duration"));

    Ok(ProbeResult {
        media_kind: detect_media_kind(&raw, duration_seconds),
        format_name: raw["format"]
            .get("format_name")
            .and_then(Value::as_str)
            .map(str::to_string),
        codec_name: video_stream
            .and_then(|stream| stream["codec_name"].as_str())
            .map(str::to_string),
        width: video_stream.and_then(|stream| stream["width"].as_u64()),
        height: video_stream.and_then(|stream| stream["height"].as_u64()),
        duration_seconds,
        bit_rate: parse_optional_u64(raw["format"].get("bit_rate")),
        raw,
    })
}

#[tauri::command]
fn build_preview_data_url(
    input_path: String,
    preview_time_seconds: Option<f64>,
) -> Result<PreviewDataUrlResult, String> {
    let preview_path = unique_temp_path("preview", "jpg");
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];

    if let Some(seconds) = preview_time_seconds {
        if seconds.is_finite() && seconds > 0.0 {
            args.extend(["-ss".to_string(), format!("{seconds:.3}")]);
        }
    }

    args.extend([
        "-i".to_string(),
        input_path.clone(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-q:v".to_string(),
        "2".to_string(),
        preview_path.to_string_lossy().to_string(),
    ]);

    let output = Command::new(find_ffmpeg())
        .args(&args)
        .output()
        .map_err(|error| format!("ffmpeg 预览图生成失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let bytes = fs::read(&preview_path).map_err(|error| format!("读取预览图失败: {error}"))?;
    let _ = fs::remove_file(&preview_path);

    Ok(PreviewDataUrlResult {
        data_url: format!("data:image/jpeg;base64,{}", general_purpose::STANDARD.encode(bytes)),
    })
}

#[tauri::command]
fn build_preview_video_asset(input_path: String) -> Result<PreviewVideoAssetResult, String> {
    let preview_path = unique_temp_path("preview-video", "mp4");
    let scale_filter = "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))',setsar=1";

    let output = Command::new(find_ffmpeg())
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &input_path,
            "-vf",
            scale_filter,
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            preview_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("ffmpeg 预览视频生成失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(PreviewVideoAssetResult {
        file_path: preview_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn export_media(window: tauri::Window, request: ExportMediaRequest) -> Result<ExportResult, String> {
    export_media_inner(request, Some(&window))
}

fn export_media_inner(
    request: ExportMediaRequest,
    progress_window: Option<&tauri::Window>,
) -> Result<ExportResult, String> {
    let probe = probe_media(request.input_path.clone())?;
    let source_width = probe.width.ok_or_else(|| "无法读取源媒体宽度".to_string())?;
    let source_height = probe.height.ok_or_else(|| "无法读取源媒体高度".to_string())?;
    let keep_even = request.mode == "video";
    let crop_rect = match &request.crop_rect {
        Some(rect) => normalize_crop_rect(rect, source_width, source_height, keep_even)?,
        None => compute_crop_rect(
            source_width,
            source_height,
            &request.ratio,
            &request.anchor,
            request.scale,
            keep_even,
        )?,
    };
    let filter = make_crop_filter(&crop_rect);
    let output_parent = Path::new(&request.output_path)
        .parent()
        .ok_or_else(|| "输出路径无效".to_string())?;

    fs::create_dir_all(output_parent)
        .map_err(|error| format!("创建输出目录失败: {error}"))?;

    let mut args = vec!["-y".to_string(), "-hide_banner".to_string()];

    if request.mode == "video" {
        args.extend([
            "-ss".to_string(),
            format!("{:.3}", request.video_start_seconds.unwrap_or(0.0).max(0.0)),
            "-t".to_string(),
            format!("{:.3}", request.video_duration_seconds.unwrap_or(5.0).max(0.5)),
        ]);
    }

    args.extend([
        "-i".to_string(),
        request.input_path.clone(),
        "-vf".to_string(),
        filter.clone(),
    ]);

    if request.mode == "image" {
        args.extend(["-frames:v".to_string(), "1".to_string()]);

        match request.image_format.as_deref().unwrap_or("jpg") {
            "png" => {}
            "webp" => {
                return Err(
                    "当前 ffmpeg 构建未启用 WEBP 图片编码，请先使用 JPG/PNG，后续在打包自定义 FFmpeg 时再补上 WEBP。"
                        .to_string(),
                );
            }
            _ => {
                let quality = request.image_quality.unwrap_or(82).clamp(1, 100);
                let qscale = (((100_u8.saturating_sub(quality)) as f64 / 100.0) * 29.0).round() as u8 + 2;
                args.extend(["-q:v".to_string(), qscale.clamp(2, 31).to_string()]);
            }
        }
    } else {
        args.extend([
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "0:a:0?".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "22".to_string(),
            "-maxrate".to_string(),
            "4000k".to_string(),
            "-bufsize".to_string(),
            "8000k".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
        ]);
    }

    args.push(request.output_path.clone());

    if request.mode == "video" {
        let total_seconds = request
            .video_duration_seconds
            .unwrap_or_else(|| probe.duration_seconds.unwrap_or(5.0))
            .max(0.5);

        args.extend(["-progress".to_string(), "pipe:2".to_string(), "-nostats".to_string()]);

        emit_export_progress(
            progress_window,
            "start",
            0.0,
            Some(0.0),
            Some(total_seconds),
            Some("开始导出视频".to_string()),
        );

        let mut child = Command::new(find_ffmpeg())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("ffmpeg 启动失败: {error}"))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取 ffmpeg 进度输出".to_string())?;
        let reader = BufReader::new(stderr);
        let mut stderr_lines = Vec::new();
        let mut latest_seconds = 0.0;
        let mut latest_percent = 0.0;

        for line in reader.lines() {
            let line = line.map_err(|error| format!("读取 ffmpeg 输出失败: {error}"))?;
            if line.is_empty() {
                continue;
            }

            if let Some(value) = line.strip_prefix("out_time_ms=") {
                if let Ok(raw_micros) = value.parse::<f64>() {
                    latest_seconds = raw_micros / 1_000_000.0;
                    latest_percent = ((latest_seconds / total_seconds) * 100.0).clamp(0.0, 99.5);
                    emit_export_progress(
                        progress_window,
                        "running",
                        latest_percent,
                        Some(latest_seconds.min(total_seconds)),
                        Some(total_seconds),
                        None,
                    );
                }
            } else if line == "progress=end" {
                emit_export_progress(
                    progress_window,
                    "running",
                    100.0,
                    Some(total_seconds),
                    Some(total_seconds),
                    None,
                );
            }

            stderr_lines.push(line);
        }

        let status = child
            .wait()
            .map_err(|error| format!("等待 ffmpeg 结束失败: {error}"))?;
        let stderr_output = stderr_lines.join("\n");

        if !status.success() {
            emit_export_progress(
                progress_window,
                "error",
                latest_percent,
                Some(latest_seconds),
                Some(total_seconds),
                Some("视频导出失败".to_string()),
            );
            return Err(stderr_output.trim().to_string());
        }

        emit_export_progress(
            progress_window,
            "completed",
            100.0,
            Some(total_seconds),
            Some(total_seconds),
            Some("视频导出完成".to_string()),
        );

        return Ok(ExportResult {
            output_path: request.output_path,
            applied_filter: filter,
            stderr: stderr_output,
        });
    }

    emit_export_progress(
        progress_window,
        "start",
        0.0,
        None,
        None,
        Some("开始导出图片".to_string()),
    );

    let output = Command::new(find_ffmpeg())
        .args(&args)
        .output()
        .map_err(|error| format!("ffmpeg 启动失败: {error}"))?;

    if !output.status.success() {
        emit_export_progress(
            progress_window,
            "error",
            0.0,
            None,
            None,
            Some("图片导出失败".to_string()),
        );
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    emit_export_progress(
        progress_window,
        "completed",
        100.0,
        None,
        None,
        Some("图片导出完成".to_string()),
    );

    Ok(ExportResult {
        output_path: request.output_path,
        applied_filter: filter,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            probe_media,
            build_preview_data_url,
            build_preview_video_asset,
            export_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{build_preview_data_url, build_preview_video_asset, export_media_inner, find_ffmpeg, find_ffprobe, probe_media, ExportMediaRequest};
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_path(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_millis();

        env::temp_dir().join(format!("media-cropper-{timestamp}-{name}"))
    }

    fn create_sample_video(output_path: &PathBuf) {
        let status = Command::new(find_ffmpeg())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                output_path.to_str().expect("utf-8 path"),
            ])
            .status()
            .expect("ffmpeg should be callable during tests");

        assert!(status.success(), "sample video generation should succeed");
    }

    fn create_sample_image(output_path: &PathBuf) {
        let status = Command::new(find_ffmpeg())
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x480:rate=1",
                "-update",
                "1",
                "-frames:v",
                "1",
                output_path.to_str().expect("utf-8 path"),
            ])
            .status()
            .expect("ffmpeg should be callable during tests");

        assert!(status.success(), "sample image generation should succeed");
    }

    #[test]
    fn probe_media_returns_basic_video_metadata() {
        let input_path = unique_path("probe-input.mp4");
        create_sample_video(&input_path);

        let result = probe_media(input_path.to_string_lossy().to_string())
            .expect("probe should succeed for generated sample");

        assert_eq!(result.media_kind, "video");
        assert_eq!(result.codec_name.as_deref(), Some("h264"));
        assert_eq!(result.width, Some(320));
        assert_eq!(result.height, Some(240));
        assert!(result.duration_seconds.unwrap_or_default() > 0.0);

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn build_preview_data_url_returns_image_data() {
        let input_path = unique_path("preview-input.mp4");
        create_sample_video(&input_path);

        let result = build_preview_data_url(input_path.to_string_lossy().to_string(), None)
            .expect("preview generation should succeed for generated sample");

        assert!(
            result.data_url.starts_with("data:image/jpeg;base64,"),
            "preview command should return a jpeg data url"
        );
    }

    #[test]
    fn build_preview_video_asset_returns_video_path() {
        let input_path = unique_path("preview-video-input.mp4");
        create_sample_video(&input_path);

        let result = build_preview_video_asset(input_path.to_string_lossy().to_string())
            .expect("preview video generation should succeed for generated sample");

        let preview_path = PathBuf::from(&result.file_path);
        assert!(preview_path.exists(), "preview proxy video should exist");

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(preview_path);
    }

    #[test]
    fn probe_media_returns_basic_image_metadata() {
        let input_path = unique_path("probe-input.png");
        create_sample_image(&input_path);

        let result = probe_media(input_path.to_string_lossy().to_string())
            .expect("probe should succeed for generated image");

        assert_eq!(result.media_kind, "image");
        assert_eq!(result.width, Some(640));
        assert_eq!(result.height, Some(480));

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn export_video_crop_generates_output_file() {
        let input_path = unique_path("export-input.mp4");
        let output_path = unique_path("export-output.mp4");
        create_sample_video(&input_path);

        let result = export_media_inner(ExportMediaRequest {
            input_path: input_path.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
            mode: "video".to_string(),
            ratio: "1:1".to_string(),
            anchor: "center".to_string(),
            scale: 1.0,
            image_format: None,
            image_quality: None,
            video_start_seconds: Some(0.0),
            video_duration_seconds: Some(1.0),
            crop_rect: None,
        }, None)
        .expect("export should succeed for generated sample");

        assert_eq!(result.output_path, output_path.to_string_lossy());
        assert_eq!(result.applied_filter, "crop=240:240:40:0");
        assert!(output_path.exists(), "output file should exist");

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn export_image_crop_generates_output_file() {
        let input_path = unique_path("export-image-input.png");
        let output_path = unique_path("export-image-output.jpg");
        create_sample_image(&input_path);

        let result = export_media_inner(ExportMediaRequest {
            input_path: input_path.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
            mode: "image".to_string(),
            ratio: "1:1".to_string(),
            anchor: "top".to_string(),
            scale: 0.5,
            image_format: Some("jpg".to_string()),
            image_quality: Some(88),
            video_start_seconds: None,
            video_duration_seconds: None,
            crop_rect: None,
        }, None)
        .expect("image export should succeed for generated sample");

        assert_eq!(result.applied_filter, "crop=240:240:200:0");
        assert!(output_path.exists(), "output image should exist");

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }
}
