import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExportBaseNames,
  buildExportFileName,
  sanitizeMaterialName,
} from "../src/export-naming.ts";

test("a unique material name is exported without a sequence or ratio", () => {
  const items = [{ id: "a", materialName: "外滩夜景航拍" }];
  assert.equal(buildExportFileName(items, "a", "mp4"), "外滩夜景航拍.mp4");
});

test("only duplicated material names receive three-digit sequence numbers", () => {
  const items = [
    { id: "a", materialName: "产品特写" },
    { id: "b", materialName: "夜景" },
    { id: "c", materialName: "产品特写" },
  ];
  const names = buildExportBaseNames(items);
  assert.equal(names.get("a"), "产品特写_001");
  assert.equal(names.get("b"), "夜景");
  assert.equal(names.get("c"), "产品特写_002");
});

test("duplicate detection uses the sanitized case-insensitive name", () => {
  const items = [
    { id: "a", materialName: "Demo:Clip.mp4" },
    { id: "b", materialName: "demo-clip" },
  ];
  assert.equal(buildExportFileName(items, "a", ".MP4"), "Demo-Clip_001.mp4");
  assert.equal(buildExportFileName(items, "b", "mp4"), "demo-clip_002.mp4");
});

test("material names remove extensions and unsafe filename characters", () => {
  assert.equal(sanitizeMaterialName("  产品/特写?.MOV  "), "产品-特写");
  assert.equal(sanitizeMaterialName("CON"), "_CON");
  assert.equal(sanitizeMaterialName("..."), "");
});
