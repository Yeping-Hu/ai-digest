import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeURL, deduplicate, localScore, parseFeed, readableArticleText, stripHTML, utcDayKey } from "../collect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");

assert.equal(
  canonicalizeURL("https://Example.com/post/?utm_source=rss&ref=home#section"),
  "https://example.com/post",
);
assert.equal(stripHTML("<![CDATA[<p>Hello &amp; <b>world</b></p>]]>"), "Hello & world");
assert.equal(utcDayKey("2026-07-21T23:59:59Z"), "2026-07-21");

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

console.log("collector tests passed");
