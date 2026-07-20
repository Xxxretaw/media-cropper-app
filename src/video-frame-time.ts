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

export function formatMinuteSecond(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const wholeSeconds = Math.floor(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatFrameTimecode(frame: number, frameRate: number) {
  const nominalFrameRate = Math.max(
    1,
    Math.round(validPositiveNumber(frameRate) ? frameRate : DEFAULT_VIDEO_FRAME_RATE),
  );
  const safeFrame = Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0));
  const totalSeconds = Math.floor(safeFrame / nominalFrameRate);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frameWithinSecond = safeFrame % nominalFrameRate;
  const frameDigits = Math.max(2, String(nominalFrameRate - 1).length);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frameWithinSecond).padStart(frameDigits, "0")}`;
}

export function formatFrameRate(frameRate: number) {
  const rounded = Math.round(frameRate * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, "");
}
