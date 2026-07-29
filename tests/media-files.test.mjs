import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_MEDIA_EXTENSIONS,
  getFileStem,
  mediaModeFromPath,
  routeMediaPaths,
} from "../src/media-files.ts";

test("the unified picker accepts every supported image and video extension", () => {
  assert.deepEqual(ALL_MEDIA_EXTENSIONS, [
    "jpg", "jpeg", "png", "bmp", "tif", "tiff",
    "mp4", "mov", "m4v", "mkv", "avi",
  ]);
});

test("media paths are classified case-insensitively", () => {
  assert.equal(mediaModeFromPath("/tmp/photo.JPEG"), "image");
  assert.equal(mediaModeFromPath("C:\\media\\clip.MOV"), "video");
  assert.equal(mediaModeFromPath("/tmp/archive.zip"), null);
});

test("mixed drops are routed while unsupported files and duplicates are reported", () => {
  const result = routeMediaPaths(
    ["/tmp/a.png", "/tmp/b.mp4", "/tmp/readme.txt", "/tmp/a.png"],
    new Set(["/tmp/existing.mov"]),
  );

  assert.deepEqual(result.accepted, [
    { mode: "image", path: "/tmp/a.png" },
    { mode: "video", path: "/tmp/b.mp4" },
  ]);
  assert.deepEqual(result.unsupported, ["/tmp/readme.txt"]);
  assert.deepEqual(result.duplicates, ["/tmp/a.png"]);
});

test("file stems are derived from both POSIX and Windows paths", () => {
  assert.equal(getFileStem("/tmp/example.photo.png"), "example.photo");
  assert.equal(getFileStem("C:\\media\\clip.mov"), "clip");
});
