import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 1, "Expected exactly one inline application script");
assert.match(scripts[0], /async function load\s*\(\s*\)/, "The dashboard must define load()");
assert.match(scripts[0], /\bload\s*\(\s*\)\s*;\s*$/, "The dashboard must invoke load() at startup");
assert.doesNotThrow(() => new Function(scripts[0]), "The inline dashboard script must parse");
console.log("ui-initialization.test.mjs: passed");
