import assert from "node:assert/strict";
import { dedupeIdeas, mergeDailyIdeas, mergeDailyRanking, zonedDayKey } from "../collect.mjs";

const items = new Map([
  ["a", { id: "a", ts: Date.parse("2026-07-22T16:00:00Z") }],
  ["b", { id: "b", ts: Date.parse("2026-07-22T17:00:00Z") }],
  ["c", { id: "c", ts: Date.parse("2026-07-22T18:00:00Z") }],
]);

const morning = mergeDailyRanking([], [
  { id: "a", score: 78, reason: "morning A" },
  { id: "b", score: 80, reason: "morning B" },
], items, "2026-07-22T16:07:00Z");
assert.deepEqual(morning.map((x) => x.id), ["b", "a"]);
assert.deepEqual(morning.map((x) => x.rank), [1, 2]);

const afternoon = mergeDailyRanking(morning, [
  { id: "a", score: 84, reason: "afternoon A" },
  { id: "c", score: 82, reason: "afternoon C" },
], items, "2026-07-22T22:07:00Z");
assert.deepEqual(afternoon.map((x) => x.id), ["a", "c", "b"]);
assert.equal(afternoon.find((x) => x.id === "a").peakScore, 84);
assert.equal(afternoon.find((x) => x.id === "a").selectionCount, 2);
assert.equal(afternoon.find((x) => x.id === "b").selectionCount, 1);
assert.equal(afternoon.find((x) => x.id === "b").score, 80);

const evening = mergeDailyRanking(afternoon, [
  { id: "b", score: 86, reason: "evening B" },
], items, "2026-07-23T04:07:00Z");
assert.deepEqual(evening.map((x) => x.id), ["b", "a", "c"]);
assert.equal(evening.find((x) => x.id === "b").peakScore, 86);
assert.equal(evening.find((x) => x.id === "b").selectionCount, 2);

assert.equal(zonedDayKey("2026-07-23T04:30:00Z", "America/Los_Angeles"), "2026-07-22");
assert.equal(zonedDayKey("2026-07-23T08:30:00Z", "America/Los_Angeles"), "2026-07-23");

const ideas = mergeDailyIdeas(
  [{ workingTitle: "Old idea", angle: "A", sourceIds: ["a"] }],
  [{ workingTitle: "New idea", angle: "B", sourceIds: ["b"] }, { workingTitle: "Old idea", angle: "newer", sourceIds: ["a"] }],
);
assert.deepEqual(ideas.map((x) => x.workingTitle), ["New idea", "Old idea"]);

const samePostIdeas = dedupeIdeas([
  { workingTitle: "Agent runtime 从图结构开始", angle: "解释 BabyAGI 4 的 active graph runtime", whyNow: "new", sourceIds: ["post-1"] },
  { workingTitle: "为什么图结构会改变 Agent runtime", angle: "仍然只解释同一篇 BabyAGI 4 内容", whyNow: "same", sourceIds: ["post-1"] },
  { workingTitle: "Context engineering 的三个误区", angle: "来自另一个来源", whyNow: "different", sourceIds: ["post-2"] },
], 3);
assert.equal(samePostIdeas.length, 2, "two ideas sourced only from the same post should collapse into one");
assert.deepEqual(samePostIdeas.map((idea) => idea.sourceIds[0]).sort(), ["post-1", "post-2"]);

console.log("daily top union tests passed");
