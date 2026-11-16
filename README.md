# SmartTV public schedule

The public TV schedule SmartTV downloads, served by GitHub Pages:

**https://gnhjh.github.io/smarttv-schedule/schedule-v2.json**

It is a *snapshot v2* file: channels, programmes by catalogue identity, titles and lengths. It holds no addresses to play from, no household data, no credentials. Where a programme plays from is decided inside the app, from its own list of approved sources.

## How it is published

The **Publish schedule** workflow (`.github/workflows/publish.yml`):

1. **build** - `tools/schedule-tool.mjs` lays out `source/channels.json`, picks the right week from `source/weeks/`, checks the result (format, references, cover, size, nothing shaped like an address, path or credential), builds it twice to prove it is deterministic, and compares it with the file that is live now. If only `generatedAtMs` would change, nothing is published.
2. **deploy** - an Actions Pages deployment of the checked file, only when it changed (or a run asks to *force*), never in a *dry run*.
3. **verify** - fetches the public address until it serves exactly the built bytes, and checks them again.

A failed build or check publishes nothing; the live schedule stays as it is.

**Run it by hand:** Actions → *Publish schedule* → *Run workflow* (options: *dry run*, *force*, and a *self-test* that breaks the build on purpose to show nothing gets published).

## The sources

- `source/channels.json` - **written channels**: a fixed list of catalogue programmes (`tmdb:movie:N`, `tmdb:episode:SHOW:SEASON:EPISODE`) with title and `durationSeconds`, repeating for ever. Edit it here (even from a phone) and the workflow publishes it.
- `source/weeks/` - **timed channels**, one complete snapshot-v2 file per week, made ahead of time by the full SmartTV publisher on the household PC (`npm run publish:public -- --at <that Monday 00:00>`). The workflow publishes the week covering *now + 48 h*, so next week goes out on the Saturday before it and phones switch at Monday 00:00 even offline. Keep several weeks queued; when the queue runs out the workflow fails loudly and leaves the live file alone.

Empty today: the public line-up has no timed channel.

## Going back

- **To an earlier version:** run the workflow from an earlier commit, or revert the change to `source/` - the workflow publishes the reverted file.
- **To manual publishing:** Settings → Pages → *Deploy from a branch* → `main` / root. That serves `schedule-v2.json` at the root of this repository - the last file published by hand - at the same address.

## Housekeeping

GitHub pauses scheduled workflows in a public repository after 60 days without activity, and emails the owner. Any commit (a new week in `source/weeks`) keeps it active; a paused workflow is re-enabled with one click in the Actions tab.
