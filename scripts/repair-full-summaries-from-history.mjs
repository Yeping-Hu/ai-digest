import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const ARCHIVE_PATH = path.join(ROOT, "data", "archive.json");
const TOP_HISTORY_PATH = path.join(ROOT, "data", "top-history.json");
const DAILY_DIR = path.join(ROOT, "data", "daily");

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJSONAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksDetailed(value) {
  const raw = String(value || "").trim();
  const flat = compact(raw);
  const paragraphs = raw.split(/\n\s*\n/).filter((part) => compact(part)).length;
  const bullets = (raw.match(/^(?:[-*•]|\d+[.)])\s+/gm) || []).length;
  return flat.length >= 650 || (flat.length >= 380 && (paragraphs >= 3 || bullets >= 4));
}

function shortPreview(item, detailed) {
  const editorial = String(item?.editorial?.summaryZh || "").trim();
  if (editorial) return editorial;
  const excerpt = compact(item?.excerpt || item?.text || "");
  if (excerpt && excerpt !== compact(detailed)) return excerpt.slice(0, 320);
  const flat = compact(detailed);
  return flat.length > 320 ? `${flat.slice(0, 319).trimEnd()}…` : flat;
}

function addCandidate(map, id, value, origin) {
  const text = String(value || "").trim();
  if (!id || !text || !looksDetailed(text)) return;
  const list = map.get(id) || [];
  if (!list.some((entry) => entry.text === text)) list.push({ text, origin });
  map.set(id, list);
}

function collectFromItems(map, items, origin) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id) continue;
    addCandidate(map, item.id, item.fullSummary, `${origin}:fullSummary`);
    if (item.full || item.fullSummaryStatus === "ready" || item.fullSummaryAt) {
      addCandidate(map, item.id, item.summary, `${origin}:summary`);
    }
  }
}

function collectCurrentFiles(map, archive, history) {
  collectFromItems(map, archive.items, "current archive");
  for (const day of history.days || []) collectFromItems(map, day.items, `current Top Archive ${day.date || ""}`);
  if (!fs.existsSync(DAILY_DIR)) return;
  for (const file of fs.readdirSync(DAILY_DIR)) {
    if (!/\.json$/i.test(file)) continue;
    const doc = readJSON(path.join(DAILY_DIR, file), null);
    if (doc) collectFromItems(map, doc.items, `current daily ${file}`);
  }
}

function gitOutput(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function collectGitHistory(map, file, maxCommits = 100) {
  const commits = gitOutput(["log", `--max-count=${maxCommits}`, "--format=%H", "--", file])
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const commit of commits) {
    const raw = gitOutput(["show", `${commit}:${file}`]);
    if (!raw) continue;
    let doc;
    try { doc = JSON.parse(raw); } catch { continue; }
    if (file.endsWith("archive.json")) collectFromItems(map, doc.items, `${commit.slice(0, 8)}:${file}`);
    else for (const day of doc.days || []) collectFromItems(map, day.items, `${commit.slice(0, 8)}:${file}:${day.date || ""}`);
  }
}

function bestCandidate(list) {
  return [...(list || [])].sort((a, b) => compact(b.text).length - compact(a.text).length)[0] || null;
}

function syncHistoryItem(snapshot, live) {
  if (!snapshot || snapshot.id !== live.id) return false;
  let changed = false;
  const fields = {
    fullSummary: live.fullSummary,
    summary: live.summary,
    full: true,
    fullSummaryStatus: "ready",
    fullSummaryMessage: "",
    fullSummaryErrorCode: "",
    fullSummaryRetryAt: "",
    fullSummaryAt: live.fullSummaryAt || snapshot.fullSummaryAt || "",
    fullSummaryChars: live.fullSummaryChars || compact(live.fullSummary).length,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (snapshot[key] !== value) { snapshot[key] = value; changed = true; }
  }
  return changed;
}

function main() {
  const archive = readJSON(ARCHIVE_PATH, { items: [] });
  const history = readJSON(TOP_HISTORY_PATH, { days: [] });
  const candidates = new Map();
  collectCurrentFiles(candidates, archive, history);
  collectGitHistory(candidates, "data/archive.json");
  collectGitHistory(candidates, "data/top-history.json");

  let repaired = 0;
  let markedForRegeneration = 0;
  let archiveChanged = false;
  const repairedById = new Map();

  for (const item of archive.items || []) {
    const expectsFull = Boolean(item.full || item.fullSummaryStatus === "ready" || item.fullSummaryAt);
    if (!expectsFull) continue;
    const current = String(item.fullSummary || "").trim();
    const candidate = bestCandidate(candidates.get(item.id));
    const detailed = looksDetailed(current) ? current : candidate?.text || "";
    if (detailed) {
      const preview = item.summary === detailed || looksDetailed(item.summary) ? shortPreview(item, detailed) : item.summary || shortPreview(item, detailed);
      const updates = {
        fullSummary: detailed,
        summary: preview,
        full: true,
        fullSummaryStatus: "ready",
        fullSummaryMessage: "",
        fullSummaryErrorCode: "",
        fullSummaryRetryAt: "",
        fullSummaryChars: compact(detailed).length,
      };
      for (const [key, value] of Object.entries(updates)) {
        if (item[key] !== value) { item[key] = value; archiveChanged = true; }
      }
      repairedById.set(item.id, item);
      if (!looksDetailed(current) && candidate) {
        repaired += 1;
        console.log(`Recovered ${item.id} from ${candidate.origin} (${compact(detailed).length} chars).`);
      }
    } else {
      const updates = {
        full: false,
        fullSummaryStatus: "needs_regeneration",
        fullSummaryMessage: "The previous full-summary flag was preserved, but its text could not be recovered. Generate it again from the cached source or original URL.",
        fullSummaryErrorCode: "full_summary_text_missing",
      };
      for (const [key, value] of Object.entries(updates)) {
        if (item[key] !== value) { item[key] = value; archiveChanged = true; }
      }
      markedForRegeneration += 1;
      console.log(`Could not recover ${item.id}; marked it for regeneration.`);
    }
  }

  let historyChanged = false;
  for (const day of history.days || []) {
    for (const snapshot of day.items || []) {
      const live = repairedById.get(snapshot.id);
      if (live && syncHistoryItem(snapshot, live)) historyChanged = true;
    }
  }

  if (archiveChanged) {
    archive.generatedAt = new Date().toISOString();
    archive.count = (archive.items || []).length;
    writeJSONAtomic(ARCHIVE_PATH, archive);
  }
  if (historyChanged) writeJSONAtomic(TOP_HISTORY_PATH, history);
  console.log(`Full-summary recovery complete: ${repaired} recovered, ${markedForRegeneration} need regeneration.`);
}

main();
