import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const requestedVersion = process.argv[2]?.trim().replace(/^v/, "");
if (!requestedVersion) {
  throw new Error("Usage: node scripts/extract-release-notes.mjs <version>");
}

const changelogPath = resolve("USER_FACING_CHANGELOG.md");
const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
const sectionStart = lines.findIndex((line) =>
  line === `## ${requestedVersion}` || line.startsWith(`## ${requestedVersion} -`),
);

if (sectionStart < 0) {
  throw new Error(`USER_FACING_CHANGELOG.md 中缺少 ${requestedVersion} 的更新记录`);
}

const nextSectionOffset = lines
  .slice(sectionStart + 1)
  .findIndex((line) => line.startsWith("## "));
const sectionEnd = nextSectionOffset < 0
  ? lines.length
  : sectionStart + 1 + nextSectionOffset;
const notes = lines.slice(sectionStart + 1, sectionEnd).join("\n").trim();

if (!notes) {
  throw new Error(`${requestedVersion} 的用户更新记录为空`);
}

process.stdout.write(`## Media Cropper ${requestedVersion} 更新内容\n\n${notes}\n`);
