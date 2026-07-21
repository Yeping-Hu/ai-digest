# AI Signal Desk

A daily, self-updating dashboard that collects English-language AI signals, keeps a rolling 30-day archive, and highlights the items most useful for deeper reading or future Chinese RedNote posts.

It runs entirely on GitHub Actions and GitHub Pages. There is no server and no database.

## Daily pipeline

```text
collect every source
        ↓
canonicalize URLs + deduplicate
        ↓
local rule-based pre-score (free)
        ↓
up to 18 candidates enter one Gemini editorial batch
        ↓
one ranked Today's Top list + content ideas
        ↓
archive every item and save a dated Top snapshot
```

The daily job makes at most **2 Gemini requests**: one structured editorial request and, only if necessary, one JSON-repair request. If Gemini is unavailable or its free quota is exhausted, local ranking still updates the site.

## Sources

The existing Builders X feed and AI Engineer YouTube channel remain. These public RSS/Atom sources are also included:

- OpenAI News
- OpenAI Engineering
- Google DeepMind Blog
- Hugging Face Blog
- Latent Space AINews
- Simon Willison's Weblog

Hugging Face Daily Papers is intentionally not included yet.

## Main views

The left sidebar contains only four primary views:

- **Today's Top** — one ranked list for all selected items
- **All New Today** — every item found in the latest run
- **My Shortlist** — manual picks saved in this browser
- **All 30 Days** — the complete rolling archive

Within **Today's Top**, the secondary tabs are:

- **Today** — the current ranking
- **Top Archive** — all saved daily rankings, including yesterday and earlier days

Source-specific filters remain below the primary navigation.

## Restored reader features

- X author profile pictures
- **Show more / Show less** for long text
- duplicate suppression when an X post and its generated description are materially the same
- large rank numbers placed in normal card flow so they do not cover content
- English interface labels; generated summaries and editorial analysis can remain in Chinese

## Full summaries

Owner mode restores the earlier manual workflow and expands it beyond YouTube:

- YouTube videos use a transcript when `SUPADATA_API_KEY` is available
- long blog posts and articles are fetched from the original page and summarized
- unusually long X posts can also be summarized
- completed items display **✓ Full summary generated**
- owner mode shows **Generate full summary** or **Regenerate**
- after a workflow is dispatched, the page polls the archive and updates automatically

The browser token is saved under `gh_token` in local storage, matching the earlier owner-tool behavior. Use a fine-grained token restricted to this repository, and remove it when it is no longer needed.

## Files

| File | Purpose |
|---|---|
| `index.html` | Static GitHub Pages dashboard |
| `collect.mjs` | Collection, deduplication, scoring, editorial ranking, and on-demand summaries |
| `sources.json` | Source and editorial configuration |
| `data/archive.json` | Complete rolling 30-day archive |
| `data/today.json` | Current ranking, content ideas, and run statistics |
| `data/top-history.json` | Rolling archive of all daily ranked lists |
| `data/daily/YYYY-MM-DD.json` | Raw daily editorial snapshots |
| `.github/workflows/daily.yml` | Scheduled collector |
| `.github/workflows/summarize-one.yml` | On-demand full summary for one item |
| `tests/collector.test.mjs` | Offline parser, extraction, and ranking tests |

## Repository secrets

Under **Settings → Secrets and variables → Actions**, configure:

- `GEMINI_API_KEY`
- `YOUTUBE_API_KEY`
- `SUPADATA_API_KEY` — optional; needed for video transcripts
- `GEMINI_MODEL` — optional override

The scheduled collector uses GitHub's built-in `GITHUB_TOKEN`; no personal token is required for daily updates.

## First run

1. Ensure Actions workflow permissions allow read/write access.
2. Open **Actions → Daily digest → Run workflow**.
3. The job updates `data/archive.json`, `data/today.json`, `data/top-history.json`, and `data/daily/<date>.json`.
4. GitHub Pages publishes the resulting dashboard.

When a source is first added, only its most recent 7 days are admitted, preventing a large historical backlog. On the first run of this version, compatible snapshots already in `data/daily/` are imported into Top Archive when their items are still present in the 30-day archive.

## Editorial controls

The main settings live in `sources.json`:

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

`topPrimary` controls how many items use the large-card layout. `topLimit` controls the total number in the single Today's Top ranking. The old `topIds` and `scanIds` fields are still written for backward compatibility, but the interface combines them into one list.

## Cost controls

- RSS/Atom collection is free.
- Daily YouTube collection does not request transcripts.
- Local rules pre-filter candidates before Gemini is called.
- The daily workflow is capped at two Gemini calls.
- An on-demand full summary is capped at one Gemini call.
- Article text is fetched directly from the public source page; no paid extraction API is required.
- If Gemini fails, collection and local ranking still complete.
