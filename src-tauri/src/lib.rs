use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

static TEMP_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);
const PREVIEW_PROXY_BIT_RATE: u64 = 1_200_000;
const MAX_PREVIEW_PROXY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PREVIEW_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportMediaRequest {
    task_id: Option<String>,
    input_path: String,
    output_path: String,
    #[serde(default)]
    avoid_overwrite: bool,
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

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
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
    rotation_degrees: i32,
    display_width: Option<u64>,
    display_height: Option<u64>,
    duration_seconds: Option<f64>,
    frame_rate: Option<f64>,
    frame_rate_numerator: Option<u64>,
    frame_rate_denominator: Option<u64>,
    frame_count: Option<u64>,
    variable_frame_rate: bool,
    bit_rate: Option<u64>,
    raw: Value,
}

#[derive(Serialize)]
struct VideoFrameIndexResult {
    frame_count: usize,
    boundaries_seconds: Vec<f64>,
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
    temporary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectBlackBordersRequest {
    task_id: Option<String>,
    input_path: String,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    sample_windows: Option<usize>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BorderMargins {
    left: u64,
    top: u64,
    right: u64,
    bottom: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectBlackBordersResult {
    status: String,
    rect: Option<CropRectRequest>,
    margins: BorderMargins,
    confidence: f64,
    sample_count: usize,
    agreeing_samples: usize,
    warning: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CropRect {
    width: u64,
    height: u64,
    x: u64,
    y: u64,
}

struct OutputTarget {
    path: PathBuf,
    working_path: PathBuf,
    reserved_path: bool,
    committed: bool,
}

#[derive(Debug)]
struct TemporaryPath {
    path: PathBuf,
    remove_on_drop: bool,
}

impl TemporaryPath {
    fn new(prefix: &str, extension: &str) -> Self {
        Self {
            path: unique_temp_path(prefix, extension),
            remove_on_drop: true,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn persist(mut self) -> PathBuf {
        self.remove_on_drop = false;
        self.path.clone()
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl OutputTarget {
    fn working_path(&self) -> &Path {
        &self.working_path
    }

    fn commit(&mut self) -> Result<(), String> {
        fs::rename(&self.working_path, &self.path)
            .map_err(|error| format!("提交导出文件失败: {error}"))?;
        self.reserved_path = false;
        self.committed = true;
        Ok(())
    }
}

impl Drop for OutputTarget {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.working_path);
            if self.reserved_path {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

#[derive(Default)]
struct MediaTaskManager {
    processes: Mutex<HashMap<String, u32>>,
}

impl MediaTaskManager {
    fn register(&self, task_id: &str, pid: u32) {
        let previous = self
            .processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(task_id.to_string(), pid);
        if let Some(previous_pid) = previous {
            terminate_process(previous_pid);
        }
    }

    fn finish(&self, task_id: &str, pid: u32) {
        let mut processes = self
            .processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if processes.get(task_id) == Some(&pid) {
            processes.remove(task_id);
        }
    }

    fn cancel(&self, task_id: &str) {
        let pid = self
            .processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(task_id);
        if let Some(pid) = pid {
            terminate_process(pid);
        }
    }

    fn cancel_all(&self) {
        let pids = self
            .processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, pid)| pid)
            .collect::<Vec<_>>();
        for pid in pids {
            terminate_process(pid);
        }
    }
}

struct RegisteredProcess<'a> {
    manager: Option<&'a MediaTaskManager>,
    task_id: Option<&'a str>,
    pid: u32,
}

impl Drop for RegisteredProcess<'_> {
    fn drop(&mut self) {
        if let (Some(manager), Some(task_id)) = (self.manager, self.task_id) {
            manager.finish(task_id, self.pid);
        }
    }
}

fn terminate_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

fn run_command_output(
    command: &mut Command,
    manager: Option<&MediaTaskManager>,
    task_id: Option<&str>,
) -> std::io::Result<std::process::Output> {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id();
    if let (Some(manager), Some(task_id)) = (manager, task_id) {
        manager.register(task_id, pid);
    }
    let registration = RegisteredProcess {
        manager,
        task_id,
        pid,
    };
    let result = child.wait_with_output();
    drop(registration);
    result
}

fn suffixed_output_path(path: &Path, suffix: u64) -> Result<PathBuf, String> {
    let stem = path
        .file_stem()
        .ok_or_else(|| "输出文件名无效".to_string())?;
    let mut file_name = stem.to_os_string();
    file_name.push(format!("_{suffix}"));

    if let Some(extension) = path.extension() {
        file_name.push(".");
        file_name.push(extension);
    }

    Ok(path.with_file_name(file_name))
}

fn create_export_working_path(output_parent: &Path, final_path: &Path) -> Result<PathBuf, String> {
    loop {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let counter = TEMP_PATH_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut file_name = format!(
            ".media-cropper-export-{}-{timestamp}-{counter}",
            std::process::id()
        );
        if let Some(extension) = final_path.extension().and_then(|value| value.to_str()) {
            file_name.push('.');
            file_name.push_str(extension);
        }
        let working_path = output_parent.join(file_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&working_path)
        {
            Ok(_) => return Ok(working_path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建导出临时文件失败: {error}")),
        }
    }
}

fn prepare_output_target(path: &Path, avoid_overwrite: bool) -> Result<OutputTarget, String> {
    let output_parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    fs::create_dir_all(output_parent).map_err(|error| format!("创建输出目录失败: {error}"))?;

    let mut candidate = path.to_path_buf();
    let mut reserved_path = false;
    if avoid_overwrite {
        let mut suffix = 2_u64;
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(_) => {
                    reserved_path = true;
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    candidate = suffixed_output_path(path, suffix)?;
                    suffix = suffix
                        .checked_add(1)
                        .ok_or_else(|| "无法为导出文件生成唯一名称".to_string())?;
                }
                Err(error) => return Err(format!("预留输出文件失败: {error}")),
            }
        }
    }

    let working_path = match create_export_working_path(output_parent, &candidate) {
        Ok(path) => path,
        Err(error) => {
            if reserved_path {
                let _ = fs::remove_file(&candidate);
            }
            return Err(error);
        }
    };
    Ok(OutputTarget {
        path: candidate,
        working_path,
        reserved_path,
        committed: false,
    })
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

fn parse_frame_rate(value: Option<&Value>) -> Option<f64> {
    let text = parse_number_string(value)?;
    let rate = if let Some((numerator, denominator)) = text.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        text.parse::<f64>().ok()?
    };

    (rate.is_finite() && rate > 0.0 && rate <= 1000.0).then_some(rate)
}

fn parse_frame_rate_ratio(value: Option<&Value>) -> Option<(u64, u64)> {
    let text = parse_number_string(value)?;
    let (numerator, denominator) = text.split_once('/')?;
    let numerator = numerator.parse::<u64>().ok()?;
    let denominator = denominator.parse::<u64>().ok()?;
    (numerator > 0 && denominator > 0 && numerator <= 1_000_000).then_some((numerator, denominator))
}

fn normalize_rotation_degrees(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }

    (value.round() as i32).rem_euclid(360)
}

fn parse_rotation_degrees(video_stream: Option<&Value>) -> i32 {
    let Some(stream) = video_stream else {
        return 0;
    };

    let side_data_rotation = stream["side_data_list"].as_array().and_then(|side_data| {
        side_data
            .iter()
            .find_map(|entry| parse_optional_f64(entry.get("rotation")))
    });

    let tag_rotation = stream["tags"].as_object().and_then(|tags| {
        tags.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("rotate"))
            .and_then(|(_, value)| parse_optional_f64(Some(value)))
    });

    side_data_rotation
        .or(tag_rotation)
        .map(normalize_rotation_degrees)
        .unwrap_or(0)
}

fn display_dimensions(
    width: Option<u64>,
    height: Option<u64>,
    rotation_degrees: i32,
) -> (Option<u64>, Option<u64>) {
    if matches!(rotation_degrees, 90 | 270) {
        (height, width)
    } else {
        (width, height)
    }
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
    exe.parent().unwrap_or_else(|| Path::new(".")).to_path_buf()
}

fn find_ffmpeg() -> PathBuf {
    #[cfg(test)]
    {
        let test_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("ffmpeg-{}-apple-darwin", std::env::consts::ARCH));
        if test_sidecar.exists() {
            return test_sidecar;
        }
    }

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
    #[cfg(test)]
    {
        let test_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("ffprobe-{}-apple-darwin", std::env::consts::ARCH));
        if test_sidecar.exists() {
            return test_sidecar;
        }
    }

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

