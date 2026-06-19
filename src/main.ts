import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

type MediaMode = "image" | "video";
type HandleMode = "move" | "nw" | "ne" | "sw" | "se";

type ProbeResult = {
  media_kind: string;
  format_name?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  bit_rate?: number;
  raw: unknown;
};

type ExportResult = {
  output_path: string;
  applied_filter: string;
  stderr: string;
};

type PreviewDataUrlResult = {
  dataUrl: string;
};

type PreviewVideoAssetResult = {
  filePath: string;
};

type ExportProgressEvent = {
  phase: "start" | "running" | "completed" | "error";
  percent: number;
  currentSeconds?: number;
  totalSeconds?: number;
  message?: string;
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ItemSettings = {
  ratio: string;
  anchor: string;
  scale: number;
  rect: CropRect | null;
  imageFormat: string;
  imageQuality: number;
  videoStartSeconds: number;
  videoDurationSeconds: number;
};

type ExportRequest = {
  inputPath: string;
  outputPath: string;
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

type QueueItem = {
  id: string;
  name: string;
  inputPath: string;
  outputPath: string;
  previewSrc: string;
  nativeVideoSrc: string;
  previewSeconds: number;
  lastProbe: ProbeResult | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string;
  settings: ItemSettings;
};

type ModeContext = {
  items: QueueItem[];
  currentIndex: number;
  log: string;
  progressPercent: number;
  progressText: string;
  loadToken: number;
};

type BatchState = {
  active: boolean;
  totalItems: number;
  currentItemIndex: number;
  completedItems: number;
  outputDir: string;
};

const state: {
  mode: MediaMode;
  exportBusy: boolean;
  exportingMode: MediaMode | null;
  previewRequestId: number;
  modes: Record<MediaMode, ModeContext>;
} = {
  mode: "image",
  exportBusy: false,
  exportingMode: null,
  previewRequestId: 0,
  modes: {
    image: createModeContext(),
    video: createModeContext(),
  },
};

const batchState: BatchState = {
  active: false,
  totalItems: 0,
  currentItemIndex: 0,
  completedItems: 0,
  outputDir: "",
};

const modeTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-tab"));
const pickInputButton = document.querySelector<HTMLButtonElement>("#pick-input-button");
const pickInputSecondaryButton = document.querySelector<HTMLButtonElement>("#pick-input-secondary");
const exportButton = document.querySelector<HTMLButtonElement>("#export-button");
const mediaSummaryEl = document.querySelector<HTMLElement>("#media-summary");
const logOutputEl = document.querySelector<HTMLElement>("#log-output");

const listCountEl = document.querySelector<HTMLElement>("#list-count");
const thumbsEl = document.querySelector<HTMLElement>("#thumbs");
const ratioButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".ratio-pill"));
const anchorButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".anchor-btn"));
const ratioSelect = document.querySelector<HTMLSelectElement>("#ratio");
const customRatioWidthInput = document.querySelector<HTMLInputElement>("#custom-ratio-width");
const customRatioHeightInput = document.querySelector<HTMLInputElement>("#custom-ratio-height");
const applyCustomRatioButton = document.querySelector<HTMLButtonElement>("#apply-custom-ratio");
const customRatioOption = document.querySelector<HTMLOptionElement>("#custom-ratio-option");
const anchorSelect = document.querySelector<HTMLSelectElement>("#anchor");
const scaleInput = document.querySelector<HTMLInputElement>("#scale");
const scaleValueEl = document.querySelector<HTMLElement>("#scale-value");
const imageSettingsEl = document.querySelector<HTMLElement>("#image-settings");
const videoSettingsEl = document.querySelector<HTMLElement>("#video-settings");
const imageFormatSelect = document.querySelector<HTMLSelectElement>("#image-format");
const videoRangeSummaryEl = document.querySelector<HTMLElement>("#video-range-summary");
const previewEmptyEl = document.querySelector<HTMLElement>("#preview-empty");
const dropTitleEl = document.querySelector<HTMLElement>("#drop-title");
const mediaWrapEl = document.querySelector<HTMLElement>("#media-wrap");
const mediaBoxEl = document.querySelector<HTMLElement>("#media-box");
const previewImageEl = document.querySelector<HTMLImageElement>("#preview-image");
const previewVideoEl = document.querySelector<HTMLVideoElement>("#preview-video");
const cropBoxEl = document.querySelector<HTMLElement>("#crop-box");
const videoTimelineEl = document.querySelector<HTMLElement>("#video-timeline");
const videoPreviewSeekEl = document.querySelector<HTMLInputElement>("#video-preview-seek");
const videoPreviewTimeEl = document.querySelector<HTMLElement>("#video-preview-time");
const videoPreviewToggleEl = document.querySelector<HTMLButtonElement>("#video-preview-toggle");
const videoExportStartEl = document.querySelector<HTMLInputElement>("#video-export-start");
const videoExportEndEl = document.querySelector<HTMLInputElement>("#video-export-end");
const videoExportFillEl = document.querySelector<HTMLElement>("#video-export-fill");
const videoExportStartTimeEl = document.querySelector<HTMLElement>("#video-export-start-time");
const videoExportEndTimeEl = document.querySelector<HTMLElement>("#video-export-end-time");
const progressFillEl = document.querySelector<HTMLElement>("#progress-fill");
const progressPercentEl = document.querySelector<HTMLElement>("#progress-percent");
const progressTextEl = document.querySelector<HTMLElement>("#progress-text");
const applyCurrentToAllButton = document.querySelector<HTMLButtonElement>("#apply-current-to-all");
const clearQueueButton = document.querySelector<HTMLButtonElement>("#clear-queue-button");
const batchExportButton = document.querySelector<HTMLButtonElement>("#batch-export-button");
const panelShellEl = document.querySelector<HTMLElement>("#panel-shell");
const cropDimsEl = document.querySelector<HTMLElement>("#crop-dims");
const themeToggleEl = document.querySelector<HTMLButtonElement>("#theme-toggle");
let videoPreviewTimer: number | null = null;
let videoPlaybackTimer: number | null = null;
let videoPreviewPlaying = false;
const MIN_VIDEO_SEGMENT_SECONDS = 0.5;

