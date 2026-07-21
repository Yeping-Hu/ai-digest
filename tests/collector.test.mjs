import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeURL, deduplicate, localScore, parseFeed, readableArticleText, stripHTML } from "../collect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");

assert.equal(
  canonicalizeURL("https://Example.com/post/?utm_source=rss&ref=home#section"),
  "https://example.com/post",
);
assert.equal(stripHTML("<![CDATA[<p>Hello &amp; <b>world</b></p>]]>"), "Hello & world");

const article = readableArticleText(`<!doctype html><html><head><script type="application/ld+json">{"@type":"Article","articleBody":"This is a long article body about agent workflows, verification, and human oversight. ${"detail ".repeat(90)}"}</script></head><body><nav>noise</nav></body></html>`);
assert.match(article, /agent workflows/);
assert.ok(article.length > 500);

const rss = parseFeed(fixture("rss.xml"), {
  name: "Example RSS",
  group: "Example",
  sourceType: "official",
  priority: 1,
  maxItems: 10,
});
assert.equal(rss.length, 1);
assert.equal(rss[0].url, "https://example.com/post");
assert.match(rss[0].excerpt, /human-in-the-loop/);
assert.deepEqual(rss[0].categories, ["Agents"]);

const atom = parseFeed(fixture("atom.xml"), {
  name: "Example Atom",
  group: "Example",
  sourceType: "independent",
  priority: 0.9,
  maxItems: 10,
});
assert.equal(atom.length, 1);
assert.equal(atom[0].url, "https://example.org/research/ai-framework");
assert.equal(atom[0].author, "Research Team");
assert.deepEqual(atom[0].categories, ["science"]);

const duplicate = deduplicate([
  { ...rss[0], source: "Feed A", sourceTags: ["Feed A"], sourcePriority: 0.8 },
  { ...rss[0], source: "Feed B", sourceTags: ["Feed B"], sourcePriority: 1.0 },
]);
assert.equal(duplicate.length, 1);
assert.equal(duplicate[0].source, "Feed B");
assert.deepEqual(duplicate[0].sourceTags.sort(), ["Feed A", "Feed B"]);

const scored = localScore(rss[0]);
assert.ok(scored.score >= 50, `expected strong score, got ${scored.score}`);
assert.ok(scored.topics.includes("agents"));
assert.ok(scored.topics.includes("workflow"));
assert.ok(scored.topics.includes("evaluation"));


const undated = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><item><title>Undated article</title><link>https://example.com/undated</link><description>Agent workflow notes without a published timestamp.</description></item></channel></rss>`, {
  name: "Undated Feed",
  group: "Example",
  sourceType: "official",
  priority: 1,
  maxItems: 10,
});
assert.equal(undated.length, 1);
assert.equal(undated[0].ts, null, "missing source dates must remain unknown instead of becoming fetch time");
assert.equal(localScore(undated[0]).reasons.some((reason) => reason.startsWith("fresh +")), false);

const undatedDuplicate = deduplicate([
  { ...undated[0], source: "Feed A", sourcePriority: 0.8 },
  { ...undated[0], source: "Feed B", sourcePriority: 1.0 },
]);
assert.equal(undatedDuplicate[0].ts, null, "deduplication must preserve an unknown publication date");

console.log("collector tests passed");
