# bytebeat-composer — radio fork

A fork of [SthephanShinkufag/bytebeat-composer](https://github.com/SthephanShinkufag/bytebeat-composer) that adds a manual-radio mode, a per-track rating system, a scrollable bytebeat reference panel, and a full-viewport Milkdrop background visualizer.

Browser-only. Pure static site. Open the URL, click a track, hit Next.

## What's added

- **Radio controls in the toolbar** — ⏮ ⏭ to walk through the full library (any composer library section becomes part of the queue as you expand it).
- **Per-track ratings** — every entry gets 👍 👎 ⭐ chips:
  - 👍 thumbs up — weighted **3× more likely** in shuffle.
  - 👎 thumbs down — excluded from the active pool.
  - ⭐ favorite — pinned to a top-of-scroll Favorites section; shows up across reloads.
- **Shuffle** (🔀) — weighted random next from the active pool.
- **Lock-to-favorites** (⭐🔒) — restrict next/shuffle to only starred tracks. Thumbs ratings are ignored while locked; favorites play in their saved order.
- **Currently-playing highlight + auto-scroll** — the playing row is highlighted in both Favorites and the library; the scroll buffer follows it on Next/Prev. Collapsed ancestor `<details>` (including the upstream's "X more bytebeats" overflow toggles) auto-open so the highlight is always visible.
- **Player-area rating chips** — 👍 👎 ⭐ next to the radio controls operate on the currently-playing track; state mirrors the per-row chips.
- **Bytebeat reference panel** — sliding side panel (the `ref` button or the chevron at the right edge) with operator tables, idiom recipes, mode docs, sample-rate cheat-table, gotchas, famous one-liners. Every "Try" button is verified audible by `scripts/audit-legend.mjs`.
- **Background Milkdrop visualizer** — 👁 toggles a full-viewport [Butterchurn](https://github.com/jberg/butterchurn) animation behind the editor. UI containers go translucent so the visualization bleeds through. **Space** cycles to a random preset (gated on no editable element being focused, so typing space in the editor still inserts a space).

## Run locally

```
npm install
npm start                       # rollup → ./build/
python3 -m http.server 8765     # any static server works
```

Open <http://localhost:8765>.

## File layout (additions only)

```
src/radio.mjs           Rating store + queue logic (pure JS, no DOM)
src/track-list.mjs      Favorites panel + chip injection on library entries
src/visualizer.mjs      Butterchurn integration + AnalyserNode wiring
src/legend.mjs          Scrollable reference panel
vendor/                 Butterchurn UMD bundles (loaded via <script>)
scripts/audit-radio.mjs Node unit tests for the radio module
scripts/audit-legend.mjs Verifies every legend "Try" example produces audio
```

The upstream's `src/`, `data/library/`, `data/songs/`, `style.css`, `index.html`, `rollup.config.mjs` are intact (extended, not replaced).

## Attribution

- **[bytebeat-composer](https://github.com/SthephanShinkufag/bytebeat-composer)** by SthephanShi — the foundation this is built on. MIT.
- **[Butterchurn](https://github.com/jberg/butterchurn)** + **[butterchurn-presets](https://github.com/jberg/butterchurn-presets)** by Jordan Berg — the visualizer. MIT.
- **[viznut](http://countercomplex.blogspot.com/2011/10/algorithmic-symphonies-from-one-line-of.html)** — invented bytebeat in 2011.
- **The Tuesday Night Machines** — beginner's guide that powered much of the legend's prose and example sequencing.
- **Ravary** — RPN guide that informed the operator reference.

Upstream's original README is preserved at [UPSTREAM-README.md](UPSTREAM-README.md).

## License

MIT, matching upstream.
