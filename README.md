# AI Signal Desk

A daily, self-updating dashboard that collects AI signals, keeps a complete 30-day archive, and highlights the few items most worth reading or turning into a Chinese RedNote post.

It runs entirely on GitHub Actions + GitHub Pages. There is no server and no database.

## What changed in this version

The old flow summarized every unseen blog/video item separately. The new flow is deliberately cheaper and more editorial:

```text
collect every source for free
        ↓
canonicalize + deduplicate
        ↓
local rule-based pre-score
        ↓
only the best 18 candidates go to Gemini
        ↓
one editorial batch returns Top items + RedNote ideas
        ↓
archive everything, feature only the best
```

The daily job makes at most **2 Gemini requests**: one normal structured-output request and, only when needed, one JSON-repair request. If Gemini is unavailable or the free quota is exhausted, the site still updates using local ranking.

## Sources included

The existing X builders feed and AI Engineer YouTube channel remain. The following English sources are added:

- OpenAI News
- OpenAI Engineering
- Google DeepMind Blog
- Hugging Face Blog
- Latent Space AINews
- Simon Willison's Weblog

Hugging Face Daily Papers is intentionally not included yet.

All six new feeds are public RSS/Atom feeds and require no API key.

## Files

| File | Purpose |
|---|---|
| `index.html` | Static dashboard for GitHub Pages |
| `collect.mjs` | Collection, deduplication, local scoring, one-batch Gemini editorial pass |
| `sources.json` | Sources and editorial limits |
| `data/archive.json` | Complete rolling 30-day archive |
| `data/today.json` | Current Top ranking, scan list, ideas, and run statistics |
| `data/daily/YYYY-MM-DD.json` | Daily ranking snapshots, retained for 30 days |
| `.github/workflows/daily.yml` | Daily collector job |
| `.github/workflows/summarize-one.yml` | Existing manual full-transcript workflow |
| `tests/collector.test.mjs` | Offline parser and ranking smoke tests |

## Homepage views

- **今日 Top** — the strongest 1-3 items
- **值得扫一眼** — ranks 4-8
- **今天全部新内容** — every newly collected item, including those not selected
- **官方来源 / 独立分析 / 聚合精选**
- **YouTube**
- **Hot on X**
- **我的 Shortlist** — manual picks saved in the browser
- **全部 30 天**

The Top list is not deletion. Every collected item remains in `archive.json` until it leaves the retention window.

## Free-tier plan

### RSS / Atom

Free. No keys.

### GitHub Actions and Pages

The repository is public, so the scheduled standard runner and Pages hosting can be used without a separate server bill.

### YouTube Data API

The current setup uses approximately two low-cost quota operations per daily run for the configured channel:

1. read the uploads playlist
2. fetch duration + public statistics for the returned videos

### Gemini

The default is:

```text
gemini-3.1-flash-lite
```

It is chosen because it is designed for lightweight processing and currently has free-tier input/output access. You can override it with a repository secret named `GEMINI_MODEL`.

The collector enforces:

```text
GEMINI_MAX_CALLS=2
```

If you want an even stricter limit, change it to `1` in `.github/workflows/daily.yml`.

### Supadata

Optional. Daily collection does **not** request transcripts. A transcript is used only when you manually choose “按需生成完整摘要” for one YouTube video.

## Required repository secrets

Go to:

```text
Settings → Secrets and variables → Actions
```

Add:

- `GEMINI_API_KEY`
- `YOUTUBE_API_KEY`
- `SUPADATA_API_KEY` — optional
- `GEMINI_MODEL` — optional override; leave unset to use the value in `sources.json`

No personal GitHub token is required for the scheduled bot. GitHub Actions uses the built-in `GITHUB_TOKEN` and the workflow requests `contents: write`.

## First run

1. Make sure Actions workflow permissions allow read/write.
2. Open **Actions → Daily digest → Run workflow**.
3. The job will create/update:
   - `data/archive.json`
   - `data/today.json`
   - `data/daily/<date>.json`
4. GitHub Pages will show the new views after the commit is published.

When a source is seen for the first time, only items from its most recent 7 days are admitted. This also applies when adding new feeds to an existing archive, preventing a large historical backlog.

## Editorial scoring

The free local pre-score uses:

- relevance to agents, workflows, context, AI for Science, evaluation, research, and open source
- source type and your configured source priority
- freshness
- visual/story potential
- basic engagement signals where available
- negative filters for hiring posts, webinars, and overt marketing

The Gemini batch then evaluates:

- why the item matters
- evidence present in the supplied excerpt
- uncertainty and verification needs
- likely Chinese-audience information gap
- a RedNote content angle
- up to three cross-source post ideas

Curated sources are treated as discovery tools. The output explicitly reminds you to return to the primary source before publishing.

## Adjusting the system

The main controls live in `sources.json`:

```json
{
  "editorial": {
    "candidateLimit": 18,
    "topPrimary": 3,
    "topLimit": 8,
    "ideaLimit": 3,
    "maxCandidatesPerSource": 5,
    "maxTopPerSource": 2,
    "initialBackfillDays": 7,
    "fallbackWindowHours": 48
  }
}
```

- `candidateLimit`: maximum items passed to the one Gemini editorial batch
- `topPrimary`: number shown as large Top cards
- `topLimit`: maximum total ranked items
- `maxCandidatesPerSource`: prevents one feed dominating the input
- `maxTopPerSource`: prevents one source group dominating the output
- `priority`: per-source relevance weight for your own account, not a universal credibility rating

## Security

The dashboard's optional Owner Tools stores a fine-grained GitHub token in **sessionStorage only**. It is cleared when the tab/session closes. Use the narrowest repository permission possible.

The normal daily pipeline does not need a personal token at all.
