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
- **Background Milkdrop visualizer** — 👁 toggles a full-viewport [Butterchurn](https://github.com/jberg/butterchurn) animation behind the editor. UI containers go translucent so the visualization bleeds through. **Space** cycles to a random preset (gated on no editable element being focused, so typing space in the editor still inserts a space). 🔁 auto-cycles presets on detected bass kicks (~6s min, ~18s max). On first 👁 enable the four bigger butterchurn-presets packs lazy-load from `vendor/` (~2.5MB extra → ~2700 presets total).
- **Vibing-cat overlay** — 🐱 toggles a 264-frame sprite of the catJAM meme inside the editor canvas, layered above the visualizer and below the code text. Driven by a real-time beat-detection + dance pipeline (spectral-flux or hybrid SuperFlux/Viterbi detectors × Classic / Groove / Expressive dance engines). **Long-press** the 🐱 button to cycle the 6 detector × engine combos. See the catJAM section below for attribution.
- **In-app help** — ❓ pops a modal with the button reference, additions, and credits — useful on mobile where tooltips don't fire.

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

## Vibing Cat / catJAM sprite

The 264-frame cat sprite (`vendor/cat-sprite.webp`) is derived from the "Vibing Cat" / catJAM internet meme. I am not the original creator of the source footage; the frames were extracted, arranged into a 12×22 sprite atlas, and wired to a real-time beat-detection + dance-engine pipeline so the cat dances to whatever audio the user plays. The atlas is included here in good faith as a transformative, non-commercial, artistic and educational use — to demonstrate audio-DSP techniques (spectral flux, SuperFlux onset detection, Viterbi tempo tracking, phase-locked dance dynamics) rather than to redistribute the source footage as-is.

If you are the original creator or rights-holder of the source footage and would prefer the asset be removed, please open an [issue](https://github.com/noderay3/bytebeat-composer/issues) or email **xaos11@gmail.com** — the sprite will be removed and the site re-deployed promptly.

The rest of the project (source code, dance engines, beat detectors) is MIT-licensed; the cat sprite itself is *not* relicensed by this project, and is included subject to the notice above.

This is a personal judgment call, not legal advice.

## License

MIT, matching upstream — applies to source code only. See the catJAM section above for the sprite atlas.
