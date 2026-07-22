import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

// Every selected item, not only the first three, must use the same Top card.
assert.match(html, /ranked\.map\(\(x,i\)=>topCard\(x\.item,x\.entry,i\)\)/);
assert.match(html, /rankings\.map\(\(rank,index\)=>\{const item=itemById\(rank\.id\)\|\|snapshots\.get\(rank\.id\);return item\?topCard\(item,rank,index,day\.date\):""\}\)/);
assert.doesNotMatch(html, /function rankCard\(/);

// Ranking is score-first in both Today's Top and Top Archive.
assert.match(html, /sort\(\(a,b\)=>rankingScore\(b\)-rankingScore\(a\)\|\|Number\(b\.selectionCount\|\|0\)-Number\(a\.selectionCount\|\|0\)/);

// The compact card opens the dedicated reader; long summaries do not stretch it.
assert.match(html, /\.top-card\{min-height:540px;height:auto/);
assert.match(html, /data-reader-id=/);
assert.match(html, /id="reader" hidden aria-hidden="true"/);
assert.match(html, /function openReader\(id,context=\{\}\)/);
assert.match(html, /body\.reader-open\{overflow:hidden\}/);
assert.match(html, /class="reader-media"/);
assert.match(html, /youtubeThumb\(item,"maxresdefault"\)/);


// Top Archive is grouped by day using the same expandable outline pattern as
// the 30-day archive, with only the newest day open by default.
assert.match(html, /class="archive-day top-archive-day"/);
assert.match(html, /Daily editorial Top/);
assert.match(html, /archive-outline/);

// Full-summary controls remain available inside the reader.
assert.match(html, /Open original ↗<\/a>\$\{fullControls\(item\)\}/);

console.log("Top card and reader tests passed");
