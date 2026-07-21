// AI Signal Desk collector — Node 20+, zero runtime dependencies.
//
// Normal run:
//   1. collect every source without spending model quota
//   2. canonicalize URLs and deduplicate
//   3. locally score new items
//   4. send only the best candidates to Gemini in one editorial batch
//   5. write the rolling archive, today's ranking, and a dated snapshot
//
// Manual run with SUMMARIZE_ITEM_ID or SUMMARIZE_VIDEO_ID:
//   upgrade one archive item with a cached source text and a detailed summary.
// Maintenance run with BACKFILL_FULL_SOURCES=1:
//   cache the source text for previously generated full summaries.
// Lightweight lifecycle run with REFRESH_YOUTUBE_STATUS=1:
//   refresh scheduled/live/replay status without spending Gemini or transcript quota.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "sources.json");
const ARCHIVE_PATH = path.join(ROOT, "data", "archive.json");
const TODAY_PATH = path.join(ROOT, "data", "today.json");
const TOP_HISTORY_PATH = path.join(ROOT, "data", "top-history.json");
const DAILY_DIR = path.join(ROOT, "data", "daily");
const TRANSCRIPT_DIR = path.join(ROOT, "data", "transcripts");

const CFG = readJSON(CONFIG_PATH, {});
const EDIT = CFG.editorial || {};
const NOW = Date.now();
const DATE_KEY = new Date(NOW).toISOString().slice(0, 10);
const RETENTION_MS = Math.max(1, Number(CFG.retentionDays || 30)) * 864e5;
const LANG = String(CFG.summaryLang || "zh").toLowerCase();
const USER_AGENT = "Mozilla/5.0 (compatible; ai-signal-desk/2.0; +https://github.com/Yeping-Hu/ai-digest)";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || EDIT.geminiModel || "gemini-3.1-flash-lite";
const GEMINI_MAX_CALLS = Math.max(0, Number(process.env.GEMINI_MAX_CALLS || EDIT.maxGeminiCalls || 2));
const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY || "";
const SUPADATA_KEY = process.env.SUPADATA_API_KEY || "";

let geminiCalls = 0;
const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function utcDayKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateChars(value, max = 400) {
  const text = compactText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function truncateWords(value, max = 200) {
  const words = compactText(value).split(" ").filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
  };
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (all, key) => named[key.toLowerCase()] ?? all);
}

