import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCachedBlackBorderResult,
  removeAppliedBlackBorderResult,
} from "../src/black-border-result.ts";
import { createQueueItem } from "../src/media-model.ts";

test("removing a detected black-border result restores the complete prior crop", () => {
  const item = createQueueItem("video", "/tmp/clip.mp4");
  item.settings.ratio = "16:9";
  item.settings.anchor = "top-left";
  item.settings.scale = 0.75;
  item.settings.rect = { x: 12, y: 18, width: 640, height: 360 };
  const originalCrop = structuredClone(item.settings);
  item.blackBorderDetection.status = "detected";
  item.blackBorderDetection.detectedRect = { x: 0, y: 80, width: 1920, height: 920 };

  assert.equal(applyCachedBlackBorderResult(item), true);
  assert.equal(item.blackBorderDetection.resultApplied, true);
  assert.equal(item.settings.ratio, "free");
  assert.deepEqual(item.settings.rect, item.blackBorderDetection.detectedRect);

  removeAppliedBlackBorderResult(item);
  assert.equal(item.blackBorderDetection.resultApplied, false);
  assert.deepEqual(item.settings, originalCrop);
});

test("reapplying a cached result remembers the latest manual crop for the next undo", () => {
  const item = createQueueItem("video", "/tmp/clip.mp4");
  item.blackBorderDetection.status = "detected";
  item.blackBorderDetection.detectedRect = { x: 0, y: 80, width: 1920, height: 920 };
  item.settings.ratio = "9:16";
  item.settings.rect = { x: 640, y: 0, width: 608, height: 1080 };
  assert.equal(applyCachedBlackBorderResult(item), true);
  removeAppliedBlackBorderResult(item);

  item.settings.ratio = "1:1";
  item.settings.rect = { x: 320, y: 0, width: 1080, height: 1080 };
  const latestManualCrop = structuredClone(item.settings);

  assert.equal(applyCachedBlackBorderResult(item), true);
  removeAppliedBlackBorderResult(item);

  assert.deepEqual(item.settings, latestManualCrop);
});
