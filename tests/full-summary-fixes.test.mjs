import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullSummaryValue, migrateAndMerge, migrateLegacyFullSummaryItems, sourceCachePath } from "../collect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

// Source caches must be stable and live under data/transcripts.
assert.equal(
  sourceCachePath({ kind: "youtube", videoId: "ab_Cd-12", id: "yt:ab_Cd-12" }),
  path.join(root, "data", "transcripts", "ab_Cd-12.txt"),
);
const articlePath = sourceCachePath({ kind: "blog", id: "article:https://example.com/a", title: "A Fireside Chat with Cat and Thariq" });
assert.match(articlePath, /data[\\/]transcripts[\\/]article-a-fireside-chat-with-cat-and-thariq-[a-f0-9]{10}\.txt$/);
const xPath = sourceCachePath({ kind: "x", id: "x:123456789", title: "" });
assert.match(xPath, /data[\\/]transcripts[\\/]x-123456789-[a-f0-9]{10}\.txt$/);

// The dashboard must expose a dedicated full-summary filter and use live archive
// objects when rendering the shortlist, not stale localStorage snapshots.
assert.match(html, /\["full","Full Summaries"/);
assert.match(html, /state\.filter==="shortlist"\)return Object\.keys\(state\.saved\)\.map\(itemById\)/);
assert.match(html, /function syncSavedWithLive\(\)/);
assert.match(html, /state\.items\.filter\(hasFullSummary\)/);
assert.match(html, /Newest summaries first/);
assert.match(html, /actions\/workflows\/daily\.yml/);
assert.match(html, /dispatch\("daily\.yml",\{itemId\}\)/);

// Evaluate the safe, limited markdown renderer and clamp generator in isolation.
const richMatch = html.match(/function richText\(text\)\{[\s\S]*?\n  \}/);
const collapseMatch = html.match(/function collapsible\(text,lines=4,extra="",forceToggle=false\)\{[\s\S]*?\n  \}/);
assert.ok(richMatch, "richText function should exist");
assert.ok(collapseMatch, "collapsible function should exist");
const context = {
  result: "",
  esc: (s) => String(s ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]),
};
vm.createContext(context);
vm.runInContext(`${richMatch[0]};${collapseMatch[0]};result=richText("**Key point**\\nDetails");`, context);
assert.equal(context.result, '<strong class="md-heading">Key point</strong><br>Details');
vm.runInContext('result=collapsible("**Heading**\\n"+"Long detail ".repeat(80),7,"",true);', context);
assert.match(context.result, /<strong class="md-heading">Heading<\/strong>/);
assert.match(context.result, /data-likely-long="1"/);
assert.doesNotMatch(context.result, /more-toggle" hidden/);

// Compact Top cards stay scannable by preferring the editorial summary, while
// the full summary is available in the in-page reader. Every blog/article URL
// is eligible for an on-demand full summary regardless of RSS excerpt length.
assert.match(html, /function topPreview\(item\)\{const ed=item\.editorial\|\|\{\};if\(ed\.summaryZh\)return ed\.summaryZh/);
assert.match(html, /function eligibleForFull\(item\)[\s\S]*?if\(\["blog","article"\]\.includes\(item\.kind\)\)return Boolean\(item\.url\)/);
assert.match(html, /id="reader" hidden aria-hidden="true"/);
assert.match(html, /function openReader\(id,context=\{\}\)/);
assert.match(html, /Click card to read/);


// Detailed summaries must live in a separate field so a later editorial pass
// can update the compact preview without destroying the long-form result.
assert.match(html, /function fullSummaryText\(item\)/);
const legacy = migrateAndMerge([{ id: "article:legacy", kind: "blog", url: "https://example.com/legacy", full: true, summary: "Long legacy full summary ".repeat(40) }], []);
assert.match(legacy.merged.get("article:legacy").fullSummary, /Long legacy full summary/);

const persisted = migrateAndMerge([{
  id: "article:persisted", kind: "blog", url: "https://example.com/persisted",
  summary: "Short Chinese preview", fullSummary: "Detailed section. ".repeat(80), full: true,
}], [{
  id: "article:persisted", kind: "blog", url: "https://example.com/persisted",
  summary: "New feed excerpt", excerpt: "New feed excerpt",
}]);
const persistedItem = persisted.merged.get("article:persisted");
assert.match(fullSummaryValue(persistedItem), /Detailed section/);
assert.equal(persistedItem.summary, "Short Chinese preview", "normal feed/editorial refreshes must not overwrite the detailed summary field");

const overwritten = [{ id: "article:history-recovery", kind: "blog", full: true, summary: "Short preview after a daily rerank" }];
const recoveryHistory = { days: [{ date: "2026-07-21", items: [{ id: "article:history-recovery", full: true, fullSummary: "Recovered full summary. ".repeat(70) }] }] };
assert.equal(migrateLegacyFullSummaryItems(overwritten, recoveryHistory), true);
assert.match(overwritten[0].fullSummary, /Recovered full summary/);
assert.equal(overwritten[0].summary, "Short preview after a daily rerank");

// Maintenance backfill must cache a non-video original source and record the
// same path in the archive and historical snapshots without any API key.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-digest-source-backfill-"));
fs.mkdirSync(path.join(temp, "data"), { recursive: true });
fs.writeFileSync(path.join(temp, "sources.json"), JSON.stringify({ summaryLang: "zh", retentionDays: 30, sources: [] }));
fs.writeFileSync(path.join(temp, "data", "archive.json"), JSON.stringify({
  generatedAt: "2026-07-21T00:00:00Z",
  count: 1,
  items: [{
    id: "x:123456789",
    kind: "x",
    source: "Builders",
    author: "@tester",
    text: "This is the complete original X post that must be saved in data/transcripts.",
    summary: "**Key point**\nA full summary already exists.",
    full: true,
    fullSummaryAt: "2026-07-21T00:00:00Z",
    url: "https://x.com/tester/status/123456789",
    ts: 1784592000000,
  }],
}, null, 2));
fs.writeFileSync(path.join(temp, "data", "top-history.json"), JSON.stringify({
  days: [{ date: "2026-07-21", ranking: [{ id: "x:123456789", rank: 1 }], items: [{ id: "x:123456789", full: true }] }],
}, null, 2));
const run = spawnSync(process.execPath, [path.join(root, "collect.mjs")], {
  cwd: temp,
  env: { ...process.env, BACKFILL_FULL_SOURCES: "1" },
  encoding: "utf8",
});
assert.equal(run.status, 0, run.stderr || run.stdout);
const archive = JSON.parse(fs.readFileSync(path.join(temp, "data", "archive.json"), "utf8"));
const cachedItem = archive.items[0];
assert.match(cachedItem.fullSourcePath, /^data\/transcripts\/x-/);
assert.equal(cachedItem.sourceTextPath, cachedItem.fullSourcePath);
assert.equal(cachedItem.transcriptPath, cachedItem.fullSourcePath);
assert.ok(fs.existsSync(path.join(temp, cachedItem.fullSourcePath)));
const history = JSON.parse(fs.readFileSync(path.join(temp, "data", "top-history.json"), "utf8"));
assert.equal(history.days[0].items[0].fullSourcePath, cachedItem.fullSourcePath);
fs.rmSync(temp, { recursive: true, force: true });

console.log("full-summary consistency tests passed");
