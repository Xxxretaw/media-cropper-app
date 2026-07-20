import type { ProbeResult } from "./media-model";

export const DEFAULT_VIDEO_FRAME_RATE = 30;

function validPositiveNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function getVideoFrameRate(probe: ProbeResult | null | undefined) {
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

export function formatPreciseClock(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const clock = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

export function formatFrameRate(frameRate: number) {
  const rounded = Math.round(frameRate * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "");
}
