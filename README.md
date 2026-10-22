# For You: personal recommendations for Stremio

A Stremio addon that turns your library and watch history into Netflix-style rows on your home screen,
**without storing anything about you**.

## Privacy first

- **Your password never reaches the addon server.** The setup page signs in to Stremio directly from your
  browser and only gets back a login key.
- **No database, no accounts, nothing about you on disk.** Your login key and settings live only in your
  personal install URL. The server keeps everything else in memory for at most a day, and its logs never include the
  key. Uninstall the addon and nothing about you remains.
- **Self-hostable in one command**, so you don't have to trust anyone else's server.
- **Treat your install URL like a password:** anyone who has it can access your Stremio account.
- The addon only reads your library, plus your addon list if you turn on "rows under Continue Watching".

## Rows

| Row | What's in it |
| --- | --- |
| **Recommended for You** | Movies and series picked from everything you've watched. Filter by genre in Discover. |
| **Finish the Story** | The next film in a series you've started, e.g. *Dune: Part Two* after *Dune*. |
| **New Seasons** | Shows where you finished a season and the next one is out. |
| **Under 100 Minutes** | Your movie picks that fit in an evening. |
| **Finish in a Weekend** | Your series picks with one short, finished season. |
| **Because you watched _X_** | Picks based on your most recently watched movie and series. |

Every pick shows **why** it's there (for example *Because you watched: Arrival*, or *Next after: Dune*).
Its genre tags open your own recommendations in that genre. Each row can be switched off on the setup page.
The rows can also sit right under **Continue Watching** instead of at the bottom.

It never recommends anything you've already watched or saved.

## Download for Windows

The easiest way: no Node.js and nothing to install.

1. Download **ForYou.exe** from the [latest release](https://github.com/Joshuabastiaans/stremio-for-you/releases/latest)
   and double-click it.
   Windows may say *"Windows protected your PC"* because the app isn't code-signed: click **More info → Run anyway**.
2. The setup page opens in your browser. The first time, it asks for a free TMDB key and shows how to get one.
   It takes a couple of minutes.
3. Sign in to Stremio, choose your rows, and click **Install in Stremio**.
4. Optional: click **Start For You with Stremio**. Your Stremio shortcuts (Start menu, taskbar, desktop) then
   start For You quietly in the background and stop it when Stremio closes. Without this, keep ForYou.exe open
   while you use Stremio.

Your TMDB key is saved in `%APPDATA%\For You`. With "Start with Stremio" on, a copy of the app lives in
`%LOCALAPPDATA%\Programs\For You`. To remove everything, click **Stop starting with Stremio** on the setup
page, uninstall the addon in Stremio, and delete those two folders.

Stremio only accepts this kind of local addon in the app on the same computer. For phones and TVs, see
[Hosting it](#hosting-it-phones-tvs-sharing-with-friends).

## Run from source

You need [Node.js 22.9+](https://nodejs.org) and a free [TMDB API key](https://www.themoviedb.org/settings/api).

```bash
git clone https://github.com/Joshuabastiaans/stremio-for-you.git
cd stremio-for-you
cp .env.example .env    # then paste your TMDB key after TMDB_API_KEY=
npm start
```

Open <http://127.0.0.1:7000/configure>, sign in, and click **Install in Stremio**. If the button doesn't open
Stremio, copy the install link, paste it into the search box on Stremio's **Addons** page, and click **Install**.

Stremio accepts `http://` addons only from `127.0.0.1`. So this setup works in Stremio on the same computer,
and only while `npm start` is running. For phones and TVs, host it (next section).

### Windows: start it with Stremio

`launcher.js` starts the addon, opens Stremio, and stops the addon about 20 seconds after Stremio closes. To make
your Stremio Start Menu and taskbar shortcuts use it:

```bash
powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1
```

Your original shortcuts are backed up to `shortcut-backup/`. Run the same command with `-Undo` to restore them.
If a Stremio update resets the shortcuts, run it again.

## Hosting it (phones, TVs, sharing with friends)

Any host that runs Docker or Node works. You need HTTPS, which hosts like Render, Railway, Fly.io or a VPS
behind Caddy give you.

```bash
docker build -t stremio-for-you .
docker run -d -p 7000:7000 -e TMDB_API_KEY=your_key stremio-for-you
```

Then open `https://your-host/configure`. Addons sync to every device on your Stremio account.

Free tiers that sleep when idle make the first load slow, and Stremio may give up on it. An always-on instance
works best.

## How it picks titles

1. **Interest score.** Each library and history item gets one:
   - Finishing a movie counts most. For series, it's hours watched.
   - Saving to your library adds a bit.
   - Movies you dropped early barely count.
   - Activity fades out over about four months.
2. **Seeds.** Your top 30 items become seeds. For each, it fetches TMDB's recommendations, plus "similar"
   titles at lower weight.
3. **Ranking.** A candidate scores the sum of (seed score × list position) across all seeds, so titles that
   several of your favourites point to win. A Bayesian rating adjustment pushes down obscure or badly rated
   titles.
4. **Filtering.** Unreleased titles and anything already in your library or history are removed.

The other rows build on this:
- **Under 100 Minutes** and **Finish in a Weekend** filter the same ranking by runtime or season count.
- **Finish the Story** uses TMDB's film collections.
- **New Seasons** compares the last episode you watched with the show's season list.

The tuning knobs are in [`lib/recommend.js`](lib/recommend.js). Results are cached for 30 minutes, so new
watches show up within about half an hour.

## Development

```bash
npm test             # end-to-end test against fake Stremio + TMDB APIs
npm run build:exe    # build dist/ForYou.exe (on Windows; needs `npm install` first)
```

| File | What it does |
| --- | --- |
| `server.js` | Entry point for `npm start` and Docker (settings from `.env`) |
| `desktop/main.js` | Entry point for ForYou.exe (TMDB key from the setup page, start with Stremio) |
| `lib/app.js` | HTTP server: config page, manifest, catalog endpoints |
| `lib/recommend.js` | Scoring, ranking and building Stremio metas |
| `lib/stremio.js` | Stremio account API (library, addon order) |
| `lib/tmdb.js` | TMDB client with caching and a concurrency cap |
| `lib/desktop.js` | Windows helpers: opening Stremio, its shortcuts |
| `public/configure.html` | Setup page (signs in to Stremio from the browser) |
| `scripts/build-exe.mjs` | Bundles everything into one exe with Node's single-executable feature |
| `launcher.js`, `install-shortcuts.ps1` | "Start with Stremio" for the run-from-source setup |

Releases: push a tag like `v1.3.0`. The [release workflow](.github/workflows/release.yml) builds ForYou.exe on
GitHub's Windows runners and publishes it.

## Credits

Movie and series data and images come from [TMDB](https://www.themoviedb.org).
This product uses the TMDB API but is not endorsed or certified by TMDB.

Not affiliated with Stremio.

## License

[MIT](LICENSE)