function stripHTML(value) {
  return compactText(
    decodeEntities(value)
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalizeURL(input) {
  if (!input) return "";
  try {
    const url = new URL(decodeEntities(String(input).trim()));
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();

    const remove = [];
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        ["fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "source", "src", "_rsc"].includes(lower)
      ) {
        remove.push(key);
      }
    }
    for (const key of remove) url.searchParams.delete(key);

    if (["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname) && url.pathname === "/watch") {
      const videoId = url.searchParams.get("v");
      url.search = videoId ? `?v=${encodeURIComponent(videoId)}` : "";
      url.hostname = "www.youtube.com";
    }

    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(input).trim();
  }
}

function articleId(url, fallback = "") {
  const key = canonicalizeURL(url) || fallback;
  return `article:${hash(key).slice(0, 24)}`;
}

async function getText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain, */*",
      ...headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function getJSON(url, headers = {}) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${String(url).replace(/key=[^&]+/g, "key=***")} ${body.slice(0, 120)}`);
  }
  return response.json();
}

function extractBlocks(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`,
    "gi",
  );
  return [...String(xml || "").matchAll(pattern)].map((match) => match[1]);
}

function tagValue(xml, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`,
      "i",
    );
    const match = String(xml || "").match(pattern);
    if (match) return match[1];
  }
  return "";
}

function parseAttributes(raw) {
  const attrs = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of String(raw || "").matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function atomLink(block) {
  const tags = [...String(block || "").matchAll(/<(?:[\w.-]+:)?link\b([^>]*)\/?\s*>/gi)];
  const links = tags
    .map((match) => parseAttributes(match[1]))
    .filter((attrs) => attrs.href)
    .sort((a, b) => {
      const score = (attrs) => (attrs.rel === "alternate" ? 3 : !attrs.rel ? 2 : attrs.rel === "self" ? 0 : 1);
      return score(b) - score(a);
    });
  return links[0]?.href || "";
}

function tagTerms(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opening = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b([^>]*)>`, "gi");
  const terms = [];
  for (const match of String(block || "").matchAll(opening)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.term) terms.push(attrs.term);
  }
  for (const inner of extractBlocks(block, name)) terms.push(stripHTML(inner));
  return unique(terms.map(compactText));
}

function parseFeed(xml, src) {
  const isAtom = /<(?:[\w.-]+:)?feed\b/i.test(xml) && /<(?:[\w.-]+:)?entry\b/i.test(xml);
  const blocks = extractBlocks(xml, isAtom ? "entry" : "item");
  const maxItems = Math.max(1, Number(src.maxItems || 12));
  const items = [];

  for (const block of blocks.slice(0, maxItems)) {
    const rawTitle = tagValue(block, ["title"]);
    const title = stripHTML(rawTitle);
    const rssLink = stripHTML(tagValue(block, ["link"]));
    const link = canonicalizeURL(isAtom ? atomLink(block) || rssLink : rssLink || atomLink(block));
    if (!link || !title) continue;

    const rawDate = stripHTML(tagValue(block, ["published", "pubDate", "updated", "date"]));
    const parsedDate = Date.parse(rawDate);
    // Preserve the source's publication date. A missing/invalid feed date must not
    // masquerade as "published today" merely because we fetched it today.
    const ts = Number.isFinite(parsedDate) ? parsedDate : null;
    const rawContent = tagValue(block, ["encoded", "content", "description", "summary"]);
    const fullFeedText = stripHTML(rawContent);
    const excerpt = truncateChars(fullFeedText, Number(src.excerptChars || 1600));
    const author = stripHTML(tagValue(block, ["creator", "author", "name"])) || src.name;
    const categories = unique([...tagTerms(block, "category"), ...tagTerms(block, "subject")]);

    items.push({
      id: articleId(link, `${src.name}:${title}:${ts}`),
      source: src.name,
      sourceGroup: src.group || src.name,
      sourceType: src.sourceType || "independent",
      sourcePriority: Number(src.priority || 0.7),
      sourceTags: [src.name],
      kind: "blog",
      author,
      subtitle: src.group || "Blog",
      title,
      text: "",
      excerpt,
      contentLength: fullFeedText.length,
      summary: excerpt,
      url: link,
      canonicalUrl: link,
      ts,
      likes: 0,
      full: false,
      categories,
    });
  }
  return items;
}

function fmtDuration(iso) {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!match) return "";
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(seconds).padStart(2, "0")}`;
}

function validISO(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function durationSeconds(iso) {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(iso || ""));
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function youtubeLifecycle(video = {}, playlistItem = {}, now = NOW) {
  const snippet = video.snippet || playlistItem.snippet || {};
  const playlistSnippet = playlistItem.snippet || {};
  const details = video.liveStreamingDetails || {};
  const content = video.contentDetails || {};
  const status = video.status || {};
  const liveBroadcastContent = String(snippet.liveBroadcastContent || "none").toLowerCase();
  const scheduledStartTime = validISO(details.scheduledStartTime);
  const actualStartTime = validISO(details.actualStartTime);
  const actualEndTime = validISO(details.actualEndTime);
  const playlistVideoPublishedAt = validISO(playlistItem.contentDetails?.videoPublishedAt);
  const youtubePublishedAt = validISO(snippet.publishedAt || playlistVideoPublishedAt);
  const playlistAddedAt = validISO(playlistSnippet.publishedAt);
  const scheduledMs = Date.parse(scheduledStartTime);
  const actualStartMs = Date.parse(actualStartTime);
  const uploadStatus = String(status.uploadStatus || "").toLowerCase();
  const seconds = durationSeconds(content.duration);

  let state = "available";
  if (liveBroadcastContent === "upcoming" || (Number.isFinite(scheduledMs) && scheduledMs > now && !actualStartTime)) {
    state = "upcoming";
  } else if (liveBroadcastContent === "live" || (actualStartTime && !actualEndTime)) {
    state = "live";
  } else if (actualEndTime && (uploadStatus && uploadStatus !== "processed" || seconds === 0)) {
    state = "processing";
  }

  let effectivePublishedAt = "";
  if (state !== "upcoming") {
    effectivePublishedAt = actualStartTime || playlistVideoPublishedAt || youtubePublishedAt || playlistAddedAt;
  }
  const effectiveMs = Date.parse(effectivePublishedAt);

  return {
    state,
    liveBroadcastContent,
    scheduledStartTime,
    actualStartTime,
    actualEndTime,
    youtubePublishedAt,
    playlistVideoPublishedAt,
    playlistAddedAt,
    effectivePublishedAt,
    ts: Number.isFinite(effectiveMs) ? effectiveMs : null,
    uploadStatus,
  };
}

class SourceNotReadyError extends Error {
  constructor(code, message, retryAt = "") {
    super(message);
    this.name = "SourceNotReadyError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

function youtubeNotReady(item) {
  const state = String(item?.youtubeState || "").toLowerCase();
  const retryAt = item?.scheduledStartTime || "";
  const retryMs = Date.parse(String(retryAt || ""));
  if (state === "upcoming" && (!Number.isFinite(retryMs) || retryMs > NOW)) {
    return new SourceNotReadyError(
      "youtube_upcoming",
      "This video is scheduled but has not started yet. A full summary will be available after the video is published and a transcript exists.",
      retryAt,
    );
  }
  if (state === "live") {
    return new SourceNotReadyError(
      "youtube_live",
      "This video is live now. A full summary will be available after the stream ends and YouTube publishes a transcript.",
      retryAt,
    );
  }
  if (state === "processing") {
    return new SourceNotReadyError(
      "youtube_processing",
      "The stream has ended, but the replay or transcript is still processing. Please try again later.",
      retryAt,
    );
  }
  return null;
}

function withinRetention(item) {
  if (item?.kind === "youtube" && String(item.youtubeState || "") === "upcoming") {
    const scheduled = Date.parse(String(item.scheduledStartTime || ""));
    if (!Number.isFinite(scheduled) || scheduled >= NOW) return true;
  }
  const anchor = Number(item?.ts || item?.firstSeen || NOW);
  return NOW - anchor < RETENTION_MS;
}

async function adaptXFeed(src) {
  const data = await getJSON(src.url);
  const out = [];
  for (const builder of data.x || []) {
    for (const tweet of builder.tweets || []) {
      const url = canonicalizeURL(tweet.url);
      const text = stripHTML(tweet.text);
      out.push({
        id: `x:${tweet.id || hash(url || text).slice(0, 20)}`,
        source: src.name,
        sourceGroup: src.group || src.name,
        sourceType: src.sourceType || "community",
        sourcePriority: Number(src.priority || 0.55),
        sourceTags: [src.name],
        kind: "x",
        author: builder.handle ? `@${builder.handle}` : builder.name || src.name,
        avatarUrl: builder.profileImageUrl || builder.profile_image_url || builder.avatarUrl || builder.avatar || builder.image || "",
        subtitle: [builder.name, truncateWords(String(builder.bio || "").split("\n")[0], 8)].filter(Boolean).join(" · "),
        title: "",
        text,
        excerpt: text,
        summary: "",
        url,
        canonicalUrl: url,
        ts: Date.parse(tweet.createdAt) || NOW,
        likes: Number(tweet.likes || 0),
        full: false,
        categories: [],
      });
    }
  }
  return out;
}

async function youtubeUploadsPlaylist(src) {
  if (src.channelId) return `UU${src.channelId.slice(2)}`;
  const handle = String(src.handle || "").replace(/^@/, "");
  const data = await getJSON(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle)}&key=${YOUTUBE_KEY}`,
  );
  const uploads = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`could not resolve YouTube channel ${src.name}`);
  return uploads;
}

async function adaptYouTube(src) {
  if (!YOUTUBE_KEY) throw new Error("YOUTUBE_API_KEY is missing");
  const playlist = await youtubeUploadsPlaylist(src);
  const maxItems = clamp(Number(src.maxItems || 15), 1, 50);
  const data = await getJSON(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails,status&maxResults=${maxItems}&playlistId=${playlist}&key=${YOUTUBE_KEY}`,
  );
  const playlistItems = (data.items || []).filter((item) => item?.snippet?.resourceId?.videoId);
  const ids = playlistItems.map((item) => item.snippet.resourceId.videoId);
  const details = new Map();

  if (ids.length) {
    try {
      const videoData = await getJSON(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,liveStreamingDetails,status&id=${ids.join(",")}&key=${YOUTUBE_KEY}`,
      );
      for (const video of videoData.items || []) details.set(video.id, video);
    } catch (error) {
      log("  ! YouTube detail lookup failed:", error.message);
    }
  }

  return playlistItems.map((playlistItem) => {
    const playlistSnippet = playlistItem.snippet || {};
    const videoId = playlistSnippet.resourceId.videoId;
    const detail = details.get(videoId) || {};
    const videoSnippet = detail.snippet || playlistSnippet;
    const lifecycle = youtubeLifecycle(detail, playlistItem);
    const url = canonicalizeURL(`https://www.youtube.com/watch?v=${videoId}`);
    const description = stripHTML(videoSnippet.description || playlistSnippet.description || "");
    return {
      id: `yt:${videoId}`,
      source: src.name,
      sourceGroup: src.group || src.name,
      sourceType: src.sourceType || "curated",
      sourcePriority: Number(src.priority || 0.75),
      sourceTags: [src.name],
      kind: "youtube",
      author: videoSnippet.channelTitle || src.name,
      subtitle: "YouTube",
      title: videoSnippet.title || playlistSnippet.title || "",
      text: "",
      excerpt: truncateChars(description, 1800),
      summary: truncateChars(description, 900),
      url,
      canonicalUrl: url,
      videoId,
      ts: lifecycle.ts,
      publishedAt: lifecycle.effectivePublishedAt || "",
      youtubePublishedAt: lifecycle.youtubePublishedAt,
      playlistVideoPublishedAt: lifecycle.playlistVideoPublishedAt,
      playlistAddedAt: lifecycle.playlistAddedAt,
      youtubeState: lifecycle.state,
      liveBroadcastContent: lifecycle.liveBroadcastContent,
      scheduledStartTime: lifecycle.scheduledStartTime,
      actualStartTime: lifecycle.actualStartTime,
      actualEndTime: lifecycle.actualEndTime,
      youtubeUploadStatus: lifecycle.uploadStatus,
      likes: Number(detail.statistics?.likeCount || 0),
      views: Number(detail.statistics?.viewCount || 0),
      duration: fmtDuration(detail.contentDetails?.duration),
      full: false,
      categories: [],
    };
  });
}

async function adaptBlog(src) {
  const xml = await getText(src.url);
  return parseFeed(xml, src);
}

const ADAPTERS = {
  "x-feed": adaptXFeed,
  youtube: adaptYouTube,
  blog: adaptBlog,
};

function mergeDuplicate(left, right) {
  const winner = Number(right.sourcePriority || 0) > Number(left.sourcePriority || 0) ? right : left;
  const other = winner === right ? left : right;
  return {
    ...other,
    ...winner,
    id: left.id || right.id,
    sourceTags: unique([...(left.sourceTags || [left.source]), ...(right.sourceTags || [right.source])]),
    categories: unique([...(left.categories || []), ...(right.categories || [])]),
    excerpt: winner.excerpt || other.excerpt || "",
    summary: winner.summary || other.summary || "",
    ts: (() => {
      const values = [left.ts, right.ts].map(Number).filter((value) => Number.isFinite(value) && value > 0);
      return values.length ? Math.max(...values) : null;
    })(),
    likes: Math.max(Number(left.likes || 0), Number(right.likes || 0)),
    views: Math.max(Number(left.views || 0), Number(right.views || 0)),
  };
}

function deduplicate(items) {
  const byKey = new Map();
  for (const item of items) {
    const canonical = canonicalizeURL(item.canonicalUrl || item.url);
    item.canonicalUrl = canonical;
    const key = canonical ? `url:${canonical}` : `id:${item.id}`;
    byKey.set(key, byKey.has(key) ? mergeDuplicate(byKey.get(key), item) : item);
  }
  return [...byKey.values()];
}

const TOPIC_RULES = [
  ["agents", 8, /\bagent(?:ic|s)?\b|computer use|tool use|multi-agent/i],
  ["workflow", 8, /workflow|harness|orchestrat|human[- ]in[- ]the[- ]loop|context engineering/i],
  ["coding", 7, /coding|code generation|developer|software engineering|repository|compiler/i],
  ["evaluation", 7, /evaluation|evals?|benchmark|verification|judge|reward model/i],
  ["science", 8, /science|scientific|biology|chemistry|physics|medicine|genomics|materials|weather|fusion/i],
  ["research", 5, /research|paper|study|technical report|arxiv/i],
  ["reasoning", 6, /reasoning|inference|test[- ]time|chain of thought|planning/i],
  ["open-source", 6, /open source|open-source|weights|hugging face|dataset/i],
  ["multimodal", 5, /multimodal|vision|video|audio|speech/i],
  ["interpretability", 7, /interpretability|mechanistic|attribution|model behavior/i],
  ["safety", 5, /safety|alignment|risk|red team|security|misuse/i],
  ["robotics", 6, /robot|robotics|embodied/i],
  ["model-release", 5, /launch|release|introducing|announce|new model|model card/i],
];

const NEGATIVE_RULES = [
  [-7, /job opening|we are hiring|careers?/i, "招聘信息"],
  [-5, /webinar|register now|event recap|conference booth/i, "活动推广"],
  [-4, /customer story|customer spotlight|case study:/i, "客户营销"],
  [-3, /sponsored|advertorial/i, "赞助内容"],
];

function localScore(item) {
  let score = clamp(Math.round(Number(item.sourcePriority || 0.7) * 20), 0, 20);
  const reasons = [];
  const topics = [];
  const text = `${item.title || ""} ${item.excerpt || item.text || ""} ${(item.categories || []).join(" ")}`;
  const sourceType = item.sourceType || "community";
  const sourceBonus = { official: 15, independent: 12, curated: 8, community: 5 }[sourceType] || 5;
  score += sourceBonus;
  reasons.push(`${sourceType} source +${sourceBonus}`);

  const publishedTs = Number(item.ts);
  const hours = Number.isFinite(publishedTs) && publishedTs > 0 ? Math.max(0, (NOW - publishedTs) / 36e5) : Infinity;
  const freshness = hours <= 24 ? 15 : hours <= 48 ? 12 : hours <= 96 ? 8 : hours <= 168 ? 4 : 0;
  score += freshness;
  if (freshness) reasons.push(`fresh +${freshness}`);

  let topicScore = 0;
  for (const [topic, weight, pattern] of TOPIC_RULES) {
    if (pattern.test(text)) {
      topics.push(topic);
      topicScore += weight;
    }
  }
  topicScore = Math.min(topicScore, 32);
  score += topicScore;
  if (topicScore) reasons.push(`topic fit +${topicScore}`);

  const visualPatterns = [
    /\bhow\b|guide|framework|workflow|architecture|playbook|field guide/i,
    /\bvs\.?\b|versus|compare|difference|trade[- ]?off/i,
    /\b\d+\b|steps?|lessons?|patterns?|principles?/i,
    /diagram|map|matrix|taxonomy|benchmark|timeline/i,
  ];
  const visual = Math.min(15, visualPatterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 4 : 0), 0));
  score += visual;
  if (visual) reasons.push(`visualizable +${visual}`);

  const depth = Math.min(8, Math.floor(compactText(item.excerpt || item.text).length / 250));
  score += depth;

  const engagement = Math.min(
    8,
    Math.round(Math.log10(1 + Number(item.likes || 0)) + Math.log10(1 + Number(item.views || 0)) / 2),
  );
  score += engagement;

  for (const [penalty, pattern, label] of NEGATIVE_RULES) {
    if (pattern.test(text)) {
      score += penalty;
      reasons.push(`${label} ${penalty}`);
    }
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons,
    topics: unique(topics),
  };
}

function rednoteAngleFor(item, topics = []) {
  const set = new Set(topics);
  if (set.has("agents") || set.has("workflow")) return "用一个具体任务画出「AI 在哪里决策、人在哪里介入」的步骤图。";
  if (set.has("science")) return "从一个普通人能理解的科研问题切入，再解释 AI 改变了哪一步。";
  if (set.has("evaluation")) return "做成「看起来很强 ≠ 真正可靠」的对照卡，解释评测到底测了什么。";
  if (set.has("open-source")) return "不要只报模型名，比较它对普通用户或研究工作流真正新增了什么。";
  if (set.has("model-release")) return "用「新能力 / 旧限制 / 适合谁」三栏，避免只翻译发布公告。";
  return "提炼一个反常识观点，用同一案例展示它如何改变实际工作方式。";
}

function gapFor(item) {
  if (item.sourceType === "official") return "中文讨论可能只转述发布结果，缺少对实际工作流、证据和限制的解释。";
  if (item.sourceType === "independent") return "这类一手实验和经验总结在中文内容中通常传播较慢。";
  if (item.sourceType === "curated") return "适合用来发现趋势，但创作前应回到它引用的原始来源核实。";
  return "需要先确认是否有更权威的原始来源，再决定是否创作。";
}

function selectWithDiversity(scored, limit, maxPerGroup) {
  const selected = [];
  const counts = new Map();
  for (const entry of scored) {
    const group = entry.item.sourceGroup || entry.item.source;
    if ((counts.get(group) || 0) >= maxPerGroup) continue;
    selected.push(entry);
    counts.set(group, (counts.get(group) || 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function buildEditorialPrompt(candidates) {
  const payload = candidates.map(({ item, local }) => ({
    id: item.id,
    source: item.source,
    sourceType: item.sourceType,
    publishedAt: Number.isFinite(Number(item.ts)) && Number(item.ts) > 0 ? new Date(Number(item.ts)).toISOString() : null,
    title: item.title || truncateChars(item.text, 160),
    excerpt: truncateChars(item.excerpt || item.text || item.summary, 1000),
    localScore: local.score,
    localTopics: local.topics,
  }));

  return `你是 @Kelly的科研日常 的英文 AI 信息源编辑。目标不是把新闻翻译成中文，而是从候选中找出真正值得认真阅读、能发展成高质量中文小红书知识图文的内容。\n\n请严格依据给出的标题和摘要，不要补充候选中没有出现的事实。聚合来源只能用于发现线索；若来源是 curated，请在 uncertaintyZh 中提醒回到原始来源核实。\n\n评分重点：\n1. 与 AI 协作、agent、workflow、科研、评测、开源工具的相关度；\n2. 来源质量和证据是否具体；\n3. 中文读者是否存在信息差；\n4. 是否容易用框架、对比、步骤或主线案例视觉化；\n5. 一个月后是否仍然有价值。\n\n从候选中最多选 ${Number(EDIT.topLimit || 8)} 条。前 ${Number(EDIT.topPrimary || 3)} 条 tier=\"top\"，其余 tier=\"scan\"。不要为了凑数选择普通内容。再给出最多 ${Number(EDIT.ideaLimit || 3)} 个可组合多个来源的小红书选题。\n\n只输出一个 JSON 对象，不要 markdown。格式：\n{\n  \"items\": [\n    {\n      \"id\": \"候选id\",\n      \"rank\": 1,\n      \"tier\": \"top 或 scan\",\n      \"score\": 0,\n      \"summaryZh\": \"1-2句准确中文摘要\",\n      \"whyItMattersZh\": \"为什么今天值得关注\",\n      \"evidenceZh\": \"候选中具体出现了什么证据或信息\",\n      \"uncertaintyZh\": \"需要核实或尚不确定的地方；没有则写空字符串\",\n      \"chineseAudienceGapZh\": \"中文内容可能缺少的角度\",\n      \"rednoteAngleZh\": \"最适合 Kelly 账号的图文切入点\",\n      \"topics\": [\"agents\"],\n      \"reason\": \"一句话入选理由\"\n    }\n  ],\n  \"ideas\": [\n    {\n      \"workingTitle\": \"可发布的中文标题\",\n      \"angle\": \"内容主线与读者收获\",\n      \"whyNow\": \"为什么现在值得做\",\n      \"sourceIds\": [\"候选id\"]\n    }\n  ]\n}\n\n候选：\n${JSON.stringify(payload)}`;
}

async function geminiRequest(prompt, jsonMode = true) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is missing");
  if (geminiCalls >= GEMINI_MAX_CALLS) throw new Error("Gemini call budget exhausted");
  geminiCalls += 1;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: jsonMode ? 0.15 : 0.25,
        maxOutputTokens: jsonMode ? 8192 : 6000,
        ...(jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini ${response.status}: ${body.slice(0, 180)}`);
  }
  const data = await response.json();
  return (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
}

function parseJSONObject(raw) {
  const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}

function fallbackEditorial(candidates) {
  const max = Math.min(Number(EDIT.topLimit || 8), candidates.length);
  const primary = Number(EDIT.topPrimary || 3);
  const items = candidates.slice(0, max).map(({ item, local }, index) => ({
    id: item.id,
    rank: index + 1,
    tier: index < primary ? "top" : "scan",
    score: local.score,
    summaryZh: truncateChars(item.summary || item.excerpt || item.text || item.title, 260),
    whyItMattersZh: `本地规则认为它与 Kelly 的内容方向高度相关，当前评分 ${local.score}/100。`,
    evidenceZh: truncateChars(item.excerpt || item.text || item.title, 220),
    uncertaintyZh: "本次未使用 Gemini 复核，请打开原文确认细节和上下文。",
    chineseAudienceGapZh: gapFor(item),
    rednoteAngleZh: rednoteAngleFor(item, local.topics),
    topics: local.topics,
    reason: local.reasons.slice(0, 3).join(" · ") || "本地规则排序",
  }));
  return { items, ideas: buildFallbackIdeas(items, candidates) };
}

function buildFallbackIdeas(selected, candidates) {
  const ideas = [];
  const topicGroups = new Map();
  for (const entry of candidates) {
    for (const topic of entry.local.topics) {
      if (!topicGroups.has(topic)) topicGroups.set(topic, []);
      topicGroups.get(topic).push(entry.item.id);
    }
  }
  const templates = {
    agents: ["AI Agent 越能自己做事，人应该在哪些节点介入？", "用几个真实案例拆解 agent 工作流里的关键决策点"],
    workflow: ["为什么改 Prompt 不够？真正影响结果的是整个 AI 工作流", "从 context、提问到验证，画出一个完整协作闭环"],
    science: ["AI for Science 最近真正改变了科研的哪一步？", "用一个问题贯穿多个最新科研案例"],
    evaluation: ["模型看起来更强，为什么仍然可能不可靠？", "解释新评测究竟测到了什么、又漏掉了什么"],
    "open-source": ["新开源模型值得关注的，不只是参数", "比较它真正降低了哪些使用门槛"],
  };
  for (const [topic, ids] of [...topicGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (!templates[topic] || ideas.length >= Number(EDIT.ideaLimit || 3)) continue;
    ideas.push({ workingTitle: templates[topic][0], angle: templates[topic][1], whyNow: "当天多个来源出现同一主题信号。", sourceIds: unique(ids).slice(0, 4) });
  }
  if (!ideas.length && selected[0]) {
    ideas.push({ workingTitle: "今天最值得深入的一条 AI 信号", angle: selected[0].rednoteAngleZh, whyNow: selected[0].whyItMattersZh, sourceIds: [selected[0].id] });
  }
  return ideas;
}

function normalizeEditorial(raw, candidates) {
  const candidateMap = new Map(candidates.map((entry) => [entry.item.id, entry]));
  const requested = Array.isArray(raw?.items) ? raw.items : [];
  const maxTop = Number(EDIT.topLimit || 8);
  const maxPerSource = Number(EDIT.maxTopPerSource || 2);
  const sourceCounts = new Map();
  const items = [];

  const sorted = [...requested].sort((a, b) => Number(a.rank || 999) - Number(b.rank || 999));
  for (const value of sorted) {
    const candidate = candidateMap.get(value?.id);
    if (!candidate || items.some((item) => item.id === value.id)) continue;
    const group = candidate.item.sourceGroup || candidate.item.source;
    if ((sourceCounts.get(group) || 0) >= maxPerSource) continue;
    sourceCounts.set(group, (sourceCounts.get(group) || 0) + 1);
    const rank = items.length + 1;
    items.push({
      id: value.id,
      rank,
      tier: rank <= Number(EDIT.topPrimary || 3) ? "top" : "scan",
      score: clamp(Number(value.score || candidate.local.score), 0, 100),
      summaryZh: truncateChars(value.summaryZh || candidate.item.summary || candidate.item.excerpt, 320),
      whyItMattersZh: truncateChars(value.whyItMattersZh, 280),
      evidenceZh: truncateChars(value.evidenceZh || candidate.item.excerpt, 300),
      uncertaintyZh: truncateChars(value.uncertaintyZh, 260),
      chineseAudienceGapZh: truncateChars(value.chineseAudienceGapZh || gapFor(candidate.item), 260),
      rednoteAngleZh: truncateChars(value.rednoteAngleZh || rednoteAngleFor(candidate.item, candidate.local.topics), 300),
      topics: unique([...(Array.isArray(value.topics) ? value.topics : []), ...candidate.local.topics]).slice(0, 6),
      reason: truncateChars(value.reason || candidate.local.reasons.slice(0, 3).join(" · "), 180),
    });
    if (items.length >= maxTop) break;
  }

  // Fill missing primary slots with local ranking instead of returning a thin page.
  if (items.length < Math.min(Number(EDIT.topPrimary || 3), candidates.length)) {
    for (const candidate of candidates) {
      if (items.some((item) => item.id === candidate.item.id)) continue;
      const group = candidate.item.sourceGroup || candidate.item.source;
      if ((sourceCounts.get(group) || 0) >= maxPerSource) continue;
      sourceCounts.set(group, (sourceCounts.get(group) || 0) + 1);
      const fallback = fallbackEditorial([candidate]).items[0];
      fallback.rank = items.length + 1;
      fallback.tier = fallback.rank <= Number(EDIT.topPrimary || 3) ? "top" : "scan";
      items.push(fallback);
      if (items.length >= Number(EDIT.topPrimary || 3)) break;
    }
  }

  const validIds = new Set(candidateMap.keys());
  const ideas = (Array.isArray(raw?.ideas) ? raw.ideas : [])
    .map((idea) => ({
      workingTitle: truncateChars(idea?.workingTitle, 120),
      angle: truncateChars(idea?.angle, 260),
      whyNow: truncateChars(idea?.whyNow, 220),
      sourceIds: unique((idea?.sourceIds || []).filter((id) => validIds.has(id))).slice(0, 5),
    }))
    .filter((idea) => idea.workingTitle && idea.angle && idea.sourceIds.length)
    .slice(0, Number(EDIT.ideaLimit || 3));

  return { items, ideas: ideas.length ? ideas : buildFallbackIdeas(items, candidates) };
}

async function runEditorial(candidates) {
  if (!candidates.length) return { result: { items: [], ideas: [] }, usedGemini: false, error: "" };
  if (!GEMINI_KEY || GEMINI_MAX_CALLS < 1) return { result: fallbackEditorial(candidates), usedGemini: false, error: "Gemini disabled" };

  try {
    const first = await geminiRequest(buildEditorialPrompt(candidates), true);
    try {
      return { result: normalizeEditorial(parseJSONObject(first), candidates), usedGemini: true, error: "" };
    } catch (parseError) {
      if (geminiCalls >= GEMINI_MAX_CALLS) throw parseError;
      const repair = await geminiRequest(
        `把下面内容修复成有效 JSON。不要改变事实，不要添加解释或 markdown。\n\n${truncateChars(first, 16000)}`,
        true,
      );
      return { result: normalizeEditorial(parseJSONObject(repair), candidates), usedGemini: true, error: "" };
    }
  } catch (error) {
    log("  ! Gemini editorial fallback:", error.message);
    return { result: fallbackEditorial(candidates), usedGemini: false, error: error.message };
  }
}

async function transcript(videoId) {
  const cacheFile = path.join(TRANSCRIPT_DIR, `${videoId}.txt`);
  try {
    const cached = fs.readFileSync(cacheFile, "utf8");
    if (cached.trim()) {
      log("Transcript: reused cached copy");
      return cached;
    }
  } catch {}

  if (!SUPADATA_KEY) throw new Error("SUPADATA_API_KEY is missing.");
  const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", "x-api-key": SUPADATA_KEY },
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    const lower = body.toLowerCase();
    if (/currently live streaming|currently live|live stream(?:ing)?/.test(lower)) {
      throw new SourceNotReadyError(
        "youtube_live",
        "This video is live now. A full summary will be available after the stream ends and a transcript is published.",
      );
    }
    if (/scheduled|upcoming|premiere|not yet published|has not (?:started|premiered)/.test(lower)) {
      throw new SourceNotReadyError(
        "youtube_upcoming",
        "This video has not been published yet. A full summary will be available after it is released and a transcript exists.",
      );
    }
    if (/transcript.*not available yet|replay.*processing|still processing|caption.*processing/.test(lower)) {
      throw new SourceNotReadyError(
        "youtube_processing",
        "The video is available, but its replay or transcript is still processing. Please try again later.",
      );
    }
    throw new Error(`Transcript service returned ${response.status}: ${body.slice(0, 240) || "unknown error"}`);
  }

  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch {}
  const text = Array.isArray(data?.content)
    ? data.content.map((segment) => segment.text || "").join(" ")
    : typeof data?.content === "string"
      ? data.content
      : "";
  if (text.trim()) {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, text);
  }
  return text;
}

function fullSummaryPrompt(item, text) {
  const body = truncateWords(text, 18000);
  const kind = item.kind === "youtube" ? "YouTube talk" : item.kind === "x" ? "long X post" : "article or blog post";
  if (LANG === "en") {
    return `Write a detailed, faithful summary of this ${kind}. Use flowing paragraphs and bullets only for genuine parallel lists. Include key arguments, examples, numbers, limitations, and uncertainties. Use short section labels in **bold** when helpful. Do not use # headings or code blocks. No preamble.\n\nTitle: ${item.title || item.text || item.url}\n\nSource text: ${body}`;
  }
  if (LANG === "bilingual") {
    return `Write a detailed, faithful summary of this ${kind} in English, followed by the same summary in Simplified Chinese. Use flowing paragraphs and bullets only for genuine parallel lists. Include key arguments, examples, numbers, limitations, and uncertainties. Use short section labels in **bold** when helpful. Do not use # headings or code blocks. No preamble.\n\nTitle: ${item.title || item.text || item.url}\n\nSource text: ${body}`;
  }
  return `请阅读下面${kind === "YouTube talk" ? "视频" : kind === "long X post" ? "长帖" : "文章"}的完整内容，写一份详细、忠于原文的简体中文总结，让读者不用打开原文也能掌握主要内容。以连贯段落为主，只有并列步骤或清单才使用「• 」列表。请保留关键论点、数字、例子、限制与不确定性。可以用 **加粗小标题** 标出主要分段；不要使用 # 标题或代码块。直接输出正文，不要开场白。\n\n标题：${item.title || item.text || item.url}\n\n原始内容：${body}`;
}

function findArticleBodyInJSON(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findArticleBodyInJSON(child);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  if (typeof value.articleBody === "string" && value.articleBody.trim()) return value.articleBody;
  for (const child of Object.values(value)) {
    const found = findArticleBodyInJSON(child);
    if (found) return found;
  }
  return "";
}

function readableArticleText(html) {
  const source = String(html || "");
  const jsonScripts = [...source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonScripts) {
    try {
      const body = findArticleBodyInJSON(JSON.parse(decodeEntities(match[1])));
      if (compactText(body).length > 500) return compactText(body);
    } catch {}
  }

  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|form|nav|footer|aside|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const candidates = [];
  for (const tag of ["article", "main"]) {
    for (const block of extractBlocks(cleaned, tag)) candidates.push(stripHTML(block));
  }
  const classPattern = /<(?:div|section)\b[^>]*(?:id|class)=["'][^"']*(?:article|post|entry|content|story|prose|body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/gi;
  for (const match of cleaned.matchAll(classPattern)) candidates.push(stripHTML(match[1]));
  candidates.push(stripHTML(cleaned));
  return candidates.map(compactText).filter((text) => text.length >= 300).sort((a, b) => b.length - a.length)[0] || "";
}

function safeSourceSlug(value, fallback = "item") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return slug || fallback;
}

function sourceCachePath(item) {
  if (item.kind === "youtube") {
    const rawVideoId = item.videoId || String(item.id || "").replace(/^yt:/, "");
    const videoId = String(rawVideoId || "").replace(/[^A-Za-z0-9_-]/g, "") || "video";
    return path.join(TRANSCRIPT_DIR, `${videoId}.txt`);
  }
  const digest = crypto.createHash("sha256").update(String(item.id || item.url || item.title || "item")).digest("hex").slice(0, 10);
  const prefix = item.kind === "x" ? "x" : "article";
  const human = item.kind === "x"
    ? safeSourceSlug(String(item.id || "").replace(/^x:/, ""), "post")
    : safeSourceSlug(item.title || item.author || "article", "article");
  return path.join(TRANSCRIPT_DIR, `${prefix}-${human}-${digest}.txt`);
}

function relativeSourcePath(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function readSourceCache(item) {
  const file = sourceCachePath(item);
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.trim()) return { text, file };
  } catch {}
  return null;
}

function saveSourceCache(item, text) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  const file = sourceCachePath(item);
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `${clean}\n`);
  return relativeSourcePath(file);
}

async function sourceTextForItem(item) {
  const cached = readSourceCache(item);
  if (cached) {
    const inferredSource = item.fullSummarySource || (item.kind === "youtube" ? "transcript" : item.kind === "x" ? "post" : "article");
    return { text: cached.text.trim(), source: inferredSource, path: relativeSourcePath(cached.file) };
  }

  if (item.kind === "youtube") {
    const blocked = youtubeNotReady(item);
    if (blocked) throw blocked;
    const videoId = item.videoId || String(item.id || "").replace(/^yt:/, "");
    const text = await transcript(videoId);
    if (!text) throw new Error("No transcript was returned. The transcript may still be processing, or the Supadata key/quota may need attention.");
    return { text, source: "transcript", path: saveSourceCache(item, text) };
  }
  if (item.kind === "x") {
    const text = String(item.text || item.excerpt || "").trim();
    if (!text) throw new Error("The X post has no text in the archive.");
    return { text, source: "post", path: saveSourceCache(item, text) };
  }

  let article = "";
  if (item.url) {
    try {
      const html = await getText(item.url, { Accept: "text/html,application/xhtml+xml,*/*" });
      article = readableArticleText(html);
    } catch (error) {
      log("Article fetch fallback:", error.message);
    }
  }
  const fallback = compactText(item.excerpt || item.text || (!item.full ? item.summary : "") || item.title);
  const text = article.length >= Math.max(700, fallback.length) ? article : fallback;
  if (!text) throw new Error("No readable article text was available.");
  return { text, source: article === text ? "article" : "feed", path: saveSourceCache(item, text) };
}

