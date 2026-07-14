# Third-party notices

## FFmpeg and FFprobe 8.1.1

This application distributes the FFmpeg and FFprobe command-line programs and invokes them as separate local processes for media inspection and conversion.

- Project: [FFmpeg](https://ffmpeg.org/)
- Version: 8.1.1
- Copyright: FFmpeg project contributors
- License: GNU Lesser General Public License, version 2.1 or later
- Corresponding source: [ffmpeg-8.1.1.tar.xz](https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz)
- Source SHA-256: `b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3`
- Reproducible build instructions: [`scripts/build-ffmpeg-macos-arm64.sh`](scripts/build-ffmpeg-macos-arm64.sh)

The distributed Apple Silicon binaries are built from the unmodified FFmpeg 8.1.1 release source with FFmpeg libraries linked statically into the two command-line programs. Their remaining dynamic dependencies are macOS system libraries and frameworks. The build does not enable GPL, nonfree, or third-party Homebrew codec libraries.

FFmpeg's `cropdetect` filter is GPL-licensed and is intentionally not included. This application uses FFmpeg's LGPL-licensed `bbox` filter for black-border analysis.

The complete LGPL text and FFmpeg's upstream license notice are copied from the source release into the binary package by the reproducible build script. When distributing the application, keep this notice and those license files with the application, and make the exact FFmpeg source archive available from the same release or download location.

This software is based in part on the work of the Independent JPEG Group. No changes were made to the Independent JPEG Group-derived files in the FFmpeg 8.1.1 source release.
