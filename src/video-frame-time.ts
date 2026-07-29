import type {
  ProbeResult,
  VideoFrameIndex,
  VideoTimelineState,
} from "./media-model";

export const DEFAULT_VIDEO_FRAME_RATE = 30;
export const DEFAULT_DETAIL_WINDOW_SECONDS = 10;

function validPositiveNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: number | null | undefined, fallback: number) {
  return validPositiveNumber(value) ? Math.max(1, Math.round(value!)) : fallback;
}

export function getVideoFrameRate(probe: ProbeResult | null | undefined) {
  if (
    validPositiveNumber(probe?.frame_rate_numerator)
    && validPositiveNumber(probe?.frame_rate_denominator)
  ) {
    return probe!.frame_rate_numerator! / probe!.frame_rate_denominator!;
  }
  if (validPositiveNumber(probe?.frame_rate)) {
    return probe!.frame_rate!;
  }
  if (validPositiveNumber(probe?.frame_count) && validPositiveNumber(probe?.duration_seconds)) {
    return probe!.frame_count! / probe!.duration_seconds!;
  }
  return DEFAULT_VIDEO_FRAME_RATE;
}

export function getVideoFrameCount(probe: ProbeResult | null | undefined) {
  if (validPositiveNumber(probe?.frame_count)) {
    return Math.max(1, Math.round(probe!.frame_count!));
  }
  const duration = validPositiveNumber(probe?.duration_seconds) ? probe!.duration_seconds! : 0;
  return Math.max(1, Math.round(duration * getVideoFrameRate(probe)));
}

export function createVideoFrameIndex(probe: ProbeResult): VideoFrameIndex {
  const rate = getVideoFrameRate(probe);
  return {
    status: probe.variable_frame_rate ? "indexing" : "ready",
    frameCount: getVideoFrameCount(probe),
    frameRateNumerator: positiveInteger(probe.frame_rate_numerator, Math.round(rate * 1000)),
    frameRateDenominator: positiveInteger(probe.frame_rate_denominator, 1000),
    variableFrameRate: Boolean(probe.variable_frame_rate),
    boundariesSeconds: null,
    warning: "",
  };
}

export function applyFrameBoundaries(
  index: VideoFrameIndex,
  boundariesSeconds: number[],
  _durationSeconds: number,
) {
  const normalized: number[] = [];
  for (const value of boundariesSeconds) {
    if (!Number.isFinite(value)) {
      continue;
    }
    const seconds = Math.max(0, value);
    if (normalized.length === 0 || seconds > normalized[normalized.length - 1]) {
      normalized.push(seconds);
    }
  }
  if (normalized.length < 2) {
    return {
      ...index,
      status: "approximate" as const,
      warning: "无法建立完整帧索引，当前仅能近似到帧。",
    };
  }
  return {
    ...index,
    status: "ready" as const,
    frameCount: normalized.length - 1,
    boundariesSeconds: normalized,
    warning: "",
  };
}

export function frameBoundaryToSeconds(
  frameBoundary: number,
  index: VideoFrameIndex,
  durationSeconds?: number,
) {
  const boundary = Math.max(0, Math.min(index.frameCount, Math.round(frameBoundary)));
  const indexed = index.boundariesSeconds?.[boundary];
  if (typeof indexed === "number" && Number.isFinite(indexed)) {
    return indexed;
  }
  const numerator = positiveInteger(index.frameRateNumerator, DEFAULT_VIDEO_FRAME_RATE);
  const denominator = positiveInteger(index.frameRateDenominator, 1);
  const seconds = boundary * denominator / numerator;
  return validPositiveNumber(durationSeconds) ? Math.min(durationSeconds!, seconds) : seconds;
}

export function secondsToIndexedFrame(
  seconds: number,
  index: VideoFrameIndex,
) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const boundaries = index.boundariesSeconds;
  if (boundaries && boundaries.length >= 2) {
    let low = 0;
    let high = boundaries.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (boundaries[middle] <= safeSeconds) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return Math.min(index.frameCount - 1, low);
  }
  const numerator = positiveInteger(index.frameRateNumerator, DEFAULT_VIDEO_FRAME_RATE);
  const denominator = positiveInteger(index.frameRateDenominator, 1);
  return Math.max(
    0,
    Math.min(index.frameCount - 1, Math.floor(safeSeconds * numerator / denominator + 1e-9)),
  );
}

export function secondsToFrame(
  seconds: number,
  frameRate: number,
  maxFrame: number,
) {
  const safeRate = validPositiveNumber(frameRate) ? frameRate : DEFAULT_VIDEO_FRAME_RATE;
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  return Math.max(0, Math.min(Math.max(0, maxFrame), Math.round(safeSeconds * safeRate)));
}

export function frameToSeconds(
  frame: number,
  frameRate: number,
  durationSeconds?: number,
) {
  const safeRate = validPositiveNumber(frameRate) ? frameRate : DEFAULT_VIDEO_FRAME_RATE;
  const seconds = Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0) / safeRate);
  return validPositiveNumber(durationSeconds) ? Math.min(durationSeconds!, seconds) : seconds;
}