function updateItemInTopHistory(item) {
  const history = readJSON(TOP_HISTORY_PATH, { days: [] });
  let changed = false;
  for (const day of history.days || []) {
    if (!Array.isArray(day.items)) continue;
    const index = day.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      day.items[index] = historySnapshot(item);
      changed = true;
    }
  }
  if (changed) writeJSONAtomic(TOP_HISTORY_PATH, history);
}

function writeFullSummaryStatus(archiveDoc, items, item, status, details = {}) {
  const at = new Date().toISOString();
  item.fullSummaryAttemptAt = at;
  item.fullSummaryStatus = status;
  item.fullSummaryMessage = details.message || "";
  item.fullSummaryErrorCode = details.code || "";
  item.fullSummaryRetryAt = details.retryAt || "";
  if (status !== "ready") item.fullSummaryLastErrorAt = at;
  writeJSONAtomic(ARCHIVE_PATH, { ...archiveDoc, generatedAt: at, count: items.length, items });
  updateItemInTopHistory(item);
}

async function summarizeOneItem(itemId) {
  const archiveDoc = readJSON(ARCHIVE_PATH, { items: [] });
  const items = archiveDoc.items || [];
  const normalizedId = String(itemId || "").trim();
  const item = items.find((entry) => entry.id === normalizedId || entry.videoId === normalizedId || entry.id === `yt:${normalizedId}`);
  if (!item) throw new Error(`Item not found in archive: ${normalizedId}`);

  try {
    const blocked = item.kind === "youtube" ? youtubeNotReady(item) : null;
    if (blocked) throw blocked;
    if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is required for a full summary.");
    const source = await sourceTextForItem(item);
    if (item.kind === "youtube" && ["upcoming", "processing"].includes(String(item.youtubeState || ""))) {
      const inferredPublishedAt = item.actualStartTime || item.scheduledStartTime || item.youtubePublishedAt || "";
      const inferredPublishedMs = Date.parse(String(inferredPublishedAt || ""));
      item.youtubeState = "available";
      if (Number.isFinite(inferredPublishedMs)) {
        item.publishedAt = new Date(inferredPublishedMs).toISOString();
        item.ts = inferredPublishedMs;
      }
      item.availabilityUpdatedAt = new Date().toISOString();
    }
    const summary = await geminiRequest(fullSummaryPrompt(item, source.text), false);
    item.summary = summary || item.summary;
    item.full = true;
    item.fullSummaryAt = new Date().toISOString();
    item.fullSummarySource = source.source;
    item.fullSummaryChars = source.text.length;
    item.fullSourcePath = source.path || relativeSourcePath(sourceCachePath(item));
    item.sourceTextPath = item.fullSourcePath;
    item.transcriptPath = item.fullSourcePath;
    item.fullSourceChars = source.text.length;
    item.fullSourceCachedAt = new Date().toISOString();
    item.fullSummaryAttemptAt = item.fullSummaryAt;
    item.fullSummaryStatus = "ready";
    item.fullSummaryMessage = "";
    item.fullSummaryErrorCode = "";
    item.fullSummaryRetryAt = "";
    item.fullSummaryLastErrorAt = "";
    writeJSONAtomic(ARCHIVE_PATH, { ...archiveDoc, generatedAt: new Date().toISOString(), count: items.length, items });
    updateItemInTopHistory(item);
    log("Upgraded full summary:", item.id);
  } catch (error) {
    const notReady = error instanceof SourceNotReadyError || error?.name === "SourceNotReadyError";
    if (notReady && item.kind === "youtube") {
      const inferredState = String(error.code || "").replace(/^youtube_/, "");
      if (["upcoming", "live", "processing"].includes(inferredState)) item.youtubeState = inferredState;
      item.availabilityUpdatedAt = new Date().toISOString();
    }
    const status = notReady ? "not_ready" : "error";
    const message = notReady
      ? error.message
      : `Full summary could not be generated: ${error.message}`;
    writeFullSummaryStatus(archiveDoc, items, item, status, {
      message,
      code: error.code || (notReady ? "source_not_ready" : "summary_failed"),
      retryAt: error.retryAt || item.scheduledStartTime || "",
    });
    if (notReady) log("Full summary deferred:", item.id, "—", message);
    else log("Full summary failed and was recorded:", item.id, "—", error.message);
  }
}

