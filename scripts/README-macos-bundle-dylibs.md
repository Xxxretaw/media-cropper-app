# macOS 动态 FFmpeg 打包回退方案

`macos-bundle-dylibs.sh` 是动态 Homebrew sidecar 的可选回退，只处理已经由 Tauri 生成的
`.app`。当构建输入中的 FFmpeg/FFprobe 来自 Homebrew 动态构建时，原始二进制会直接引用
`/opt/homebrew/...`；如果不做后处理，未安装同一组 Homebrew 包的 Mac 无法运行视频功能。
若正式打包流程已经换成经过验证的全静态 FFmpeg/FFprobe，则无需调用本脚本。

脚本会执行以下操作：

1. 从 `Contents/MacOS/ffmpeg*` 和 `ffprobe*` 开始递归解析 Mach-O 依赖。
2. 将所有非 macOS 系统动态库复制到 `Contents/Frameworks`。
3. 将 sidecar 的依赖改为 `@executable_path/../Frameworks/...`，将动态库之间的依赖及
   动态库 ID 改为 `@loader_path/...`。
4. 删除非系统绝对 `LC_RPATH`，并拒绝同名但内容来源不同的动态库，避免生成含糊的包。
5. 按“动态库、可执行文件、整个 app”的顺序重新签名。
6. 静态检查完整依赖图，在干净环境中实际运行 FFmpeg/FFprobe，并验证运行时没有加载
   `/opt/homebrew` 中的库。

## 使用方式

先生成 macOS app（只生成 app，避免先生成一个尚未处理的 DMG）：

```bash
npm run tauri build -- --bundles app
```

保留 Tauri 原始产物并生成一个新副本：

```bash
scripts/macos-bundle-dylibs.sh \
  --output src-tauri/target/release/bundle/macos/media-cropper-portable.app \
  src-tauri/target/release/bundle/macos/media-cropper.app
```

`--output` 目标必须不存在。这是为了避免脚本静默覆盖已有发布物。如果不传
`--output`，脚本会直接修改输入 app。

## 签名

没有配置签名身份时，脚本使用 ad-hoc 签名。这适用于本机测试，但不适合作为面向普通用户
的正式分发签名：

```bash
scripts/macos-bundle-dylibs.sh /path/to/media-cropper.app
```

正式发布时，通过 Tauri 已使用的 `APPLE_SIGNING_IDENTITY`，或优先级更高的
`MACOS_CODESIGN_IDENTITY`，传入 `Developer ID Application` 身份：

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: Company Name (TEAMID)'
export MACOS_CODESIGN_ENTITLEMENTS='/absolute/path/to/entitlements.plist' # 可选

scripts/macos-bundle-dylibs.sh /path/to/media-cropper.app
```

也可以使用 `--identity` 和 `--entitlements` 显式覆盖环境变量。使用真实签名身份时，脚本会
启用 hardened runtime 和可信时间戳；ad-hoc 签名不会请求时间戳。

## 发布边界

- 该脚本解决动态库可移植性和代码签名顺序，不替代 Apple 公证。对外发布仍应执行
  `notarytool submit --wait` 和 `stapler staple`，再制作最终 DMG/ZIP。
- 脚本只能复制构建机当前存在的依赖，因此运行前不能卸载/升级掉生成 FFmpeg sidecar 时所用
  的 Homebrew 版本。若依赖路径已经失效，脚本会立即报错。
- 当前仓库的 sidecar 是 Apple Silicon (`arm64`) 版本；生成 Intel 或 Universal 版本需要先
  提供对应架构的 FFmpeg/FFprobe 及依赖库。
- Homebrew FFmpeg 可能链接 GPL 或其他许可证约束的编解码库。正式分发前需确认 FFmpeg 和
  所有随包动态库的许可证、源码提供与署名义务。

## 验证结果的含义

成功时脚本会明确输出：

- 收集的动态库数量和 `Contents/Frameworks` 大小；
- Mach-O load command 中不存在 `/opt/homebrew`；
- FFmpeg/FFprobe 的实际运行没有从 `/opt/homebrew` 加载动态库；
- `codesign --verify --deep --strict` 通过。

ad-hoc 签名即使通过上述验证，也不会通过面向互联网下载应用的 Gatekeeper 身份校验。这需要
有效的 `Developer ID Application` 签名和 Apple 公证。

## 当前 0.2.0 实测

2026-07-10 使用仓库现有的 Apple Silicon `0.2.0` app 从原始 Tauri 产物完整执行了一次
`--output` 后处理，并对结果再次原地执行以验证幂等性。两次均通过。当前依赖集合的结果为：

- `Contents/Frameworks` 收集 17 个动态库，约 36 MB；
- FFmpeg 和 FFprobe 在仅保留 `/usr/bin:/bin` 的环境中成功运行；
- `DYLD_PRINT_LIBRARIES=1` 未观察到 `/opt/homebrew` 运行时加载；
- app 全部 Mach-O load command 不含 `/opt/homebrew`；
- ad-hoc 签名下的 `codesign --verify --deep --strict` 通过。

动态库数量和体积取决于 FFmpeg 的构建选项。升级 FFmpeg 或 Homebrew 依赖后应以脚本当次输出为准，
不能把 17 个视为固定清单。