function createItemSettings(): ItemSettings {
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

function createModeContext(): ModeContext {
  return {
    items: [],
    currentIndex: -1,
    log: "等待操作...",
    progressPercent: 0,
    progressText: "等待导出...",
    loadToken: 0,
  };
}

function currentContext(mode = state.mode) {
  return state.modes[mode];
}

function currentItem(mode = state.mode) {
  const context = currentContext(mode);
  return context.items[context.currentIndex] ?? null;
}

function getRenderedSourceSize(mode = state.mode) {
  const item = currentItem(mode);
  if (!item) {
    return { width: 0, height: 0 };
  }

  if (mode === state.mode) {
    if (usingNativeVideoPreview(item) && previewVideoEl && !previewVideoEl.classList.contains("hide")) {
      return {
        width: previewVideoEl.videoWidth || item.lastProbe?.width || 0,
        height: previewVideoEl.videoHeight || item.lastProbe?.height || 0,
      };
    }

    if (item.previewSrc && previewImageEl && !previewImageEl.classList.contains("hide")) {
      return {
        width: previewImageEl.naturalWidth || item.lastProbe?.width || 0,
        height: previewImageEl.naturalHeight || item.lastProbe?.height || 0,
      };
    }
  }

  return {
    width: item.lastProbe?.width ?? 0,
    height: item.lastProbe?.height ?? 0,
  };
}

function getSourceWidth(mode = state.mode) {
  return getRenderedSourceSize(mode).width;
}

function getSourceHeight(mode = state.mode) {
  return getRenderedSourceSize(mode).height;
}

function getMediaExtensions(mode: MediaMode) {
  return mode === "image"
    ? ["jpg", "jpeg", "png", "bmp", "tif", "tiff"]
    : ["mp4", "mov", "m4v", "mkv", "avi"];
}

function getSelectedScale() {
  return Number(scaleInput?.value ?? 100) / 100;
}

function getSelectedImageQuality() {
  return 100;
}

function getSelectedAnchor() {
  return anchorSelect?.value ?? "center";
}

function getSelectedRatio() {
  return ratioSelect?.value ?? "9:16";
}

function getImageFormatExtension() {
  return imageFormatSelect?.value ?? "png";
}

function getFileStem(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? "output";
  return fileName.replace(/\.[^.]+$/, "") || "output";
}

function setLog(message: string) {
  currentContext().log = message;
  if (logOutputEl) {
    logOutputEl.textContent = message;
  }
}

function setMediaSummary(message: string) {
  if (mediaSummaryEl) {
    mediaSummaryEl.textContent = message;
  }
}

function setProgress(percent: number, text: string) {
  const context = currentContext();
  const safePercent = Math.max(0, Math.min(100, percent));
  context.progressPercent = safePercent;
  context.progressText = text;
  if (progressFillEl) {
    progressFillEl.style.width = `${safePercent}%`;
  }
  if (progressPercentEl) {
    progressPercentEl.textContent = `${Math.round(safePercent)}%`;
  }
  if (progressTextEl) {
    progressTextEl.textContent = text;
  }
}

function setButtonsDisabledState() {
  const hasCurrent = Boolean(currentItem());
  const disabled = !hasCurrent || state.exportBusy;
  if (exportButton) {
    exportButton.disabled = disabled;
  }
  if (pickInputButton) {
    pickInputButton.disabled = state.exportBusy;
  }
  if (applyCurrentToAllButton) {
    applyCurrentToAllButton.disabled = !hasCurrent || state.exportBusy;
  }
  if (clearQueueButton) {
    clearQueueButton.disabled = currentContext().items.length === 0 || state.exportBusy;
  }
  if (batchExportButton) {
    batchExportButton.disabled = currentContext().items.length === 0 || state.exportBusy;
  }
  if (applyCustomRatioButton) {
    applyCustomRatioButton.disabled = !hasCurrent || state.exportBusy;
  }
}

function formatClock(seconds?: number) {
  if (!seconds || Number.isNaN(seconds) || seconds < 0) {
    return "00:00";
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remain = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
}

function currentMediaEl() {
  if (previewVideoEl && !previewVideoEl.classList.contains("hide")) {
    return previewVideoEl;
  }
  return previewImageEl;
}

function shouldResetRectForRenderedSource(item = currentItem()) {
  if (!item?.lastProbe) {
    return false;
  }
  const rendered = getRenderedSourceSize();
  if (!rendered.width || !rendered.height) {
    return false;
  }
  return rendered.width !== (item.lastProbe.width ?? 0) || rendered.height !== (item.lastProbe.height ?? 0);
}

function resetPreviewLayout() {
  mediaBoxEl?.style.removeProperty("width");
  mediaBoxEl?.style.removeProperty("height");
}

function updateModeUi() {
  const isImage = state.mode === "image";
  modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === state.mode);
  });
  if (pickInputButton) {
    pickInputButton.textContent = isImage ? "添加图片" : "添加视频";
  }
  if (pickInputSecondaryButton) {
    pickInputSecondaryButton.textContent = isImage ? "选择图片" : "选择视频";
  }
  if (exportButton) {
    exportButton.textContent = isImage ? "导出当前图片" : "导出当前视频";
  }
  imageSettingsEl?.classList.toggle("hide", !isImage);
  videoSettingsEl?.classList.toggle("hide", isImage);
  if (dropTitleEl && !currentItem()) {
    dropTitleEl.textContent = isImage ? "拖入图片" : "拖入视频";
  }
}

function updateScaleLabel() {
  const item = currentItem();
  if (scaleValueEl) {
    scaleValueEl.textContent = `${Math.round((item?.settings.scale ?? 1) * 100)}%`;
  }
}

function syncRatioButtons() {
  const currentRatio = ratioSelect?.value ?? "9:16";
  ratioButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.ratio === currentRatio);
  });

  if (!currentRatio.includes(":") || currentRatio === "free") {
    if (customRatioWidthInput) {
      customRatioWidthInput.value = "";
    }
    if (customRatioHeightInput) {
      customRatioHeightInput.value = "";
    }
    return;
  }

  const builtIn = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  if (!builtIn.has(currentRatio)) {
    const [width, height] = currentRatio.split(":");
    if (customRatioWidthInput) {
      customRatioWidthInput.value = width ?? "";
    }
    if (customRatioHeightInput) {
      customRatioHeightInput.value = height ?? "";
    }
  }
}

function syncAnchorButtons() {
  const currentAnchor = anchorSelect?.value ?? "center";
  anchorButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.anchor === currentAnchor);
  });
}

function syncControlsFromState() {
  const item = currentItem();
  if (ratioSelect) {
    ratioSelect.value = item?.settings.ratio ?? "9:16";
  }
  if (anchorSelect) {
    anchorSelect.value = item?.settings.anchor ?? "center";
  }
  if (scaleInput) {
    scaleInput.value = String(Math.round((item?.settings.scale ?? 1) * 100));
  }
  if (imageFormatSelect) {
    imageFormatSelect.value = item?.settings.imageFormat ?? "png";
  }
  updateScaleLabel();
  syncRatioButtons();
  syncAnchorButtons();
}

function getVideoSegmentEnd(item: QueueItem) {
  const duration = item.lastProbe?.duration_seconds ?? 0;
  return Math.min(duration, item.settings.videoStartSeconds + item.settings.videoDurationSeconds);
}

function canUseNativeVideoPreview(item: QueueItem) {
  return item.lastProbe?.media_kind === "video";
}

function usingNativeVideoPreview(item = currentItem()) {
  return Boolean(item?.nativeVideoSrc && state.mode === "video");
}

function updateVideoExportRangeUi() {
  const item = currentItem();
  const isVideo = state.mode === "video" && item?.lastProbe?.media_kind === "video";
  if (!isVideo || !item) {
    if (videoExportStartTimeEl) {
      videoExportStartTimeEl.textContent = "00:00";
    }
    if (videoExportEndTimeEl) {
      videoExportEndTimeEl.textContent = "00:00";
    }
    if (videoRangeSummaryEl) {
      videoRangeSummaryEl.textContent = "请在中间时间轴选择";
    }
    if (videoExportFillEl) {
      videoExportFillEl.style.left = "0%";
      videoExportFillEl.style.width = "0%";
    }
    return;
  }

  const duration = item.lastProbe?.duration_seconds ?? 0;
  const start = Math.max(0, Math.min(item.settings.videoStartSeconds, duration));
  const end = Math.max(start, getVideoSegmentEnd(item));
  const totalSteps = Math.max(1, Math.round(duration * 10));
  const startSteps = Math.round(start * 10);
  const endSteps = Math.round(end * 10);

  if (videoExportStartEl) {
    videoExportStartEl.max = String(totalSteps);
    videoExportStartEl.value = String(startSteps);
  }
  if (videoExportEndEl) {
    videoExportEndEl.max = String(totalSteps);
    videoExportEndEl.value = String(endSteps);
  }
  if (videoExportStartTimeEl) {
    videoExportStartTimeEl.textContent = formatClock(start);
  }
  if (videoExportEndTimeEl) {
    videoExportEndTimeEl.textContent = formatClock(end);
  }
  if (videoRangeSummaryEl) {
    videoRangeSummaryEl.textContent = `${formatClock(start)} - ${formatClock(end)} · ${formatClock(end - start)}`;
  }
  if (videoExportFillEl) {
    const leftPercent = duration > 0 ? (start / duration) * 100 : 0;
    const widthPercent = duration > 0 ? ((end - start) / duration) * 100 : 0;
    videoExportFillEl.style.left = `${leftPercent}%`;
    videoExportFillEl.style.width = `${Math.max(0, widthPercent)}%`;
  }
}

