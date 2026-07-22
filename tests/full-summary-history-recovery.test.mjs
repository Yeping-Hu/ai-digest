import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-digest-history-repair-"));
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: tmp, encoding: "utf8", ...options });

fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "repair-full-summaries-from-history.mjs"), path.join(tmp, "scripts", "repair-full-summaries-from-history.mjs"));

assert.equal(run("git", ["init", "-b", "main"]).status, 0);
assert.equal(run("git", ["config", "user.name", "test"]).status, 0);
assert.equal(run("git", ["config", "user.email", "test@example.com"]).status, 0);

const longSummary = [
  "**核心观点**",
  "这是一份曾经生成成功的详细总结。".repeat(35),
  "\n\n**第二部分**\n",
  "这里包含具体论点、证据、例子与限制。".repeat(30),
].join("");
const item = {
  id: "article:fireside",
  kind: "blog",
  title: "A Fireside Chat with Cat and Thariq",
  url: "https://example.com/fireside",
  summary: longSummary,
  full: true,
  fullSummaryAt: "2026-07-21T10:00:00Z",
};
fs.writeFileSync(path.join(tmp, "data", "archive.json"), JSON.stringify({ count: 1, items: [item] }, null, 2));
fs.writeFileSync(path.join(tmp, "data", "top-history.json"), JSON.stringify({ days: [] }, null, 2));
assert.equal(run("git", ["add", "."]).status, 0);
assert.equal(run("git", ["commit", "-m", "store detailed summary"]).status, 0);

const broken = {
  ...item,
  summary: "A short editorial preview.",
  fullSummary: "",
  full: true,
  fullSummaryStatus: "ready",
};
fs.writeFileSync(path.join(tmp, "data", "archive.json"), JSON.stringify({ count: 1, items: [broken] }, null, 2));
assert.equal(run("git", ["add", "data/archive.json"]).status, 0);
assert.equal(run("git", ["commit", "-m", "accidentally overwrite summary"]).status, 0);

const repair = run(process.execPath, [path.join(tmp, "scripts", "repair-full-summaries-from-history.mjs")]);
assert.equal(repair.status, 0, repair.stderr || repair.stdout);
const repaired = JSON.parse(fs.readFileSync(path.join(tmp, "data", "archive.json"), "utf8")).items[0];
assert.equal(repaired.full, true);
assert.equal(repaired.fullSummaryStatus, "ready");
assert.equal(repaired.summary, "A short editorial preview.");
assert.equal(repaired.fullSummary, longSummary);
assert.match(repair.stdout, /Recovered article:fireside/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("full-summary history recovery tests passed");