    if format_name.contains("image")
        || format_name.contains("png_pipe")
        || format_name.contains("jpeg_pipe")
    {
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
        .as_nanos();
    let counter = TEMP_PATH_COUNTER.fetch_add(1, Ordering::Relaxed);
    env::temp_dir().join(format!(
        "media-cropper-{prefix}-{}-{timestamp}-{counter}.{extension}",
        std::process::id()
    ))
}

fn is_managed_preview_asset(path: &Path) -> bool {
    let temp_dir = env::temp_dir();
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    path.parent() == Some(temp_dir.as_path())
        && file_name.starts_with("media-cropper-preview-video-")
        && path.extension().and_then(|extension| extension.to_str()) == Some("mp4")
}

fn cleanup_stale_preview_assets(max_age: Duration) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(env::temp_dir()) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_managed_preview_asset(&path) {
            continue;
        }
        let is_stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if is_stale {
            let _ = fs::remove_file(path);
        }
    }
}

fn cleanup_current_process_preview_assets() {
    let prefix = format!("media-cropper-preview-video-{}-", std::process::id());
    let Ok(entries) = fs::read_dir(env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let belongs_to_current_process = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&prefix));
        if belongs_to_current_process && is_managed_preview_asset(&path) {
            let _ = fs::remove_file(path);
        }
    }
}

fn probe_result_from_raw(raw: Value) -> ProbeResult {
    let video_stream = raw["streams"].as_array().and_then(|streams| {
        streams
            .iter()
            .find(|stream| stream["codec_type"] == "video")
    });
    let duration_seconds = parse_optional_f64(raw["format"].get("duration"));
    let width = video_stream.and_then(|stream| stream["width"].as_u64());
    let height = video_stream.and_then(|stream| stream["height"].as_u64());
    let rotation_degrees = parse_rotation_degrees(video_stream);
    let (display_width, display_height) = display_dimensions(width, height, rotation_degrees);
    let media_kind = detect_media_kind(&raw, duration_seconds);
    let format_name = raw["format"]
        .get("format_name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let codec_name = video_stream
        .and_then(|stream| stream["codec_name"].as_str())
        .map(str::to_string);
    let average_frame_rate =
        video_stream.and_then(|stream| parse_frame_rate(stream.get("avg_frame_rate")));
    let real_frame_rate =
        video_stream.and_then(|stream| parse_frame_rate(stream.get("r_frame_rate")));
    let frame_rate = average_frame_rate.or(real_frame_rate);
    let frame_rate_ratio = video_stream
        .and_then(|stream| parse_frame_rate_ratio(stream.get("avg_frame_rate")))
        .or_else(|| {
            video_stream.and_then(|stream| parse_frame_rate_ratio(stream.get("r_frame_rate")))
        });
    let variable_frame_rate = match (average_frame_rate, real_frame_rate) {
        (Some(average), Some(real)) => (average - real).abs() > 0.001,
        _ => false,
    };
    let frame_count = video_stream
        .and_then(|stream| parse_optional_u64(stream.get("nb_frames")))
        .or_else(|| {
            let estimated = duration_seconds? * frame_rate?;
            (estimated.is_finite() && estimated > 0.0).then_some(estimated.round() as u64)
        });
    let bit_rate = parse_optional_u64(raw["format"].get("bit_rate"));

    ProbeResult {
        media_kind,
        format_name,
        codec_name,
        width,
        height,
        rotation_degrees,
        display_width,
        display_height,
        duration_seconds,
        frame_rate,
        frame_rate_numerator: frame_rate_ratio.map(|ratio| ratio.0),
        frame_rate_denominator: frame_rate_ratio.map(|ratio| ratio.1),
        frame_count,
        variable_frame_rate,
        bit_rate,
        raw,
    }
}

fn probe_media_inner(
    input_path: String,
    manager: Option<&MediaTaskManager>,
    task_id: Option<&str>,
) -> Result<ProbeResult, String> {
    let input = Path::new(&input_path);
    if !input.is_file() {
        return Err("输入媒体不存在或不是普通文件".to_string());
    }

    let output = run_command_output(
        Command::new(find_ffprobe()).args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &input_path,
        ]),
        manager,
        task_id,
    )
    .map_err(|error| format!("ffprobe 启动失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let raw: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("ffprobe 输出解析失败: {error}"))?;

    Ok(probe_result_from_raw(raw))
}

#[tauri::command(async)]
fn probe_media(
    manager: tauri::State<'_, MediaTaskManager>,
    input_path: String,
    task_id: Option<String>,
) -> Result<ProbeResult, String> {
    probe_media_inner(input_path, Some(&manager), task_id.as_deref())
}

fn normalize_frame_boundaries(raw: &Value, duration_seconds: Option<f64>) -> Vec<f64> {
    let frames = raw["frames"].as_array().cloned().unwrap_or_default();
    let last_frame_duration = frames
        .last()
        .and_then(|frame| parse_optional_f64(frame.get("pkt_duration_time")))
        .filter(|value| value.is_finite() && *value > 0.0);
    let mut starts = frames
        .iter()
        .filter_map(|frame| parse_optional_f64(frame.get("best_effort_timestamp_time")))
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if starts.is_empty() {
        return Vec::new();
    }
    starts.sort_by(|left, right| left.total_cmp(right));
    let origin = starts[0];
    let mut boundaries = Vec::with_capacity(starts.len() + 1);
    for value in starts {
        let normalized = (value - origin).max(0.0);
        if boundaries
            .last()
            .is_none_or(|previous| normalized > *previous)
        {
            boundaries.push(normalized);
        }
    }
    if boundaries.is_empty() {
        return Vec::new();
    }
    let fallback_step = boundaries
        .windows(2)
        .last()
        .map(|pair| pair[1] - pair[0])
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0 / 30.0);
    let source_duration = duration_seconds.filter(|value| value.is_finite() && *value > 0.0);
    let inferred_end =
        boundaries[boundaries.len() - 1] + last_frame_duration.unwrap_or(fallback_step);
    let final_boundary = source_duration
        .filter(|duration| (*duration - inferred_end).abs() <= fallback_step * 2.0)
        .unwrap_or(inferred_end)
        .max(boundaries[boundaries.len() - 1] + f64::EPSILON);
    boundaries.push(final_boundary);
    boundaries
}

