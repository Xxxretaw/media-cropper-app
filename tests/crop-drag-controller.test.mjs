import assert from "node:assert/strict";
import test from "node:test";
import { resizeFixedRatioRectFromCorner } from "../src/crop-drag-controller.ts";

const bounds = { x: 0, y: 0, width: 200, height: 200 };

test("fixed-ratio corner resizing responds to vertical pointer movement", () => {
  const start = { x: 50, y: 50, width: 80, height: 80 };
  const resized = resizeFixedRatioRectFromCorner(
    start,
    bounds,
    "se",
    0,
    40,
    1,
  );

  assert.ok(resized.width > start.width);
  assert.equal(resized.width, resized.height);
  assert.equal(resized.x, start.x);
  assert.equal(resized.y, start.y);
});

test("fixed-ratio corner resizing preserves the opposite corner at bounds", () => {
  const start = { x: 40, y: 50, width: 80, height: 40 };
  const resized = resizeFixedRatioRectFromCorner(
    start,
    bounds,
    "nw",
    -200,
    -200,
    2,
  );

  assert.equal(resized.x, 0);
  assert.equal(resized.y, 30);
  assert.equal(resized.width / resized.height, 2);
  assert.equal(resized.x + resized.width, start.x + start.width);
  assert.equal(resized.y + resized.height, start.y + start.height);
});
