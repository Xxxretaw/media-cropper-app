import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFrameBoundaries,
  centerTimelineView,
  createVideoFrameIndex,
  createVideoTimelineState,
  formatIndexedFrame,
  formatFrameTimecode,
  formatFrameRate,
  formatMinuteSecond,
  frameBoundaryToSeconds,
  frameFromTrackPosition,
  framePositionPercent,
  frameToSeconds,
  getVideoFrameCount,
  getVideoFrameRate,
  normalizeVideoTimeline,
  secondsToIndexedFrame,
  secondsToFrame,
  zoomTimelineView,
} from "../src/video-frame-time.ts";

test("uses probe frame metadata for frame-precise ranges", () => {
  const probe = {
    media_kind: "video",
    duration_seconds: 10,
    frame_rate: 29.97,
    frame_count: 300,
    raw: {},
  };

  assert.equal(getVideoFrameRate(probe), 29.97);
  assert.equal(getVideoFrameCount(probe), 300);
  assert.equal(secondsToFrame(1, 29.97, 300), 30);
  assert.equal(frameToSeconds(30, 29.97, 10), 30 / 29.97);
});

test("estimates missing frame metadata without losing one-frame precision", () => {
  const probe = { media_kind: "video", duration_seconds: 2, raw: {} };
  assert.equal(getVideoFrameRate(probe), 30);
  assert.equal(getVideoFrameCount(probe), 60);
  assert.equal(frameToSeconds(1, 30, 2), 1 / 30);
});

test("formats preview time as minutes and seconds", () => {
  assert.equal(formatMinuteSecond(30.125), "00:30");
  assert.equal(formatMinuteSecond(140.1), "02:20");
  assert.equal(formatMinuteSecond(3661.5), "01:01:01");
});

test("formats edit positions as minutes, seconds, and frame number", () => {
  assert.equal(formatFrameTimecode(0, 30), "00:00:00");
  assert.equal(formatFrameTimecode(4203, 30), "02:20:03");
  assert.equal(formatFrameTimecode(4585, 30), "02:32:25");
  assert.equal(formatFrameTimecode(3603, 60), "01:00:03");
  assert.equal(formatFrameTimecode(108_003, 30), "01:00:00:03");
});

test("formats readable frame rates", () => {
  assert.equal(formatFrameRate(30), "30");
  assert.equal(formatFrameRate(30000 / 1001), "29.97");
});

test("uses rational CFR boundaries without cumulative 29.97 drift", () => {
  const probe = {
    media_kind: "video",
    duration_seconds: 3600,
    frame_rate: 30000 / 1001,
    frame_rate_numerator: 30000,
    frame_rate_denominator: 1001,
    frame_count: 107_892,
    variable_frame_rate: false,
    raw: {},
  };
  const index = createVideoFrameIndex(probe);
  assert.equal(frameBoundaryToSeconds(30_000, index), 1001);
  assert.equal(secondsToIndexedFrame(1001, index), 30_000);
});

test("VFR boundaries map exact frame starts and exclusive range ends", () => {
  const base = createVideoFrameIndex({
    media_kind: "video",
    duration_seconds: 0.14,
    frame_rate: 30,
    frame_count: 4,
    variable_frame_rate: true,
    raw: {},
  });
  const index = applyFrameBoundaries(base, [0, 0.033, 0.083, 0.116, 0.15], 0.2);
  assert.equal(index.status, "ready");
  assert.equal(index.frameCount, 4);
  assert.equal(frameBoundaryToSeconds(2, index), 0.083);
  assert.equal(frameBoundaryToSeconds(4, index), 0.15);
  assert.equal(secondsToIndexedFrame(0.1, index), 2);
  assert.equal(formatIndexedFrame(2, index), "00:00.083 · 帧 2");
});

test("timeline normalization keeps an inclusive one-frame selection valid", () => {
  const timeline = normalizeVideoTimeline({
    startFrame: 99,
    endFrameExclusive: 99,
    playheadFrame: 150,
    viewStartFrame: 95,
    viewEndFrameExclusive: 105,
  }, 100);
  assert.deepEqual(timeline, {
    startFrame: 99,
    endFrameExclusive: 100,
    playheadFrame: 99,
    viewStartFrame: 90,
    viewEndFrameExclusive: 100,
  });
});

test("long-video detail views center, zoom and convert pointer positions by frame", () => {
  const index = createVideoFrameIndex({
    media_kind: "video",
    duration_seconds: 7200,
    frame_rate: 30,
    frame_rate_numerator: 30,
    frame_rate_denominator: 1,
    frame_count: 216_000,
    raw: {},
  });
  let timeline = createVideoTimelineState(index, 200_000);
  assert.equal(timeline.viewEndFrameExclusive - timeline.viewStartFrame, 300);
  timeline = zoomTimelineView(timeline, index.frameCount, 0.5);
  assert.equal(timeline.viewEndFrameExclusive - timeline.viewStartFrame, 150);
  timeline = centerTimelineView(timeline, 215_999, index.frameCount);
  assert.equal(timeline.viewEndFrameExclusive, 216_000);
  assert.equal(
    frameFromTrackPosition(500, 0, 1000, 215_850, 216_000),
    215_925,
  );
  assert.equal(framePositionPercent(215_925, 215_850, 216_000), 50);
});
