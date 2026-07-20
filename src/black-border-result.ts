import type { CropRect } from "./crop-geometry";
import type { QueueItem } from "./media-model";

function cloneCropRect(rect: CropRect | null) {
  return rect ? { ...rect } : null;
}

export function saveCropBeforeDetection(item: QueueItem) {
  item.blackBorderDetection.cropBeforeDetection = {
    ratio: item.settings.ratio,
    anchor: item.settings.anchor,
    scale: item.settings.scale,
    rect: cloneCropRect(item.settings.rect),
  };
}

export function restoreCropBeforeDetection(item: QueueItem) {
  const snapshot = item.blackBorderDetection.cropBeforeDetection;
  if (!snapshot) {
    return;
  }
  item.settings.ratio = snapshot.ratio;
  item.settings.anchor = snapshot.anchor;
  item.settings.scale = snapshot.scale;
  item.settings.rect = cloneCropRect(snapshot.rect);
}

export function applyCachedBlackBorderResult(item: QueueItem, captureCurrentCrop = true) {
  const detection = item.blackBorderDetection;
  if (!["detected", "no_border"].includes(detection.status) || !detection.detectedRect) {
    return false;
  }
  if (captureCurrentCrop && !detection.resultApplied) {
    saveCropBeforeDetection(item);
  }
  item.settings.ratio = "free";
  item.settings.scale = 1;
  item.settings.rect = cloneCropRect(detection.detectedRect);
  detection.resultApplied = true;
  detection.manuallyAdjusted = false;
  return true;
}

export function removeAppliedBlackBorderResult(item: QueueItem) {
  item.blackBorderDetection.resultApplied = false;
  item.blackBorderDetection.manuallyAdjusted = false;
  restoreCropBeforeDetection(item);
}
