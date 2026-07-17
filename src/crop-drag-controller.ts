import type { CropRect } from "./crop-geometry";
import type { QueueItem } from "./media-model";

type HandleMode = "move" | "nw" | "ne" | "sw" | "se";

export type CropDragBindings = {
  cropBoxEl: HTMLElement | null;
  currentMediaEl: () => HTMLElement | null;
  getSourceWidth: () => number;
  currentItem: () => QueueItem | null;
  isBusy: () => boolean;
  markAdjusted: (item: QueueItem) => void;
  ratioValue: () => number | null;
  getBounds: () => CropRect;
  clampRect: () => void;
  syncScaleFromRect: () => void;
  drawCropBox: () => void;
};

export function bindCropDragging(bindings: CropDragBindings) {
  let mode: HandleMode | null = null;
  let startRect: CropRect | null = null;
  let startX = 0;
  let startY = 0;

  function mediaScale() {
    const mediaEl = bindings.currentMediaEl();
    const sourceWidth = bindings.getSourceWidth();
    return mediaEl && sourceWidth ? mediaEl.clientWidth / sourceWidth : 1;
  }

  bindings.cropBoxEl?.addEventListener("mousedown", (event) => {
    const item = bindings.currentItem();
    if (!item?.lastProbe || !item.settings.rect || bindings.isBusy()) {
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
    const item = bindings.currentItem();
    if (!mode || !startRect || !item?.lastProbe || !item.settings.rect) {
      return;
    }

    bindings.markAdjusted(item);

    const scale = mediaScale();
    const dx = (event.clientX - startX) / scale;
    const dy = (event.clientY - startY) / scale;
    const ratio = bindings.ratioValue();
    const bounds = bindings.getBounds();
    const boundsRight = bounds.x + bounds.width;
    const boundsBottom = bounds.y + bounds.height;

    if (mode === "move") {
      item.settings.rect.x = Math.max(
        bounds.x,
        Math.min(boundsRight - startRect.width, startRect.x + dx),
      );
      item.settings.rect.y = Math.max(
        bounds.y,
        Math.min(boundsBottom - startRect.height, startRect.y + dy),
      );
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

      x1 = Math.max(bounds.x, Math.min(x1, x2 - 20));
      y1 = Math.max(bounds.y, Math.min(y1, y2 - 20));
      x2 = Math.min(boundsRight, Math.max(x2, x1 + 20));
      y2 = Math.min(boundsBottom, Math.max(y2, y1 + 20));
      item.settings.rect = {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
      };
      bindings.syncScaleFromRect();
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

      if (nextX < bounds.x) {
        const overflow = bounds.x - nextX;
        nextWidth -= overflow;
        nextHeight = nextWidth / ratio;
        nextX = bounds.x;
      }
      if (nextY < bounds.y) {
        nextY = bounds.y;
      }
      if (nextX + nextWidth > boundsRight) {
        nextWidth = boundsRight - nextX;
        nextHeight = nextWidth / ratio;
      }
      if (nextY + nextHeight > boundsBottom) {
        nextHeight = boundsBottom - nextY;
        nextWidth = nextHeight * ratio;
      }

      item.settings.rect = {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextWidth / ratio,
      };
      bindings.clampRect();
      bindings.syncScaleFromRect();
    }

    bindings.drawCropBox();
  });

  window.addEventListener("mouseup", () => {
    mode = null;
    startRect = null;
  });
}
