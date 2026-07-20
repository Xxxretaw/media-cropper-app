import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFrameRate,
  formatPreciseClock,
  frameToSeconds,
  getVideoFrameCount,
  getVideoFrameRate,
  secondsToFrame,
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

test("formats precise time and readable frame rates", () => {
  assert.equal(formatPreciseClock(30.125), "00:30.125");
  assert.equal(formatPreciseClock(3661.5), "01:01:01.500");
  assert.equal(formatFrameRate(30), "30");
  assert.equal(formatFrameRate(30000 / 1001), "29.97");
});