fn build_video_frame_index_inner(
    input_path: String,
    duration_seconds: Option<f64>,
    manager: Option<&MediaTaskManager>,
    task_id: Option<&str>,
) -> Result<VideoFrameIndexResult, String> {
    let input = Path::new(&input_path);
    if !input.is_file() {
        return Err("输入媒体不存在或不是普通文件".to_string());
    }
    let output = run_command_output(
        Command::new(find_ffprobe()).args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time,pkt_duration_time",
            "-print_format",
            "json",
            &input_path,
        ]),
        manager,
        task_id,
    )
    .map_err(|error| format!("ffprobe 帧索引启动失败: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let raw: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("ffprobe 帧索引解析失败: {error}"))?;
    let boundaries_seconds = normalize_frame_boundaries(&raw, duration_seconds);
    if boundaries_seconds.len() < 2 {
        return Err("没有读取到有效的视频帧时间戳".to_string());
    }
    Ok(VideoFrameIndexResult {
        frame_count: boundaries_seconds.len() - 1,
        boundaries_seconds,
    })
}

#[tauri::command(async)]
fn build_video_frame_index(
    manager: tauri::State<'_, MediaTaskManager>,
    input_path: String,
    duration_seconds: Option<f64>,
    task_id: Option<String>,
) -> Result<VideoFrameIndexResult, String> {
    build_video_frame_index_inner(
        input_path,
        duration_seconds,
        Some(&manager),
        task_id.as_deref(),
    )
}

fn build_preview_data_url_inner(
    input_path: String,
    preview_time_seconds: Option<f64>,
    manager: Option<&MediaTaskManager>,
    task_id: Option<&str>,
) -> Result<PreviewDataUrlResult, String> {
    let preview_file = TemporaryPath::new("preview", "jpg");
    let preview_path = preview_file.path();
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];

    if let Some(seconds) = preview_time_seconds {
        if seconds.is_finite() && seconds > 0.0 {
            args.extend(["-ss".to_string(), format!("{seconds:.9}")]);
        }
    }

    args.extend([
        "-i".to_string(),
        input_path.clone(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        "scale='if(gte(iw,ih),min(1600,iw),-2)':'if(gte(iw,ih),-2,min(1600,ih))'".to_string(),
        "-q:v".to_string(),
        "4".to_string(),
        preview_path.to_string_lossy().to_string(),
    ]);

    let output = run_command_output(Command::new(find_ffmpeg()).args(&args), manager, task_id)
        .map_err(|error| format!("ffmpeg 预览图生成失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let bytes = fs::read(preview_path).map_err(|error| format!("读取预览图失败: {error}"))?;

    Ok(PreviewDataUrlResult {
        data_url: format!(
            "data:image/jpeg;base64,{}",
            general_purpose::STANDARD.encode(bytes)
        ),
    })
}

#[tauri::command(async)]
fn build_preview_data_url(
    manager: tauri::State<'_, MediaTaskManager>,
    input_path: String,
    preview_time_seconds: Option<f64>,
    task_id: Option<String>,
) -> Result<PreviewDataUrlResult, String> {
    build_preview_data_url_inner(
        input_path,
        preview_time_seconds,
        Some(&manager),
        task_id.as_deref(),
    )
}

fn is_direct_preview_compatible(probe: &ProbeResult) -> bool {
    probe.codec_name.as_deref() == Some("h264")
        && probe
            .format_name
            .as_deref()
            .is_some_and(|format| format.split(',').any(|part| part == "mov" || part == "mp4"))
}

fn managed_preview_cache_bytes() -> u64 {
    fs::read_dir(env::temp_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            is_managed_preview_asset(&path)
                .then(|| entry.metadata().ok().map(|metadata| metadata.len()))
                .flatten()
        })
        .sum()
}

fn generate_preview_video_asset(
    input_path: &str,
    duration_seconds: Option<f64>,
    manager: Option<&MediaTaskManager>,
    task_id: Option<&str>,
) -> Result<TemporaryPath, String> {
    let duration_seconds = duration_seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "无法确定视频时长，已回退静态预览".to_string())?;
    let estimated_bytes = (duration_seconds * PREVIEW_PROXY_BIT_RATE as f64 / 8.0 * 1.15) as u64;
    if estimated_bytes > MAX_PREVIEW_PROXY_BYTES {
        return Err("视频过长，代理文件预计超过 512 MB，已回退静态预览".to_string());
    }
    let cache_bytes = managed_preview_cache_bytes();
    if cache_bytes.saturating_add(estimated_bytes) > MAX_PREVIEW_CACHE_BYTES {
        return Err("代理视频缓存将超过 1 GB，已回退静态预览".to_string());
    }

    let preview_file = TemporaryPath::new("preview-video", "mp4");
    let preview_path = preview_file.path();
    let scale_filter =
        "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))',setsar=1";

    let output = run_command_output(
        Command::new(find_ffmpeg()).args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            input_path,
            "-vf",
            scale_filter,
            "-an",
            "-c:v",
            "h264_videotoolbox",
            "-allow_sw",
            "1",
            "-b:v",
            "1200k",
            "-maxrate",
            "1600k",
            "-bufsize",
            "3200k",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-fs",
            &MAX_PREVIEW_PROXY_BYTES.to_string(),
            preview_path.to_string_lossy().as_ref(),
        ]),
        manager,
        task_id,
    )
    .map_err(|error| format!("ffmpeg 预览视频生成失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(preview_file)
}

#[tauri::command(async)]
fn build_preview_video_asset(
    app: tauri::AppHandle,
    manager: tauri::State<'_, MediaTaskManager>,
    input_path: String,
    task_id: Option<String>,
) -> Result<PreviewVideoAssetResult, String> {
    let probe = probe_media_inner(input_path.clone(), Some(&manager), task_id.as_deref())?;
    if is_direct_preview_compatible(&probe) {
        let input = PathBuf::from(&input_path);
        app.asset_protocol_scope()
            .allow_file(&input)
            .map_err(|error| format!("授权原视频访问失败: {error}"))?;
        return Ok(PreviewVideoAssetResult {
            file_path: input_path,
            temporary: false,
        });
    }

    let preview_file = generate_preview_video_asset(
        &input_path,
        probe.duration_seconds,
        Some(&manager),
        task_id.as_deref(),
    )?;
    let preview_path = preview_file.path();

    app.asset_protocol_scope()
        .allow_file(preview_path)
        .map_err(|error| format!("授权代理视频访问失败: {error}"))?;
    let preview_path = preview_file.persist();

    Ok(PreviewVideoAssetResult {
        file_path: preview_path.to_string_lossy().to_string(),
        temporary: true,
    })
}

#[tauri::command]
fn delete_preview_asset(
    app: tauri::AppHandle,
    file_path: String,
    temporary: bool,
) -> Result<(), String> {
    let path = PathBuf::from(file_path);
    if temporary && !is_managed_preview_asset(&path) {
        return Err("拒绝删除不受本应用管理的文件".to_string());
    }

    app.asset_protocol_scope()
        .forbid_file(&path)
        .map_err(|error| format!("撤销代理视频访问失败: {error}"))?;
    if !temporary {
        return Ok(());
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除代理视频失败: {error}")),
    }
}

#[tauri::command]
fn cancel_media_tasks(manager: tauri::State<'_, MediaTaskManager>, task_ids: Vec<String>) {
    for task_id in task_ids {
        manager.cancel(&task_id);
    }
}

#[tauri::command]
fn cancel_all_media_tasks(manager: tauri::State<'_, MediaTaskManager>) {
    manager.cancel_all();
}

fn crop_rect_to_request(rect: CropRect) -> CropRectRequest {
    CropRectRequest {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

fn margins_from_rect(
    rect: &CropRect,
    source_width: u64,
    source_height: u64,
) -> Option<BorderMargins> {
    let right_edge = rect.x.checked_add(rect.width)?;
    let bottom_edge = rect.y.checked_add(rect.height)?;
    if rect.width == 0
        || rect.height == 0
        || right_edge > source_width
        || bottom_edge > source_height
    {
        return None;
    }

    Some(BorderMargins {
        left: rect.x,
        top: rect.y,
        right: source_width - right_edge,
        bottom: source_height - bottom_edge,
    })
}

fn rect_from_margins(
    margins: BorderMargins,
    source_width: u64,
    source_height: u64,
) -> Option<CropRect> {
    let horizontal_margins = margins.left.checked_add(margins.right)?;
    let vertical_margins = margins.top.checked_add(margins.bottom)?;
    if horizontal_margins >= source_width || vertical_margins >= source_height {
        return None;
    }

    Some(CropRect {
        x: margins.left,
        y: margins.top,
        width: source_width - horizontal_margins,
        height: source_height - vertical_margins,
    })
}

fn border_tolerances(source_width: u64, source_height: u64) -> BorderMargins {
    let horizontal = ((source_width as f64 * 0.005).round() as u64).max(4);
    let vertical = ((source_height as f64 * 0.005).round() as u64).max(4);
    BorderMargins {
        left: horizontal,
        top: vertical,
        right: horizontal,
        bottom: vertical,
    }
}

fn margins_agree(first: BorderMargins, second: BorderMargins, tolerance: BorderMargins) -> bool {
    first.left.abs_diff(second.left) <= tolerance.left
        && first.top.abs_diff(second.top) <= tolerance.top
        && first.right.abs_diff(second.right) <= tolerance.right
        && first.bottom.abs_diff(second.bottom) <= tolerance.bottom
}

fn largest_margin_cluster(samples: &[BorderMargins], tolerance: BorderMargins) -> Vec<usize> {
    let mut largest: Vec<usize> = Vec::new();

    for (candidate_index, candidate) in samples.iter().copied().enumerate() {
        let cluster = samples
            .iter()
            .copied()
            .enumerate()
            .filter_map(|(index, sample)| {
                margins_agree(candidate, sample, tolerance).then_some(index)
            })
            .collect::<Vec<_>>();

        if cluster.len() > largest.len()
            || (cluster.len() == largest.len()
                && cluster.contains(&candidate_index)
                && cluster
                    .iter()
                    .map(|index| {
                        let value = samples[*index];
                        value.left + value.top + value.right + value.bottom
                    })
                    .sum::<u64>()
                    < largest
                        .iter()
                        .map(|index| {
                            let value = samples[*index];
                            value.left + value.top + value.right + value.bottom
                        })
                        .sum::<u64>())
        {
            largest = cluster;
        }
    }

    largest
}

fn minimum_margin(samples: &[BorderMargins], cluster: &[usize]) -> Option<BorderMargins> {
    let first = *cluster.first()?;
    let mut result = samples[first];
    for index in cluster.iter().copied().skip(1) {
        let sample = samples[index];
        result.left = result.left.min(sample.left);
        result.top = result.top.min(sample.top);
        result.right = result.right.min(sample.right);
        result.bottom = result.bottom.min(sample.bottom);
    }
    Some(result)
}

fn parse_bbox_metadata(output: &str, source_width: u64, source_height: u64) -> Vec<CropRect> {
    let mut rects = Vec::new();
    let mut x = None;
    let mut y = None;
    let mut width = None;
    let mut height = None;

    let flush = |rects: &mut Vec<CropRect>,
                 x: &mut Option<u64>,
                 y: &mut Option<u64>,
                 width: &mut Option<u64>,
                 height: &mut Option<u64>| {
        if let (Some(x_value), Some(y_value), Some(width_value), Some(height_value)) =
            (*x, *y, *width, *height)
        {
            let rect = CropRect {
                x: x_value,
                y: y_value,
                width: width_value,
                height: height_value,
            };
            if margins_from_rect(&rect, source_width, source_height).is_some() {
                rects.push(rect);
            }
        }
        *x = None;
        *y = None;
        *width = None;
        *height = None;
    };

    for line in output.lines() {
        if line.trim_start().starts_with("frame:") {
            flush(&mut rects, &mut x, &mut y, &mut width, &mut height);
            continue;
        }

        let Some(metadata_start) = line.find("lavfi.bbox.") else {
            continue;
        };
        let metadata = &line[metadata_start + "lavfi.bbox.".len()..];
        let Some((key, raw_value)) = metadata.split_once('=') else {
            continue;
        };
        let Some(value) = raw_value
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };

        match key.trim() {
            "x1" => x = Some(value),
            "y1" => y = Some(value),
            "w" => width = Some(value),
            "h" => height = Some(value),
            _ => {}
        }
    }

    flush(&mut rects, &mut x, &mut y, &mut width, &mut height);
    rects
}

fn representative_rect_for_window(
    rects: &[CropRect],
    source_width: u64,
    source_height: u64,
) -> Option<CropRect> {
    // Use the union across the window so content that only reaches an edge in
    // one frame is still kept. This is deliberately conservative: subtitles or
    // overlays inside a black bar may leave part of that bar instead of cutting
    // visible content.
    let mut valid_rects = rects
        .iter()
        .copied()
        .filter(|rect| margins_from_rect(rect, source_width, source_height).is_some());
    let first = valid_rects.next()?;
    let mut left = first.x;
    let mut top = first.y;
    let mut right = first.x.checked_add(first.width)?;
    let mut bottom = first.y.checked_add(first.height)?;

    for rect in valid_rects {
        left = left.min(rect.x);
        top = top.min(rect.y);
        right = right.max(rect.x.checked_add(rect.width)?);
        bottom = bottom.max(rect.y.checked_add(rect.height)?);
    }

    let union = CropRect {
        x: left,
        y: top,
        width: right.checked_sub(left)?,
        height: bottom.checked_sub(top)?,
    };
    margins_from_rect(&union, source_width, source_height).map(|_| union)
}

fn sample_seek_positions(
    start_seconds: f64,
    duration_seconds: f64,
    sample_windows: usize,
    window_seconds: f64,
) -> Vec<f64> {
    let latest_start = (duration_seconds - window_seconds).max(0.0);
    (0..sample_windows)
        .map(|index| {
            let fraction = (index as f64 + 0.5) / sample_windows as f64;
            start_seconds + latest_start * fraction
        })
        .collect()
}

fn run_bbox_window(
    input_path: &str,
    seek_seconds: f64,
    window_seconds: f64,
    source_width: u64,
    source_height: u64,
    manager: Option<&MediaTaskManager>,
    task_id: Option<&str>,
) -> Result<Option<CropRect>, String> {
    let output = run_command_output(
        Command::new(find_ffmpeg()).args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{seek_seconds:.3}"),
            "-i",
            input_path,
            "-t",
            &format!("{window_seconds:.3}"),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            "fps=8,format=yuv420p,bbox=min_val=24,metadata=mode=print:file=-",
            "-f",
            "null",
            "-",
        ]),
        manager,
        task_id,
    )
    .map_err(|error| format!("ffmpeg 黑边检测启动失败: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let mut metadata = String::from_utf8_lossy(&output.stdout).into_owned();
    metadata.push('\n');
    metadata.push_str(&String::from_utf8_lossy(&output.stderr));
    let rects = parse_bbox_metadata(&metadata, source_width, source_height);
    Ok(representative_rect_for_window(
        &rects,
        source_width,
        source_height,
    ))
}

fn no_detection_result(
    status: &str,
    warning: String,
    sample_count: usize,
) -> DetectBlackBordersResult {
    DetectBlackBordersResult {
        status: status.to_string(),
        rect: None,
        margins: BorderMargins::default(),
        confidence: 0.0,
        sample_count,
        agreeing_samples: 0,
        warning: Some(warning),
    }
}

fn detection_confidence(agreeing_samples: usize, attempted_samples: usize) -> f64 {
    if attempted_samples == 0 {
        0.0
    } else {
        agreeing_samples as f64 / attempted_samples as f64
    }
}

fn detect_black_borders_inner(
    request: DetectBlackBordersRequest,
    manager: Option<&MediaTaskManager>,
) -> Result<DetectBlackBordersResult, String> {
    let probe = probe_media_inner(
        request.input_path.clone(),
        manager,
        request.task_id.as_deref(),
    )?;
    if probe.media_kind != "video" {
        return Ok(no_detection_result(
            "failed",
            "当前素材不是可检测的视频".to_string(),
            0,
        ));
    }

    let source_width = probe
        .display_width
        .ok_or_else(|| "无法读取视频显示宽度".to_string())?;
    let source_height = probe
        .display_height
        .ok_or_else(|| "无法读取视频显示高度".to_string())?;
    let total_duration = probe.duration_seconds.unwrap_or_else(|| {
        request.start_seconds.unwrap_or(0.0).max(0.0)
            + request.duration_seconds.unwrap_or(5.0).max(0.0)
    });
    let start_seconds = request
        .start_seconds
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
        .min(total_duration.max(0.0));
    let available_duration = (total_duration - start_seconds).max(0.0);
    let duration_seconds = request
        .duration_seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(available_duration)
        .min(available_duration);

    if duration_seconds <= 0.0 {
        return Ok(no_detection_result(
            "failed",
            "所选视频时间范围为空，无法检测黑边".to_string(),
            0,
        ));
    }

    let sample_windows = request.sample_windows.unwrap_or(7).clamp(3, 15);
    let window_seconds = 1.0_f64.min((duration_seconds / 3.0).max(0.125));
    let seek_positions = sample_seek_positions(
        start_seconds,
        duration_seconds,
        sample_windows,
        window_seconds,
    );
    let mut samples = Vec::new();
    let mut failed_windows = 0_usize;

    for seek_seconds in seek_positions.iter().copied() {
        match run_bbox_window(
            &request.input_path,
            seek_seconds,
            window_seconds,
            source_width,
            source_height,
            manager,
            request.task_id.as_deref(),
        ) {
            Ok(Some(rect)) => {
                if let Some(margins) = margins_from_rect(&rect, source_width, source_height) {
                    samples.push(margins);
                } else {
                    failed_windows += 1;
                }
            }
            Ok(None) | Err(_) => failed_windows += 1,
        }
    }

    if samples.is_empty() {
        return Ok(no_detection_result(
            "failed",
            "所有采样窗口都未获得有效的黑边检测数据".to_string(),
            seek_positions.len(),
        ));
    }

    let tolerance = border_tolerances(source_width, source_height);
    let cluster = largest_margin_cluster(&samples, tolerance);
    let sample_count = seek_positions.len();
    let agreeing_samples = cluster.len();
    let confidence = detection_confidence(agreeing_samples, sample_count);
    let partial_warning = (failed_windows > 0).then(|| {
        format!(
            "有 {failed_windows} 个采样窗口未获得有效数据，结果基于 {} 个有效窗口",
            samples.len()
        )
    });

    if agreeing_samples < 3 || confidence + f64::EPSILON < 0.7 {
        return Ok(DetectBlackBordersResult {
            status: "needs_review".to_string(),
            rect: None,
            margins: BorderMargins::default(),
            confidence,
            sample_count,
            agreeing_samples,
            warning: Some(format!(
                "不同时间点的画面边界不一致（{agreeing_samples}/{sample_count} 个采样一致），请人工确认"
            )),
        });
    }

    let consensus =
        minimum_margin(&samples, &cluster).ok_or_else(|| "无法汇总黑边检测结果".to_string())?;
    let near_full_frame = consensus.left <= tolerance.left
        && consensus.top <= tolerance.top
        && consensus.right <= tolerance.right
        && consensus.bottom <= tolerance.bottom;

    if near_full_frame {
        return Ok(DetectBlackBordersResult {
            status: "no_border".to_string(),
            rect: Some(CropRectRequest {
                x: 0,
                y: 0,
                width: source_width,
                height: source_height,
            }),
            margins: BorderMargins::default(),
            confidence,
            sample_count,
            agreeing_samples,
            warning: partial_warning,
        });
    }

    let horizontal_safety = ((source_width as f64 * 0.002).round() as u64).clamp(2, 4);
    let vertical_safety = ((source_height as f64 * 0.002).round() as u64).clamp(2, 4);
    let safe_margins = BorderMargins {
        left: consensus.left.saturating_sub(horizontal_safety),
        top: consensus.top.saturating_sub(vertical_safety),
        right: consensus.right.saturating_sub(horizontal_safety),
        bottom: consensus.bottom.saturating_sub(vertical_safety),
    };
    let safe_rect = rect_from_margins(safe_margins, source_width, source_height)
        .ok_or_else(|| "检测到的内容区域无效".to_string())?;
    let normalized = normalize_crop_rect(
        &crop_rect_to_request(safe_rect),
        source_width,
        source_height,
        true,
    )?;
    let final_margins = margins_from_rect(&normalized, source_width, source_height)
        .ok_or_else(|| "归一化后的内容区域无效".to_string())?;

    Ok(DetectBlackBordersResult {
        status: "detected".to_string(),
        rect: Some(crop_rect_to_request(normalized)),
        margins: final_margins,
        confidence,
        sample_count,
        agreeing_samples,
        warning: partial_warning,
    })
}

#[tauri::command(async)]
fn detect_black_borders(
    manager: tauri::State<'_, MediaTaskManager>,
    request: DetectBlackBordersRequest,
) -> Result<DetectBlackBordersResult, String> {
    detect_black_borders_inner(request, Some(&manager))
}

#[tauri::command(async)]
fn export_media(
    window: tauri::Window,
    manager: tauri::State<'_, MediaTaskManager>,
    request: ExportMediaRequest,
) -> Result<ExportResult, String> {
    export_media_inner(request, Some(&window), Some(&manager))
}

fn export_media_inner(
    request: ExportMediaRequest,
    progress_window: Option<&tauri::Window>,
    manager: Option<&MediaTaskManager>,
) -> Result<ExportResult, String> {
    if request.mode != "image" && request.mode != "video" {
        return Err("不支持的媒体导出模式".to_string());
    }
    if request.output_path.trim().is_empty() {
        return Err("输出路径不能为空".to_string());
    }
    let probe = probe_media_inner(
        request.input_path.clone(),
        manager,
        request.task_id.as_deref(),
    )?;
    // FFmpeg enables autorotation by default and applies it before the filter graph,
    // so crop coordinates must use the displayed (post-rotation) frame dimensions.
    let source_width = probe
        .display_width
        .ok_or_else(|| "无法读取源媒体显示宽度".to_string())?;
    let source_height = probe
        .display_height
        .ok_or_else(|| "无法读取源媒体显示高度".to_string())?;
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
    let mut output_target =
        prepare_output_target(Path::new(&request.output_path), request.avoid_overwrite)?;
    let output_path = output_target.path.to_string_lossy().into_owned();
    let working_output_path = output_target.working_path().to_string_lossy().into_owned();

    let mut args = vec!["-y".to_string(), "-hide_banner".to_string()];

    if request.mode == "video" {
        args.extend([
            "-ss".to_string(),
            format!("{:.9}", request.video_start_seconds.unwrap_or(0.0).max(0.0)),
            "-t".to_string(),
            format!(
                "{:.9}",
                request.video_duration_seconds.unwrap_or(5.0).max(0.000_001)
            ),
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
                let qscale =
                    (((100_u8.saturating_sub(quality)) as f64 / 100.0) * 29.0).round() as u8 + 2;
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
            "h264_videotoolbox".to_string(),
            "-allow_sw".to_string(),
            "1".to_string(),
            "-profile:v".to_string(),
            "high".to_string(),
            "-b:v".to_string(),
            "6000k".to_string(),
            "-maxrate".to_string(),
            "8000k".to_string(),
            "-bufsize".to_string(),
            "16000k".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
        ]);
    }

    args.push(working_output_path);

    if request.mode == "video" {
        let total_seconds = request
            .video_duration_seconds
            .unwrap_or_else(|| probe.duration_seconds.unwrap_or(5.0))
            .max(0.5);

        args.extend([
            "-progress".to_string(),
            "pipe:2".to_string(),
            "-nostats".to_string(),
        ]);

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
        let pid = child.id();
        if let (Some(manager), Some(task_id)) = (manager, request.task_id.as_deref()) {
            manager.register(task_id, pid);
        }
        let registration = RegisteredProcess {
            manager,
            task_id: request.task_id.as_deref(),
            pid,
        };

        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                terminate_process(pid);
                let _ = child.wait();
                return Err("无法读取 ffmpeg 进度输出".to_string());
            }
        };
        let reader = BufReader::new(stderr);
        let mut stderr_lines = Vec::new();
        let mut latest_seconds = 0.0;
        let mut latest_percent = 0.0;

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    terminate_process(pid);
                    let _ = child.wait();
                    return Err(format!("读取 ffmpeg 输出失败: {error}"));
                }
            };
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
        drop(registration);
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

        output_target.commit()?;
        return Ok(ExportResult {
            output_path,
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

    let output = run_command_output(
        Command::new(find_ffmpeg()).args(&args),
        manager,
        request.task_id.as_deref(),
    )
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

    output_target.commit()?;
    Ok(ExportResult {
        output_path,
        applied_filter: filter,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(MediaTaskManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_| {
            cleanup_stale_preview_assets(Duration::from_secs(24 * 60 * 60));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            build_video_frame_index,
            build_preview_data_url,
            build_preview_video_asset,
            delete_preview_asset,
            cancel_media_tasks,
            cancel_all_media_tasks,
            detect_black_borders,
            export_media
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<MediaTaskManager>().cancel_all();
            cleanup_current_process_preview_assets();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        build_preview_data_url_inner, build_video_frame_index_inner, detect_black_borders_inner,
        detection_confidence, export_media_inner, find_ffmpeg, generate_preview_video_asset,
        is_direct_preview_compatible, is_managed_preview_asset, normalize_frame_boundaries,
        parse_bbox_metadata, parse_frame_rate, parse_frame_rate_ratio, parse_rotation_degrees,
        probe_media_inner, probe_result_from_raw, representative_rect_for_window,
        suffixed_output_path, CropRect, CropRectRequest, DetectBlackBordersRequest,
        ExportMediaRequest, ProbeResult,
    };
    use serde_json::json;
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_path(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_millis();

        env::temp_dir().join(format!("media-cropper-{timestamp}-{name}"))
    }

    fn create_sample_video(output_path: &Path) {
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
                "mpeg4",
                "-q:v",
                "5",
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

    fn create_sample_vfr_video(output_path: &Path) {
        let status = Command::new(find_ffmpeg())
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=24:duration=1",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x120:rate=30:duration=1",
                "-filter_complex",
                "[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,settb=1/60000[v]",
                "-map",
                "[v]",
                "-fps_mode",
                "vfr",
                "-c:v",
                "mpeg4",
                "-q:v",
                "5",
                "-pix_fmt",
                "yuv420p",
                output_path.to_str().expect("utf-8 path"),
            ])
            .status()
            .expect("ffmpeg should generate a VFR sample during tests");

        assert!(status.success(), "VFR sample generation should succeed");
    }

    fn create_sample_image(output_path: &Path) {
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

    fn create_black_border_video(output_path: &Path) {
        let status = Command::new(find_ffmpeg())
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=240x160:rate=30,pad=320:240:40:40:black",
                "-t",
                "3",
                "-c:v",
                "mpeg4",
                "-q:v",
                "5",
                "-pix_fmt",
                "yuv420p",
                output_path.to_str().expect("utf-8 path"),
            ])
            .status()
            .expect("ffmpeg should generate a bordered video during tests");

        assert!(status.success(), "bordered video generation should succeed");
    }

    fn add_display_rotation(input_path: &Path, output_path: &Path, degrees: i32) {
        let status = Command::new(find_ffmpeg())
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-display_rotation:v:0",
                &degrees.to_string(),
                "-i",
                input_path.to_str().expect("utf-8 input path"),
                "-c",
                "copy",
                output_path.to_str().expect("utf-8 output path"),
            ])
            .status()
            .expect("ffmpeg should add display rotation during tests");

        assert!(status.success(), "display rotation remux should succeed");
    }

    #[test]
    fn probe_media_returns_basic_video_metadata() {
        let input_path = unique_path("probe-input.mp4");
        create_sample_video(&input_path);

        let result = probe_media_inner(input_path.to_string_lossy().to_string(), None, None)
            .expect("probe should succeed for generated sample");

        assert_eq!(result.media_kind, "video");
        assert_eq!(result.codec_name.as_deref(), Some("mpeg4"));
        assert_eq!(result.width, Some(320));
        assert_eq!(result.height, Some(240));
        assert_eq!(result.rotation_degrees, 0);
        assert_eq!(result.display_width, Some(320));
        assert_eq!(result.display_height, Some(240));
        assert!(result.duration_seconds.unwrap_or_default() > 0.0);
        assert!((result.frame_rate.unwrap_or_default() - 30.0).abs() < 0.01);
        assert_eq!(result.frame_rate_numerator, Some(30));
        assert_eq!(result.frame_rate_denominator, Some(1));
        assert_eq!(result.frame_count, Some(60));
        assert!(!result.variable_frame_rate);

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn rotation_metadata_uses_side_data_then_tags_and_swaps_display_dimensions() {
        let side_data_stream = json!({
            "side_data_list": [{ "rotation": -90 }],
            "tags": { "rotate": "180" }
        });
        assert_eq!(parse_rotation_degrees(Some(&side_data_stream)), 270);

        let tag_stream = json!({ "tags": { "rotate": "90" } });
        assert_eq!(parse_rotation_degrees(Some(&tag_stream)), 90);

        let raw = json!({
            "streams": [{
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "side_data_list": [{ "rotation": 90 }]
            }],
            "format": { "format_name": "mov,mp4", "duration": "2.0" }
        });
        let result = probe_result_from_raw(raw);
        assert_eq!(result.rotation_degrees, 90);
        assert_eq!(result.display_width, Some(1080));
        assert_eq!(result.display_height, Some(1920));
    }

    #[test]
    fn frame_rate_parser_supports_ffprobe_rationals() {
        assert_eq!(parse_frame_rate(Some(&json!("30/1"))), Some(30.0));
        let ntsc = parse_frame_rate(Some(&json!("30000/1001"))).expect("valid NTSC rate");
        assert!((ntsc - 29.970_029_97).abs() < 0.000_001);
        assert_eq!(parse_frame_rate(Some(&json!("0/0"))), None);
        assert_eq!(
            parse_frame_rate_ratio(Some(&json!("30000/1001"))),
            Some((30000, 1001))
        );
    }

    #[test]
    fn frame_boundaries_are_normalized_and_get_an_exclusive_end() {
        let raw = json!({
            "frames": [
                { "best_effort_timestamp_time": "5.000" },
                { "best_effort_timestamp_time": "5.033" },
                { "best_effort_timestamp_time": "5.067" },
                { "best_effort_timestamp_time": "5.067" }
            ]
        });
        let boundaries = normalize_frame_boundaries(&raw, Some(0.1));
        assert_eq!(boundaries.len(), 4);
        assert_eq!(boundaries[0], 0.0);
        assert!((boundaries[1] - 0.033).abs() < 0.000_001);
        assert!(boundaries[3] >= 0.1);
    }

    #[test]
    fn frame_index_reads_real_vfr_boundaries() {
        let input_path = unique_path("frame-index-vfr.mp4");
        create_sample_vfr_video(&input_path);
        let probe = probe_media_inner(input_path.to_string_lossy().to_string(), None, None)
            .expect("VFR probe should succeed");
        assert!(probe.variable_frame_rate);
        let result = build_video_frame_index_inner(
            input_path.to_string_lossy().to_string(),
            Some(2.0),
            None,
            None,
        )
        .expect("VFR frame index should succeed");

        assert_eq!(result.frame_count, 54);
        assert_eq!(result.boundaries_seconds.len(), 55);
        assert!(result
            .boundaries_seconds
            .windows(2)
            .all(|pair| pair[1] > pair[0]));

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn bbox_metadata_parser_reads_complete_frame_rectangles() {
        let metadata = r#"
frame:0 pts:0 pts_time:0
lavfi.bbox.x1=40
lavfi.bbox.x2=279
lavfi.bbox.y1=40
lavfi.bbox.y2=199
lavfi.bbox.w=240
lavfi.bbox.h=160
frame:1 pts:1 pts_time:0.125
lavfi.bbox.x1=38
lavfi.bbox.x2=281
lavfi.bbox.y1=38
lavfi.bbox.y2=201
lavfi.bbox.w=244
lavfi.bbox.h=164
"#;

        let rects = parse_bbox_metadata(metadata, 320, 240);
        assert_eq!(
            rects,
            vec![
                CropRect {
                    x: 40,
                    y: 40,
                    width: 240,
                    height: 160,
                },
                CropRect {
                    x: 38,
                    y: 38,
                    width: 244,
                    height: 164,
                },
            ]
        );
    }

    #[test]
    fn window_representative_uses_union_of_bbox_frames() {
        let rects = vec![
            CropRect {
                x: 40,
                y: 40,
                width: 240,
                height: 160,
            },
            CropRect {
                x: 10,
                y: 20,
                width: 240,
                height: 160,
            },
        ];

        assert_eq!(
            representative_rect_for_window(&rects, 320, 240),
            Some(CropRect {
                x: 10,
                y: 20,
                width: 270,
                height: 180,
            })
        );
    }

    #[test]
    fn detection_confidence_counts_failed_attempts_in_denominator() {
        let confidence = detection_confidence(3, 7);
        assert!((confidence - (3.0 / 7.0)).abs() < f64::EPSILON);
        assert!(confidence < 0.7);
    }

    #[test]
    fn build_preview_data_url_returns_image_data() {
        let input_path = unique_path("preview-input.mp4");
        create_sample_video(&input_path);

        let result = build_preview_data_url_inner(
            input_path.to_string_lossy().to_string(),
            None,
            None,
            None,
        )
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

        let preview_file = generate_preview_video_asset(
            input_path.to_string_lossy().as_ref(),
            Some(2.0),
            None,
            None,
        )
        .expect("preview video generation should succeed for generated sample");
        let preview_path = preview_file.path().to_path_buf();
        assert!(preview_path.exists(), "preview proxy video should exist");

        let _ = fs::remove_file(input_path);
        drop(preview_file);
        assert!(
            !preview_path.exists(),
            "temporary preview should be removed on drop"
        );
    }

    #[test]
    fn direct_video_preview_only_accepts_h264_mp4_or_mov() {
        let make_probe = |codec_name: &str, format_name: &str| ProbeResult {
            media_kind: "video".to_string(),
            format_name: Some(format_name.to_string()),
            codec_name: Some(codec_name.to_string()),
            width: Some(1920),
            height: Some(1080),
            rotation_degrees: 0,
            display_width: Some(1920),
            display_height: Some(1080),
            duration_seconds: Some(5.0),
            frame_rate: Some(30.0),
            frame_rate_numerator: Some(30),
            frame_rate_denominator: Some(1),
            frame_count: Some(150),
            variable_frame_rate: false,
            bit_rate: None,
            raw: json!({}),
        };

        assert!(is_direct_preview_compatible(&make_probe(
            "h264",
            "mov,mp4,m4a"
        )));
        assert!(!is_direct_preview_compatible(&make_probe(
            "hevc",
            "mov,mp4,m4a"
        )));
        assert!(!is_direct_preview_compatible(&make_probe(
            "h264",
            "matroska,webm"
        )));
    }

    #[test]
    fn preview_proxy_rejects_estimated_files_over_the_limit() {
        let result = generate_preview_video_asset(
            "/path/does/not/need/to/exist.mp4",
            Some(60.0 * 60.0),
            None,
            None,
        );

        assert!(result
            .expect_err("one-hour proxy should exceed the configured size limit")
            .contains("512 MB"));
    }

    #[test]
    fn managed_preview_asset_guard_rejects_unrelated_paths() {
        let managed = super::unique_temp_path("preview-video", "mp4");
        let unrelated_name = env::temp_dir().join("unrelated-preview.mp4");
        let outside_temp = PathBuf::from("/tmp/subdir/media-cropper-preview-video-1-2-3.mp4");

        assert!(is_managed_preview_asset(&managed));
        assert!(!is_managed_preview_asset(&unrelated_name));
        assert!(!is_managed_preview_asset(&outside_temp));
    }

    #[test]
    fn probe_media_returns_basic_image_metadata() {
        let input_path = unique_path("probe-input.png");
        create_sample_image(&input_path);

        let result = probe_media_inner(input_path.to_string_lossy().to_string(), None, None)
            .expect("probe should succeed for generated image");

        assert_eq!(result.media_kind, "image");
        assert_eq!(result.width, Some(640));
        assert_eq!(result.height, Some(480));

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn detects_borders_and_exports_in_rotated_display_coordinates() {
        let source_path = unique_path("border-source.mp4");
        let rotated_path = unique_path("border-rotated.mp4");
        let output_path = unique_path("border-rotated-output.mp4");
        create_black_border_video(&source_path);
        add_display_rotation(&source_path, &rotated_path, 90);

        let probe = probe_media_inner(rotated_path.to_string_lossy().to_string(), None, None)
            .expect("rotated video probe should succeed");
        assert_eq!(probe.rotation_degrees, 90);
        assert_eq!(probe.display_width, Some(240));
        assert_eq!(probe.display_height, Some(320));

        let detection = detect_black_borders_inner(
            DetectBlackBordersRequest {
                task_id: None,
                input_path: rotated_path.to_string_lossy().to_string(),
                start_seconds: Some(0.0),
                duration_seconds: Some(3.0),
                sample_windows: Some(7),
            },
            None,
        )
        .expect("black border detection should run");

        assert_eq!(detection.status, "detected");
        assert_eq!(detection.sample_count, 7);
        assert!(detection.agreeing_samples >= 5);
        assert!(detection.confidence >= 0.7);
        assert!((34..=42).contains(&detection.margins.left));
        assert!((34..=42).contains(&detection.margins.top));
        assert!((34..=42).contains(&detection.margins.right));
        assert!((34..=42).contains(&detection.margins.bottom));

        let export = export_media_inner(
            ExportMediaRequest {
                task_id: None,
                input_path: rotated_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                avoid_overwrite: false,
                mode: "video".to_string(),
                ratio: "free".to_string(),
                anchor: "center".to_string(),
                scale: 1.0,
                image_format: None,
                image_quality: None,
                video_start_seconds: Some(0.0),
                video_duration_seconds: Some(1.0),
                crop_rect: Some(CropRectRequest {
                    x: 0,
                    y: 0,
                    width: 240,
                    height: 320,
                }),
            },
            None,
            None,
        )
        .expect("rotated display-space crop should export");

        assert_eq!(export.applied_filter, "crop=240:320:0:0");
        assert!(output_path.exists());

        let _ = fs::remove_file(source_path);
        let _ = fs::remove_file(rotated_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn export_video_crop_generates_output_file() {
        let input_path = unique_path("export-input.mp4");
        let output_path = unique_path("export-output.mp4");
        create_sample_video(&input_path);

        let result = export_media_inner(
            ExportMediaRequest {
                task_id: None,
                input_path: input_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                avoid_overwrite: false,
                mode: "video".to_string(),
                ratio: "1:1".to_string(),
                anchor: "center".to_string(),
                scale: 1.0,
                image_format: None,
                image_quality: None,
                video_start_seconds: Some(0.0),
                video_duration_seconds: Some(1.0),
                crop_rect: None,
            },
            None,
            None,
        )
        .expect("export should succeed for generated sample");

        assert_eq!(result.output_path, output_path.to_string_lossy());
        assert_eq!(result.applied_filter, "crop=240:240:40:0");
        assert!(output_path.exists(), "output file should exist");
        let output_probe = probe_media_inner(output_path.to_string_lossy().to_string(), None, None)
            .expect("exported video should be probeable");
        assert_eq!(output_probe.frame_count, Some(30));

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn export_vfr_range_uses_exact_frame_boundaries() {
        let input_path = unique_path("export-vfr-input.mp4");
        let output_path = unique_path("export-vfr-output.mp4");
        create_sample_vfr_video(&input_path);
        let index = build_video_frame_index_inner(
            input_path.to_string_lossy().to_string(),
            Some(2.0),
            None,
            None,
        )
        .expect("VFR index should succeed");
        let start = index.boundaries_seconds[24];
        let end = index.boundaries_seconds[29];

        export_media_inner(
            ExportMediaRequest {
                task_id: None,
                input_path: input_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                avoid_overwrite: false,
                mode: "video".to_string(),
                ratio: "free".to_string(),
                anchor: "center".to_string(),
                scale: 1.0,
                image_format: None,
                image_quality: None,
                video_start_seconds: Some(start),
                video_duration_seconds: Some(end - start),
                crop_rect: Some(CropRectRequest {
                    x: 0,
                    y: 0,
                    width: 160,
                    height: 120,
                }),
            },
            None,
            None,
        )
        .expect("VFR range export should succeed");
        let output_probe = probe_media_inner(output_path.to_string_lossy().to_string(), None, None)
            .expect("VFR export should be probeable");
        assert_eq!(output_probe.frame_count, Some(5));

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn export_image_crop_generates_output_file() {
        let input_path = unique_path("export-image-input.png");
        let output_path = unique_path("export-image-output.jpg");
        create_sample_image(&input_path);
        fs::write(&output_path, b"stale output").expect("existing output should be writable");

        let result = export_media_inner(
            ExportMediaRequest {
                task_id: None,
                input_path: input_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                avoid_overwrite: false,
                mode: "image".to_string(),
                ratio: "1:1".to_string(),
                anchor: "top".to_string(),
                scale: 0.5,
                image_format: Some("jpg".to_string()),
                image_quality: Some(88),
                video_start_seconds: None,
                video_duration_seconds: None,
                crop_rect: None,
            },
            None,
            None,
        )
        .expect("image export should succeed for generated sample");

        assert_eq!(result.output_path, output_path.to_string_lossy());
        assert_eq!(result.applied_filter, "crop=240:240:200:0");
        assert!(output_path.exists(), "output image should exist");
        assert_ne!(
            fs::read(&output_path).expect("exported image should be readable"),
            b"stale output",
            "single-file export should keep its existing overwrite behavior"
        );

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn failed_export_preserves_existing_output_file() {
        let input_path = unique_path("atomic-failure-input.png");
        let output_path = unique_path("atomic-failure-output.webp");
        create_sample_image(&input_path);
        fs::write(&output_path, b"keep existing").expect("existing output should be writable");

        let result = export_media_inner(
            ExportMediaRequest {
                task_id: None,
                input_path: input_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                avoid_overwrite: false,
                mode: "image".to_string(),
                ratio: "free".to_string(),
                anchor: "center".to_string(),
                scale: 1.0,
                image_format: Some("webp".to_string()),
                image_quality: Some(88),
                video_start_seconds: None,
                video_duration_seconds: None,
                crop_rect: None,
            },
            None,
            None,
        );

        assert!(result.is_err(), "unsupported WEBP export should fail");
        assert_eq!(
            fs::read(&output_path).expect("existing output should remain readable"),
            b"keep existing",
            "failed export must not truncate or replace the existing file"
        );

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn batch_style_exports_preserve_existing_files_and_return_unique_paths() {
        let input_path = unique_path("unique-export-input.png");
        let requested_path = unique_path("unique-export-output.jpg");
        let expected_second_path =
            suffixed_output_path(&requested_path, 2).expect("second output path should be valid");
        let expected_third_path =
            suffixed_output_path(&requested_path, 3).expect("third output path should be valid");
        create_sample_image(&input_path);
        fs::write(&requested_path, b"keep existing").expect("existing output should be writable");

        let export_once = || {
            export_media_inner(
                ExportMediaRequest {
                    task_id: None,
                    input_path: input_path.to_string_lossy().to_string(),
                    output_path: requested_path.to_string_lossy().to_string(),
                    avoid_overwrite: true,
                    mode: "image".to_string(),
                    ratio: "1:1".to_string(),
                    anchor: "center".to_string(),
                    scale: 1.0,
                    image_format: Some("jpg".to_string()),
                    image_quality: Some(88),
                    video_start_seconds: None,
                    video_duration_seconds: None,
                    crop_rect: None,
                },
                None,
                None,
            )
            .expect("non-overwriting export should succeed")
        };

        let first_result = export_once();
        let second_result = export_once();

        assert_eq!(
            first_result.output_path,
            expected_second_path.to_string_lossy()
        );
        assert_eq!(
            second_result.output_path,
            expected_third_path.to_string_lossy()
        );
        assert_eq!(
            fs::read(&requested_path).expect("existing output should remain readable"),
            b"keep existing",
            "batch-style export must not overwrite an existing file"
        );
        assert!(expected_second_path.exists());
        assert!(expected_third_path.exists());

        let _ = fs::remove_file(input_path);
        let _ = fs::remove_file(requested_path);
        let _ = fs::remove_file(expected_second_path);
        let _ = fs::remove_file(expected_third_path);
    }
}