export function createVideoTimelineState(
  index: VideoFrameIndex,
  playheadFrame = 0,
): VideoTimelineState {
  const total = Math.max(1, index.frameCount);
  const rate = index.frameRateNumerator / index.frameRateDenominator;
  const detailSpan = Math.max(1, Math.min(total, Math.round(rate * DEFAULT_DETAIL_WINDOW_SECONDS)));
  const playhead = Math.max(0, Math.min(total - 1, Math.round(playheadFrame)));
  const viewStart = Math.max(0, Math.min(total - detailSpan, playhead - Math.floor(detailSpan / 2)));
  return {
    startFrame: 0,
    endFrameExclusive: total,
    playheadFrame: playhead,
    viewStartFrame: viewStart,
    viewEndFrameExclusive: viewStart + detailSpan,
  };
}

export function normalizeVideoTimeline(
  timeline: VideoTimelineState,
  frameCount: number,
) {
  const total = Math.max(1, Math.round(frameCount));
  const startFrame = Math.max(0, Math.min(total - 1, Math.round(timeline.startFrame)));
  const endFrameExclusive = Math.max(
    startFrame + 1,
    Math.min(total, Math.round(timeline.endFrameExclusive)),
  );
  const playheadFrame = Math.max(0, Math.min(total - 1, Math.round(timeline.playheadFrame)));
  const requestedViewSpan = Math.max(
    1,
    Math.round(timeline.viewEndFrameExclusive - timeline.viewStartFrame),
  );
  const viewSpan = Math.min(total, requestedViewSpan);
  const viewStartFrame = Math.max(
    0,
    Math.min(total - viewSpan, Math.round(timeline.viewStartFrame)),
  );
  return {
    startFrame,
    endFrameExclusive,
    playheadFrame,
    viewStartFrame,
    viewEndFrameExclusive: viewStartFrame + viewSpan,
  };
}

export function centerTimelineView(
  timeline: VideoTimelineState,
  frame: number,
  frameCount: number,
) {
  const normalized = normalizeVideoTimeline(timeline, frameCount);
  const span = normalized.viewEndFrameExclusive - normalized.viewStartFrame;
  const start = Math.max(
    0,
    Math.min(frameCount - span, Math.round(frame) - Math.floor(span / 2)),
  );
  return {
    ...normalized,
    viewStartFrame: start,
    viewEndFrameExclusive: start + span,
  };
}

export function zoomTimelineView(
  timeline: VideoTimelineState,
  frameCount: number,
  factor: number,
) {
  const normalized = normalizeVideoTimeline(timeline, frameCount);
  const currentSpan = normalized.viewEndFrameExclusive - normalized.viewStartFrame;
  const nextSpan = Math.max(1, Math.min(frameCount, Math.round(currentSpan * factor)));
  const center = normalized.playheadFrame;
  const start = Math.max(0, Math.min(frameCount - nextSpan, center - Math.floor(nextSpan / 2)));
  return {
    ...normalized,
    viewStartFrame: start,
    viewEndFrameExclusive: start + nextSpan,
  };
}

export function frameFromTrackPosition(
  clientX: number,
  left: number,
  width: number,
  startFrame: number,
  endFrameExclusive: number,
  allowEndBoundary = false,
) {
  const span = Math.max(1, endFrameExclusive - startFrame);
  const ratio = width > 0 ? Math.max(0, Math.min(1, (clientX - left) / width)) : 0;
  const frame = startFrame + Math.round(ratio * span);
  const max = allowEndBoundary ? endFrameExclusive : endFrameExclusive - 1;
  return Math.max(startFrame, Math.min(max, frame));
}

export function framePositionPercent(
  frame: number,
  startFrame: number,
  endFrameExclusive: number,
) {
  const span = Math.max(1, endFrameExclusive - startFrame);
  return Math.max(0, Math.min(100, ((frame - startFrame) / span) * 100));
}

export function formatMinuteSecond(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const wholeSeconds = Math.floor(safeSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  const base = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${base}` : base;
}

export function formatPreciseClock(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const base = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${base}` : base;
}

export function formatFrameTimecode(frame: number, frameRate: number) {
  const nominalFrameRate = Math.max(
    1,
    Math.round(validPositiveNumber(frameRate) ? frameRate : DEFAULT_VIDEO_FRAME_RATE),
  );
  const safeFrame = Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0));
  const totalSeconds = Math.floor(safeFrame / nominalFrameRate);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frameWithinSecond = safeFrame % nominalFrameRate;
  const frameDigits = Math.max(2, String(nominalFrameRate - 1).length);
  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frameWithinSecond).padStart(frameDigits, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${base}` : base;
}

export function formatIndexedFrame(frame: number, index: VideoFrameIndex) {
  const safeFrame = Math.max(0, Math.min(index.frameCount - 1, Math.round(frame)));
  if (index.variableFrameRate && index.boundariesSeconds) {
    return `${formatPreciseClock(frameBoundaryToSeconds(safeFrame, index))} · 帧 ${safeFrame}`;
  }
  return `${formatFrameTimecode(
    safeFrame,
    index.frameRateNumerator / index.frameRateDenominator,
  )} · 帧 ${safeFrame}`;
}

export function formatFrameRate(frameRate: number) {
  const rounded = Math.round(frameRate * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "");
}
