// AI Builders Digest — collector (zero dependencies, Node 20+).
// Normal run: fetch all sources, summarize new items, merge into 30-day archive.
// One-video run (SUMMARIZE_VIDEO_ID set): upgrade one video to a transcript summary.
import fs from "node:fs";
import path from "node:path";

const CFG = JSON.parse(fs.readFileSync("sources.json", "utf8"));
const ARCHIVE_PATH = "data/archive.json";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const SUPADATA_KEY = process.env.SUPADATA_API_KEY || "";
const GEMINI_MODEL_OVERRIDE = process.env.GEMINI_MODEL || "";  // optional pin; otherwise auto-detected
const YT_KEY = process.env.YOUTUBE_API_KEY || "";  // must be a YouTube Data API v3 key (a Gemini/AI Studio key does NOT work here)
const LANG = (CFG.summaryLang || "en").toLowerCase();  // "en" | "zh" | "bilingual"
const RETENTION = (CFG.retentionDays || 30) * 864e5;
const UA = "Mozilla/5.0 (compatible; ai-digest/1.0)";
const now = Date.now();
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
// like getJSON, but hides the api key from any error message (for keyed API URLs)
async function getJSONSafe(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`${r.status} ${url.replace(/key=[^&]+/, "key=***")} ${t.slice(0, 140)}`); }
  return r.json();
}
const truncateWords = (s, n) => {
  const w = (s || "").replace(/\s+/g, " ").trim().split(" ");
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…";
};
const decode = (s) => (s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ---- summarization + translation (Gemini) ----
function buildPrompt(kind, title, body) {
  const b = truncateWords(body, 4000);
  if (LANG === "zh")
    return `请用2-3句简体中文，总结下面这个${kind}的核心内容，帮助读者快速判断是否值得花时间。直接给出总结，不要任何开场白，不要使用 markdown。\n\n标题：${title}\n\n内容：${b}`;
  if (LANG === "bilingual")
    return `Summarize this ${kind} in 2-3 sentences to help someone decide whether it is worth their time. Then, on a new line, give a Simplified Chinese translation of that summary. No preamble, no markdown.\n\nTitle: ${title}\n\n${b}`;
  return `Summarize this ${kind} in 2-3 plain sentences to help someone decide whether it is worth their time. No preamble, no markdown.\n\nTitle: ${title}\n\n${b}`;
}
// Pick a valid Gemini model at runtime — model names change, so a hardcoded one can 404.
let RESOLVED_MODEL = "";
async function pickModel() {
  if (GEMINI_MODEL_OVERRIDE) return GEMINI_MODEL_OVERRIDE;
  if (RESOLVED_MODEL) return RESOLVED_MODEL;
  try {
    const d = await getJSONSafe(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
    const gen = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    const ok = (m) => !/(preview|exp|thinking|vision|image|audio|tts|8b|embedding)/i.test(m);
    RESOLVED_MODEL =
      gen.filter((m) => /flash/i.test(m) && /lite/i.test(m) && ok(m)).sort().reverse()[0]   // flash-lite: highest free-tier RPM + daily limit
      || gen.filter((m) => /flash/i.test(m) && ok(m)).sort().reverse()[0]
      || gen.find((m) => /gemini/i.test(m) && ok(m))
      || gen[0]
      || "gemini-2.0-flash-lite";
    log("  using Gemini model:", RESOLVED_MODEL);
  } catch (e) {
    RESOLVED_MODEL = "gemini-2.0-flash";
    log("  model auto-detect failed, using default:", e.message);
  }
  return RESOLVED_MODEL;
}

// Throttle calls to stay under the free-tier per-minute limit.
let lastGemini = 0;
let geminiExhausted = false;  // set once the daily quota is gone — stop trying for the rest of the run
async function geminiCall(prompt) {
  const model = await pickModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  for (let i = 0; i < 4; i++) {
    const gap = 4000 - (Date.now() - lastGemini);
    if (gap > 0) await sleep(gap);
    lastGemini = Date.now();
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (r.status === 429) {
      const t = await r.text().catch(() => "");
      if (/per\s*day|perday|daily|requests per day/i.test(t)) { geminiExhausted = true; throw new Error("gemini daily quota reached (resets midnight Pacific)"); }
      log("  gemini busy (429/min); retrying…"); await sleep(8000); continue;
    }
    if (r.status >= 500) { log(`  gemini busy (${r.status}); retrying…`); await sleep(8000); continue; }
    if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`gemini ${r.status} ${t.slice(0, 120)}`); }
    const d = await r.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  }
  throw new Error("gemini rate-limited after retries");
}
// Returns a summary string. If Gemini is unavailable or over its limit, falls
// back to the ORIGINAL ENGLISH text (translation needs Gemini, so the fallback
// can only be English).
async function summarize(kind, title, body, fallbackEn) {
  const fallback = truncateWords(fallbackEn || body || title, 180);
  if (!GEMINI_KEY || !body || geminiExhausted) return fallback;
  try { return (await geminiCall(buildPrompt(kind, title, body))) || fallback; }
  catch (e) { log("  summarize fallback (English):", e.message); return fallback; }
}

