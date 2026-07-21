import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-digest-backfill-"));
fs.mkdirSync(path.join(tmp, "data", "transcripts"), { recursive: true });
fs.copyFileSync(path.join(root, "collect.mjs"), path.join(tmp, "collect.mjs"));
fs.writeFileSync(path.join(tmp, "sources.json"), JSON.stringify({ summaryLang: "zh", retentionDays: 30, sources: [] }, null, 2));
fs.writeFileSync(path.join(tmp, "data", "transcripts", "ab_Cd-12.txt"), "Existing video transcript\n");
fs.writeFileSync(path.join(tmp, "data", "archive.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  count: 2,
  items: [
    {
      id: "yt:ab_Cd-12",
      videoId: "ab_Cd-12",
      kind: "youtube",
      title: "Video",
      full: true,
      summary: "Detailed summary",
      ts: Date.now(),
    },
    {
      id: "x:123456789",
      kind: "x",
      author: "@builder",
      text: "Original post line one.\nOriginal post line two.",
      full: true,
      summary: "Generated Chinese summary",
      ts: Date.now(),
    },
  ],
}, null, 2));

const run = spawnSync(process.execPath, ["collect.mjs"], {
  cwd: tmp,
  env: { ...process.env, BACKFILL_FULL_SOURCES: "1", GEMINI_API_KEY: "", SUPADATA_API_KEY: "" },
  encoding: "utf8",
});
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

const archive = JSON.parse(fs.readFileSync(path.join(tmp, "data", "archive.json"), "utf8"));
const video = archive.items.find((item) => item.id === "yt:ab_Cd-12");
const post = archive.items.find((item) => item.id === "x:123456789");
assert.equal(video.fullSourcePath, "data/transcripts/ab_Cd-12.txt");
assert.equal(video.fullSourceChars, fs.readFileSync(path.join(tmp, "data", "transcripts", "ab_Cd-12.txt"), "utf8").trim().length);
assert.match(post.fullSourcePath, /^data\/transcripts\/x-123456789-[a-f0-9]{10}\.txt$/);
const postFile = path.join(tmp, post.fullSourcePath);
assert.equal(fs.readFileSync(postFile, "utf8").trim(), "Original post line one.\nOriginal post line two.");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("source-cache backfill tests passed");
