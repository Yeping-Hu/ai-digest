import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateAndMerge, youtubeLifecycle, youtubeNotReady } from "../collect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const now = Date.parse("2026-07-21T18:00:00Z");

const playlistItem = {
  snippet: {
    publishedAt: "2026-07-20T12:00:00Z",
    resourceId: { videoId: "khVX_BUnEwU" },
  },
  contentDetails: { videoPublishedAt: "2026-07-20T12:00:00Z" },
};

const upcoming = youtubeLifecycle({
  snippet: {
    publishedAt: "2026-07-20T12:00:00Z",
    liveBroadcastContent: "upcoming",
  },
  contentDetails: { duration: "PT0S" },
  status: { uploadStatus: "uploaded" },
  liveStreamingDetails: { scheduledStartTime: "2026-07-22T18:00:00Z" },
}, playlistItem, now);
assert.equal(upcoming.state, "upcoming");
assert.equal(upcoming.ts, null, "an upcoming video must not use its playlist-add date as publication time");
assert.equal(upcoming.scheduledStartTime, "2026-07-22T18:00:00.000Z");

const blocked = youtubeNotReady({ kind: "youtube", youtubeState: "upcoming", scheduledStartTime: upcoming.scheduledStartTime });
assert.equal(blocked.code, "youtube_upcoming");
assert.match(blocked.message, /scheduled|not started/i);
assert.equal(
  youtubeNotReady({ kind: "youtube", youtubeState: "upcoming", scheduledStartTime: "2026-07-20T18:00:00Z" }),
  null,
  "after the scheduled time the summary action should be allowed to check transcript availability",
);

const live = youtubeLifecycle({
  snippet: { liveBroadcastContent: "live", publishedAt: "2026-07-20T12:00:00Z" },
  contentDetails: { duration: "PT0S" },
  status: { uploadStatus: "uploaded" },
  liveStreamingDetails: {
    scheduledStartTime: "2026-07-22T18:00:00Z",
    actualStartTime: "2026-07-22T18:04:00Z",
  },
}, playlistItem, Date.parse("2026-07-22T18:10:00Z"));
assert.equal(live.state, "live");
assert.equal(live.ts, Date.parse("2026-07-22T18:04:00Z"));

const processing = youtubeLifecycle({
  snippet: { liveBroadcastContent: "none", publishedAt: "2026-07-20T12:00:00Z" },
  contentDetails: { duration: "PT0S" },
  status: { uploadStatus: "processed" },
  liveStreamingDetails: {
    scheduledStartTime: "2026-07-22T18:00:00Z",
    actualStartTime: "2026-07-22T18:04:00Z",
    actualEndTime: "2026-07-22T19:05:00Z",
  },
}, playlistItem, Date.parse("2026-07-22T19:10:00Z"));
assert.equal(processing.state, "processing");
assert.equal(processing.ts, Date.parse("2026-07-22T18:04:00Z"));

const available = youtubeLifecycle({
  snippet: { liveBroadcastContent: "none", publishedAt: "2026-07-20T12:00:00Z" },
  contentDetails: { duration: "PT1H1M" },
  status: { uploadStatus: "processed" },
  liveStreamingDetails: {
    scheduledStartTime: "2026-07-22T18:00:00Z",
    actualStartTime: "2026-07-22T18:04:00Z",
    actualEndTime: "2026-07-22T19:05:00Z",
  },
}, playlistItem, Date.parse("2026-07-22T20:00:00Z"));
assert.equal(available.state, "available");
assert.equal(available.ts, Date.parse("2026-07-22T18:04:00Z"), "released livestreams should be dated by actual start time");

const normal = youtubeLifecycle({
  snippet: { liveBroadcastContent: "none", publishedAt: "2026-07-21T15:00:00Z" },
  contentDetails: { duration: "PT20M" },
  status: { uploadStatus: "processed" },
}, {
  snippet: { publishedAt: "2026-07-21T14:58:00Z" },
  contentDetails: { videoPublishedAt: "2026-07-21T15:00:00Z" },
}, now);
assert.equal(normal.state, "available");
assert.equal(normal.ts, Date.parse("2026-07-21T15:00:00Z"));

// The same stable archive ID must survive the lifecycle transition. That is
// what lets browser shortlist state remain attached to the item.
const firstSeen = Date.parse("2026-07-21T12:00:00Z");
const stalePlaylistDate = {
  id: "yt:khVX_BUnEwU",
  kind: "youtube",
  title: "Active Graph Agent Runtime (BabyAGI 4)",
  url: "https://www.youtube.com/watch?v=khVX_BUnEwU",
  canonicalUrl: "https://www.youtube.com/watch?v=khVX_BUnEwU",
  ts: Date.parse("2026-07-20T12:00:00Z"),
  firstSeen,
  full: false,
};
const scheduledIncoming = {
  ...stalePlaylistDate,
  youtubeState: "upcoming",
  scheduledStartTime: "2026-07-22T18:00:00.000Z",
  ts: null,
  firstSeen: undefined,
};
const scheduledMerge = migrateAndMerge([stalePlaylistDate], [scheduledIncoming]);
assert.equal(scheduledMerge.merged.get(stalePlaylistDate.id).ts, null, "a playlist-add timestamp must be removed once YouTube identifies an upcoming release");

