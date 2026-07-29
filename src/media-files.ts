import type { MediaMode } from "./media-model";

export const MEDIA_EXTENSIONS: Record<MediaMode, readonly string[]> = {
  image: ["jpg", "jpeg", "png", "bmp", "tif", "tiff"],
  video: ["mp4", "mov", "m4v", "mkv", "avi"],
};

export const ALL_MEDIA_EXTENSIONS = [
  ...MEDIA_EXTENSIONS.image,
  ...MEDIA_EXTENSIONS.video,
];

export type RoutedMediaFile = {
  mode: MediaMode;
  path: string;
};

export type MediaRouteResult = {
  accepted: RoutedMediaFile[];
  unsupported: string[];
  duplicates: string[];
};

export function getFileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? "output";
}

export function getFileStem(filePath: string) {
  return getFileName(filePath).replace(/\.[^.]+$/, "") || "output";
}

export function mediaModeFromPath(filePath: string): MediaMode | null {
  const fileName = getFileName(filePath);
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : "";
  if (extension && MEDIA_EXTENSIONS.image.includes(extension)) {
    return "image";
  }
  if (extension && MEDIA_EXTENSIONS.video.includes(extension)) {
    return "video";
  }
  return null;
}

export function routeMediaPaths(
  paths: readonly string[],
  existingPaths: ReadonlySet<string> = new Set(),
): MediaRouteResult {
  const accepted: RoutedMediaFile[] = [];
  const unsupported: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set(existingPaths);

  for (const path of paths) {
    if (seen.has(path)) {
      duplicates.push(path);
      continue;
    }

    const mode = mediaModeFromPath(path);
    if (!mode) {
      unsupported.push(path);
      continue;
    }

    seen.add(path);
    accepted.push({ mode, path });
  }

  return { accepted, unsupported, duplicates };
}
