# Media Cropper Desktop

基于 Tauri 2、Vanilla TypeScript、Rust 和本地 FFmpeg 的桌面图片/视频裁切工具。素材在本机处理，不上传服务器。

当前版本：`0.4.1`

## 当前能力

- 图片和视频的自由裁切、固定比例裁切与批量导出。
- 支持为每个素材单独设置导出名称，原始文件保持不变；同名素材才自动追加三位序号。
- 支持从 Finder 同时拖入图片和视频，并自动分流到各自队列；不支持和重复的文件会单独提示。
- 视频时间范围选择、代理预览和导出进度显示。
- 视频黑边多点自动检测：默认在导入后检测，也可单独“检测当前”或“检测全部”。
- 每个视频独立保存检测结果；稳定结果自动应用，动态画幅或低置信度结果提示人工确认。
- 检测黑边后切换画幅比例、锚点或缩放时，始终在去黑边后的有效画面内继续裁切。
- 识别视频旋转元数据，裁切框统一使用 FFmpeg 自动旋转后的显示坐标。
- 启动后自动检查 GitHub Releases；发现新版本时可在 App 内完成下载、签名校验、安装和重启。

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

运行前端单元测试：

```bash
npm test
```

代理视频仅对当前运行实例按需开放读取权限。移除素材、清空队列和正常退出应用时会删除对应临时文件；异常退出遗留的代理文件会在后续启动时自动清理。

## 黑边检测说明

检测会在所选输出片段的多个时间点采样，并综合 FFmpeg `bbox` 亮度边界结果。只有多数采样结果稳定一致时才会自动更新裁切框；检测到画幅变化时会保留当前裁切区域并标记“需确认”。检测成功后，该区域会成为后续比例、锚点、缩放和手动拖拽的有效边界，避免重新带回黑边。修改视频输出时间范围后，需要重新检测。

当前仓库只包含 Apple Silicon macOS 使用的 FFmpeg/FFprobe sidecar。构建其他平台版本前，需要补充对应目标架构的二进制文件。

内置 sidecar 基于 FFmpeg 8.1.2 官方源码构建，仅依赖 macOS 系统库。构建配置、源码校验值和许可证说明见 [`scripts/build-ffmpeg-macos-arm64.sh`](scripts/build-ffmpeg-macos-arm64.sh) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## macOS 发行包

生成 `.app` 和 `.dmg`：

```bash
npm run tauri -- build
```

产物默认位于：

- `src-tauri/target/release/bundle/macos/media-cropper.app`
- `src-tauri/target/release/bundle/dmg/media-cropper_0.4.1_aarch64.dmg`

当前发行包使用 ad-hoc 签名，不依赖 Apple Developer ID。首次从网络下载后，macOS 仍可能要求用户在“系统设置 → 隐私与安全性”中确认打开。

## 自动更新发布

更新签名私钥只保存在本机 `~/.tauri/media-cropper-updater.key` 和 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY` 中，不得提交到仓库。密钥密码保存在 macOS 钥匙串和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secret 中。

发布新版本时同步更新版本号和更新记录，然后创建并推送版本标签：

```bash
git tag v0.4.1
git push origin v0.4.1
```

GitHub Actions 会自动构建 Apple Silicon 的 DMG 和 Tauri 更新包，并将 `latest.json`、签名与产物发布到 GitHub Releases。已安装 `0.4.0` 或更高版本的用户会在下次启动时收到更新提示。
