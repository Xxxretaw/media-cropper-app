import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  clampRectToBounds,
  contentBoundsFromMargins,
  createRectForRatio,
  maxFit,
  positionRectInBounds,
  resizeRectAroundCenter,
  scaleForRect,
  type CropRect,
} from "./crop-geometry";
import {
  createAppState,
  createBatchState,
  createBlackBorderDetectionState,
  createQueueItem,
  getBlackBorderDetectionCandidates,
  getItemSourceSize,
  getProbeDisplaySize,
  type BlackBorderDetectionResult,
  type BlackBorderDetectionStatus,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportResult,
  type MediaMode,
  type PreviewDataUrlResult,
  type PreviewVideoAssetResult,
  type ProbeResult,
  type QueueItem,
  type VideoFrameIndexResult,
} from "./media-model";
import {
  ALL_MEDIA_EXTENSIONS,
  routeMediaPaths,
  type RoutedMediaFile,
} from "./media-files";
import {
  buildExportBaseNames,
  buildExportFileName,
  sanitizeMaterialName,
} from "./export-naming";
import { createQueueThumbnail } from "./queue-view";
import { bindCropDragging } from "./crop-drag-controller";
import { bindFileDropEvents } from "./file-drop";
import { bindAppUpdater } from "./app-updater";
import {
  applyCachedBlackBorderResult,
  removeAppliedBlackBorderResult,
  restoreCropBeforeDetection,
  saveCropBeforeDetection,
} from "./black-border-result";
import {
  applyFrameBoundaries,
  centerTimelineView,
  createVideoFrameIndex,
  createVideoTimelineState,
  formatIndexedFrame,
  formatFrameRate,
  formatPreciseClock,
  frameBoundaryToSeconds,
  frameFromTrackPosition,
  framePositionPercent,
  normalizeVideoTimeline,
  secondsToIndexedFrame,
} from "./video-frame-time";

const state = createAppState();
const batchState = createBatchState();

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
const autoDetectBlackBordersEl = document.querySelector<HTMLInputElement>("#auto-detect-black-borders");
const skipBlackBorderDetectionEl = document.querySelector<HTMLInputElement>("#skip-black-border-detection");
const detectCurrentButton = document.querySelector<HTMLButtonElement>("#detect-black-borders-current");
const detectAllButton = document.querySelector<HTMLButtonElement>("#detect-black-borders-all");
const toggleBlackBorderResultButton = document.querySelector<HTMLButtonElement>("#toggle-black-border-result");
const blackBorderStatusEl = document.querySelector<HTMLElement>("#black-border-status");
const blackBorderConfidenceEl = document.querySelector<HTMLElement>("#black-border-confidence");
const blackBorderDetailEl = document.querySelector<HTMLElement>("#black-border-detail");
const imageFormatSelect = document.querySelector<HTMLSelectElement>("#image-format");
const materialNameInput = document.querySelector<HTMLInputElement>("#material-name-input");
const originalFileNameEl = document.querySelector<HTMLElement>("#original-file-name");
const exportNamePreviewEl = document.querySelector<HTMLElement>("#export-name-preview");
const namingMessageEl = document.querySelector<HTMLElement>("#naming-message");
const videoRangeSummaryEl = document.querySelector<HTMLElement>("#video-range-summary");
const videoRangeFpsEl = document.querySelector<HTMLElement>("#video-range-fps");
const previewEmptyEl = document.querySelector<HTMLElement>("#preview-empty");
const dropTitleEl = document.querySelector<HTMLElement>("#drop-title");
const mediaWrapEl = document.querySelector<HTMLElement>("#media-wrap");
const mediaBoxEl = document.querySelector<HTMLElement>("#media-box");
const previewImageEl = document.querySelector<HTMLImageElement>("#preview-image");
const previewVideoEl = document.querySelector<HTMLVideoElement>("#preview-video");
const cropBoxEl = document.querySelector<HTMLElement>("#crop-box");
const videoTimelineEl = document.querySelector<HTMLElement>("#video-timeline");
const videoPreviewTimeEl = document.querySelector<HTMLElement>("#video-preview-time");
const videoPreviewToggleEl = document.querySelector<HTMLButtonElement>("#video-preview-toggle");
const videoExportStartTimeEl = document.querySelector<HTMLElement>("#video-export-start-time");
const videoExportEndTimeEl = document.querySelector<HTMLElement>("#video-export-end-time");
const videoSelectionDurationEl = document.querySelector<HTMLElement>("#video-selection-duration");
const videoIndexStatusEl = document.querySelector<HTMLElement>("#video-index-status");
const videoMainTrackEl = document.querySelector<HTMLElement>("#video-main-track");
const videoMainSelectionEl = document.querySelector<HTMLElement>("#video-main-selection");
const videoMainStartEl = document.querySelector<HTMLButtonElement>("#video-main-start");
const videoMainEndEl = document.querySelector<HTMLButtonElement>("#video-main-end");
const videoMainPlayheadEl = document.querySelector<HTMLButtonElement>("#video-main-playhead");
const videoFineTuneEl = document.querySelector<HTMLElement>("#video-fine-tune");
const videoFineTrackEl = document.querySelector<HTMLElement>("#video-fine-track");
const videoFineHandleEl = document.querySelector<HTMLButtonElement>("#video-fine-handle");
const videoFineLabelEl = document.querySelector<HTMLElement>("#video-fine-label");
const videoFineValueEl = document.querySelector<HTMLElement>("#video-fine-value");
const videoFineDoneEl = document.querySelector<HTMLButtonElement>("#video-fine-done");
const videoFineStepEls = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-fine-step]"),
);
const progressFillEl = document.querySelector<HTMLElement>("#progress-fill");
const progressPercentEl = document.querySelector<HTMLElement>("#progress-percent");
const progressTextEl = document.querySelector<HTMLElement>("#progress-text");
const exportProgressSectionEl = document.querySelector<HTMLElement>("#export-progress-section");
const applyCurrentToAllButton = document.querySelector<HTMLButtonElement>("#apply-current-to-all");
const clearQueueButton = document.querySelector<HTMLButtonElement>("#clear-queue-button");
const batchExportButton = document.querySelector<HTMLButtonElement>("#batch-export-button");
const panelShellEl = document.querySelector<HTMLElement>("#panel-shell");
const cropDimsEl = document.querySelector<HTMLElement>("#crop-dims");
const themeToggleEl = document.querySelector<HTMLButtonElement>("#theme-toggle");
const previewStageEl = document.querySelector<HTMLElement>("#preview-stage");
const updateCheckButton = document.querySelector<HTMLButtonElement>("#update-check-button");
const updateOverlayEl = document.querySelector<HTMLElement>("#update-overlay");
const updateVersionEl = document.querySelector<HTMLElement>("#update-version");
const updateNotesEl = document.querySelector<HTMLElement>("#update-notes");
const updateStatusEl = document.querySelector<HTMLElement>("#update-status");
const updateErrorEl = document.querySelector<HTMLElement>("#update-error");
const updateProgressShellEl = document.querySelector<HTMLElement>("#update-progress-shell");
const updateProgressFillEl = document.querySelector<HTMLElement>("#update-progress-fill");
const updateProgressTextEl = document.querySelector<HTMLElement>("#update-progress-text");
const updateLaterButton = document.querySelector<HTMLButtonElement>("#update-later-button");
const updateInstallButton = document.querySelector<HTMLButtonElement>("#update-install-button");
let videoPreviewTimer: number | null = null;
let videoPlaybackTimer: number | null = null;
let videoPlaybackStartedAt = 0;
let videoPlaybackStartSeconds = 0;
let videoLastStaticPreviewAt = 0;
let videoPreviewPlaying = false;
let activeFineTune: {
  itemId: string;
  role: "start" | "end";
} | null = null;
const BLACK_BORDER_SAMPLE_WINDOWS = 7;

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

  const sourceSize = getItemSourceSize(item);

  if (mode === state.mode) {
    if (usingNativeVideoPreview(item) && previewVideoEl && !previewVideoEl.classList.contains("hide")) {
      return {
        width: previewVideoEl.videoWidth || sourceSize.width,
        height: previewVideoEl.videoHeight || sourceSize.height,
      };
    }

    if (item.previewSrc && previewImageEl && !previewImageEl.classList.contains("hide")) {
      return {
        width: previewImageEl.naturalWidth || sourceSize.width,
        height: previewImageEl.naturalHeight || sourceSize.height,
      };
    }
  }

  return sourceSize;
}

function getSourceWidth(mode = state.mode) {
  return getItemSourceSize(currentItem(mode)).width;
}