function updateCropDims() {
  if (!cropDimsEl) return;
  const item = currentItem();
  if (!item?.lastProbe) {
    cropDimsEl.textContent = "";
    return;
  }
  const sourceW = item.lastProbe.width ?? 0;
  const sourceH = item.lastProbe.height ?? 0;
  if (sourceW === 0 || sourceH === 0) {
    cropDimsEl.textContent = "";
    return;
  }
  const rect = item.settings.rect;
  if (!rect) {
    cropDimsEl.textContent = "";
    return;
  }
  const cropW = Math.round(rect.width);
  const cropH = Math.round(rect.height);
  cropDimsEl.textContent = `${sourceW}\u00d7${sourceH} \u2192 ${cropW}\u00d7${cropH}`;
}

function updateVideoTimelineUi() {
  const item = currentItem();
  const isVideo = state.mode === "video" && item?.lastProbe?.media_kind === "video";
  videoTimelineEl?.classList.toggle("hide", !isVideo);
  if (!isVideo || !item) {
    if (videoPreviewTimeEl) {
      videoPreviewTimeEl.textContent = "00:00 / 00:00";
    }
    if (videoPreviewToggleEl) {
      videoPreviewToggleEl.textContent = "▶";
    }
    stopVideoPlayback();
    updateVideoExportRangeUi();
    return;
  }
  const duration = item.lastProbe?.duration_seconds ?? 0;
  const current = Math.min(item.previewSeconds ?? 0, Math.max(0, duration));
  if (videoPreviewSeekEl) {
    videoPreviewSeekEl.max = String(Math.max(1, Math.round(duration * 10)));
    videoPreviewSeekEl.value = String(Math.round(current * 10));
  }
  if (videoPreviewTimeEl) {
    videoPreviewTimeEl.textContent = `${formatClock(current)} / ${formatClock(duration)}`;
  }
  if (videoPreviewToggleEl) {
    videoPreviewToggleEl.textContent = videoPreviewPlaying ? "❚❚" : "▶";
  }
  updateVideoExportRangeUi();
}

function cancelScheduledVideoPreview() {
  if (videoPreviewTimer !== null) {
    window.clearTimeout(videoPreviewTimer);
    videoPreviewTimer = null;
  }
}

function stopVideoPlayback() {
  if (usingNativeVideoPreview() && previewVideoEl) {
    previewVideoEl.pause();
  }
  if (videoPlaybackTimer !== null) {
    window.clearInterval(videoPlaybackTimer);
    videoPlaybackTimer = null;
  }
  videoPreviewPlaying = false;
  if (videoPreviewToggleEl) {
    videoPreviewToggleEl.textContent = "▶";
  }
}

function startVideoPlayback() {
  const item = currentItem();
  const duration = item?.lastProbe?.duration_seconds ?? 0;
  if (!item || state.mode !== "video" || duration <= 0) {
    stopVideoPlayback();
    return;
  }

  if (usingNativeVideoPreview(item) && previewVideoEl) {
    void previewVideoEl.play().catch((error) => {
      setLog(`视频播放失败：${String(error)}`);
    });
    return;
  }

  stopVideoPlayback();
  videoPreviewPlaying = true;
  updateVideoTimelineUi();

  const stepSeconds = 0.25;
  videoPlaybackTimer = window.setInterval(() => {
    const activeItem = currentItem();
    if (!activeItem || state.mode !== "video") {
      stopVideoPlayback();
      return;
    }
    const total = activeItem.lastProbe?.duration_seconds ?? 0;
    const nextSeconds = Math.min((activeItem.previewSeconds ?? 0) + stepSeconds, total);
    activeItem.previewSeconds = nextSeconds;
    updateVideoTimelineUi();
    void requestPreviewFrame("video", activeItem.previewSeconds);

    if (nextSeconds >= total) {
      stopVideoPlayback();
      updateVideoTimelineUi();
    }
  }, 280);
}

function scheduleVideoPreviewRefresh(delay = 140) {
  cancelScheduledVideoPreview();
  videoPreviewTimer = window.setTimeout(() => {
    videoPreviewTimer = null;
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    void requestPreviewFrame("video", item.previewSeconds);
  }, delay);
}

function clearPreviewDom() {
  cancelScheduledVideoPreview();
  stopVideoPlayback();
  resetPreviewLayout();
  previewImageEl?.classList.add("hide");
  previewVideoEl?.classList.add("hide");
  if (previewImageEl) {
    previewImageEl.removeAttribute("src");
  }
  if (previewVideoEl) {
    previewVideoEl.pause();
    previewVideoEl.removeAttribute("src");
    previewVideoEl.load();
  }
  mediaWrapEl?.classList.add("hide");
  previewEmptyEl?.classList.remove("hide");
  cropBoxEl?.classList.add("hide");
}

async function requestPreviewFrame(mode = state.mode, previewSeconds?: number) {
  const context = currentContext(mode);
  const item = currentItem(mode);
  if (!item?.inputPath) {
    return;
  }

  state.previewRequestId += 1;
  const requestId = state.previewRequestId;
  item.status = "loading";
  if (typeof previewSeconds === "number") {
    item.previewSeconds = Math.max(0, previewSeconds);
  }
  if (mode === state.mode) {
    updatePreviewVisibility();
    updateVideoTimelineUi();
  }

  try {
    const preview = await invoke<PreviewDataUrlResult>("build_preview_data_url", {
      inputPath: item.inputPath,
      previewTimeSeconds: mode === "video" ? item.previewSeconds : undefined,
    });
    if (requestId !== state.previewRequestId || currentContext(mode) !== context) {
      return;
    }
    item.previewSrc = preview.dataUrl;
    item.status = "ready";
    item.errorMessage = "";
    if (mode === state.mode) {
      applyPreviewSource();
      renderThumbs();
      drawCropBox();
      updateVideoTimelineUi();
    }
  } catch (error) {
    if (requestId !== state.previewRequestId) {
      return;
    }
    item.status = "error";
    item.errorMessage = String(error);
    item.previewSrc = "";
    if (mode === state.mode) {
      updatePreviewVisibility();
      setLog(`预览帧生成失败：${String(error)}`);
    }
  }
}

