import assert from "node:assert/strict";
import test from "node:test";
import {
  createQueueItem,
  getBlackBorderDetectionCandidates,
} from "../src/media-model.ts";

test("new videos participate in on-demand black-border detection", () => {
  const item = createQueueItem("video", "/tmp/clip.mp4");
  assert.equal(item.blackBorderDetection.skipDetection, false);
  assert.deepEqual(getBlackBorderDetectionCandidates([item]), [item]);
});

test("videos can be excluded independently from bulk black-border detection", () => {
  const included = createQueueItem("video", "/tmp/included.mp4");
  const skipped = createQueueItem("video", "/tmp/skipped.mp4");
  skipped.blackBorderDetection.skipDetection = true;

  assert.deepEqual(getBlackBorderDetectionCandidates([included, skipped]), [included]);
});
