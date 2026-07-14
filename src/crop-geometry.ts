export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CropMargins = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function contentBoundsFromMargins(
  sourceWidth: number,
  sourceHeight: number,
  margins: CropMargins,
): CropRect | null {
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    ![margins.left, margins.top, margins.right, margins.bottom].every(Number.isFinite)
  ) {
    return null;
  }

  const left = Math.max(0, Math.min(sourceWidth, margins.left));
  const top = Math.max(0, Math.min(sourceHeight, margins.top));
  const right = Math.max(0, Math.min(sourceWidth - left, margins.right));
  const bottom = Math.max(0, Math.min(sourceHeight - top, margins.bottom));
  const width = sourceWidth - left - right;
  const height = sourceHeight - top - bottom;

  return width >= 2 && height >= 2
    ? { x: left, y: top, width, height }
    : null;
}

export function maxFit(width: number, height: number, ratio: number) {
  const currentRatio = width / height;
  if (currentRatio > ratio) {
    return { width: height * ratio, height };
  }
  return { width, height: width / ratio };
}

export function clampRectToBounds(rect: CropRect, bounds: CropRect): CropRect {
  const width = Math.max(2, Math.min(rect.width, bounds.width));
  const height = Math.max(2, Math.min(rect.height, bounds.height));
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, rect.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, rect.y)),
    width,
    height,
  };
}

export function positionRectInBounds(
  rect: CropRect,
  bounds: CropRect,
  anchor: string,
): CropRect {
  let x: number;
  let y: number;

  if (["lt", "left", "lb"].includes(anchor)) {
    x = bounds.x;
  } else if (["rt", "right", "rb"].includes(anchor)) {
    x = bounds.x + bounds.width - rect.width;
  } else {
    x = bounds.x + (bounds.width - rect.width) / 2;
  }

  if (["lt", "top", "rt"].includes(anchor)) {
    y = bounds.y;
  } else if (["lb", "bottom", "rb"].includes(anchor)) {
    y = bounds.y + bounds.height - rect.height;
  } else {
    y = bounds.y + (bounds.height - rect.height) / 2;
  }

  return clampRectToBounds({ ...rect, x, y }, bounds);
}

export function createRectForRatio(
  bounds: CropRect,
  ratio: number | null,
  scale: number,
  anchor: string,
): CropRect {
  if (ratio === null) {
    return { ...bounds };
  }

  const fitted = maxFit(bounds.width, bounds.height, ratio);
  const safeScale = Number.isFinite(scale) ? Math.max(0.1, Math.min(1, scale)) : 1;
  return positionRectInBounds(
    {
      x: bounds.x,
      y: bounds.y,
      width: fitted.width * safeScale,
      height: fitted.height * safeScale,
    },
    bounds,
    anchor,
  );
}
