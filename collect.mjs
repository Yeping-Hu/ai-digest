// AI Builders Digest — daily collector.
// Runs on GitHub Actions (or anywhere with Node 20+). Zero dependencies.
// Reads sources.json, fetches each source, summarizes new items, and merges
// everything into data/archive.json keeping a rolling window (retentionDays).

import fs from "node:fs";
import path from "node:path";

const CFG = JSON.parse(fs.readFileSync("sources.json", "utf8"));
const ARCHIVE_PATH = "data/archive.json";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const SUPADATA_KEY = process.env.SUPADATA_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RETENTION = (CFG.retentionDays || 30) * 24 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 (compatible; ai-digest/1.0)";

const now = Date.now();
const log = (...a) => console.log(...a);

// ---------- tiny fetch helpers ----------
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
const truncateWords = (s, n) => {
  const w = (s || "").replace(/\s+/g, " ").trim().split(" ");
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…";
};
const decode = (s) =>
  (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ---------- summarization (Gemini, with graceful fallback) ----------
async function summarize(kind, title, body) {
  const fallback = truncateWords(body || title, 180);
  if (!GEMINI_KEY || !body) return fallback;
  try {
    const prompt =
      `Summarize this ${kind} in 2-3 plain sentences for someone deciding whether it's worth their time. ` +
      `No preamble, no markdown.\n\nTitle: ${title}\n\n${truncateWords(body, 4000)}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!r.ok) throw new Error(`gemini ${r.status}`);
    const d = await r.json();
    const out = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return out || fallback;
  } catch (e) {
    log("  summarize fallback:", e.message);
    return fallback;
  }
}

// ---------- transcript (Supadata, optional) ----------
async function transcript(videoId) {
  if (!SUPADATA_KEY) return "";
  try {
    const d = await getJSON(
      `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`,
      { "x-api-key": SUPADATA_KEY }
    );
    if (Array.isArray(d?.content)) return d.content.map((s) => s.text).join(" ");
    if (typeof d?.content === "string") return d.content;
    return "";
  } catch (e) {
    log("  transcript failed:", e.message);
    return "";
  }
}

// ================= ADAPTERS =================
// Each returns an array of normalized items:
// { id, source, kind, author, subtitle, title, text, url, ts, likes, summary }

async function adapt_x_feed(src) {
  const data = await getJSON(src.url);
  const out = [];
  for (const b of data.x || []) {
    for (const t of b.tweets || []) {
      out.push({
        id: "x:" + t.id,
        source: src.name,
        kind: "x",
        author: "@" + b.handle,
        subtitle: b.name + (b.bio ? " · " + truncateWords(b.bio.split("\n")[0], 6) : ""),
        title: "",
        text: decode(t.text),
        url: t.url,
        ts: Date.parse(t.createdAt) || now,
        likes: t.likes || 0,
        summary: "",
      });
    }
  }
  return out;
}

async function resolveChannelId(src) {
  if (src.channelId) return src.channelId;
  const handle = (src.handle || "").replace(/^@/, "");
  const html = await getText("https://www.youtube.com/@" + handle);
  const m = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/"externalId":"(UC[\w-]+)"/);
  if (!m) throw new Error("could not resolve channelId for @" + handle);
  return m[1];
}

async function adapt_youtube(src, existingIds) {
  const channelId = await resolveChannelId(src);
  const xml = await getText(
    "https://www.youtube.com/feeds/videos.xml?channel_id=" + channelId
  );
  const entries = xml.split("<entry>").slice(1);
  const out = [];
  for (const e of entries.slice(0, 15)) {
    const vid = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!vid) continue;
    const id = "yt:" + vid;
    const title = decode((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const url = (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] ||
      "https://www.youtube.com/watch?v=" + vid;
    const ts = Date.parse((e.match(/<published>([^<]+)<\/published>/) || [])[1]) || now;
    const desc = decode((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1]);
    const item = { id, source: src.name, kind: "youtube", author: src.name,
      subtitle: "YouTube", title, text: "", url, ts, likes: 0, summary: "" };
    if (!existingIds.has(id)) {
      const body = (src.transcript !== false ? await transcript(vid) : "") || desc || title;
      item.summary = await summarize("YouTube talk", title, body);
      log("  + new video:", title.slice(0, 60));
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
    const link = isAtom
      ? (c.match(/<link[^>]*href="([^"]+)"/) || [])[1]
      : decode((c.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    if (!link) continue;
    const id = "blog:" + link;
    const title = decode((c.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const ts = Date.parse(
      (c.match(/<(?:published|pubDate|updated)>([^<]+)<\/(?:published|pubDate|updated)>/) || [])[1]
    ) || now;
    const raw = decode((c.match(/<(?:content|description|summary)[^>]*>([\s\S]*?)<\/(?:content|description|summary)>/) || [])[1]);
    const item = { id, source: src.name, kind: "blog", author: src.name,
      subtitle: "Blog", title, text: "", url: link, ts, likes: 0, summary: "" };
    if (!existingIds.has(id)) {
      item.summary = await summarize("blog post", title, raw);
      log("  + new post:", title.slice(0, 60));
    }
    out.push(item);
  }
  return out;
}

const ADAPTERS = { "x-feed": adapt_x_feed, youtube: adapt_youtube, blog: adapt_blog };

// ================= MAIN =================
async function main() {
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
    } catch (e) {
      log("! source failed (skipping):", src.name, "—", e.message);
    }
  }

  // merge: keep prior summaries, add firstSeen for new items
  const merged = new Map(existing);
  for (const it of collected) {
    const prev = merged.get(it.id);
    merged.set(it.id, {
      ...it,
      summary: it.summary || prev?.summary || "",
      firstSeen: prev?.firstSeen || now,
    });
  }

  // prune to retention window (by publish date, falling back to firstSeen)
  const kept = [...merged.values()]
    .filter((i) => now - (i.ts || i.firstSeen || now) < RETENTION)
    .sort((a, b) => b.ts - a.ts);

  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  fs.writeFileSync(
    ARCHIVE_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: kept.length, items: kept }, null, 2)
  );
  log(`\nDone. ${kept.length} items in archive (${collected.length} fetched this run).`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