// ---- transcript (Supadata, optional) ----
async function transcript(videoId) {
  if (!SUPADATA_KEY) return "";
  try {
    const d = await getJSON(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`, { "x-api-key": SUPADATA_KEY });
    if (Array.isArray(d?.content)) return d.content.map((s) => s.text).join(" ");
    if (typeof d?.content === "string") return d.content;
    return "";
  } catch (e) { log("  transcript failed:", e.message); return ""; }
}

// ================= ADAPTERS =================
async function adapt_x_feed(src) {
  const data = await getJSON(src.url);
  const out = [];
  for (const b of data.x || []) {
    for (const t of b.tweets || []) {
      out.push({
        id: "x:" + t.id, source: src.name, kind: "x", author: "@" + b.handle,
        subtitle: b.name + (b.bio ? " · " + truncateWords(b.bio.split("\n")[0], 6) : ""),
        title: "", text: decode(t.text), url: t.url,
        ts: Date.parse(t.createdAt) || now, likes: t.likes || 0, summary: "",
      });
    }
  }
  return out;
}
// Resolve the channel's "uploads" playlist via the official Data API (reliable from any IP).
async function ytUploadsPlaylist(src) {
  if (src.channelId) return "UU" + src.channelId.slice(2);
  const handle = (src.handle || "").replace(/^@/, "");
  const d = await getJSONSafe(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle)}&key=${YT_KEY}`);
  const up = d?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!up) throw new Error("could not resolve channel for @" + handle + " (check the handle or set channelId)");
  return up;
}
async function adapt_youtube(src, existingIds) {
  if (!YT_KEY) throw new Error("no YouTube API key — add a YOUTUBE_API_KEY secret (a YouTube Data API v3 key from Google Cloud)");
  const playlist = await ytUploadsPlaylist(src);
  const d = await getJSONSafe(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=15&playlistId=${playlist}&key=${YT_KEY}`);
  const out = [];
  for (const it of d.items || []) {
    const sn = it.snippet || {};
    const vid = sn.resourceId?.videoId;
    if (!vid) continue;
    const id = "yt:" + vid;
    const title = sn.title || "";
    const desc = sn.description || "";
    const url = "https://www.youtube.com/watch?v=" + vid;
    const ts = Date.parse(sn.publishedAt) || now;
    const item = { id, source: src.name, kind: "youtube", author: src.name, subtitle: "YouTube", title, text: "", url, ts, likes: 0, summary: "", full: false };
    if (!existingIds.has(id)) {
      const tx = src.transcript === true ? await transcript(vid) : "";
      item.full = !!tx;
      item.summary = await summarize("YouTube talk", title, tx || desc || title, desc);
      log(`  + new video${tx ? " [transcript]" : ""}:`, title.slice(0, 55));
    }
    out.push(item);
  }
  return out;
}
async function adapt_blog(src, existingIds) {
  const xml = await getText(src.url);
  const isAtom = xml.includes("<entry>");
  const chunks = isAtom ? xml.split("<entry>").slice(1) : xml.split("<item>").slice(1);
  const out = [];
  for (const c of chunks.slice(0, 10)) {
    const link = isAtom ? (c.match(/<link[^>]*href="([^"]+)"/) || [])[1] : decode((c.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    if (!link) continue;
    const id = "blog:" + link;
    const title = decode((c.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const ts = Date.parse((c.match(/<(?:published|pubDate|updated)>([^<]+)<\/(?:published|pubDate|updated)>/) || [])[1]) || now;
    const raw = decode((c.match(/<(?:content|description|summary)[^>]*>([\s\S]*?)<\/(?:content|description|summary)>/) || [])[1]);
    const item = { id, source: src.name, kind: "blog", author: src.name, subtitle: "Blog", title, text: "", url: link, ts, likes: 0, summary: "", full: false };
    if (!existingIds.has(id)) { item.summary = await summarize("blog post", title, raw, raw); log("  + new post:", title.slice(0, 55)); }
    out.push(item);
  }
  return out;
}
const ADAPTERS = { "x-feed": adapt_x_feed, youtube: adapt_youtube, blog: adapt_blog };

// ---- one-off: upgrade a single video to a full transcript summary ----
async function summarizeOne(vid) {
  let arch = [];
  try { arch = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8")).items || []; } catch {}
  const item = arch.find((i) => i.id === "yt:" + vid);
  if (!item) { console.error("Video not found in archive:", vid); process.exit(1); }
  const tx = await transcript(vid);
  if (!tx) { console.error("No transcript available (check SUPADATA_API_KEY and your credit balance)."); process.exit(1); }
  item.summary = await summarize("YouTube talk", item.title, tx, item.summary);
  item.full = true;
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), count: arch.length, items: arch }, null, 2));
  log("Upgraded to full summary:", vid);
}

// ================= MAIN =================
async function main() {
  const one = process.env.SUMMARIZE_VIDEO_ID;
  if (one && one.trim()) { await summarizeOne(one.trim()); return; }

  let archive = [];
  try { archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8")).items || []; } catch {}
  const existing = new Map(archive.map((i) => [i.id, i]));
  const existingIds = new Set(existing.keys());

  let collected = [];
  for (const src of CFG.sources) {
    if (src.enabled === false) continue;
    const fn = ADAPTERS[src.type];
    if (!fn) { log("! unknown source type:", src.type); continue; }
    try {
      log("Fetching", src.type, "·", src.name);
      const items = await fn(src, existingIds);
      collected = collected.concat(items);
      log("  got", items.length, "items");
    } catch (e) { log("! source failed (skipping):", src.name, "—", e.message); }
  }

  const merged = new Map(existing);
  for (const it of collected) {
    const prev = merged.get(it.id);
    merged.set(it.id, {
      ...it,
      summary: it.summary || prev?.summary || "",
      full: (prev?.full || it.full) || false,
      firstSeen: prev?.firstSeen || now,
    });
  }
  const kept = [...merged.values()]
    .filter((i) => now - (i.ts || i.firstSeen || now) < RETENTION)
    .sort((a, b) => b.ts - a.ts);

  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), count: kept.length, items: kept }, null, 2));
  log(`\nDone. ${kept.length} items in archive (${collected.length} fetched this run).`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
