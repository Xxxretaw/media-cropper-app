import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRectToBounds,
  contentBoundsFromMargins,
  createRectForRatio,
} from "../src/crop-geometry.ts";

const detectedBounds = contentBoundsFromMargins(1920, 1080, {
  left: 0,
  top: 140,
  right: 0,
  bottom: 140,
});

test("detected margins become the base bounds for later ratio crops", () => {
  assert.deepEqual(detectedBounds, { x: 0, y: 140, width: 1920, height: 800 });

  const crop = createRectForRatio(detectedBounds, 16 / 9, 1, "center");
  assert.deepEqual(crop, { x: 248.8888888888889, y: 140, width: 1422.2222222222222, height: 800 });
});

test("free ratio restores the detected content bounds instead of the full source", () => {
  assert.deepEqual(createRectForRatio(detectedBounds, null, 1, "center"), detectedBounds);
});

test("anchor and scale stay inside the detected content bounds", () => {
  const crop = createRectForRatio(detectedBounds, 1, 0.5, "rb");
  assert.deepEqual(crop, { x: 1520, y: 540, width: 400, height: 400 });
});

test("manual movement cannot move the crop back into detected black bars", () => {
  assert.deepEqual(
    clampRectToBounds({ x: -200, y: 0, width: 1000, height: 600 }, detectedBounds),
    { x: 0, y: 140, width: 1000, height: 600 },
  );
});