async function backfillFullSourceCaches() {
  const archiveDoc = readJSON(ARCHIVE_PATH, { items: [] });
  const items = Array.isArray(archiveDoc.items) ? archiveDoc.items : [];
  let changed = false;
  let cachedCount = 0;
  let skippedCount = 0;

  for (const item of items) {
    if (!item?.full) continue;
    const cached = readSourceCache(item);
    if (cached) {
      const relative = relativeSourcePath(cached.file);
      const cachedLength = cached.text.trim().length;
      if (
        item.fullSourcePath !== relative ||
        item.sourceTextPath !== relative ||
        item.transcriptPath !== relative ||
        item.fullSourceChars !== cachedLength
      ) {
        item.fullSourcePath = relative;
        item.sourceTextPath = relative;
        item.transcriptPath = relative;
        item.fullSourceChars = cachedLength;
        item.fullSourceCachedAt = item.fullSourceCachedAt || new Date().toISOString();
        changed = true;
      }
      cachedCount += 1;
      continue;
    }

    // Fetch missing YouTube transcripts only when the maintenance workflow explicitly opts in.
    // This keeps normal backfills free, while allowing a one-time repair to preserve the
    // original script for summaries that were generated by an older collector version.
    if (item.kind === "youtube" && String(process.env.BACKFILL_YOUTUBE_SOURCES || "").trim() !== "1") {
      skippedCount += 1;
      log(`Backfill skipped uncached YouTube transcript: ${item.id}`);
      continue;
    }

    try {
      const source = await sourceTextForItem(item);
      item.fullSourcePath = source.path || relativeSourcePath(sourceCachePath(item));
      item.sourceTextPath = item.fullSourcePath;
      item.transcriptPath = item.fullSourcePath;
      item.fullSourceChars = source.text.length;
      item.fullSourceCachedAt = new Date().toISOString();
      item.fullSummarySource = item.fullSummarySource || source.source;
      updateItemInTopHistory(item);
      changed = true;
      cachedCount += 1;
      log(`Backfilled source text: ${item.id} -> ${item.fullSourcePath}`);
    } catch (error) {
      skippedCount += 1;
      log(`Backfill failed for ${item.id}: ${error.message}`);
    }
  }

  if (changed) {
    writeJSONAtomic(ARCHIVE_PATH, { ...archiveDoc, generatedAt: new Date().toISOString(), count: items.length, items });
  }
  log(`Source cache backfill complete: ${cachedCount} cached, ${skippedCount} skipped.`);
}

