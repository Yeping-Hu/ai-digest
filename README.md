# AI Builders Digest

A daily, self-updating dashboard of what AI builders are posting on X (via Zara's
public feed) and YouTube (new videos + AI summaries). Runs entirely on GitHub —
a scheduled bot fetches everything, summarizes it, and publishes the page. No
server, no local machine, no personal token.

---

## What's here

| File | What it does |
|---|---|
| `index.html` | The dashboard you open (reads `data/archive.json`) |
| `collect.mjs` | The collector — fetches sources, summarizes, updates the archive |
| `sources.json` | **The one file you edit to add/remove sources** |
| `data/archive.json` | The rolling 30-day archive (the bot maintains this) |
| `.github/workflows/daily.yml` | The daily bot |

---

## Deploy it (about 10 minutes, all in the browser)

**1. Create the repo.** On GitHub: **New repository** → name it e.g. `ai-digest` →
**Public** → Create.

**2. Upload these files.** On the new repo page: **Add file → Upload files** →
drag in everything here (keep the folders `data/` and `.github/`) → **Commit**.

**3. Get your free API keys.**
- **Gemini** (summaries + Chinese translation): https://aistudio.google.com/apikey → Create API key. Free.
- **YouTube Data API v3** (to list videos reliably from the cloud): in Google Cloud Console, enable "YouTube Data API v3" and create an API key. Free (10,000 requests/day). Tip: if you enable it on the *same* Google project as your Gemini key, your Gemini key works for it too and you can skip a separate secret.
- **Supadata** (optional — full transcripts for the "Get full summary" button): https://supadata.ai → sign up → copy your key. Free tier is 100 transcripts/month, no card.

**4. Add the keys as secrets.** Repo **Settings → Secrets and variables → Actions
→ New repository secret**. Add:
- `GEMINI_API_KEY` = your Gemini key
- `YOUTUBE_API_KEY` = your YouTube Data API key (skip if your Gemini key already has the API enabled)
- `SUPADATA_API_KEY` = your Supadata key (skip if you're not using transcripts)

**5. Let the bot write.** **Settings → Actions → General → Workflow permissions →
Read and write permissions → Save.**

**6. Turn on the website.** **Settings → Pages → Source: Deploy from a branch →
Branch: `main` / `/ (root)` → Save.** Your dashboard will be at
`https://<your-username>.github.io/ai-digest/`

**7. Run it once now.** **Actions tab → Daily digest → Run workflow.** It'll fetch
fresh content and refresh the page. After this it runs automatically every day.

That's it. Bookmark your Pages URL.

---

## Adding a source later

Open `sources.json` on GitHub (click the file → pencil icon), add a line, commit.
The next run picks it up.

**Another YouTube channel** (free):
```json
{ "type": "youtube", "name": "Channel Name", "channelId": "UCxxxxxxxx", "transcript": true }
```
Find `channelId`: open the channel page → View Source → search for `channelId`.
Set `"transcript": false` to use the description instead and save Supadata credits.

**A blog** (free):
```json
{ "type": "blog", "name": "Blog Name", "url": "https://site.com/feed" }
```
Most blogs have a feed at `/feed`, `/rss`, or `/atom.xml`.

**Someone new on X:** not free — Zara's feed is a fixed list of 26 builders, so a
new handle needs a paid X API plus a small new adapter. Ask Claude for that one.

---

## Notes

- **Your saved picks** live in your browser (local storage), as full snapshots —
  they survive refreshes and outlive the 30-day feed window. Use **Export** for a
  permanent copy.
- **Change the schedule:** edit the `cron` line in `.github/workflows/daily.yml`
  (it's in UTC).
- **Change the model:** add a `GEMINI_MODEL` secret to override the default.
- **Security:** revoke any personal access token you may have shared — this setup
  never needs one. The bot uses GitHub's own built-in token.
