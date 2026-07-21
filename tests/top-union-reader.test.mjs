import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dayKeyInTimeZone, mergeDailyRanking } from "../collect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const collect = fs.readFileSync(path.join(root, "collect.mjs"), "utf8");

assert.equal(
  dayKeyInTimeZone("2026-07-22T05:30:00Z", "America/Los_Angeles"),
  "2026-07-21",
  "Pacific editorial days must not roll over at UTC midnight",
);
assert.equal(
  dayKeyInTimeZone("2026-12-01T07:30:00Z", "America/Los_Angeles"),
  "2026-11-30",
  "Pacific editorial days must also respect standard time",
);

const itemMap = new Map([
  ["a", { id: "a", ts: 100 }],
  ["b", { id: "b", ts: 200 }],
  ["c", { id: "c", ts: 300 }],
]);
const previous = [
  { id: "a", rank: 1, score: 78, selectionCount: 1, firstSelectedAt: "2026-07-21T16:00:00Z", lastSelectedAt: "2026-07-21T16:00:00Z" },
  { id: "b", rank: 2, score: 80, selectionCount: 1, firstSelectedAt: "2026-07-21T16:00:00Z", lastSelectedAt: "2026-07-21T16:00:00Z" },
];
const current = [
  { id: "a", score: 75, reason: "selected again" },
  { id: "c", score: 85, reason: "new high score" },
];
const merged = mergeDailyRanking(previous, current, itemMap, "2026-07-21T22:00:00Z");
assert.deepEqual(merged.map((x) => x.id), ["c", "b", "a"]);
assert.equal(merged.find((x) => x.id === "a").peakScore, 78);
assert.equal(merged.find((x) => x.id === "a").lastScore, 75);
assert.equal(merged.find((x) => x.id === "a").selectionCount, 2);
assert.equal(merged.find((x) => x.id === "b").selectionCount, 1);
assert.ok(merged.every((x, index) => x.rank === index + 1 && x.tier === "top"));

assert.match(collect, /await refreshYouTubeMetadata\(\)/, "normal digest runs should refresh YouTube lifecycle metadata");
assert.match(collect, /mergeDailyRanking\(previousDay\.ranking \|\| \[\], currentRanking/);
assert.match(collect, /peakScore/);

assert.match(html, /id="readerOverlay"/);
assert.match(html, /function openReader\(/);
assert.match(html, /Open reader for the full summary, evidence and notes/);
assert.match(html, /ranked\.map\(\(x,i\)=>topCard/);
assert.match(html, /history-grid">\$\{cards\}/);
assert.doesNotMatch(html, /function rankCard\(/, "all Today's Top entries should use the same card format");
assert.match(html, /if\(item\.kind==="blog"\)return Boolean\(item\.url\)/, "every article with a URL should expose full-summary generation");
assert.match(html, /rankScore\(b\)-rankScore\(a\)/, "display order should follow scores, not stale model ranks");

console.log("top-union and reader tests passed");
