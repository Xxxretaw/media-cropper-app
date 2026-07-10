# Media Cropper Desktop

基于 Tauri 2、Vanilla TypeScript、Rust 和本地 FFmpeg 的桌面图片/视频裁切工具。素材在本机处理，不上传服务器。

## 当前能力

- 图片和视频的自由裁切、固定比例裁切与批量导出。
- 视频时间范围选择、代理预览和导出进度显示。
- 视频黑边多点自动检测：默认在导入后检测，也可单独“检测当前”或“检测全部”。
- 每个视频独立保存检测结果；稳定结果自动应用，动态画幅或低置信度结果提示人工确认。
- 识别视频旋转元数据，裁切框统一使用 FFmpeg 自动旋转后的显示坐标。

## 本地运行

```bash
npm install
npm run tauri dev
```

只验证前端构建：

```bash
npm run build
```

运行 Rust 测试：

```bash
cd src-tauri
cargo test
```

## 黑边检测说明

检测会在所选输出片段的多个时间点采样，并综合 FFmpeg `cropdetect` 的结果。只有多数采样结果稳定一致时才会自动更新裁切框；检测到画幅变化时会保留当前裁切区域并标记“需确认”。修改视频输出时间范围后，需要重新检测。

当前仓库只包含 Apple Silicon macOS 使用的 FFmpeg/FFprobe sidecar。构建其他平台版本前，需要补充对应目标架构的二进制文件。