function createQueueItem(mode: MediaMode, inputPath: string): QueueItem {
  const normalized = inputPath.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? `${mode}-item`;
  return {
    id: `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    inputPath,
    outputPath: "",
    previewSrc: "",
    nativeVideoSrc: "",
    previewSeconds: 0,
    lastProbe: null,
    status: "loading",
    errorMessage: "",
    settings: createItemSettings(),
  };
}

function listLabel(mode = state.mode) {
  return mode === "image" ? "图片" : "视频";
}

function selectItem(index: number, mode = state.mode) {
  const context = currentContext(mode);
  if (index < 0 || index >= context.items.length) {
    context.currentIndex = -1;
    return;
  }
  context.currentIndex = index;
}

function removeItem(index: number, mode = state.mode) {
  const context = currentContext(mode);
  context.items.splice(index, 1);
  if (context.currentIndex >= context.items.length) {
    context.currentIndex = context.items.length - 1;
  }
  if (context.items.length === 0) {
    context.currentIndex = -1;
    context.progressPercent = 0;
    context.progressText = "等待导出...";
    context.log = "等待操作...";
  }
}

function renderThumbs() {
  const context = currentContext();
  if (!thumbsEl) {
    return;
  }
  thumbsEl.innerHTML = "";

  context.items.forEach((item, index) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = `thumb${index === context.currentIndex ? " active" : ""}`;

    const media =
      item.previewSrc
        ? `<img src="${item.previewSrc}" alt="">`
        : `<div class="thumb-fallback">${state.mode === "image" ? "IMG" : "VID"}</div>`;
    const ratio = item.settings.ratio === "free" ? "自由" : item.settings.ratio;
    const detail = item.lastProbe
      ? `${item.lastProbe.width ?? "-"}×${item.lastProbe.height ?? "-"}${item.lastProbe.duration_seconds ? ` · ${item.lastProbe.duration_seconds.toFixed(2)}s` : ""}`
      : item.status === "error"
        ? "读取失败"
        : "加载中...";

    thumb.innerHTML = `
      ${media}
      <div class="thumb-meta">
        <div class="thumb-name">${item.name}</div>
        <div class="thumb-info">${detail}</div>
        <div class="thumb-ratio">${ratio}</div>
      </div>
      <span class="thumb-delete" data-delete="true">×</span>
    `;

    thumb.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.dataset.delete === "true") {
        removeItem(index);
        renderCurrentContext();
        return;
      }
      selectItem(index);
      renderCurrentContext();
    });

    thumbsEl.appendChild(thumb);
  });

  if (listCountEl) {
    listCountEl.textContent = `${listLabel()} ${context.items.length}`;
  }
}

function ratioValue(mode = state.mode, ratio = currentItem(mode)?.settings.ratio ?? "9:16") {
  if (ratio === "free") {
    return null;
  }
  const [width, height] = ratio.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function maxFit(width: number, height: number, ratio: number) {
  const currentRatio = width / height;
  if (currentRatio > ratio) {
    return { width: height * ratio, height };
  }
  return { width, height: width / ratio };
}

function clampRect(mode = state.mode) {
  const item = currentItem(mode);
  const rect = item?.settings.rect;
  const sourceWidth = getSourceWidth(mode);
  const sourceHeight = getSourceHeight(mode);
  if (!rect || sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }
  rect.width = Math.max(2, Math.min(rect.width, sourceWidth));
  rect.height = Math.max(2, Math.min(rect.height, sourceHeight));
  rect.x = Math.max(0, Math.min(sourceWidth - rect.width, rect.x));
  rect.y = Math.max(0, Math.min(sourceHeight - rect.height, rect.y));
}

function positionRectByAnchor(mode = state.mode) {
  const item = currentItem(mode);
  const rect = item?.settings.rect;
  if (!rect) {
    return;
  }
  const sourceWidth = getSourceWidth(mode);
  const sourceHeight = getSourceHeight(mode);
  const anchor = item?.settings.anchor ?? "center";

  if (["lt", "left", "lb"].includes(anchor)) {
    rect.x = 0;
  } else if (["rt", "right", "rb"].includes(anchor)) {
    rect.x = sourceWidth - rect.width;
  } else {
    rect.x = (sourceWidth - rect.width) / 2;
  }

  if (["lt", "top", "rt"].includes(anchor)) {
    rect.y = 0;
  } else if (["lb", "bottom", "rb"].includes(anchor)) {
    rect.y = sourceHeight - rect.height;
  } else {
    rect.y = (sourceHeight - rect.height) / 2;
  }

  clampRect(mode);
}

function ensureRect(mode = state.mode) {
  const item = currentItem(mode);
  if (!item?.lastProbe) {
    return;
  }
  const sourceWidth = getSourceWidth(mode);
  const sourceHeight = getSourceHeight(mode);
  const ratio = ratioValue(mode);

  if (!item.settings.rect) {
    if (ratio === null) {
      item.settings.rect = {
        x: 0,
        y: 0,
        width: sourceWidth,
        height: sourceHeight,
      };
    } else {
      const fitted = maxFit(sourceWidth, sourceHeight, ratio);
      item.settings.rect = {
        x: 0,
        y: 0,
        width: fitted.width * item.settings.scale,
        height: fitted.height * item.settings.scale,
      };
      positionRectByAnchor(mode);
    }
  }

  clampRect(mode);
}

function resizeRectByScale(mode = state.mode) {
  const item = currentItem(mode);
  if (!item?.lastProbe) {
    return;
  }
  const ratio = ratioValue(mode);
  const rect = item.settings.rect;
  if (!rect || ratio === null) {
    return;
  }
  const fitted = maxFit(getSourceWidth(mode), getSourceHeight(mode), ratio);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  rect.width = fitted.width * item.settings.scale;
  rect.height = fitted.height * item.settings.scale;
  rect.x = centerX - rect.width / 2;
  rect.y = centerY - rect.height / 2;
  clampRect(mode);
}

function clampVideoSettings(mode = state.mode) {
  const item = currentItem(mode);
  const duration = item?.lastProbe?.duration_seconds ?? 0;
  if (duration > 0) {
    if (!item) {
      return;
    }
    const minSegment = Math.min(MIN_VIDEO_SEGMENT_SECONDS, duration);
    let start = Math.max(0, Math.min(item.settings.videoStartSeconds, Math.max(0, duration - minSegment)));
    let end = Math.max(start + minSegment, start + item.settings.videoDurationSeconds);
    end = Math.min(duration, end);

    if (end - start < minSegment) {
      if (end >= duration) {
        start = Math.max(0, duration - minSegment);
        end = duration;
      } else {
        end = Math.min(duration, start + minSegment);
      }
    }

    item.settings.videoStartSeconds = start;
    item.settings.videoDurationSeconds = Math.max(minSegment, end - start);
  }
}

function updateDurationInputs() {
  updateVideoExportRangeUi();
}

function formatDuration(seconds?: number) {
  if (!seconds || Number.isNaN(seconds)) {
    return "";
  }
  return `${seconds.toFixed(2)}s`;
}

function renderMediaSummary() {
  const item = currentItem();
  if (!item?.lastProbe) {
    setMediaSummary("");
    return;
  }

  const probe = item.lastProbe;
  const parts = [
    `${probe.width ?? "-"}×${probe.height ?? "-"}`,
    probe.codec_name ?? probe.format_name ?? "unknown",
  ];
  if (probe.duration_seconds) {
    parts.push(formatDuration(probe.duration_seconds));
  }
  setMediaSummary(parts.join(" · "));
}

function updatePreviewVisibility() {
  const item = currentItem();
  const hasPreview = Boolean(item?.previewSrc || item?.nativeVideoSrc);
  mediaWrapEl?.classList.toggle("hide", !hasPreview);
  previewEmptyEl?.classList.toggle("hide", hasPreview);
  if (dropTitleEl) {
    if (!item) {
      dropTitleEl.textContent = state.mode === "image" ? "拖入图片" : "拖入视频";
    } else if (item.status === "loading") {
      dropTitleEl.textContent = "正在生成预览...";
    } else if (item.status === "error") {
      dropTitleEl.textContent = "当前素材预览不可用";
    } else {
      dropTitleEl.textContent = item.name;
    }
  }
}

function applyPreviewSource() {
  const item = currentItem();
  if (!item?.previewSrc && !item?.nativeVideoSrc) {
    clearPreviewDom();
    return;
  }

  updatePreviewVisibility();
  if (usingNativeVideoPreview(item)) {
    previewImageEl?.classList.add("hide");
    previewVideoEl?.classList.remove("hide");
    if (previewVideoEl) {
      if (previewVideoEl.src !== item.nativeVideoSrc) {
        previewVideoEl.src = item.nativeVideoSrc;
        previewVideoEl.load();
      } else if (Math.abs(previewVideoEl.currentTime - item.previewSeconds) > 0.25) {
        previewVideoEl.currentTime = item.previewSeconds;
      }
    }
    return;
  }

  previewVideoEl?.classList.add("hide");
  previewImageEl?.classList.remove("hide");
  if (previewImageEl && previewImageEl.src !== item.previewSrc) {
    previewImageEl.src = item.previewSrc;
  }
}

function syncPreviewLayout() {
  const item = currentItem();
  if ((!item?.previewSrc && !item?.nativeVideoSrc) || !mediaWrapEl || !mediaBoxEl) {
    resetPreviewLayout();
    return;
  }

  const { width: sourceWidth, height: sourceHeight } = getRenderedSourceSize();
  const availableWidth = mediaWrapEl.clientWidth;
  const availableHeight = mediaWrapEl.clientHeight;

  if (!sourceWidth || !sourceHeight || !availableWidth || !availableHeight) {
    resetPreviewLayout();
    return;
  }

  // Keep a consistent operation gutter around the preview so larger images
  // do not visually fill the whole stage even when they still fit.
  const maxViewportUsage = 0.86;
  const reservedX = Math.min(64, availableWidth * 0.08);
  const reservedY = Math.min(64, availableHeight * 0.08);
  const targetWidth = Math.max(1, Math.min(availableWidth * maxViewportUsage, availableWidth - reservedX * 2));
  const targetHeight = Math.max(1, Math.min(availableHeight * maxViewportUsage, availableHeight - reservedY * 2));
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight, 1);
  const displayWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const displayHeight = Math.max(1, Math.floor(sourceHeight * scale));

  mediaBoxEl.style.width = `${displayWidth}px`;
  mediaBoxEl.style.height = `${displayHeight}px`;
}

function drawCropBox() {
  const item = currentItem();
  if (!cropBoxEl || !item?.lastProbe || !item.settings.rect) {
    cropBoxEl?.classList.add("hide");
    return;
  }

  const mediaEl = currentMediaEl();
  if (!mediaEl || !mediaEl.clientWidth || !mediaEl.clientHeight) {
    return;
  }

  const sourceWidth = getSourceWidth();
  const sourceHeight = getSourceHeight();
  if (!sourceWidth || !sourceHeight) {
    return;
  }

  const scaleX = mediaEl.clientWidth / sourceWidth;
  const scaleY = mediaEl.clientHeight / sourceHeight;
  const rect = item.settings.rect;

  cropBoxEl.classList.remove("hide");
  cropBoxEl.style.left = `${rect.x * scaleX}px`;
  cropBoxEl.style.top = `${rect.y * scaleY}px`;
  cropBoxEl.style.width = `${rect.width * scaleX}px`;
  cropBoxEl.style.height = `${rect.height * scaleY}px`;
  updateCropDims();
}

function getRoundedCropRect() {
  ensureRect();
  const rect = currentItem()?.settings.rect;
  if (!rect) {
    return undefined;
  }
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function syncScaleFromRect() {
  const item = currentItem();
  if (!item?.lastProbe || !item.settings.rect) {
    return;
  }
  const ratio = ratioValue();
  if (ratio === null) {
    return;
  }
  const fitted = maxFit(getSourceWidth(), getSourceHeight(), ratio);
  item.settings.scale = Math.max(0.1, Math.min(1, item.settings.rect.width / fitted.width));
  if (scaleInput) {
    scaleInput.value = String(Math.round(item.settings.scale * 100));
  }
  updateScaleLabel();
}

function renderCurrentContext() {
  const context = currentContext();
  const item = currentItem();
  if (logOutputEl) {
    logOutputEl.textContent = context.log;
  }
  syncControlsFromState();
  renderMediaSummary();
  setProgress(context.progressPercent, context.progressText);
  renderThumbs();
  updatePreviewVisibility();
  applyPreviewSource();
  syncPreviewLayout();
  setButtonsDisabledState();
  updateDurationInputs();
  updateVideoTimelineUi();
  drawCropBox();
  panelShellEl?.classList.toggle("disabled", !item);
}

async function autoProbeMedia(mode = state.mode) {
  const context = currentContext(mode);
  const item = currentItem(mode);
  if (!item?.inputPath) {
    return;
  }

  context.loadToken += 1;
  const loadToken = context.loadToken;
  context.log = "正在自动调用 ffprobe 读取媒体信息...";
  if (mode === state.mode) {
    setMediaSummary("正在自动读取媒体信息...");
    renderCurrentContext();
  }

  try {
    const result = await invoke<ProbeResult>("probe_media", {
      inputPath: item.inputPath,
    });
    if (context.loadToken !== loadToken) {
      return;
    }

    item.lastProbe = result;
    clampVideoSettings(mode);
    item.settings.rect = null;
    context.log = "媒体信息读取成功，可以直接拖拽裁剪框或调整参数。";
    ensureRect(mode);
    if (mode === "video") {
      const totalDuration = Math.max(MIN_VIDEO_SEGMENT_SECONDS, result.duration_seconds ?? item.settings.videoDurationSeconds);
      item.settings.videoStartSeconds = 0;
      item.settings.videoDurationSeconds = totalDuration;
      item.previewSeconds = 0;
      clampVideoSettings(mode);
      if (canUseNativeVideoPreview(item)) {
        try {
          const previewVideo = await invoke<PreviewVideoAssetResult>("build_preview_video_asset", {
            inputPath: item.inputPath,
          });
          if (context.loadToken !== loadToken) {
            return;
          }
          item.nativeVideoSrc = convertFileSrc(previewVideo.filePath);
          item.previewSrc = "";
          item.status = "ready";
          item.errorMessage = "";
        } catch (previewError) {
          item.nativeVideoSrc = "";
          context.log = `代理视频预览生成失败，已回退静态预览：${String(previewError)}`;
          await requestPreviewFrame(mode, item.previewSeconds);
        }
      } else {
        await requestPreviewFrame(mode, item.previewSeconds);
      }
    } else {
      item.previewSeconds = 0;
      await requestPreviewFrame(mode, item.previewSeconds);
    }
    if (mode === state.mode) {
      renderCurrentContext();
    }
  } catch (error) {
    if (context.loadToken !== loadToken) {
      return;
    }
    item.previewSrc = "";
    item.status = "error";
    item.errorMessage = String(error);
    context.log = `自动读取媒体信息失败：${String(error)}`;
    if (mode === state.mode) {
      renderCurrentContext();
      setMediaSummary("媒体信息读取失败");
    }
  }
}

async function loadInputFile(filePath: string) {
  const context = currentContext();
  const item = createQueueItem(state.mode, filePath);
  context.items.push(item);
  context.currentIndex = context.items.length - 1;
  context.progressPercent = 0;
  context.progressText = "等待导出...";
  context.log = "正在准备素材...";
  renderCurrentContext();
  await autoProbeMedia();
}

async function pickInputFile() {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: state.mode === "image" ? "Image" : "Video",
        extensions: getMediaExtensions(state.mode),
      },
    ],
  });

  if (!selected) {
    setLog("已取消文件选择。");
    return;
  }

  const paths = Array.isArray(selected) ? selected : [selected];
  for (const filePath of paths) {
    await loadInputFile(filePath);
  }
}

async function exportSampleCrop() {
  const item = currentItem();
  if (!item) {
    setLog(`请先选择输入${state.mode === "image" ? "图片" : "视频"}。`);
    return;
  }

  if (!item.lastProbe) {
    await autoProbeMedia();
    if (!currentItem()?.lastProbe) {
      return;
    }
  }

  const isImage = state.mode === "image";
  const outputExtension = isImage ? getImageFormatExtension() : "mp4";
  const suggestedName = `${getFileStem(item.inputPath)}_${getSelectedRatio().replace(":", "x")}.${outputExtension}`;
  const outputPath = await save({
    title: isImage ? "保存导出图片" : "保存导出视频",
    defaultPath: suggestedName,
    filters: [
      {
        name: isImage ? "Image" : "MP4 Video",
        extensions: [outputExtension],
      },
    ],
  });

  if (!outputPath) {
    setLog("已取消导出。");
    return;
  }

  const request: ExportRequest = {
    inputPath: item.inputPath,
    outputPath,
    mode: state.mode,
    ratio: item.settings.ratio,
    anchor: item.settings.anchor,
    scale: item.settings.scale,
    cropRect: getRoundedCropRect(),
    imageFormat: isImage ? getImageFormatExtension() : undefined,
    imageQuality: isImage ? getSelectedImageQuality() : undefined,
    videoStartSeconds: isImage ? undefined : item.settings.videoStartSeconds,
    videoDurationSeconds: isImage ? undefined : item.settings.videoDurationSeconds,
  };

  state.exportBusy = true;
  state.exportingMode = state.mode;
  setButtonsDisabledState();
  setLog(`正在调用 ffmpeg 导出${isImage ? "裁剪图片" : "裁剪视频"}...`);

  try {
    const result = await invoke<ExportResult>("export_media", { request });
    item.outputPath = result.output_path;
    setLog(
      [
        "ffmpeg 导出成功。",
        `输出路径：${result.output_path}`,
        `裁剪滤镜：${result.applied_filter}`,
        "",
        "ffmpeg 日志摘要：",
        result.stderr.trim() || "(无 stderr 输出)",
      ].join("\n"),
    );
  } catch (error) {
    setLog(`ffmpeg 导出失败：${String(error)}`);
  } finally {
    state.exportBusy = false;
    state.exportingMode = null;
    setButtonsDisabledState();
    renderCurrentContext();
  }
}

async function exportBatch() {
  const context = currentContext();
  const items = context.items;
  if (items.length === 0) {
    setLog("当前队列中没有素材。");
    return;
  }

  const outputDir = await open({
    directory: true,
    title: "选择批量导出目录",
  });
  if (!outputDir || typeof outputDir !== "string") {
    setLog("已取消批量导出。");
    return;
  }

  const isImage = state.mode === "image";
  const outputExtension = isImage ? "png" : "mp4";

  state.exportBusy = true;
  state.exportingMode = state.mode;
  batchState.active = true;
  batchState.totalItems = items.length;
  batchState.currentItemIndex = 0;
  batchState.completedItems = 0;
  batchState.outputDir = outputDir;
  setButtonsDisabledState();
  setProgress(0, `准备批量导出 ${items.length} 个素材...`);

  let failedCount = 0;
  const logLines: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    batchState.currentItemIndex = i;

    const stem = getFileStem(item.inputPath);
    const ratioSuffix = item.settings.ratio.replace(":", "x");
    const outputPath = `${outputDir}/${stem}_${ratioSuffix}.${outputExtension}`;

    const request: ExportRequest = {
      inputPath: item.inputPath,
      outputPath,
      mode: state.mode,
      ratio: item.settings.ratio,
      anchor: item.settings.anchor,
      scale: item.settings.scale,
      cropRect: item.settings.rect
        ? {
            x: Math.round(item.settings.rect.x),
            y: Math.round(item.settings.rect.y),
            width: Math.round(item.settings.rect.width),
            height: Math.round(item.settings.rect.height),
          }
        : undefined,
      imageFormat: isImage ? "png" : undefined,
      imageQuality: isImage ? 100 : undefined,
      videoStartSeconds: isImage ? undefined : item.settings.videoStartSeconds,
      videoDurationSeconds: isImage ? undefined : item.settings.videoDurationSeconds,
    };

    try {
      const result = await invoke<ExportResult>("export_media", { request });
      item.outputPath = result.output_path;
      logLines.push(`[${i + 1}/${items.length}] ${item.name} 导出成功 → ${result.output_path}`);
    } catch (error) {
      failedCount += 1;
      logLines.push(`[${i + 1}/${items.length}] ${item.name} 导出失败：${String(error)}`);
    }

    batchState.completedItems = i + 1;
  }

  batchState.active = false;
  state.exportBusy = false;
  state.exportingMode = null;
  setButtonsDisabledState();

  const summary = failedCount === 0
    ? `批量导出完成，共 ${items.length} 个素材全部成功。`
    : `批量导出完成，${items.length - failedCount}/${items.length} 成功，${failedCount} 失败。`;
  setLog([summary, "", ...logLines].join("\n"));
  setProgress(100, summary);
  renderCurrentContext();
}

function bindCropDragging() {
  let mode: HandleMode | null = null;
  let startRect: CropRect | null = null;
  let startX = 0;
  let startY = 0;

  function mediaScale() {
    const mediaEl = currentMediaEl();
    const sourceWidth = getSourceWidth();
    return mediaEl && sourceWidth ? mediaEl.clientWidth / sourceWidth : 1;
  }

  cropBoxEl?.addEventListener("mousedown", (event) => {
    const item = currentItem();
    if (!item?.lastProbe || !item.settings.rect || state.exportBusy) {
      return;
    }
    const target = event.target as HTMLElement;
    mode = (target.dataset.handle as HandleMode | undefined) ?? "move";
    startRect = { ...item.settings.rect };
    startX = event.clientX;
    startY = event.clientY;
    event.preventDefault();
    event.stopPropagation();
  });

  window.addEventListener("mousemove", (event) => {
    const item = currentItem();
    if (!mode || !startRect || !item?.lastProbe || !item.settings.rect) {
      return;
    }

    const scale = mediaScale();
    const dx = (event.clientX - startX) / scale;
    const dy = (event.clientY - startY) / scale;
    const ratio = ratioValue();
    const sourceWidth = getSourceWidth();
    const sourceHeight = getSourceHeight();

    if (mode === "move") {
      item.settings.rect.x = Math.max(0, Math.min(sourceWidth - startRect.width, startRect.x + dx));
      item.settings.rect.y = Math.max(0, Math.min(sourceHeight - startRect.height, startRect.y + dy));
    } else if (ratio === null) {
      let x1 = startRect.x;
      let y1 = startRect.y;
      let x2 = startRect.x + startRect.width;
      let y2 = startRect.y + startRect.height;

      if (mode === "nw") {
        x1 += dx;
        y1 += dy;
      } else if (mode === "ne") {
        x2 += dx;
        y1 += dy;
      } else if (mode === "sw") {
        x1 += dx;
        y2 += dy;
      } else if (mode === "se") {
        x2 += dx;
        y2 += dy;
      }

      x1 = Math.max(0, Math.min(x1, x2 - 20));
      y1 = Math.max(0, Math.min(y1, y2 - 20));
      x2 = Math.min(sourceWidth, Math.max(x2, x1 + 20));
      y2 = Math.min(sourceHeight, Math.max(y2, y1 + 20));
      item.settings.rect = {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
      };
    } else {
      let nextWidth = startRect.width;
      let nextX = startRect.x;
      let nextY = startRect.y;

      if (mode === "se" || mode === "ne") {
        nextWidth = startRect.width + dx;
      } else if (mode === "sw" || mode === "nw") {
        nextWidth = startRect.width - dx;
      }

      nextWidth = Math.max(20, nextWidth);
      let nextHeight = nextWidth / ratio;

      if (mode === "se") {
        nextX = startRect.x;
        nextY = startRect.y;
      } else if (mode === "ne") {
        nextX = startRect.x;
        nextY = startRect.y + startRect.height - nextHeight;
      } else if (mode === "sw") {
        nextX = startRect.x + startRect.width - nextWidth;
        nextY = startRect.y;
      } else if (mode === "nw") {
        nextX = startRect.x + startRect.width - nextWidth;
        nextY = startRect.y + startRect.height - nextHeight;
      }

      if (nextX < 0) {
        const overflow = -nextX;
        nextWidth -= overflow;
        nextHeight = nextWidth / ratio;
        nextX = 0;
      }
      if (nextY < 0) {
        nextY = 0;
      }
      if (nextX + nextWidth > sourceWidth) {
        nextWidth = sourceWidth - nextX;
      }
      if (nextY + nextHeight > sourceHeight) {
        nextHeight = sourceHeight - nextY;
        nextWidth = nextHeight * ratio;
      }

      item.settings.rect = {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextWidth / ratio,
      };
      clampRect();
      syncScaleFromRect();
    }

    drawCropBox();
  });

  window.addEventListener("mouseup", () => {
    mode = null;
    startRect = null;
  });
}

async function bindExportProgressEvents() {
  const appWindow = getCurrentWindow();
  await appWindow.listen<ExportProgressEvent>("export-progress", ({ payload }) => {
    const targetMode = state.exportingMode ?? state.mode;
    const context = currentContext(targetMode);
    const current = payload.currentSeconds;
    const total = payload.totalSeconds;
    const timeText =
      typeof current === "number" && typeof total === "number"
        ? `（${current.toFixed(2)}s / ${total.toFixed(2)}s）`
        : "";

    if (batchState.active) {
      const itemProgress = payload.percent / 100;
      const globalPercent = ((batchState.completedItems + itemProgress) / batchState.totalItems) * 100;
      const itemLabel = `正在导出 ${batchState.currentItemIndex + 1}/${batchState.totalItems}`;

      if (payload.phase === "start") {
        context.progressPercent = globalPercent;
        context.progressText = `${itemLabel}${timeText}`;
        if (state.mode === targetMode) {
          setProgress(context.progressPercent, context.progressText);
        }
        return;
      }
      if (payload.phase === "running") {
        context.progressPercent = globalPercent;
        context.progressText = `${itemLabel}${timeText}`;
        if (state.mode === targetMode) {
          setProgress(context.progressPercent, context.progressText);
        }
        return;
      }
      if (payload.phase === "completed") {
        context.progressPercent = globalPercent;
        context.progressText = `${itemLabel} 完成`;
        if (state.mode === targetMode) {
          setProgress(context.progressPercent, context.progressText);
        }
        return;
      }
      if (payload.phase === "error") {
        context.progressPercent = globalPercent;
        context.progressText = `${itemLabel} 失败`;
        if (state.mode === targetMode) {
          setProgress(context.progressPercent, context.progressText);
        }
      }
      return;
    }

    if (payload.phase === "start") {
      context.progressPercent = payload.percent;
      context.progressText = payload.message ?? "开始导出...";
      if (state.mode === targetMode) {
        setProgress(context.progressPercent, context.progressText);
      }
      return;
    }
    if (payload.phase === "running") {
      context.progressPercent = payload.percent;
      context.progressText = `正在导出${timeText}`;
      if (state.mode === targetMode) {
        setProgress(context.progressPercent, context.progressText);
      }
      return;
    }
    if (payload.phase === "completed") {
      context.progressPercent = 100;
      context.progressText = payload.message ?? "导出完成";
      if (state.mode === targetMode) {
        setProgress(100, context.progressText);
      }
      return;
    }
    if (payload.phase === "error") {
      context.progressPercent = payload.percent;
      context.progressText = payload.message ?? "导出失败";
      if (state.mode === targetMode) {
        setProgress(context.progressPercent, context.progressText);
      }
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  void bindExportProgressEvents();
  bindCropDragging();
  updateModeUi();
  syncControlsFromState();
  setButtonsDisabledState();
  clearPreviewDom();
  renderCurrentContext();

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const nextMode = tab.dataset.mode === "image" ? "image" : "video";
      if (state.mode === nextMode) {
        return;
      }
      state.mode = nextMode;
      updateModeUi();
      renderCurrentContext();
    });
  });

  pickInputButton?.addEventListener("click", () => {
    void pickInputFile();
  });
  pickInputSecondaryButton?.addEventListener("click", () => {
    void pickInputFile();
  });

  exportButton?.addEventListener("click", () => {
    void exportSampleCrop();
  });

  batchExportButton?.addEventListener("click", () => {
    void exportBatch();
  });

  ratioSelect?.addEventListener("change", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    item.settings.ratio = getSelectedRatio();
    item.settings.rect = null;
    ensureRect();
    drawCropBox();
    renderThumbs();
    syncRatioButtons();
  });

  anchorSelect?.addEventListener("change", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    item.settings.anchor = getSelectedAnchor();
    if (item.settings.rect) {
      positionRectByAnchor();
      drawCropBox();
    }
    syncAnchorButtons();
  });

  ratioButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextRatio = button.dataset.ratio;
      if (!ratioSelect || !nextRatio) {
        return;
      }
      ratioSelect.value = nextRatio;
      ratioSelect.dispatchEvent(new Event("change"));
    });
  });

  anchorButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextAnchor = button.dataset.anchor;
      if (!anchorSelect || !nextAnchor) {
        return;
      }
      anchorSelect.value = nextAnchor;
      anchorSelect.dispatchEvent(new Event("change"));
    });
  });

  applyCustomRatioButton?.addEventListener("click", () => {
    const width = Number(customRatioWidthInput?.value || 0);
    const height = Number(customRatioHeightInput?.value || 0);
    if (!ratioSelect || !customRatioOption || width <= 0 || height <= 0) {
      setLog("请输入有效的自定义宽高比例。");
      return;
    }
    const ratio = `${Math.round(width)}:${Math.round(height)}`;
    customRatioOption.value = ratio;
    customRatioOption.textContent = ratio;
    ratioSelect.value = ratio;
    ratioSelect.dispatchEvent(new Event("change"));
  });

  scaleInput?.addEventListener("input", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    item.settings.scale = getSelectedScale();
    updateScaleLabel();
    if (ratioValue() !== null) {
      if (!item.settings.rect) {
        ensureRect();
      } else {
        resizeRectByScale();
      }
      drawCropBox();
    }
    renderThumbs();
  });

  imageFormatSelect?.addEventListener("change", () => {
    const item = currentItem();
    if (item) {
      item.settings.imageFormat = getImageFormatExtension();
    }
  });
  videoPreviewSeekEl?.addEventListener("input", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    stopVideoPlayback();
    item.previewSeconds = Number(videoPreviewSeekEl.value || 0) / 10;
    updateVideoTimelineUi();
    if (usingNativeVideoPreview(item) && previewVideoEl) {
      previewVideoEl.currentTime = item.previewSeconds;
      return;
    }
    scheduleVideoPreviewRefresh();
  });
  videoPreviewSeekEl?.addEventListener("change", () => {
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    if (usingNativeVideoPreview(item) && previewVideoEl) {
      previewVideoEl.currentTime = item.previewSeconds;
      return;
    }
    cancelScheduledVideoPreview();
    void requestPreviewFrame("video", item.previewSeconds);
  });
  videoPreviewToggleEl?.addEventListener("click", () => {
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    cancelScheduledVideoPreview();
    if (videoPreviewPlaying) {
      stopVideoPlayback();
      updateVideoTimelineUi();
      return;
    }
    startVideoPlayback();
  });
  videoExportStartEl?.addEventListener("input", () => {
    const item = currentItem();
    const duration = item?.lastProbe?.duration_seconds ?? 0;
    if (!item || state.mode !== "video" || duration <= 0) {
      return;
    }
    stopVideoPlayback();
    const end = getVideoSegmentEnd(item);
    const nextStart = Math.min(Number(videoExportStartEl.value || 0) / 10, Math.max(0, end - MIN_VIDEO_SEGMENT_SECONDS));
    item.settings.videoStartSeconds = nextStart;
    item.settings.videoDurationSeconds = Math.max(MIN_VIDEO_SEGMENT_SECONDS, end - nextStart);
    item.previewSeconds = nextStart;
    clampVideoSettings();
    updateVideoTimelineUi();
    if (usingNativeVideoPreview(item) && previewVideoEl) {
      previewVideoEl.currentTime = item.previewSeconds;
      return;
    }
    scheduleVideoPreviewRefresh();
  });
  videoExportEndEl?.addEventListener("input", () => {
    const item = currentItem();
    const duration = item?.lastProbe?.duration_seconds ?? 0;
    if (!item || state.mode !== "video" || duration <= 0) {
      return;
    }
    stopVideoPlayback();
    const start = item.settings.videoStartSeconds;
    const nextEnd = Math.max(Number(videoExportEndEl.value || 0) / 10, start + MIN_VIDEO_SEGMENT_SECONDS);
    item.settings.videoDurationSeconds = Math.max(MIN_VIDEO_SEGMENT_SECONDS, Math.min(duration, nextEnd) - start);
    item.previewSeconds = Math.min(duration, nextEnd);
    clampVideoSettings();
    updateVideoTimelineUi();
    if (usingNativeVideoPreview(item) && previewVideoEl) {
      previewVideoEl.currentTime = item.previewSeconds;
      return;
    }
    scheduleVideoPreviewRefresh();
  });
  videoExportStartEl?.addEventListener("change", () => {
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    if (usingNativeVideoPreview(item) && previewVideoEl) {
      previewVideoEl.currentTime = item.previewSeconds;
      return;
    }
    cancelScheduledVideoPreview();
    void requestPreviewFrame("video", item.previewSeconds);
  });
  videoExportEndEl?.addEventListener("change", () => {
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    if (usingNativeVideoPreview(item) && previewVideoEl) {
      previewVideoEl.currentTime = item.previewSeconds;
      return;
    }
    cancelScheduledVideoPreview();
    void requestPreviewFrame("video", item.previewSeconds);
  });
  previewVideoEl?.addEventListener("loadedmetadata", () => {
    const item = currentItem();
    if (!item || !usingNativeVideoPreview(item) || !previewVideoEl) {
      return;
    }
    if (shouldResetRectForRenderedSource(item)) {
      item.settings.rect = null;
      ensureRect();
    }
    previewVideoEl.currentTime = Math.min(item.previewSeconds, previewVideoEl.duration || item.previewSeconds);
    item.status = "ready";
    syncPreviewLayout();
    drawCropBox();
    updateVideoTimelineUi();
  });
  previewVideoEl?.addEventListener("timeupdate", () => {
    const item = currentItem();
    if (!item || !usingNativeVideoPreview(item) || !previewVideoEl) {
      return;
    }
    item.previewSeconds = previewVideoEl.currentTime;
    updateVideoTimelineUi();
  });
  previewVideoEl?.addEventListener("play", () => {
    videoPreviewPlaying = true;
    updateVideoTimelineUi();
  });
  previewVideoEl?.addEventListener("pause", () => {
    videoPreviewPlaying = false;
    updateVideoTimelineUi();
  });
  previewVideoEl?.addEventListener("ended", () => {
    videoPreviewPlaying = false;
    updateVideoTimelineUi();
  });
  previewVideoEl?.addEventListener("error", () => {
    const item = currentItem();
    if (!item || !item.nativeVideoSrc || state.mode !== "video") {
      return;
    }
    item.nativeVideoSrc = "";
    item.previewSeconds = item.settings.videoStartSeconds;
    setLog("当前视频无法在预览区原生播放，已回退为静态帧预览。");
    void requestPreviewFrame("video", item.previewSeconds);
  });
  applyCurrentToAllButton?.addEventListener("click", () => {
    const context = currentContext();
    const source = currentItem();
    if (!source) {
      return;
    }
    ensureRect();
    const sourceRect = source.settings.rect;
    if (!sourceRect) {
      return;
    }
    const relativeRect = {
      x: sourceRect.x / getSourceWidth(),
      y: sourceRect.y / getSourceHeight(),
      width: sourceRect.width / getSourceWidth(),
      height: sourceRect.height / getSourceHeight(),
    };
    const sourceRatio = source.settings.ratio;
    const fixedRatio = ratioValue(state.mode, sourceRatio);
    const sourceFit = fixedRatio ? maxFit(getSourceWidth(), getSourceHeight(), fixedRatio) : null;
    const actualScale = sourceFit ? Math.max(0.1, Math.min(1, sourceRect.width / sourceFit.width)) : source.settings.scale;

    context.items.forEach((item) => {
      item.settings.ratio = source.settings.ratio;
      item.settings.anchor = source.settings.anchor;
      item.settings.scale = actualScale;
      item.settings.imageFormat = source.settings.imageFormat;
      item.settings.imageQuality = source.settings.imageQuality;
      item.settings.videoStartSeconds = source.settings.videoStartSeconds;
      item.settings.videoDurationSeconds = source.settings.videoDurationSeconds;

      const width = item.lastProbe?.width ?? 0;
      const height = item.lastProbe?.height ?? 0;
      if (!width || !height) {
        item.settings.rect = null;
        return;
      }

      if (sourceRatio === "free") {
        item.settings.rect = {
          x: relativeRect.x * width,
          y: relativeRect.y * height,
          width: relativeRect.width * width,
          height: relativeRect.height * height,
        };
      } else if (fixedRatio) {
        const fit = maxFit(width, height, fixedRatio);
        const rectWidth = fit.width * actualScale;
        const rectHeight = fit.height * actualScale;
        const travelX = Math.max(0, width - rectWidth);
        const travelY = Math.max(0, height - rectHeight);
        const sourceTravelX = Math.max(0, getSourceWidth() - sourceRect.width);
        const sourceTravelY = Math.max(0, getSourceHeight() - sourceRect.height);
        const positionX = sourceTravelX ? sourceRect.x / sourceTravelX : 0.5;
        const positionY = sourceTravelY ? sourceRect.y / sourceTravelY : 0.5;
        item.settings.rect = {
          x: travelX * positionX,
          y: travelY * positionY,
          width: rectWidth,
          height: rectHeight,
        };
      }

      if (item === currentItem()) {
        clampRect();
      } else {
        clampRect(state.mode);
      }
    });

    setLog(`已应用到全部${listLabel()}`);
    renderCurrentContext();
  });
  clearQueueButton?.addEventListener("click", () => {
    const context = currentContext();
    if (state.exportBusy) {
      return;
    }
    context.items = [];
    context.currentIndex = -1;
    context.log = "等待操作...";
    context.progressPercent = 0;
    context.progressText = "等待导出...";
    renderCurrentContext();
  });
  previewImageEl?.addEventListener("load", () => {
    const item = currentItem();
    if (item && shouldResetRectForRenderedSource(item)) {
      item.settings.rect = null;
      ensureRect();
    }
    syncPreviewLayout();
    drawCropBox();
  });
  window.addEventListener("resize", () => {
    syncPreviewLayout();
    drawCropBox();
  });

  /* theme */
  const savedTheme = localStorage.getItem("media-cropper-theme");
  if (savedTheme === "light") {
    document.documentElement.classList.add("light");
    if (themeToggleEl) themeToggleEl.textContent = "☾";
  }
  themeToggleEl?.addEventListener("click", () => {
    const isLight = document.documentElement.classList.toggle("light");
    localStorage.setItem("media-cropper-theme", isLight ? "light" : "dark");
    if (themeToggleEl) themeToggleEl.textContent = isLight ? "☾" : "☀";
  });
});