function getSourceHeight(mode = state.mode) {
  return getItemSourceSize(currentItem(mode)).height;
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
  const isIdle = safePercent === 0 && text === "等待导出...";
  context.progressPercent = safePercent;
  context.progressText = text;
  exportProgressSectionEl?.classList.toggle("hide", isIdle);
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
  const hasValidCurrentName = Boolean(sanitizeMaterialName(currentItem()?.materialName ?? ""));
  const hasInvalidQueueName = currentContext().items.some(
    (item) => !sanitizeMaterialName(item.materialName),
  );
  const busy = isOperationBusy();
  const disabled = !hasCurrent || busy;
  const currentVideo = state.mode === "video" ? currentItem("video") : null;
  const detectionCandidates = getBlackBorderDetectionCandidates(currentContext("video").items);
  if (exportButton) {
    exportButton.disabled = disabled || !hasValidCurrentName;
  }
  if (pickInputButton) {
    pickInputButton.disabled = busy;
  }
  if (pickInputSecondaryButton) {
    pickInputSecondaryButton.disabled = busy;
  }
  if (applyCurrentToAllButton) {
    applyCurrentToAllButton.disabled = !hasCurrent || busy;
  }
  if (clearQueueButton) {
    clearQueueButton.disabled = currentContext().items.length === 0 || busy;
  }
  if (batchExportButton) {
    batchExportButton.disabled = currentContext().items.length === 0 || hasInvalidQueueName || busy;
  }
  if (applyCustomRatioButton) {
    applyCustomRatioButton.disabled = !hasCurrent || busy;
  }
  ratioButtons.forEach((button) => {
    button.disabled = disabled;
  });
  anchorButtons.forEach((button) => {
    button.disabled = disabled;
  });
  if (ratioSelect) ratioSelect.disabled = disabled;
  if (anchorSelect) anchorSelect.disabled = disabled;
  if (scaleInput) scaleInput.disabled = disabled;
  if (customRatioWidthInput) customRatioWidthInput.disabled = disabled;
  if (customRatioHeightInput) customRatioHeightInput.disabled = disabled;
  if (imageFormatSelect) imageFormatSelect.disabled = disabled;
  if (materialNameInput) materialNameInput.disabled = !hasCurrent || busy;
  if (videoPreviewToggleEl) videoPreviewToggleEl.disabled = disabled;
  [
    videoMainStartEl,
    videoMainEndEl,
    videoMainPlayheadEl,
    videoFineHandleEl,
    videoFineDoneEl,
    ...videoFineStepEls,
  ].forEach((element) => {
    if (element) element.disabled = disabled;
  });
  if (detectCurrentButton) {
    detectCurrentButton.disabled = !currentVideo?.lastProbe || busy;
  }
  if (detectAllButton) {
    detectAllButton.disabled = state.mode !== "video" || detectionCandidates.length === 0 || busy;
  }
  if (autoDetectBlackBordersEl) {
    autoDetectBlackBordersEl.disabled = busy;
  }
  if (skipBlackBorderDetectionEl) {
    skipBlackBorderDetectionEl.disabled = !currentVideo || busy;
  }
  if (toggleBlackBorderResultButton) {
    const hasReusableResult = Boolean(
      currentVideo && ["detected", "no_border"].includes(currentVideo.blackBorderDetection.status),
    );
    toggleBlackBorderResultButton.disabled = !hasReusableResult || busy;
  }
  modeTabs.forEach((tab) => {
    tab.disabled = busy;
  });
}

function currentMediaEl() {
  if (previewVideoEl && !previewVideoEl.classList.contains("hide")) {
    return previewVideoEl;
  }
  return previewImageEl;
}

function isOperationBusy() {
  return state.exportBusy || state.detectionBusy || state.importBusy;
}

function resetPreviewLayout() {
  mediaBoxEl?.style.removeProperty("width");
  mediaBoxEl?.style.removeProperty("height");
}

function updateModeUi() {
  const isImage = state.mode === "image";
  modeTabs.forEach((tab) => {
    const mode = tab.dataset.mode === "image" ? "image" : "video";
    const count = currentContext(mode).items.length;
    tab.classList.toggle("active", mode === state.mode);
    tab.textContent = `${mode === "image" ? "图片" : "视频"}${count > 0 ? ` · ${count}` : ""}`;
  });
  if (pickInputButton) {
    pickInputButton.textContent = "添加素材";
  }
  if (pickInputSecondaryButton) {
    pickInputSecondaryButton.textContent = "选择素材";
  }
  if (exportButton) {
    exportButton.textContent = isImage ? "导出当前图片" : "导出当前视频";
  }
  imageSettingsEl?.classList.toggle("hide", !isImage);
  videoSettingsEl?.classList.toggle("hide", isImage);
  if (dropTitleEl && !currentItem()) {
    dropTitleEl.textContent = "拖入图片或视频";
  }
}

function outputExtensionForItem(item: QueueItem, mode = state.mode) {
  return mode === "image" ? item.settings.imageFormat || "png" : "mp4";
}

function exportFileNameForItem(item: QueueItem, mode = state.mode) {
  return buildExportFileName(
    currentContext(mode).items,
    item.id,
    outputExtensionForItem(item, mode),
  );
}