function migrateAndMerge(existingItems, collectedItems) {
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const existingByURL = new Map(
    existingItems
      .map((item) => [canonicalizeURL(item.canonicalUrl || item.url), item])
      .filter(([url]) => url),
  );
  const merged = new Map(existingById);
  const newIds = new Set();
  const releasedIds = new Set();

  for (const incoming of collectedItems) {
    const canonical = canonicalizeURL(incoming.canonicalUrl || incoming.url);
    const previous = existingById.get(incoming.id) || (canonical ? existingByURL.get(canonical) : undefined);
    const id = previous?.id || incoming.id;
    const lifecycleKeys = [
      "youtubeState", "liveBroadcastContent", "scheduledStartTime", "actualStartTime",
      "actualEndTime", "youtubePublishedAt", "playlistVideoPublishedAt", "publishedAt",
      "youtubeUploadStatus", "ts",
    ];
    const lifecycleChanged = incoming.kind === "youtube" && (
      !previous || lifecycleKeys.some((key) => String(previous?.[key] ?? "") !== String(incoming?.[key] ?? ""))
    );
    const value = {
      ...(previous || {}),
      ...incoming,
      id,
      canonicalUrl: canonical,
      summary: previous?.summary || incoming.summary || incoming.excerpt || "",
      editorial: previous?.editorial || null,
      full: Boolean(previous?.full || incoming.full),
      firstSeen: previous?.firstSeen || incoming.firstSeen || previous?.ts || NOW,
      sourceTags: unique([...(previous?.sourceTags || []), ...(incoming.sourceTags || [incoming.source])]),
    };
    if (value.kind === "youtube") {
      value.availabilityUpdatedAt = lifecycleChanged
        ? new Date().toISOString()
        : previous?.availabilityUpdatedAt || incoming.availabilityUpdatedAt || "";
      const state = String(value.youtubeState || "");
      const availabilityBlock = youtubeNotReady(value);
      if (value.full) {
        value.fullSummaryStatus = "ready";
      } else if (availabilityBlock) {
        value.fullSummaryStatus = "not_ready";
        value.fullSummaryErrorCode = availabilityBlock.code || `youtube_${state}`;
        value.fullSummaryRetryAt = availabilityBlock.retryAt || value.scheduledStartTime || "";
        value.fullSummaryMessage = availabilityBlock.message;
      } else if (previous?.fullSummaryStatus === "not_ready" && String(previous?.fullSummaryErrorCode || "").startsWith("youtube_")) {
        value.fullSummaryStatus = "";
        value.fullSummaryErrorCode = "";
        value.fullSummaryRetryAt = "";
        value.fullSummaryMessage = "";
      }
    }
    merged.set(id, value);
    if (!previous) {
      newIds.add(id);
    } else if (
      value.kind === "youtube" &&
      String(previous.youtubeState || "") === "upcoming" &&
      String(value.youtubeState || "") !== "upcoming" &&
      Number.isFinite(Number(value.ts)) &&
      Number(value.ts) > 0
    ) {
      releasedIds.add(id);
    }
  }
  return { merged, newIds, releasedIds };
}

