import assert from "node:assert/strict";
import test from "node:test";
import {
  createQueueItem,
  getBlackBorderDetectionCandidates,
} from "../src/media-model.ts";

test("new videos preserve the complete source frame by default", () => {
  const video = createQueueItem("video", "/tmp/landscape.mp4");
  const image = createQueueItem("image", "/tmp/poster.png");

  assert.equal(video.settings.ratio, "free");
  assert.equal(video.settings.scale, 1);
  assert.equal(image.settings.ratio, "9:16");
});

test("new videos participate in on-demand black-border detection", () => {
  const item = createQueueItem("video", "/tmp/clip.mp4");
  assert.equal(item.blackBorderDetection.skipDetection, false);
  assert.equal(item.blackBorderDetection.resultApplied, false);
  assert.equal(item.blackBorderDetection.detectedRect, null);
  assert.equal(item.blackBorderDetection.cropBeforeDetection, null);
  assert.deepEqual(getBlackBorderDetectionCandidates([item]), [item]);
});

test("videos can be excluded independently from bulk black-border detection", () => {
  const included = createQueueItem("video", "/tmp/included.mp4");
  const skipped = createQueueItem("video", "/tmp/skipped.mp4");
  skipped.blackBorderDetection.skipDetection = true;

  assert.deepEqual(getBlackBorderDetectionCandidates([included, skipped]), [included]);
});