function syncFileNamingUi() {
  const item = currentItem();
  if (!item) {
    if (materialNameInput && document.activeElement !== materialNameInput) {
      materialNameInput.value = "";
    }
    if (originalFileNameEl) originalFileNameEl.textContent = "—";
    if (exportNamePreviewEl) {
      exportNamePreviewEl.textContent = "—";
      exportNamePreviewEl.removeAttribute("title");
    }
    if (namingMessageEl) {
      namingMessageEl.textContent = "选择素材后可单独设置导出名称";
      namingMessageEl.dataset.state = "";
    }
    return;
  }

  if (materialNameInput && document.activeElement !== materialNameInput) {
    materialNameInput.value = item.materialName;
  }
  if (originalFileNameEl) {
    originalFileNameEl.textContent = item.name;
    originalFileNameEl.title = item.name;
  }

  const sanitizedName = sanitizeMaterialName(item.materialName);
  const baseName = buildExportBaseNames(currentContext().items).get(item.id) ?? "";
  const fileName = exportFileNameForItem(item);
  if (exportNamePreviewEl) {
    exportNamePreviewEl.textContent = fileName || "请输入有效的素材名称";
    if (fileName) exportNamePreviewEl.title = fileName;
    else exportNamePreviewEl.removeAttribute("title");
  }

  if (!namingMessageEl) {
    return;
  }
  if (!sanitizedName) {
    namingMessageEl.textContent = "素材名称不能为空或仅包含无效字符";
    namingMessageEl.dataset.state = "error";
  } else if (baseName !== sanitizedName) {
    namingMessageEl.textContent = "检测到同名素材，已按队列顺序自动添加序号";
    namingMessageEl.dataset.state = "duplicate";
  } else if (sanitizedName !== item.materialName.trim()) {
    namingMessageEl.textContent = "导出时会自动移除扩展名并替换文件名无效字符";
    namingMessageEl.dataset.state = "duplicate";
  } else {
    namingMessageEl.textContent = "原始文件不会被修改 · F2 快速编辑";
    namingMessageEl.dataset.state = "";
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

function blackBorderStatusLabel(status: BlackBorderDetectionStatus, compact = false) {
  if (status === "detecting") return compact ? "检测中" : "正在检测黑边…";
  if (status === "detected") return compact ? "已去黑边" : "已检测到黑边";
  if (status === "no_border") return compact ? "无黑边" : "未发现黑边";
  if (status === "needs_review") return compact ? "需确认" : "检测结果需要确认";
  if (status === "failed") return compact ? "失败" : "黑边检测失败";
  return compact ? "未检测" : "尚未检测";
}

function itemBlackBorderStatusLabel(item: QueueItem, compact = false) {
  if (
    ["detected", "no_border"].includes(item.blackBorderDetection.status)
    && !item.blackBorderDetection.resultApplied
  ) {
    return compact ? "未应用" : "已检测 · 未应用";
  }
  if (item.blackBorderDetection.skipDetection) {
    return compact ? "不批量检测" : "不参与批量检测";
  }
  if (item.blackBorderDetection.manuallyAdjusted) {
    if (item.blackBorderDetection.status === "detected" && item.blackBorderDetection.resultApplied) {
      return compact ? "去边后调整" : "已在去黑边区域内调整";
    }
    return compact ? "已调整" : "裁切框已手动调整";
  }
  return blackBorderStatusLabel(item.blackBorderDetection.status, compact);
}

function markCropManuallyAdjusted(item: QueueItem | null) {
  if (
    !item ||
    ["not_run", "detecting"].includes(item.blackBorderDetection.status) ||
    item.blackBorderDetection.manuallyAdjusted
  ) {
    return;
  }
  item.blackBorderDetection.manuallyAdjusted = true;
  if (state.mode === "video" && currentItem("video") === item) {
    syncBlackBorderDetectionUi();
  }
}

function invalidateDetectionForSegmentChange(item: QueueItem) {
  const detection = item.blackBorderDetection;
  if (!["detected", "no_border"].includes(detection.status)) {
    return;
  }

  detection.status = "needs_review";
  detection.resultApplied = false;
  detection.confidence = null;
  detection.manuallyAdjusted = false;
  detection.warning = "输出片段已改变，请重新检测黑边后再批量导出。";
  syncBlackBorderDetectionUi();
  renderThumbs();
}

function formatConfidence(confidence: number | null) {
  if (confidence === null || !Number.isFinite(confidence)) {
    return "";
  }
  const percent = confidence <= 1 ? confidence * 100 : confidence;
  return `置信度 ${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}

function syncBlackBorderDetectionUi() {
  const item = state.mode === "video" ? currentItem("video") : null;
  const detection = item?.blackBorderDetection ?? createBlackBorderDetectionState();
  const skipDetection = Boolean(item?.blackBorderDetection.skipDetection);
  if (
    videoSettingsEl instanceof HTMLDetailsElement
    && (detection.status === "needs_review" || detection.status === "failed")
  ) {
    videoSettingsEl.open = true;
  }
  if (blackBorderStatusEl) {
    blackBorderStatusEl.textContent = item ? itemBlackBorderStatusLabel(item) : blackBorderStatusLabel(detection.status);
    blackBorderStatusEl.dataset.status = ["detected", "no_border"].includes(detection.status) && !detection.resultApplied
      ? "unapplied"
      : skipDetection ? "skipped" : detection.status;
  }
  if (blackBorderConfidenceEl) {
    blackBorderConfidenceEl.textContent = skipDetection ? "" : formatConfidence(detection.confidence);
  }
  if (skipBlackBorderDetectionEl) {
    skipBlackBorderDetectionEl.checked = skipDetection;
  }
  if (toggleBlackBorderResultButton) {
    const hasReusableResult = Boolean(item && ["detected", "no_border"].includes(detection.status));
    toggleBlackBorderResultButton.classList.toggle("hide", !hasReusableResult);
    toggleBlackBorderResultButton.textContent = detection.resultApplied ? "撤销检测结果" : "重新应用检测结果";
  }
  if (!blackBorderDetailEl) {
    return;
  }

  if (skipDetection) {
    blackBorderDetailEl.textContent = detection.resultApplied
      ? "当前检测结果仍在使用；“检测全部”会跳过这个视频。"
      : "当前视频不会参与“检测全部”，单独检测仍可使用。";
  } else if (["detected", "no_border"].includes(detection.status) && !detection.resultApplied) {
    blackBorderDetailEl.textContent = "检测结果已撤销，裁切范围已恢复；需要时可重新应用。";
  } else if (detection.manuallyAdjusted && detection.status === "detected") {
    blackBorderDetailEl.textContent = item?.settings.ratio === "free"
      ? "已保留黑边检测边界，当前在有效画面内手动调整。"
      : `已保留黑边检测边界，并在有效画面内应用 ${item?.settings.ratio} 画幅。`;
  } else if (detection.manuallyAdjusted) {
    blackBorderDetailEl.textContent = "当前使用手动调整后的裁切区域。";
  } else if (detection.warning) {
    blackBorderDetailEl.textContent = detection.warning;
  } else if (detection.status === "detected") {
    const { left, top, right, bottom } = detection.margins;
    blackBorderDetailEl.textContent = `裁去：上 ${top}px · 右 ${right}px · 下 ${bottom}px · 左 ${left}px`;
  } else if (detection.status === "no_border") {
    blackBorderDetailEl.textContent = "已使用视频完整画幅。";
  } else if (detection.status === "needs_review") {
    blackBorderDetailEl.textContent = "未自动修改当前裁切框。";
  } else if (detection.status === "failed") {
    blackBorderDetailEl.textContent = "可稍后重试或继续手动裁切。";
  } else {
    blackBorderDetailEl.textContent = "可检测当前视频，或批量检测未跳过的视频。";
  }
}

function getVideoSegmentEnd(item: QueueItem) {
  return frameBoundaryToSeconds(
    item.videoTimeline.endFrameExclusive,
    item.videoFrameIndex,
    item.lastProbe?.duration_seconds,
  );
}

function syncVideoRangeSeconds(item: QueueItem) {
  item.videoTimeline = normalizeVideoTimeline(
    item.videoTimeline,
    item.videoFrameIndex.frameCount,
  );
  const start = frameBoundaryToSeconds(
    item.videoTimeline.startFrame,
    item.videoFrameIndex,
    item.lastProbe?.duration_seconds,
  );
  const end = getVideoSegmentEnd(item);
  item.settings.videoStartSeconds = start;
  item.settings.videoDurationSeconds = Math.max(0, end - start);
  item.previewSeconds = frameBoundaryToSeconds(
    item.videoTimeline.playheadFrame,
    item.videoFrameIndex,
    item.lastProbe?.duration_seconds,
  );
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
      videoExportStartTimeEl.textContent = "起点 00:00:00 · 帧 0";
    }
    if (videoExportEndTimeEl) {
      videoExportEndTimeEl.textContent = "终点 00:00:00 · 帧 0";
    }
    if (videoRangeSummaryEl) {
      videoRangeSummaryEl.textContent = "请在中间时间轴选择";
    }
    if (videoRangeFpsEl) {
      videoRangeFpsEl.textContent = "— fps";
    }
    if (videoIndexStatusEl) {
      videoIndexStatusEl.textContent = "";
      videoIndexStatusEl.removeAttribute("data-status");
    }
    return;
  }

  const index = item.videoFrameIndex;
  const timeline = normalizeVideoTimeline(item.videoTimeline, index.frameCount);
  item.videoTimeline = timeline;
  const endFrame = timeline.endFrameExclusive - 1;
  const selectedFrames = timeline.endFrameExclusive - timeline.startFrame;
  if (videoExportStartTimeEl) {
    videoExportStartTimeEl.textContent = `起点 ${formatIndexedFrame(timeline.startFrame, index)}`;
  }
  if (videoExportEndTimeEl) {
    videoExportEndTimeEl.textContent = `终点 ${formatIndexedFrame(endFrame, index)}`;
  }
  if (videoSelectionDurationEl) {
    videoSelectionDurationEl.textContent =
      `共 ${selectedFrames} 帧 · ${formatPreciseClock(item.settings.videoDurationSeconds)}`;
  }
  if (videoRangeSummaryEl) {
    videoRangeSummaryEl.textContent =
      `${formatIndexedFrame(timeline.startFrame, index)} — ${formatIndexedFrame(endFrame, index)} · 共 ${selectedFrames} 帧`;
  }
  if (videoRangeFpsEl) {
    videoRangeFpsEl.textContent = index.variableFrameRate
      ? "可变帧率"
      : `${formatFrameRate(index.frameRateNumerator / index.frameRateDenominator)} fps`;
  }
  if (videoIndexStatusEl) {
    videoIndexStatusEl.dataset.status = index.status;
    videoIndexStatusEl.textContent = index.status === "indexing"
      ? "正在建立逐帧索引…"
      : index.warning || (index.variableFrameRate ? "可变帧率 · 已建立逐帧索引" : "");
  }
}

function setTimelinePosition(element: HTMLElement | null, percent: number) {
  if (element) {
    element.style.left = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

function setTimelineRange(
  element: HTMLElement | null,
  startPercent: number,
  endPercent: number,
) {
  if (!element) return;
  const left = Math.max(0, Math.min(100, startPercent));
  const right = Math.max(left, Math.min(100, endPercent));
  element.style.left = `${left}%`;
  element.style.width = `${right - left}%`;
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
      videoPreviewTimeEl.textContent = "00:00:00 · 帧 0";
    }
    if (videoPreviewToggleEl) {
      videoPreviewToggleEl.textContent = "▶";
    }
    videoFineTuneEl?.classList.add("hide");
    stopVideoPlayback();
    updateVideoExportRangeUi();
    return;
  }
  const index = item.videoFrameIndex;
  if (activeFineTune && activeFineTune.itemId !== item.id) {
    activeFineTune = null;
  }
  const timeline = normalizeVideoTimeline(item.videoTimeline, index.frameCount);
  item.videoTimeline = timeline;
  const totalFrames = index.frameCount;
  if (videoPreviewTimeEl) {
    videoPreviewTimeEl.textContent = formatIndexedFrame(timeline.playheadFrame, index);
  }
  if (videoPreviewToggleEl) {
    videoPreviewToggleEl.textContent = videoPreviewPlaying ? "❚❚" : "▶";
  }

  const mainStart = framePositionPercent(timeline.startFrame, 0, totalFrames);
  const mainEnd = framePositionPercent(timeline.endFrameExclusive, 0, totalFrames);
  const mainPlayhead = framePositionPercent(timeline.playheadFrame, 0, totalFrames);
  setTimelineRange(videoMainSelectionEl, mainStart, mainEnd);
  setTimelinePosition(videoMainStartEl, mainStart);
  setTimelinePosition(videoMainEndEl, mainEnd);
  setTimelinePosition(videoMainPlayheadEl, mainPlayhead);

  const fineTuneActive = activeFineTune?.itemId === item.id;
  videoFineTuneEl?.classList.toggle("hide", !fineTuneActive);
  if (fineTuneActive && activeFineTune) {
    const role = activeFineTune.role;
    const endpointBoundary = role === "start"
      ? timeline.startFrame
      : timeline.endFrameExclusive;
    const displayFrame = role === "start"
      ? timeline.startFrame
      : timeline.endFrameExclusive - 1;
    if (videoFineLabelEl) {
      videoFineLabelEl.textContent = role === "start" ? "逐帧微调起点" : "逐帧微调终点";
    }
    if (videoFineValueEl) {
      videoFineValueEl.textContent = formatIndexedFrame(displayFrame, index);
    }
    setTimelinePosition(
      videoFineHandleEl,
      framePositionPercent(
        endpointBoundary,
        timeline.viewStartFrame,
        timeline.viewEndFrameExclusive,
      ),
    );
  }
  updateVideoExportRangeUi();
}

function openFineTune(item: QueueItem, role: "start" | "end") {
  const focusFrame = role === "start"
    ? item.videoTimeline.startFrame
    : item.videoTimeline.endFrameExclusive - 1;
  item.videoTimeline = centerTimelineView(
    item.videoTimeline,
    focusFrame,
    item.videoFrameIndex.frameCount,
  );
  activeFineTune = { itemId: item.id, role };
  updateVideoTimelineUi();
  window.setTimeout(() => videoFineHandleEl?.focus(), 0);
}

function closeFineTune() {
  activeFineTune = null;
  videoFineTuneEl?.classList.add("hide");
}

function previewTimelineFrame(item: QueueItem, frame: number, immediate = false) {
  item.videoTimeline.playheadFrame = Math.max(
    0,
    Math.min(item.videoFrameIndex.frameCount - 1, Math.round(frame)),
  );
  syncVideoRangeSeconds(item);
  updateVideoTimelineUi();
  if (usingNativeVideoPreview(item) && previewVideoEl) {
    previewVideoEl.currentTime = item.previewSeconds;
    return;
  }
  if (immediate) {
    cancelScheduledVideoPreview();
    void requestPreviewFrame(item, "video", item.previewSeconds);
  } else {
    scheduleVideoPreviewRefresh();
  }
}

function setTimelineRoleFrame(
  item: QueueItem,
  role: "start" | "end" | "playhead",
  frame: number,
  recenter = false,
) {
  stopVideoPlayback();
  const timeline = item.videoTimeline;
  let previewFrame = frame;
  if (role === "start") {
    timeline.startFrame = Math.max(
      0,
      Math.min(timeline.endFrameExclusive - 1, Math.round(frame)),
    );
    previewFrame = timeline.startFrame;
    invalidateDetectionForSegmentChange(item);
  } else if (role === "end") {
    timeline.endFrameExclusive = Math.max(
      timeline.startFrame + 1,
      Math.min(item.videoFrameIndex.frameCount, Math.round(frame)),
    );
    previewFrame = timeline.endFrameExclusive - 1;
    invalidateDetectionForSegmentChange(item);
  } else {
    previewFrame = Math.max(
      0,
      Math.min(item.videoFrameIndex.frameCount - 1, Math.round(frame)),
    );
  }
  timeline.playheadFrame = previewFrame;
  if (recenter) {
    item.videoTimeline = centerTimelineView(
      timeline,
      previewFrame,
      item.videoFrameIndex.frameCount,
    );
  }
  previewTimelineFrame(item, previewFrame);
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
  if (!item || state.mode !== "video" || item.videoFrameIndex.frameCount <= 0) {
    stopVideoPlayback();
    return;
  }

  const timeline = item.videoTimeline;
  if (
    timeline.playheadFrame < timeline.startFrame
    || timeline.playheadFrame >= timeline.endFrameExclusive
  ) {
    timeline.playheadFrame = timeline.startFrame;
  }
  syncVideoRangeSeconds(item);
  videoPlaybackStartedAt = performance.now();
  videoPlaybackStartSeconds = item.previewSeconds;
  videoLastStaticPreviewAt = 0;
  stopVideoPlayback();
  videoPreviewPlaying = true;

  if (usingNativeVideoPreview(item) && previewVideoEl) {
    previewVideoEl.currentTime = item.previewSeconds;
    void previewVideoEl.play().catch((error) => {
      setLog(`视频播放失败：${String(error)}`);
      stopVideoPlayback();
    });
  }

  updateVideoTimelineUi();
  videoPlaybackTimer = window.setInterval(() => {
    const activeItem = currentItem();
    if (!activeItem || state.mode !== "video") {
      stopVideoPlayback();
      return;
    }
    const endSeconds = getVideoSegmentEnd(activeItem);
    const nextSeconds = usingNativeVideoPreview(activeItem) && previewVideoEl
      ? previewVideoEl.currentTime
      : videoPlaybackStartSeconds + (performance.now() - videoPlaybackStartedAt) / 1000;
    if (nextSeconds >= endSeconds) {
      activeItem.videoTimeline.playheadFrame = activeItem.videoTimeline.endFrameExclusive - 1;
      syncVideoRangeSeconds(activeItem);
      if (usingNativeVideoPreview(activeItem) && previewVideoEl) {
        previewVideoEl.currentTime = activeItem.previewSeconds;
      } else {
        void requestPreviewFrame(activeItem, "video", activeItem.previewSeconds);
      }
      stopVideoPlayback();
      updateVideoTimelineUi();
      return;
    }
    activeItem.videoTimeline.playheadFrame = secondsToIndexedFrame(
      nextSeconds,
      activeItem.videoFrameIndex,
    );
    syncVideoRangeSeconds(activeItem);
    updateVideoTimelineUi();
    const now = performance.now();
    if (!usingNativeVideoPreview(activeItem) && now - videoLastStaticPreviewAt >= 180) {
      videoLastStaticPreviewAt = now;
      void requestPreviewFrame(activeItem, "video", activeItem.previewSeconds);
    }
  }, 16);
}

function scheduleVideoPreviewRefresh(delay = 140) {
  cancelScheduledVideoPreview();
  videoPreviewTimer = window.setTimeout(() => {
    videoPreviewTimer = null;
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    void requestPreviewFrame(item, "video", item.previewSeconds);
  }, delay);
}

function mediaTaskIds(item: QueueItem) {
  return [
    `probe:${item.id}`,
    `preview-frame:${item.id}`,
    `thumbnail:${item.id}`,
    `preview-video:${item.id}`,
    `frame-index:${item.id}`,
    `detect:${item.id}`,
    `export:${item.id}`,
  ];
}

async function cancelItemMediaTasks(item: QueueItem) {
  try {
    await invoke("cancel_media_tasks", { taskIds: mediaTaskIds(item) });
  } catch (error) {
    console.warn("Failed to cancel media tasks", error);
  }
}

async function releasePreviewAssetPath(filePath: string, temporary: boolean) {
  if (!filePath) {
    return;
  }
  try {
    await invoke("delete_preview_asset", { filePath, temporary });
  } catch (error) {
    console.warn("Failed to release preview asset", error);
  }
}

async function releasePreviewAsset(item: QueueItem) {
  const filePath = item.previewAssetPath;
  const temporary = item.previewAssetTemporary;
  item.previewAssetPath = "";
  item.previewAssetTemporary = false;
  item.nativeVideoSrc = "";
  if (filePath) {
    await releasePreviewAssetPath(filePath, temporary);
  }
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

async function requestPreviewFrame(item: QueueItem, mode: MediaMode, previewSeconds?: number) {
  const context = currentContext(mode);
  if (!item?.inputPath) {
    return;
  }

  item.previewRevision += 1;
  const requestId = item.previewRevision;
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
      taskId: `preview-frame:${item.id}`,
    });
    if (
      requestId !== item.previewRevision ||
      currentContext(mode) !== context ||
      !context.items.includes(item)
    ) {
      return;
    }
    item.previewSrc = preview.dataUrl;
    if (!item.thumbnailSrc) {
      item.thumbnailSrc = preview.dataUrl;
    }
    item.status = "ready";
    item.errorMessage = "";
    if (mode === state.mode && currentItem(mode) === item) {
      applyPreviewSource();
      renderThumbs();
      drawCropBox();
      updateVideoTimelineUi();
    }
  } catch (error) {
    if (requestId !== item.previewRevision || !context.items.includes(item)) {
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

async function requestThumbnailFrame(
  item: QueueItem,
  mode: MediaMode,
  previewSeconds = 0,
) {
  if (item.thumbnailSrc || !item.inputPath) {
    return;
  }

  const context = currentContext(mode);
  const loadRevision = item.loadRevision;
  try {
    const preview = await invoke<PreviewDataUrlResult>("build_preview_data_url", {
      inputPath: item.inputPath,
      previewTimeSeconds: mode === "video" ? Math.max(0, previewSeconds) : undefined,
      taskId: `thumbnail:${item.id}`,
    });
    if (
      item.loadRevision !== loadRevision ||
      currentContext(mode) !== context ||
      !context.items.includes(item)
    ) {
      return;
    }
    item.thumbnailSrc = preview.dataUrl;
    if (mode === state.mode) {
      renderThumbs();
    }
  } catch (error) {
    console.warn("Failed to generate queue thumbnail", error);
  }
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
  const [removed] = context.items.splice(index, 1);
  if (removed) {
    void cancelItemMediaTasks(removed);
    void releasePreviewAsset(removed);
  }
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
  thumbsEl.replaceChildren();

  context.items.forEach((item, index) => {
    const ratio = item.settings.ratio === "free" ? "自由" : item.settings.ratio;
    const sourceSize = getItemSourceSize(item);
    const detail = item.lastProbe
      ? `${sourceSize.width || "-"}×${sourceSize.height || "-"}${item.lastProbe.duration_seconds ? ` · ${item.lastProbe.duration_seconds.toFixed(2)}s` : ""}`
      : item.status === "error"
        ? "读取失败"
        : "加载中...";
    const thumb = createQueueThumbnail(
      {
        active: index === context.currentIndex,
        disabled: isOperationBusy(),
        previewSrc: item.thumbnailSrc || item.previewSrc,
        fallbackLabel: state.mode === "image" ? "IMG" : "VID",
        name: item.materialName.trim() || "未命名素材",
        detail,
        ratio,
        detectionLabel: state.mode === "video" ? itemBlackBorderStatusLabel(item, true) : undefined,
        detectionStatus: state.mode === "video"
          ? ["detected", "no_border"].includes(item.blackBorderDetection.status)
              && !item.blackBorderDetection.resultApplied
            ? "unapplied"
            : item.blackBorderDetection.skipDetection ? "skipped" : item.blackBorderDetection.status
          : undefined,
      },
      () => {
        selectItem(index);
        renderCurrentContext();
      },
      () => {
        removeItem(index);
        renderCurrentContext();
      },
    );

    thumbsEl.appendChild(thumb);
  });

  if (listCountEl) {
    listCountEl.textContent = `${listLabel()} ${context.items.length}`;
  }
  updateModeUi();
}

function ratioValue(mode = state.mode, ratio = currentItem(mode)?.settings.ratio ?? "9:16") {
  if (ratio === "free") {
    return null;
  }
  const [width, height] = ratio.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function getItemCropBounds(item: QueueItem, mode: MediaMode): CropRect {
  const { width: sourceWidth, height: sourceHeight } = getItemSourceSize(item);
  const fullSource = {
    x: 0,
    y: 0,
    width: Math.max(0, sourceWidth),
    height: Math.max(0, sourceHeight),
  };

  if (
    mode !== "video" ||
    item.blackBorderDetection.status !== "detected" ||
    !item.blackBorderDetection.resultApplied
  ) {
    return fullSource;
  }

  return contentBoundsFromMargins(
    sourceWidth,
    sourceHeight,
    item.blackBorderDetection.margins,
  ) ?? fullSource;
}

function getCropBounds(mode = state.mode): CropRect {
  const item = currentItem(mode);
  return item
    ? getItemCropBounds(item, mode)
    : { x: 0, y: 0, width: 0, height: 0 };
}

function clampRect(mode = state.mode) {
  const rect = currentItem(mode)?.settings.rect;
  const bounds = getCropBounds(mode);
  if (!rect || bounds.width <= 0 || bounds.height <= 0) {
    return;
  }
  Object.assign(rect, clampRectToBounds(rect, bounds));
}

function positionRectByAnchor(mode = state.mode) {
  const item = currentItem(mode);
  const rect = item?.settings.rect;
  if (!rect) {
    return;
  }
  const bounds = getCropBounds(mode);
  const anchor = item?.settings.anchor ?? "center";
  Object.assign(rect, positionRectInBounds(rect, bounds, anchor));
}

function ensureRect(mode = state.mode, item: QueueItem | null = currentItem(mode)) {
  if (!item?.lastProbe) {
    return;
  }
  const bounds = getItemCropBounds(item, mode);
  const ratio = ratioValue(mode, item.settings.ratio);

  if (!item.settings.rect) {
    item.settings.rect = createRectForRatio(
      bounds,
      ratio,
      item.settings.scale,
      item.settings.anchor,
    );
  }

  item.settings.rect = clampRectToBounds(item.settings.rect, bounds);
}

function resizeRectByScale(mode = state.mode) {
  const item = currentItem(mode);
  if (!item?.lastProbe) {
    return;
  }
  const ratio = ratioValue(mode);
  const rect = item.settings.rect;
  if (!rect) {
    return;
  }
  const bounds = getCropBounds(mode);
  item.settings.rect = resizeRectAroundCenter(rect, bounds, item.settings.scale, ratio);
}

function clampVideoSettings(mode = state.mode, item: QueueItem | null = currentItem(mode)) {
  if (!item?.lastProbe || mode !== "video") return;
  item.videoTimeline = normalizeVideoTimeline(
    item.videoTimeline,
    item.videoFrameIndex.frameCount,
  );
  syncVideoRangeSeconds(item);
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
  const sourceSize = getProbeDisplaySize(probe);
  const parts = [
    `${sourceSize.width || "-"}×${sourceSize.height || "-"}`,
    probe.codec_name ?? probe.format_name ?? "unknown",
  ];
  if (probe.rotation_degrees) {
    parts.push(`旋转 ${probe.rotation_degrees}°`);
  }
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
      dropTitleEl.textContent = "拖入图片或视频";
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
  const bounds = getCropBounds();
  item.settings.scale = scaleForRect(item.settings.rect, bounds, ratio);
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
  syncBlackBorderDetectionUi();
  renderMediaSummary();
  syncFileNamingUi();
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

function normalizeDetectedRect(rect: CropRect, item: QueueItem) {
  const { width: sourceWidth, height: sourceHeight } = getItemSourceSize(item);
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.width < 2 ||
    rect.height < 2
  ) {
    return null;
  }

  const x = Math.max(0, Math.min(sourceWidth - 2, rect.x));
  const y = Math.max(0, Math.min(sourceHeight - 2, rect.y));
  return {
    x,
    y,
    width: Math.max(2, Math.min(rect.width, sourceWidth - x)),
    height: Math.max(2, Math.min(rect.height, sourceHeight - y)),
  };
}

function toggleBlackBorderResult(item: QueueItem) {
  const detection = item.blackBorderDetection;
  if (detection.resultApplied) {
    removeAppliedBlackBorderResult(item);
  } else {
    applyCachedBlackBorderResult(item);
  }
  ensureRect("video", item);
  refreshDetectionPresentation("video", item);
  updateCropDims();
}

function refreshDetectionPresentation(mode: MediaMode, item: QueueItem) {
  if (mode !== state.mode) {
    return;
  }
  renderThumbs();
  if (currentItem(mode) === item) {
    syncControlsFromState();
    syncBlackBorderDetectionUi();
    drawCropBox();
  }
  setButtonsDisabledState();
}

async function detectBlackBordersForItem(item: QueueItem, mode: MediaMode) {
  const detection = item.blackBorderDetection;
  if (!detection.resultApplied) {
    saveCropBeforeDetection(item);
  }
  detection.status = "detecting";
  detection.warning = "";
  detection.manuallyAdjusted = false;
  refreshDetectionPresentation(mode, item);

  if (mode !== "video" || !item.lastProbe) {
    detection.status = "failed";
    detection.warning = "尚未读取到有效的视频信息。";
    refreshDetectionPresentation(mode, item);
    return detection.status;
  }

  const totalDuration = item.lastProbe.duration_seconds ?? 0;
  const startSeconds = Math.max(0, item.settings.videoStartSeconds);
  const durationSeconds = totalDuration > 0
    ? Math.max(0, Math.min(item.settings.videoDurationSeconds, totalDuration - startSeconds))
    : undefined;

  try {
    const result = await invoke<BlackBorderDetectionResult>("detect_black_borders", {
      request: {
        taskId: `detect:${item.id}`,
        inputPath: item.inputPath,
        startSeconds,
        durationSeconds,
        sampleWindows: BLACK_BORDER_SAMPLE_WINDOWS,
      },
    });

    detection.status = result.status;
    detection.margins = result.margins;
    detection.confidence = result.confidence;
    detection.sampleCount = result.sampleCount;
    detection.agreeingSamples = result.agreeingSamples;
    detection.warning = result.warning ?? "";
    detection.manuallyAdjusted = false;
    detection.resultApplied = false;
    detection.detectedRect = null;

    if (result.status === "detected") {
      const nextRect = result.rect ? normalizeDetectedRect(result.rect, item) : null;
      if (!nextRect) {
        detection.status = "failed";
        detection.warning = detection.warning || "检测结果没有包含有效的裁切区域。";
      } else {
        detection.detectedRect = nextRect;
        applyCachedBlackBorderResult(item, false);
      }
    } else if (result.status === "no_border") {
      const { width, height } = getItemSourceSize(item);
      if (width > 0 && height > 0) {
        detection.detectedRect = { x: 0, y: 0, width, height };
        applyCachedBlackBorderResult(item, false);
      } else {
        detection.status = "failed";
        detection.warning = detection.warning || "无法确定视频的显示尺寸。";
      }
    }
    if (!detection.resultApplied) {
      restoreCropBeforeDetection(item);
    }
  } catch (error) {
    detection.status = "failed";
    detection.confidence = null;
    detection.sampleCount = 0;
    detection.agreeingSamples = 0;
    detection.warning = String(error);
    detection.resultApplied = false;
    detection.detectedRect = null;
    restoreCropBeforeDetection(item);
  }

  refreshDetectionPresentation(mode, item);
  return detection.status;
}

function setModeProgress(mode: MediaMode, percent: number, text: string) {
  const context = currentContext(mode);
  context.progressPercent = Math.max(0, Math.min(100, percent));
  context.progressText = text;
  if (mode === state.mode) {
    setProgress(context.progressPercent, context.progressText);
  }
}

async function runBlackBorderDetection(
  items: QueueItem[],
  mode: MediaMode,
  automatic = false,
  includeSkipped = false,
) {
  if (mode !== "video" || items.length === 0 || state.exportBusy || state.detectionBusy) {
    return;
  }

  const context = currentContext(mode);
  const candidates = includeSkipped ? items : getBlackBorderDetectionCandidates(items);
  const skippedCount = items.length - candidates.length;
  if (candidates.length === 0) {
    const message = "未开始黑边检测：所选视频均已设置为跳过检测。";
    context.log = message;
    setModeProgress(mode, 0, message);
    if (mode === state.mode) {
      renderCurrentContext();
    }
    return;
  }
  state.detectionBusy = true;
  setButtonsDisabledState();
  const logLines: string[] = [];

  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      const prefix = automatic ? "正在自动检测" : "正在检测";
      const progressText = `${prefix}黑边 ${index + 1}/${candidates.length}：${item.name}`;
      context.log = progressText;
      if (mode === state.mode && logOutputEl) {
        logOutputEl.textContent = context.log;
      }
      setModeProgress(mode, (index / candidates.length) * 100, progressText);

      const status = await detectBlackBordersForItem(item, mode);
      logLines.push(`[${index + 1}/${candidates.length}] ${item.name}：${blackBorderStatusLabel(status)}`);
      setModeProgress(mode, ((index + 1) / candidates.length) * 100, `黑边检测 ${index + 1}/${candidates.length} 完成`);
    }

    const reviewCount = candidates.filter((item) => item.blackBorderDetection.status === "needs_review").length;
    const failedCount = candidates.filter((item) => item.blackBorderDetection.status === "failed").length;
    const appliedCount = candidates.length - reviewCount - failedCount;
    const skippedSummary = skippedCount > 0 ? `，${skippedCount} 个已跳过` : "";
    const summary = `黑边检测完成：${appliedCount} 个已应用，${reviewCount} 个需确认，${failedCount} 个失败${skippedSummary}。`;
    context.log = [summary, "", ...logLines].join("\n");
    setModeProgress(mode, 100, summary);
  } finally {
    state.detectionBusy = false;
    if (mode === state.mode) {
      renderCurrentContext();
    } else {
      setButtonsDisabledState();
    }
  }
}

async function buildExactVideoFrameIndex(
  item: QueueItem,
  mode: MediaMode,
  loadRevision: number,
) {
  if (!item.lastProbe?.variable_frame_rate) {
    return;
  }
  item.videoFrameIndex.status = "indexing";
  item.videoFrameIndex.warning = "";
  if (mode === state.mode && currentItem(mode) === item) {
    updateVideoTimelineUi();
  }
  const oldStart = item.settings.videoStartSeconds;
  const oldEnd = getVideoSegmentEnd(item);
  const oldPlayhead = item.previewSeconds;
  try {
    const result = await invoke<VideoFrameIndexResult>("build_video_frame_index", {
      inputPath: item.inputPath,
      durationSeconds: item.lastProbe.duration_seconds,
      taskId: `frame-index:${item.id}`,
    });
    if (
      item.loadRevision !== loadRevision
      || !currentContext(mode).items.includes(item)
    ) {
      return;
    }
    item.videoFrameIndex = applyFrameBoundaries(
      item.videoFrameIndex,
      result.boundaries_seconds,
      item.lastProbe.duration_seconds ?? 0,
    );
    const index = item.videoFrameIndex;
    const playheadFrame = secondsToIndexedFrame(oldPlayhead, index);
    const nextTimeline = createVideoTimelineState(index, playheadFrame);
    nextTimeline.startFrame = secondsToIndexedFrame(oldStart, index);
    nextTimeline.endFrameExclusive = oldEnd >= (item.lastProbe.duration_seconds ?? oldEnd)
      ? index.frameCount
      : Math.min(index.frameCount, secondsToIndexedFrame(Math.max(0, oldEnd - 0.000_001), index) + 1);
    item.videoTimeline = normalizeVideoTimeline(nextTimeline, index.frameCount);
    syncVideoRangeSeconds(item);
  } catch (error) {
    if (
      item.loadRevision !== loadRevision
      || !currentContext(mode).items.includes(item)
    ) {
      return;
    }
    item.videoFrameIndex.status = "approximate";
    item.videoFrameIndex.warning = `帧索引失败，当前仅能近似到帧：${String(error)}`;
  }
  if (mode === state.mode && currentItem(mode) === item) {
    updateVideoTimelineUi();
  }
}

async function autoProbeMedia(item: QueueItem, mode: MediaMode) {
  const context = currentContext(mode);
  if (!item?.inputPath) {
    return;
  }

  item.loadRevision += 1;
  const loadRevision = item.loadRevision;
  context.log = "正在自动调用 ffprobe 读取媒体信息...";
  if (mode === state.mode && currentItem(mode) === item) {
    setMediaSummary("正在自动读取媒体信息...");
    renderCurrentContext();
  }

  try {
    const result = await invoke<ProbeResult>("probe_media", {
      inputPath: item.inputPath,
      taskId: `probe:${item.id}`,
    });
    if (item.loadRevision !== loadRevision || !context.items.includes(item)) {
      return;
    }

    if (result.media_kind !== mode) {
      throw new Error(`文件实际类型为${result.media_kind === "video" ? "视频" : "图片"}，与导入队列不一致`);
    }

    item.lastProbe = result;
    if (mode === "video") {
      item.videoFrameIndex = createVideoFrameIndex(result);
      item.videoTimeline = createVideoTimelineState(item.videoFrameIndex);
    }
    clampVideoSettings(mode, item);
    item.settings.rect = null;
    context.log = "媒体信息读取成功，可以直接拖拽裁剪框或调整参数。";
    ensureRect(mode, item);
    if (mode === "video") {
      const totalDuration = Math.max(0, result.duration_seconds ?? item.settings.videoDurationSeconds);
      item.videoTimeline = createVideoTimelineState(item.videoFrameIndex);
      item.settings.videoStartSeconds = 0;
      item.settings.videoDurationSeconds = totalDuration;
      item.previewSeconds = 0;
      clampVideoSettings(mode, item);
      void buildExactVideoFrameIndex(item, mode, loadRevision);
      if (autoDetectBlackBordersEl?.checked ?? false) {
        await runBlackBorderDetection([item], mode, true);
        if (item.loadRevision !== loadRevision || !context.items.includes(item)) {
          return;
        }
      }
      if (canUseNativeVideoPreview(item)) {
        try {
          const previewVideo = await invoke<PreviewVideoAssetResult>("build_preview_video_asset", {
            inputPath: item.inputPath,
            taskId: `preview-video:${item.id}`,
          });
          if (item.loadRevision !== loadRevision || !context.items.includes(item)) {
            await releasePreviewAssetPath(previewVideo.filePath, previewVideo.temporary);
            return;
          }
          await releasePreviewAsset(item);
          item.previewAssetPath = previewVideo.filePath;
          item.previewAssetTemporary = previewVideo.temporary;
          item.nativeVideoSrc = convertFileSrc(previewVideo.filePath);
          item.previewSrc = "";
          item.status = "ready";
          item.errorMessage = "";
          await requestThumbnailFrame(item, mode, item.previewSeconds);
        } catch (previewError) {
          await releasePreviewAsset(item);
          context.log = `代理视频预览生成失败，已回退静态预览：${String(previewError)}`;
          await requestPreviewFrame(item, mode, item.previewSeconds);
        }
      } else {
        await requestPreviewFrame(item, mode, item.previewSeconds);
      }
    } else {
      item.previewSeconds = 0;
      await requestPreviewFrame(item, mode, item.previewSeconds);
    }
    if (mode === state.mode && currentItem(mode) === item) {
      renderCurrentContext();
    }
  } catch (error) {
    if (item.loadRevision !== loadRevision || !context.items.includes(item)) {
      return;
    }
    item.previewSrc = "";
    item.status = "error";
    item.errorMessage = String(error);
    context.log = `自动读取媒体信息失败：${String(error)}`;
    if (mode === state.mode && currentItem(mode) === item) {
      renderCurrentContext();
      setMediaSummary("媒体信息读取失败");
    }
  }
}

function existingMediaPaths() {
  return new Set(
    (["image", "video"] as const).flatMap((mode) =>
      currentContext(mode).items.map((item) => item.inputPath),
    ),
  );
}

async function importRoutedFiles(files: RoutedMediaFile[]) {
  const queued = files.map(({ mode, path }) => {
    const context = currentContext(mode);
    const item = createQueueItem(mode, path);
    context.items.push(item);
    context.currentIndex = context.items.length - 1;
    context.progressPercent = 0;
    context.progressText = "等待导出...";
    context.log = "正在准备素材...";
    return { mode, item };
  });

  if (!queued.some(({ mode }) => mode === state.mode)) {
    state.mode = queued[queued.length - 1]?.mode ?? state.mode;
  }
  renderCurrentContext();
  for (const { mode, item } of queued) {
    await autoProbeMedia(item, mode);
  }

  const imageCount = queued.filter(({ mode }) => mode === "image").length;
  const videoCount = queued.length - imageCount;
  const summaryParts = [
    imageCount > 0 ? `${imageCount} 张图片` : "",
    videoCount > 0 ? `${videoCount} 个视频` : "",
  ].filter(Boolean);
  const summary = `导入完成：${summaryParts.join("、")}`;
  if (imageCount > 0) currentContext("image").log = summary;
  if (videoCount > 0) currentContext("video").log = summary;
}

async function runImport(files: RoutedMediaFile[]) {
  if (files.length === 0 || isOperationBusy()) {
    return false;
  }

  state.importBusy = true;
  setButtonsDisabledState();
  try {
    await importRoutedFiles(files);
    return true;
  } finally {
    state.importBusy = false;
    renderCurrentContext();
  }
}

async function pickInputFile() {
  if (isOperationBusy()) {
    return;
  }

  state.importBusy = true;
  setButtonsDisabledState();
  try {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "图片和视频",
          extensions: [...ALL_MEDIA_EXTENSIONS],
        },
      ],
    });

    if (!selected) {
      setLog("已取消文件选择。");
      return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];
    const routed = routeMediaPaths(paths, existingMediaPaths());
    if (routed.accepted.length === 0) {
      const reasons = [];
      if (routed.unsupported.length > 0) reasons.push(`${routed.unsupported.length} 个不支持的文件`);
      if (routed.duplicates.length > 0) reasons.push(`${routed.duplicates.length} 个重复文件`);
      setLog(reasons.length > 0 ? `没有可导入的素材：${reasons.join("、")}。` : "没有检测到可导入的文件。");
      return;
    }
    await importRoutedFiles(routed.accepted);
    if (routed.duplicates.length > 0) {
      const context = currentContext();
      context.log = `${context.log}\n已忽略 ${routed.duplicates.length} 个重复文件。`;
    }
  } finally {
    state.importBusy = false;
    renderCurrentContext();
  }
}

async function exportSampleCrop() {
  const item = currentItem();
  if (!item) {
    setLog(`请先选择输入${state.mode === "image" ? "图片" : "视频"}。`);
    return;
  }

  if (!item.lastProbe) {
    await autoProbeMedia(item, state.mode);
    if (!currentItem()?.lastProbe) {
      return;
    }
  }

  const isImage = state.mode === "image";
  const outputExtension = isImage ? getImageFormatExtension() : "mp4";
  const suggestedName = buildExportFileName(currentContext().items, item.id, outputExtension);
  if (!suggestedName) {
    setLog("请先为当前素材填写有效的素材名称。");
    materialNameInput?.focus();
    materialNameInput?.select();
    return;
  }
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
    taskId: `export:${item.id}`,
    inputPath: item.inputPath,
    outputPath,
    avoidOverwrite: false,
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

  const invalidNameIndex = items.findIndex((item) => !sanitizeMaterialName(item.materialName));
  if (invalidNameIndex >= 0) {
    context.currentIndex = invalidNameIndex;
    renderCurrentContext();
    setLog("批量导出前，请先为所有素材填写有效的素材名称。");
    materialNameInput?.focus();
    materialNameInput?.select();
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
  const exportBaseNames = buildExportBaseNames(items);

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

    const exportBaseName = exportBaseNames.get(item.id);
    if (!exportBaseName) {
      failedCount += 1;
      logLines.push(`[${i + 1}/${items.length}] ${item.name} 导出失败：素材名称无效`);
      batchState.completedItems = i + 1;
      continue;
    }
    const outputExtension = isImage ? item.settings.imageFormat : "mp4";
    const outputPath = `${outputDir}/${exportBaseName}.${outputExtension}`;

    const request: ExportRequest = {
      taskId: `export:${item.id}`,
      inputPath: item.inputPath,
      outputPath,
      avoidOverwrite: true,
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
      imageFormat: isImage ? item.settings.imageFormat : undefined,
      imageQuality: isImage ? item.settings.imageQuality : undefined,
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

async function handleDroppedPaths(paths: string[]) {
  if (isOperationBusy()) {
    setLog("当前正在执行其他操作，请完成后再拖入素材。");
    return;
  }

  const routed = routeMediaPaths(paths, existingMediaPaths());
  if (routed.accepted.length === 0) {
    const reasons = [];
    if (routed.unsupported.length > 0) reasons.push(`${routed.unsupported.length} 个不支持的文件`);
    if (routed.duplicates.length > 0) reasons.push(`${routed.duplicates.length} 个重复文件`);
    setLog(reasons.length > 0 ? `没有可导入的素材：${reasons.join("、")}。` : "没有检测到可导入的文件。");
    return;
  }

  const imported = await runImport(routed.accepted);
  if (!imported) {
    return;
  }

  const notes = [];
  if (routed.unsupported.length > 0) notes.push(`已忽略 ${routed.unsupported.length} 个不支持的文件`);
  if (routed.duplicates.length > 0) notes.push(`已忽略 ${routed.duplicates.length} 个重复文件`);
  if (notes.length > 0) {
    const context = currentContext();
    context.log = `${context.log}\n${notes.join("；")}。`;
    renderCurrentContext();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const savedAutoDetection = localStorage.getItem("media-cropper-auto-detect-black-borders");
  if (autoDetectBlackBordersEl && savedAutoDetection !== null) {
    autoDetectBlackBordersEl.checked = savedAutoDetection === "true";
  }
  void bindExportProgressEvents();
  void bindFileDropEvents(previewStageEl, handleDroppedPaths).catch((error) => {
    setLog(`文件拖拽监听初始化失败：${String(error)}`);
  });
  bindCropDragging({
    cropBoxEl,
    currentMediaEl,
    getSourceWidth,
    currentItem,
    isBusy: isOperationBusy,
    markAdjusted: markCropManuallyAdjusted,
    ratioValue,
    getBounds: getCropBounds,
    clampRect,
    syncScaleFromRect,
    drawCropBox,
  });
  bindAppUpdater({
    checkButton: updateCheckButton,
    overlay: updateOverlayEl,
    version: updateVersionEl,
    notes: updateNotesEl,
    status: updateStatusEl,
    error: updateErrorEl,
    progressShell: updateProgressShellEl,
    progressFill: updateProgressFillEl,
    progressText: updateProgressTextEl,
    laterButton: updateLaterButton,
    installButton: updateInstallButton,
  }, {
    canInstall: () => !isOperationBusy(),
  });
  updateModeUi();
  syncControlsFromState();
  setButtonsDisabledState();
  clearPreviewDom();
  renderCurrentContext();

  materialNameInput?.addEventListener("focus", () => {
    materialNameInput.select();
  });
  materialNameInput?.addEventListener("input", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    item.materialName = materialNameInput.value;
    renderThumbs();
    syncFileNamingUi();
    setButtonsDisabledState();
  });
  materialNameInput?.addEventListener("change", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    item.materialName = sanitizeMaterialName(materialNameInput.value);
    materialNameInput.value = item.materialName;
    renderThumbs();
    syncFileNamingUi();
    setButtonsDisabledState();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "F2" || !currentItem() || isOperationBusy()) {
      return;
    }
    event.preventDefault();
    materialNameInput?.focus();
    materialNameInput?.select();
  });

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

  detectCurrentButton?.addEventListener("click", () => {
    const item = currentItem("video");
    if (!item) {
      return;
    }
    void runBlackBorderDetection([item], "video", false, true);
  });

  detectAllButton?.addEventListener("click", () => {
    void runBlackBorderDetection([...currentContext("video").items], "video");
  });

  autoDetectBlackBordersEl?.addEventListener("change", () => {
    localStorage.setItem("media-cropper-auto-detect-black-borders", String(autoDetectBlackBordersEl.checked));
  });

  skipBlackBorderDetectionEl?.addEventListener("change", () => {
    const item = currentItem("video");
    if (!item) {
      return;
    }
    item.blackBorderDetection.skipDetection = skipBlackBorderDetectionEl.checked;
    syncBlackBorderDetectionUi();
    renderThumbs();
    setButtonsDisabledState();
  });

  toggleBlackBorderResultButton?.addEventListener("click", () => {
    const item = currentItem("video");
    if (!item || !["detected", "no_border"].includes(item.blackBorderDetection.status)) {
      return;
    }
    toggleBlackBorderResult(item);
  });

  ratioSelect?.addEventListener("change", () => {
    const item = currentItem();
    if (!item) {
      return;
    }
    item.settings.ratio = getSelectedRatio();
    markCropManuallyAdjusted(item);
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
    markCropManuallyAdjusted(item);
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
    markCropManuallyAdjusted(item);
    item.settings.scale = getSelectedScale();
    updateScaleLabel();
    if (!item.settings.rect) {
      ensureRect();
    } else {
      resizeRectByScale();
    }
    drawCropBox();
    renderThumbs();
  });

  imageFormatSelect?.addEventListener("change", () => {
    const item = currentItem();
    if (item) {
      item.settings.imageFormat = getImageFormatExtension();
    }
  });
  videoPreviewToggleEl?.addEventListener("click", () => {
    const item = currentItem();
    if (!item || state.mode !== "video") {
      return;
    }
    closeFineTune();
    cancelScheduledVideoPreview();
    if (videoPreviewPlaying) {
      stopVideoPlayback();
      updateVideoTimelineUi();
      return;
    }
    startVideoPlayback();
  });

  type TimelineRole = "start" | "end" | "playhead";
  let activeTimelineDrag: {
    role: TimelineRole;
    fine: boolean;
  } | null = null;

  const timelineFrameAtPointer = (
    track: HTMLElement,
    clientX: number,
    fine: boolean,
    role: TimelineRole,
  ) => {
    const item = currentItem();
    if (!item) return 0;
    const rect = track.getBoundingClientRect();
    const start = fine ? item.videoTimeline.viewStartFrame : 0;
    const end = fine
      ? item.videoTimeline.viewEndFrameExclusive
      : item.videoFrameIndex.frameCount;
    return frameFromTrackPosition(
      clientX,
      rect.left,
      rect.width,
      start,
      end,
      role === "end",
    );
  };

  const beginTimelineDrag = (
    event: PointerEvent,
    track: HTMLElement,
    fine: boolean,
  ) => {
    const item = currentItem();
    if (!item || state.mode !== "video") return;
    const target = event.target as HTMLElement;
    const role = fine && activeFineTune?.itemId === item.id
      ? activeFineTune.role
      : (target.closest<HTMLElement>("[data-timeline-role]")
        ?.dataset.timelineRole ?? "playhead") as TimelineRole;
    target.closest<HTMLButtonElement>("button")?.focus();
    if (role === "playhead") {
      closeFineTune();
    }
    activeTimelineDrag = { role, fine };
    setTimelineRoleFrame(
      item,
      role,
      timelineFrameAtPointer(track, event.clientX, fine, role),
      !fine && role !== "playhead",
    );
    event.preventDefault();
  };

  videoMainTrackEl?.addEventListener("pointerdown", (event) => {
    beginTimelineDrag(event, videoMainTrackEl, false);
  });
  videoFineTrackEl?.addEventListener("pointerdown", (event) => {
    const item = currentItem();
    if (!item || activeFineTune?.itemId !== item.id) return;
    beginTimelineDrag(event, videoFineTrackEl, true);
  });
  window.addEventListener("pointermove", (event) => {
    const item = currentItem();
    if (!activeTimelineDrag || !item || state.mode !== "video") return;
    const track = activeTimelineDrag.fine ? videoFineTrackEl : videoMainTrackEl;
    if (!track) return;
    setTimelineRoleFrame(
      item,
      activeTimelineDrag.role,
      timelineFrameAtPointer(
        track,
        event.clientX,
        activeTimelineDrag.fine,
        activeTimelineDrag.role,
      ),
      !activeTimelineDrag.fine && activeTimelineDrag.role !== "playhead",
    );
  });
  window.addEventListener("pointerup", () => {
    const item = currentItem();
    const finishedDrag = activeTimelineDrag;
    activeTimelineDrag = null;
    if (!finishedDrag || !item) return;
    if (!usingNativeVideoPreview(item)) {
      previewTimelineFrame(item, item.videoTimeline.playheadFrame, true);
    }
    if (finishedDrag.role === "start" || finishedDrag.role === "end") {
      openFineTune(item, finishedDrag.role);
    }
  });

  const bindTimelineKeyboard = (
    element: HTMLButtonElement | null,
    role: TimelineRole,
  ) => {
    element?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const item = currentItem();
      if (!item || state.mode !== "video") return;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const step = event.shiftKey ? 10 : 1;
      const current = role === "start"
        ? item.videoTimeline.startFrame
        : role === "end"
          ? item.videoTimeline.endFrameExclusive
          : item.videoTimeline.playheadFrame;
      setTimelineRoleFrame(item, role, current + direction * step, true);
      if (role === "start" || role === "end") {
        openFineTune(item, role);
      }
      event.preventDefault();
    });
  };
  bindTimelineKeyboard(videoMainStartEl, "start");
  bindTimelineKeyboard(videoMainEndEl, "end");
  bindTimelineKeyboard(videoMainPlayheadEl, "playhead");
  videoFineHandleEl?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const item = currentItem();
    if (!item || activeFineTune?.itemId !== item.id) return;
    const role = activeFineTune.role;
    const current = role === "start"
      ? item.videoTimeline.startFrame
      : item.videoTimeline.endFrameExclusive;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setTimelineRoleFrame(item, role, current + direction * (event.shiftKey ? 10 : 1));
    event.preventDefault();
  });
  videoFineStepEls.forEach((button) => {
    button.addEventListener("click", () => {
      const item = currentItem();
      if (!item || activeFineTune?.itemId !== item.id) return;
      const role = activeFineTune.role;
      const current = role === "start"
        ? item.videoTimeline.startFrame
        : item.videoTimeline.endFrameExclusive;
      setTimelineRoleFrame(item, role, current + Number(button.dataset.fineStep ?? 0));
      videoFineHandleEl?.focus();
    });
  });
  videoFineDoneEl?.addEventListener("click", () => {
    closeFineTune();
    updateVideoTimelineUi();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeFineTune) return;
    closeFineTune();
    updateVideoTimelineUi();
  });

  previewVideoEl?.addEventListener("loadedmetadata", () => {
    const item = currentItem();
    if (!item || !usingNativeVideoPreview(item) || !previewVideoEl) {
      return;
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
    const nextFrame = secondsToIndexedFrame(
      previewVideoEl.currentTime,
      item.videoFrameIndex,
    );
    item.videoTimeline.playheadFrame = videoPreviewPlaying
      ? Math.max(
          item.videoTimeline.startFrame,
          Math.min(item.videoTimeline.endFrameExclusive - 1, nextFrame),
        )
      : nextFrame;
    syncVideoRangeSeconds(item);
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
    void releasePreviewAsset(item);
    item.videoTimeline.playheadFrame = item.videoTimeline.startFrame;
    syncVideoRangeSeconds(item);
    setLog("当前视频无法在预览区原生播放，已回退为静态帧预览。");
    void requestPreviewFrame(item, "video", item.previewSeconds);
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
    const sourceBounds = getItemCropBounds(source, state.mode);
    const relativeRect = {
      x: (sourceRect.x - sourceBounds.x) / sourceBounds.width,
      y: (sourceRect.y - sourceBounds.y) / sourceBounds.height,
      width: sourceRect.width / sourceBounds.width,
      height: sourceRect.height / sourceBounds.height,
    };
    const sourceRatio = source.settings.ratio;
    const fixedRatio = ratioValue(state.mode, sourceRatio);
    const sourceFit = fixedRatio
      ? maxFit(sourceBounds.width, sourceBounds.height, fixedRatio)
      : null;
    const actualScale = sourceFit ? Math.max(0.1, Math.min(1, sourceRect.width / sourceFit.width)) : source.settings.scale;

    context.items.forEach((item) => {
      markCropManuallyAdjusted(item);
      item.settings.ratio = source.settings.ratio;
      item.settings.anchor = source.settings.anchor;
      item.settings.scale = actualScale;
      item.settings.imageFormat = source.settings.imageFormat;
      item.settings.imageQuality = source.settings.imageQuality;
      item.settings.videoStartSeconds = source.settings.videoStartSeconds;
      item.settings.videoDurationSeconds = source.settings.videoDurationSeconds;
      if (state.mode === "video" && item.lastProbe) {
        const targetEnd = source.settings.videoStartSeconds + source.settings.videoDurationSeconds;
        item.videoTimeline.startFrame = secondsToIndexedFrame(
          source.settings.videoStartSeconds,
          item.videoFrameIndex,
        );
        item.videoTimeline.endFrameExclusive = Math.min(
          item.videoFrameIndex.frameCount,
          secondsToIndexedFrame(Math.max(0, targetEnd - 0.000_001), item.videoFrameIndex) + 1,
        );
        item.videoTimeline.playheadFrame = item.videoTimeline.startFrame;
        item.videoTimeline = centerTimelineView(
          item.videoTimeline,
          item.videoTimeline.startFrame,
          item.videoFrameIndex.frameCount,
        );
        clampVideoSettings("video", item);
        invalidateDetectionForSegmentChange(item);
      }

      const targetBounds = getItemCropBounds(item, state.mode);
      if (!targetBounds.width || !targetBounds.height) {
        item.settings.rect = null;
        return;
      }

      if (sourceRatio === "free") {
        item.settings.rect = {
          x: targetBounds.x + relativeRect.x * targetBounds.width,
          y: targetBounds.y + relativeRect.y * targetBounds.height,
          width: relativeRect.width * targetBounds.width,
          height: relativeRect.height * targetBounds.height,
        };
      } else if (fixedRatio) {
        const fit = maxFit(targetBounds.width, targetBounds.height, fixedRatio);
        const rectWidth = fit.width * actualScale;
        const rectHeight = fit.height * actualScale;
        const travelX = Math.max(0, targetBounds.width - rectWidth);
        const travelY = Math.max(0, targetBounds.height - rectHeight);
        const sourceTravelX = Math.max(0, sourceBounds.width - sourceRect.width);
        const sourceTravelY = Math.max(0, sourceBounds.height - sourceRect.height);
        const positionX = sourceTravelX
          ? (sourceRect.x - sourceBounds.x) / sourceTravelX
          : 0.5;
        const positionY = sourceTravelY
          ? (sourceRect.y - sourceBounds.y) / sourceTravelY
          : 0.5;
        item.settings.rect = {
          x: targetBounds.x + travelX * positionX,
          y: targetBounds.y + travelY * positionY,
          width: rectWidth,
          height: rectHeight,
        };
      }

      if (item.settings.rect) {
        item.settings.rect = clampRectToBounds(item.settings.rect, targetBounds);
      }
    });

    setLog(`已应用到全部${listLabel()}`);
    renderCurrentContext();
  });
  clearQueueButton?.addEventListener("click", () => {
    const context = currentContext();
    if (isOperationBusy()) {
      return;
    }
    const items = context.items;
    context.items = [];
    items.forEach((item) => {
      void cancelItemMediaTasks(item);
      void releasePreviewAsset(item);
    });
    context.currentIndex = -1;
    context.log = "等待操作...";
    context.progressPercent = 0;
    context.progressText = "等待导出...";
    renderCurrentContext();
  });
  previewImageEl?.addEventListener("load", () => {
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