function hasSourceHistory(existingItems, src) {
  const group = src.group || src.name;
  return existingItems.some((item) =>
    item.source === src.name ||
    (group === src.name && item.sourceGroup === group) ||
    (Array.isArray(item.sourceTags) && item.sourceTags.includes(src.name)),
  );
}

function historySnapshot(item) {
  if (!item) return null;
  return {
    id: item.id,
    source: item.source,
    sourceGroup: item.sourceGroup,
    sourceType: item.sourceType,
    kind: item.kind,
    author: item.author,
    avatarUrl: item.avatarUrl || "",
    subtitle: item.subtitle || "",
    title: item.title || "",
    text: item.text || "",
    excerpt: item.excerpt || "",
    summary: item.summary || "",
    url: item.url,
    ts: item.ts,
    likes: item.likes || 0,
    views: item.views || 0,
    duration: item.duration || "",
    videoId: item.videoId || "",
    youtubeState: item.youtubeState || "",
    liveBroadcastContent: item.liveBroadcastContent || "",
    scheduledStartTime: item.scheduledStartTime || "",
    actualStartTime: item.actualStartTime || "",
    actualEndTime: item.actualEndTime || "",
    youtubePublishedAt: item.youtubePublishedAt || "",
    playlistVideoPublishedAt: item.playlistVideoPublishedAt || "",
    availabilityUpdatedAt: item.availabilityUpdatedAt || "",
    full: Boolean(item.full),
    fullSummaryAt: item.fullSummaryAt || "",
    fullSummaryStatus: item.fullSummaryStatus || "",
    fullSummaryAttemptAt: item.fullSummaryAttemptAt || "",
    fullSummaryMessage: item.fullSummaryMessage || "",
    fullSummaryErrorCode: item.fullSummaryErrorCode || "",
    fullSummaryRetryAt: item.fullSummaryRetryAt || "",
    fullSummarySource: item.fullSummarySource || "",
    fullSourcePath: item.fullSourcePath || item.sourceTextPath || item.transcriptPath || "",
    sourceTextPath: item.sourceTextPath || item.fullSourcePath || item.transcriptPath || "",
    transcriptPath: item.transcriptPath || item.fullSourcePath || item.sourceTextPath || "",
    fullSourceChars: item.fullSourceChars || 0,
    editorial: item.editorial || null,
  };
}