const previous = {
  id: "yt:khVX_BUnEwU",
  kind: "youtube",
  title: "Active Graph Agent Runtime (BabyAGI 4)",
  url: "https://www.youtube.com/watch?v=khVX_BUnEwU",
  canonicalUrl: "https://www.youtube.com/watch?v=khVX_BUnEwU",
  youtubeState: "upcoming",
  scheduledStartTime: "2026-07-22T18:00:00.000Z",
  ts: null,
  firstSeen,
  full: false,
  summary: "Scheduled talk",
};
const incoming = {
  ...previous,
  youtubeState: "live",
  actualStartTime: "2026-07-22T18:04:00.000Z",
  publishedAt: "2026-07-22T18:04:00.000Z",
  ts: Date.parse("2026-07-22T18:04:00Z"),
  firstSeen: undefined,
};
const transition = migrateAndMerge([previous], [incoming]);
const updated = transition.merged.get("yt:khVX_BUnEwU");
assert.equal(updated.id, previous.id);
assert.equal(updated.firstSeen, firstSeen);
assert.equal(updated.youtubeState, "live");
assert.equal(updated.ts, Date.parse("2026-07-22T18:04:00Z"));
assert.equal(transition.newIds.size, 0, "a release-state update must not create a new archive item");
assert.deepEqual([...transition.releasedIds], [previous.id], "a newly published scheduled video should re-enter the day's editorial candidate pool");

// A requested full summary for a known upcoming video should finish cleanly,
// persist a not-ready status, and never require Gemini/Supadata quota.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-digest-upcoming-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.copyFileSync(path.join(root, "collect.mjs"), path.join(tmp, "collect.mjs"));
fs.writeFileSync(path.join(tmp, "sources.json"), JSON.stringify({ summaryLang: "zh", retentionDays: 30, sources: [] }, null, 2));
fs.writeFileSync(path.join(tmp, "data", "archive.json"), JSON.stringify({
  generatedAt: new Date(now).toISOString(),
  count: 1,
  items: [previous],
}, null, 2));
const run = spawnSync(process.execPath, ["collect.mjs"], {
  cwd: tmp,
  env: {
    ...process.env,
    SUMMARIZE_VIDEO_ID: previous.id,
    GEMINI_API_KEY: "",
    SUPADATA_API_KEY: "",
  },
  encoding: "utf8",
});
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
const stored = JSON.parse(fs.readFileSync(path.join(tmp, "data", "archive.json"), "utf8")).items[0];
assert.equal(stored.full, false);
assert.equal(stored.fullSummaryStatus, "not_ready");
assert.equal(stored.fullSummaryErrorCode, "youtube_upcoming");
assert.equal(stored.fullSummaryRetryAt, "2026-07-22T18:00:00.000Z");
assert.match(stored.fullSummaryMessage, /scheduled|not started/i);
fs.rmSync(tmp, { recursive: true, force: true });


// Full-summary dispatch must refresh official YouTube metadata before touching
// Supadata, and the current generic transcript endpoint must stay in native mode.
const collectorSource = fs.readFileSync(path.join(root, "collect.mjs"), "utf8");
assert.match(collectorSource, /await refreshSingleYouTubeItem\(item\)/);
assert.match(collectorSource, /api\.supadata\.ai\/v1\/transcript/);
assert.match(collectorSource, /searchParams\.set\("mode", "native"\)/);
assert.doesNotMatch(collectorSource, /\/v1\/youtube\/transcript\?videoId=/);

// Front-end contract: upcoming status is visible, summary dispatch is blocked,
// the item is grouped separately until publication, and shortlist snapshots are
// refreshed from the stable live archive object.
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
assert.match(html, /Upcoming\$\{when\?/);
assert.match(html, /Available after \${when}/);
assert.match(html, /Check availability & summarize/);
assert.match(html, /Release time reached · checking availability/);
assert.match(html, /data-summary-block/);
assert.match(html, /Scheduled YouTube releases/);
assert.match(html, /youtubeState\(item\)!=="upcoming"&&publishedDayKey\(item\)===today/);
assert.match(html, /state\.saved\[id\]=snapshot\(live\)/);

console.log("YouTube lifecycle tests passed");
