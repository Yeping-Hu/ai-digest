import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEditorial } from "../collect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const collector = fs.readFileSync(path.join(root, "collect.mjs"), "utf8");

// Cards must grow with their content at desktop and mobile widths. A fixed
// pixel height was the root cause of the action row spilling outside cards.
assert.match(html, /\.top-grid\{[^}]*align-items:stretch/);
assert.match(html, /\.top-card\{min-height:540px;height:auto;min-width:0;overflow:hidden/);
assert.match(html, /@media\(max-width:760px\)[\s\S]*?\.top-card\{height:auto;min-height:0\}/);
assert.doesNotMatch(html, /\.top-card\{height:540px/);

// YouTube readers must restore the large video cover, with a high-resolution
// image and a reliable fallback when maxresdefault is unavailable.
assert.match(html, /class="reader-media"/);
assert.match(html, /youtubeThumb\(item,"maxresdefault"\)/);
assert.match(html, /data-fallback=/);
assert.match(html, /onerror="if\(this\.dataset\.fallback\)/);

// The UI must never label raw English feed/video text as a Chinese summary.
assert.match(html, /function hasChineseText\(value\)/);
assert.match(html, /function shortSummaryLabel\(item,text\)/);
assert.match(html, /if\(hasChineseText\(text\)\)return"Chinese summary"/);
assert.match(html, /if\(item\?\.kind==="youtube"\)return"Source description"/);

// Every recent English-only item should enter the translation queue, not only
// the current Top candidates. This also repairs items ingested by older runs.
assert.match(collector, /translationBackfillDays \|\| 7/);
assert.match(collector, /for \(const item of kept\)[\s\S]*addTranslationTarget\(item\)/);
assert.match(collector, /target\.summaryLanguage = "zh"/);

const item = {
  id: "yt:better-agent-auth",
  kind: "youtube",
  title: "Better Agent Auth — Bereket Habtemeskel & Paola Estefania",
  excerpt: "A practical discussion of authentication patterns for AI agents.",
  summary: "A practical discussion of authentication patterns for AI agents.",
  source: "AI Engineer",
  sourceGroup: "AI Engineer",
  sourceType: "curated",
  ts: Date.now(),
};
const candidates = [{ item, local: { score: 78, reasons: ["agent workflow"], topics: ["agents", "workflow"] } }];

const normalized = normalizeEditorial({
  items: [{
    id: item.id,
    rank: 1,
    score: 78,
    summaryZh: "A practical discussion of authentication patterns for AI agents.",
    whyItMattersZh: "这场分享讨论了 Agent 认证设计。",
    evidenceZh: "演讲涵盖认证模式与工程实践。",
    uncertaintyZh: "",
    chineseAudienceGapZh: "中文资料较少。",
    rednoteAngleZh: "Agent 为什么需要单独的认证设计？",
    topics: ["agents"],
    reason: "实用工程主题",
  }],
  translations: [{
    id: item.id,
    summaryZh: "这场分享介绍了 AI Agent 的认证模式，以及在实际工程中如何安全地管理身份与权限。",
  }],
  ideas: [],
}, candidates, [item]);

assert.match(normalized.items[0].summaryZh, /这场分享介绍了/);
assert.match(normalized.translations[0].summaryZh, /身份与权限/);
assert.doesNotMatch(normalized.items[0].summaryZh, /^A practical discussion/);

console.log("layout-language-regression.test.mjs: passed");