function dailySnapshotHistory(itemMap) {
  if (!fs.existsSync(DAILY_DIR)) return [];
  const entries = [];
  for (const file of fs.readdirSync(DAILY_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const doc = readJSON(path.join(DAILY_DIR, file), null);
    if (!doc || !Array.isArray(doc.ranking)) continue;
    const date = doc.date || file.slice(0, 10);
    entries.push({
      date,
      generatedAt: doc.generatedAt || `${date}T12:00:00Z`,
      ranking: doc.ranking,
      ideas: doc.ideas || [],
      items: doc.ranking.map((rank) => historySnapshot(itemMap.get(rank.id))).filter(Boolean),
    });
  }
  return entries;
}

function updateTopHistory(today, itemMap) {
  const existing = readJSON(TOP_HISTORY_PATH, { days: [] });
  const entry = {
    date: today.date,
    generatedAt: today.generatedAt,
    ranking: today.ranking || [],
    ideas: today.ideas || [],
    items: (today.ranking || []).map((rank) => historySnapshot(itemMap.get(rank.id))).filter(Boolean),
  };
  const cutoff = NOW - RETENTION_MS;
  const byDate = new Map();
  for (const day of [entry, ...dailySnapshotHistory(itemMap), ...(existing.days || [])]) {
    if (!day?.date || byDate.has(day.date)) continue;
    const ts = Date.parse(`${day.date}T12:00:00Z`);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    byDate.set(day.date, day);
  }
  const days = [...byDate.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, Math.max(30, Number(CFG.retentionDays || 30)));
  writeJSONAtomic(TOP_HISTORY_PATH, { generatedAt: today.generatedAt, days });
}

function cleanDailySnapshots() {
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  const cutoff = NOW - RETENTION_MS;
  for (const file of fs.readdirSync(DAILY_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const day = Date.parse(file.slice(0, 10));
    if (Number.isFinite(day) && day < cutoff) fs.unlinkSync(path.join(DAILY_DIR, file));
  }
}

async function refreshYouTubeMetadata() {
  if (!YOUTUBE_KEY) throw new Error("YOUTUBE_API_KEY is required to refresh YouTube availability.");
  const archiveDoc = readJSON(ARCHIVE_PATH, { items: [] });
  const existingItems = Array.isArray(archiveDoc.items) ? archiveDoc.items : [];
  let collected = [];
  for (const src of CFG.sources || []) {
    if (src.enabled === false || src.type !== "youtube") continue;
    try {
      collected.push(...await adaptYouTube(src));
    } catch (error) {
      log(`YouTube refresh skipped for ${src.name}:`, error.message);
    }
  }

  const incomingItems = deduplicate(collected);
  const incomingById = new Map(incomingItems.map((item) => [item.id, item]));
  const changedItems = [];
  const releaseIds = new Set();
  const refreshKeys = [
    "source", "sourceGroup", "sourceType", "sourcePriority", "sourceTags",
    "author", "subtitle", "title", "excerpt", "url", "canonicalUrl", "videoId",
    "duration", "ts", "publishedAt", "youtubePublishedAt", "playlistVideoPublishedAt",
    "playlistAddedAt", "youtubeState", "liveBroadcastContent", "scheduledStartTime",
    "actualStartTime", "actualEndTime", "youtubeUploadStatus", "availabilityUpdatedAt",
    "fullSummaryStatus", "fullSummaryMessage", "fullSummaryErrorCode", "fullSummaryRetryAt",
  ];

  const nextItems = existingItems.map((previous) => {
    if (previous.kind !== "youtube") return previous;
    const incoming = incomingById.get(previous.id);
    if (!incoming) return previous;
    const { merged, releasedIds } = migrateAndMerge([previous], [incoming]);
    const mergedItem = merged.get(previous.id);
    const next = { ...previous };
    for (const key of refreshKeys) {
      if (Object.prototype.hasOwnProperty.call(mergedItem, key)) next[key] = mergedItem[key];
    }
    const before = JSON.stringify(refreshKeys.map((key) => previous[key] ?? null));
    const after = JSON.stringify(refreshKeys.map((key) => next[key] ?? null));
    if (before !== after) changedItems.push(next);
    for (const id of releasedIds) releaseIds.add(id);
    return next;
  });

  // This lightweight job deliberately updates existing archive entries only.
  // New videos remain the responsibility of the full daily collector so they
  // still receive editorial ranking and Chinese enrichment on first ingestion.
  if (!changedItems.length) {
    log(`YouTube availability is already current for ${incomingItems.length} item(s).`);
    return;
  }

  const sortValue = (item) => {
    const published = Number(item?.ts);
    if (Number.isFinite(published) && published > 0) return published;
    const scheduled = Date.parse(String(item?.scheduledStartTime || ""));
    if (Number.isFinite(scheduled)) return scheduled;
    const firstSeen = Number(item?.firstSeen);
    return Number.isFinite(firstSeen) ? firstSeen : 0;
  };
  const kept = nextItems.filter(withinRetention).sort((a, b) => sortValue(b) - sortValue(a));
  const generatedAt = new Date().toISOString();
  writeJSONAtomic(ARCHIVE_PATH, { ...archiveDoc, generatedAt, count: kept.length, items: kept });
  for (const item of changedItems) updateItemInTopHistory(item);

  // Preserve the stable ID but let the current day's data remember that a
  // previously scheduled video became a real release. The website's All New
  // Today view still derives its count from the actual publication timestamp.
  if (releaseIds.size) {
    for (const file of [TODAY_PATH, path.join(DAILY_DIR, `${DATE_KEY}.json`)]) {
      const doc = readJSON(file, null);
      if (!doc || doc.date !== DATE_KEY) continue;
      doc.newIds = unique([...(doc.newIds || []), ...releaseIds]);
      doc.newCount = doc.newIds.length;
      doc.generatedAt = generatedAt;
      writeJSONAtomic(file, doc);
    }
  }

  log(`Refreshed YouTube availability: ${changedItems.length} changed, ${releaseIds.size} newly released.`);
}

async function main() {
  if (String(process.env.REFRESH_YOUTUBE_STATUS || "").trim() === "1") {
    await refreshYouTubeMetadata();
    return;
  }
  if (String(process.env.BACKFILL_FULL_SOURCES || "").trim() === "1") {
    await backfillFullSourceCaches();
    return;
  }

  const requestedItem = String(process.env.SUMMARIZE_ITEM_ID || process.env.SUMMARIZE_VIDEO_ID || "").trim();
  if (requestedItem) {
    await summarizeOneItem(requestedItem);
    return;
  }

  const archiveDoc = readJSON(ARCHIVE_PATH, { items: [] });
  const existingItems = Array.isArray(archiveDoc.items) ? archiveDoc.items : [];
  const run = {
    status: "ok",
    startedAt: new Date().toISOString(),
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    itemsFetched: 0,
    itemsAfterDedup: 0,
    newItems: 0,
    candidates: 0,
    geminiCalls: 0,
    geminiModel: GEMINI_MODEL,
    usedGemini: false,
    errors: [],
  };

  let collected = [];
  for (const src of CFG.sources || []) {
    if (src.enabled === false) continue;
    run.sourcesAttempted += 1;
    const adapter = ADAPTERS[src.type];
    if (!adapter) {
      run.sourcesFailed += 1;
      run.errors.push(`${src.name}: unknown source type ${src.type}`);
      continue;
    }
    try {
      log(`Fetching ${src.type} · ${src.name}`);
      let items = await adapter(src);
      if (!hasSourceHistory(existingItems, src)) {
        const sourceCutoff = NOW - Math.max(1, Number(EDIT.initialBackfillDays || 7)) * 864e5;
        const before = items.length;
        items = items.filter((item) => Number(item.ts || NOW) >= sourceCutoff);
        if (before !== items.length) log(`  first-seen source: kept ${items.length}/${before} items from the last ${Number(EDIT.initialBackfillDays || 7)} day(s)`);
      }
      collected.push(...items);
      run.sourcesSucceeded += 1;
      run.itemsFetched += items.length;
      log(`  got ${items.length} items`);
    } catch (error) {
      run.sourcesFailed += 1;
      run.errors.push(`${src.name}: ${error.message}`);
      log(`  ! source failed: ${src.name} — ${error.message}`);
    }
  }

  const deduped = deduplicate(collected);
  run.itemsAfterDedup = deduped.length;
  const { merged, newIds, releasedIds } = migrateAndMerge(existingItems, deduped);

  let kept = [...merged.values()]
    .filter(withinRetention)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  const previousDay = readJSON(path.join(DAILY_DIR, `${DATE_KEY}.json`), { newIds: [] });
  const dailyNewIds = unique([
    ...(previousDay.newIds || []),
    ...kept.filter((item) => item.firstSeen && utcDayKey(item.firstSeen) === DATE_KEY).map((item) => item.id),
    ...newIds,
    ...releasedIds,
  ]).filter((id) => merged.has(id));
  const dailyNewSet = new Set(dailyNewIds);
  run.newItemsThisRun = newIds.size;
  run.releasedItemsThisRun = releasedIds.size;
  run.newItems = dailyNewIds.length;
  const newItems = kept.filter((item) => dailyNewSet.has(item.id));
  const fallbackCutoff = NOW - Math.max(1, Number(EDIT.fallbackWindowHours || 48)) * 36e5;
  const pool = [...newItems];
  if (pool.length < Number(EDIT.topPrimary || 3)) {
    for (const item of kept) {
      if (pool.some((candidate) => candidate.id === item.id)) continue;
      if (Number(item.firstSeen || item.ts || 0) < fallbackCutoff && Number(item.ts || 0) < fallbackCutoff) continue;
      pool.push(item);
    }
  }

  const scored = pool
    .map((item) => ({ item, local: localScore(item) }))
    .sort((a, b) => b.local.score - a.local.score || Number(b.item.ts || 0) - Number(a.item.ts || 0));
  const candidates = selectWithDiversity(
    scored,
    Number(EDIT.candidateLimit || 18),
    Number(EDIT.maxCandidatesPerSource || 5),
  );
  run.candidates = candidates.length;

  for (const { item, local } of candidates) {
    const target = merged.get(item.id);
    if (target) target.signals = { localScore: local.score, reasons: local.reasons, topics: local.topics };
  }

  const editorial = await runEditorial(candidates);
  run.geminiCalls = geminiCalls;
  run.usedGemini = editorial.usedGemini;
  if (editorial.error) run.errors.push(`Gemini: ${editorial.error}`);

  const ranking = editorial.result.items.map((entry, index) => ({
    id: entry.id,
    rank: index + 1,
    tier: index < Number(EDIT.topPrimary || 3) ? "top" : "scan",
    score: entry.score,
    reason: entry.reason,
  }));

  for (const entry of editorial.result.items) {
    const target = merged.get(entry.id);
    if (!target) continue;
    target.summary = entry.summaryZh || target.summary;
    target.editorial = {
      summaryZh: entry.summaryZh,
      whyItMattersZh: entry.whyItMattersZh,
      evidenceZh: entry.evidenceZh,
      uncertaintyZh: entry.uncertaintyZh,
      chineseAudienceGapZh: entry.chineseAudienceGapZh,
      rednoteAngleZh: entry.rednoteAngleZh,
      topics: entry.topics,
      processedAt: new Date().toISOString(),
      model: editorial.usedGemini ? GEMINI_MODEL : "local-fallback",
    };
  }

  kept = [...merged.values()]
    .filter(withinRetention)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  run.finishedAt = new Date().toISOString();
  const today = {
    generatedAt: run.finishedAt,
    date: DATE_KEY,
    newCount: dailyNewIds.length,
    newIds: dailyNewIds,
    topIds: ranking.filter((entry) => entry.tier === "top").map((entry) => entry.id),
    scanIds: ranking.filter((entry) => entry.tier === "scan").map((entry) => entry.id),
    ranking,
    ideas: editorial.result.ideas,
    run,
  };

  writeJSONAtomic(ARCHIVE_PATH, {
    generatedAt: run.finishedAt,
    count: kept.length,
    items: kept,
  });
  writeJSONAtomic(TODAY_PATH, today);
  writeJSONAtomic(path.join(DAILY_DIR, `${DATE_KEY}.json`), today);
  updateTopHistory(today, merged);
  cleanDailySnapshots();

  log(`\nDone. ${kept.length} archived · ${newIds.size} new this run · ${dailyNewIds.length} new today · ${ranking.length} ranked · ${geminiCalls} Gemini call(s).`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error("FATAL", error);
    process.exit(1);
  });
}

export {
  canonicalizeURL,
  utcDayKey,
  deduplicate,
  localScore,
  migrateAndMerge,
  normalizeEditorial,
  parseFeed,
  readableArticleText,
  sourceCachePath,
  stripHTML,
  youtubeLifecycle,
  youtubeNotReady,
};
