import type { CropRect } from "./crop-geometry";

export type MediaMode = "image" | "video";

export type ProbeResult = {
  media_kind: string;
  format_name?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  rotation_degrees?: number;
  display_width?: number;
  display_height?: number;
  duration_seconds?: number;
  frame_rate?: number;
  frame_count?: number;
  bit_rate?: number;
  raw: unknown;
};

export type ExportResult = {
  output_path: string;
  applied_filter: string;
  stderr: string;
};

export type PreviewDataUrlResult = {
  dataUrl: string;
};

export type PreviewVideoAssetResult = {
  filePath: string;
  temporary: boolean;
};

export type ExportProgressEvent = {
  phase: "start" | "running" | "completed" | "error";
  percent: number;
  currentSeconds?: number;
  totalSeconds?: number;
  message?: string;
};

export type BlackBorderDetectionStatus =
  | "not_run"
  | "detecting"
  | "detected"
  | "no_border"
  | "needs_review"
  | "failed";

export type BlackBorderMargins = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type BlackBorderDetectionResult = {
  status: Exclude<BlackBorderDetectionStatus, "not_run" | "detecting">;
  rect?: CropRect;
  margins: BlackBorderMargins;
  confidence: number;
  sampleCount: number;
  agreeingSamples: number;
  warning?: string;
};

export type BlackBorderDetectionState = {
  status: BlackBorderDetectionStatus;
  margins: BlackBorderMargins;
  confidence: number | null;
  sampleCount: number;
  agreeingSamples: number;
  warning: string;
  manuallyAdjusted: boolean;
  skipDetection: boolean;
  resultApplied: boolean;
  detectedRect: CropRect | null;
  cropBeforeDetection: {
    ratio: string;
    anchor: string;
    scale: number;
    rect: CropRect | null;
  } | null;
};

export type ItemSettings = {
  ratio: string;
  anchor: string;
  scale: number;
  rect: CropRect | null;
  imageFormat: string;
  imageQuality: number;
  videoStartSeconds: number;
  videoDurationSeconds: number;
};

export type ExportRequest = {
  taskId?: string;
  inputPath: string;
  outputPath: string;
  avoidOverwrite?: boolean;
  mode: MediaMode;
  ratio: string;
  anchor: string;
  scale: number;
  imageFormat?: string;
  imageQuality?: number;
  videoStartSeconds?: number;
  videoDurationSeconds?: number;
  cropRect?: CropRect;
};

export type QueueItem = {
  id: string;
  name: string;
  materialName: string;
  inputPath: string;
  outputPath: string;
  previewSrc: string;
  thumbnailSrc: string;
  nativeVideoSrc: string;
  previewAssetPath: string;
  previewAssetTemporary: boolean;
  previewSeconds: number;
  previewRevision: number;
  loadRevision: number;
  lastProbe: ProbeResult | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string;
  blackBorderDetection: BlackBorderDetectionState;
  settings: ItemSettings;
};

export type ModeContext = {
  items: QueueItem[];
  currentIndex: number;
  log: string;
  progressPercent: number;
  progressText: string;
};

export type BatchState = {
  active: boolean;
  totalItems: number;
  currentItemIndex: number;
  completedItems: number;
  outputDir: string;
};

export type AppState = {
  mode: MediaMode;
  exportBusy: boolean;
  detectionBusy: boolean;
  importBusy: boolean;
  exportingMode: MediaMode | null;
  modes: Record<MediaMode, ModeContext>;
};

export function createBlackBorderDetectionState(): BlackBorderDetectionState {
  return {
    status: "not_run",
    margins: { left: 0, top: 0, right: 0, bottom: 0 },
    confidence: null,
    sampleCount: 0,
    agreeingSamples: 0,
    warning: "",
    manuallyAdjusted: false,
    skipDetection: false,
    resultApplied: false,
    detectedRect: null,
    cropBeforeDetection: null,
  };
}

export function createItemSettings(): ItemSettings {
  return {
    ratio: "9:16",
    anchor: "center",
    scale: 1,
    rect: null,
    imageFormat: "png",
    imageQuality: 100,
    videoStartSeconds: 0,
    videoDurationSeconds: 5,
  };
}

export function createModeContext(): ModeContext {
  return {
    items: [],
    currentIndex: -1,
    log: "等待操作...",
    progressPercent: 0,
    progressText: "等待导出...",
  };
}

export function createQueueItem(mode: MediaMode, inputPath: string): QueueItem {
  const normalized = inputPath.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? `${mode}-item`;
  const materialName = name.replace(/\.[^.]+$/, "") || "素材";
  return {
    id: `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    materialName,
    inputPath,
    outputPath: "",
    previewSrc: "",
    thumbnailSrc: "",
    nativeVideoSrc: "",
    previewAssetPath: "",
    previewAssetTemporary: false,
    previewSeconds: 0,
    previewRevision: 0,
    loadRevision: 0,
    lastProbe: null,
    status: "loading",
    errorMessage: "",
    blackBorderDetection: createBlackBorderDetectionState(),
    settings: createItemSettings(),
  };
}

export function getBlackBorderDetectionCandidates(items: QueueItem[]) {
  return items.filter((item) => !item.blackBorderDetection.skipDetection);
}

export function createAppState(): AppState {
  return {
    mode: "image",
    exportBusy: false,
    detectionBusy: false,
    importBusy: false,
    exportingMode: null,
    modes: {
      image: createModeContext(),
      video: createModeContext(),
    },
  };
}

export function createBatchState(): BatchState {
  return {
    active: false,
    totalItems: 0,
    currentItemIndex: 0,
    completedItems: 0,
    outputDir: "",
  };
}

export function getProbeDisplaySize(probe: ProbeResult | null | undefined) {
  return {
    width: probe?.display_width ?? probe?.width ?? 0,
    height: probe?.display_height ?? probe?.height ?? 0,
  };
}

export function getItemSourceSize(item: QueueItem | null | undefined) {
  return getProbeDisplaySize(item?.lastProbe);
}
