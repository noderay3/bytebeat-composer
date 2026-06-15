// Two-part UI:
//
//   1. Favorites section at the top of #container-scroll — renders the
//      tracks the user has starred. Source of truth is radio.ratings;
//      each rating row carries the full track metadata so we can render
//      favorites even before the underlying library is loaded.
//
//   2. Rating chips injected onto every `.entry` row that appears inside
//      a composer library container (#library-classic, #library-js-256,
//      #library-js-1k, #library-js-big, #library-floatbeat, etc).
//      A MutationObserver watches those containers; when the upstream
//      Library renders new entries (lazy-loaded on click), we append
//      👍 👎 ⭐ chips per row.
//
// Per-track identity is the `hash` (stable, set by library.mjs on every
// `.entry` via data-hash). Click delegation lives at document.body so we
// don't have to re-bind every time the library re-renders.

import { trackKey } from './radio.mjs';

const LIBRARY_CONTAINER_SELECTORS = [
	'#library-classic',
	'#library-js-256',
	'#library-js-1k',
	'#library-js-big',
	'#library-floatbeat',
	'#library-funcbeat',
	'#library-recent',
];

export class TrackList {
	constructor(radio, onSelectTrack) {
		this.radio = radio;
		this.onSelectTrack = onSelectTrack;
		this.favList = null;
		this.favCount = null;
		// Map<hash, track-metadata> for tracks we've seen in any composer
		// library since page load. Drives Next/Prev/Shuffle's "track
		// universe" — only what the user has had a chance to discover.
		this.universe = new Map();
		this._libraryObserver = null;
	}

	initElements() {
		this.favList  = document.getElementById('coderadio-fav-list');
		this.favCount = document.getElementById('coderadio-fav-count');
		if(!this.favList) return;
		// One delegated click handler for every rating/favorite chip we've
		// added, anywhere in the page.
		document.addEventListener('click', e => this._onChipClick(e));
		// And one delegated handler for clicks on the favorite rows.
		this.favList.addEventListener('click', e => this._onFavListClick(e));
		this.radio.subscribe(ev => {
			if(ev.type === 'rating') {
				this.renderFavorites();
				this._refreshChipStateNear(ev.key);
			} else if(ev.type === 'mode') {
				this._updateModeAttrs();
			} else if(ev.type === 'current') {
				this._updateCurrent();
			}
		});
		// Watch every composer library container. Entries get injected by
		// the upstream Library on summary-click; we react there.
		this._libraryObserver = new MutationObserver(muts => this._onLibraryMutation(muts));
		for(const sel of LIBRARY_CONTAINER_SELECTORS) {
			const el = document.querySelector(sel);
			if(el) this._libraryObserver.observe(el, { childList: true, subtree: true });
		}
		this.renderFavorites();
		this._updateModeAttrs();
	}

	// --- Favorites section -------------------------------------------

	renderFavorites() {
		if(!this.favList) return;
		const favs = this.radio.getFavoriteTracks();
		this.favCount.textContent = favs.length;
		if(favs.length === 0) {
			this.favList.innerHTML =
				`<div class="coderadio-empty-fav">No favorites yet. Star a track ` +
				`( ⭐ ) from any library section below to add it here.</div>`;
			return;
		}
		this.favList.innerHTML = favs.map(t => this._favRowHtml(t)).join('');
		this._updateCurrent();
	}

	_favRowHtml(track) {
		const key = trackKey(track);
		const r = this.radio.getRating(key);
		const desc = (track.description && String(track.description).trim()) ||
			(track.code && track.code.length > 60 ? track.code.slice(0, 58) + '…' : (track.code || '<no code>'));
		const author = track.author || 'unknown';
		const mode = track.mode || 'Bytebeat';
		return `
<div class="coderadio-track" data-fav-key="${ escAttr(key) }">
	<div class="coderadio-track-meta">
		<div class="coderadio-track-desc">${ esc(desc) }</div>
		<div class="coderadio-track-sub">
			<span class="coderadio-track-author">${ esc(author) }</span>
			<span class="coderadio-track-mode">${ esc(mode) }</span>
		</div>
	</div>
	<div class="coderadio-track-actions">
		<button class="coderadio-rate ${ r.rating === 'up' ? 'is-active' : '' }" data-chip="up" data-key="${ escAttr(key) }" title="Thumbs up — boosts in shuffle">👍</button>
		<button class="coderadio-rate ${ r.rating === 'down' ? 'is-active is-down' : '' }" data-chip="down" data-key="${ escAttr(key) }" title="Thumbs down — never plays (unless locked to favorites)">👎</button>
		<button class="coderadio-fav is-active" data-chip="fav" data-key="${ escAttr(key) }" title="Click to remove from favorites">⭐</button>
	</div>
</div>`;
	}

	_onFavListClick(e) {
		// chip clicks are handled by the document-level delegate; here
		// we just handle row-body clicks → play that favorite.
		if(e.target.closest('[data-chip]')) return;
		const row = e.target.closest('[data-fav-key]');
		if(!row) return;
		const key = row.dataset.favKey;
		const v = this.radio.ratings.get(key);
		if(v && v.track && this.onSelectTrack) {
			this.onSelectTrack(v.track);
		}
	}

	// --- Composer library entry chip injection -----------------------

	_onLibraryMutation(muts) {
		let anyAdded = false;
		for(const m of muts) {
			for(const node of m.addedNodes) {
				if(node.nodeType !== 1) continue;
				if(node.classList && node.classList.contains('entry')) {
					this._augmentEntry(node);
					anyAdded = true;
				}
				// Library wraps entries in songs-block / songs containers.
				if(node.querySelectorAll) {
					node.querySelectorAll('.entry').forEach(e => {
						this._augmentEntry(e);
						anyAdded = true;
					});
				}
			}
		}
		// If a track is currently playing and the user just expanded the
		// library section that contains it, paint the highlight on the
		// freshly-rendered row too.
		if(anyAdded) this._updateCurrent();
	}

	/// Add 👍 👎 ⭐ chips to a single `.entry` row + record the track in our
	/// universe Map. The hash is on the entry via data-hash; metadata is
	/// read from the entry's first .code-text button (data-songdata) and
	/// the code text content.
	_augmentEntry(entry) {
		if(entry.querySelector('.coderadio-chips')) return; // already augmented
		const hash = entry.dataset.hash;
		if(!hash) return; // upstream songs-block etc.

		// Build the track metadata. Two flavors exist in the composer's
		// library: inline (the .code-text button contains the code text)
		// and file-based (no .code-text; code lives at
		// data/songs/<type>/<hash>.js and is fetched on demand by the
		// upstream's onclickCodeLoadButton). Capture both shapes so the
		// radio's Next/Prev / Favorites click can play either.
		const codeBtn = entry.querySelector('.code-text');
		const fileBtn = entry.querySelector('.code-load[data-code-file]');
		let track = { hash, code: '', codeFile: null, codeType: null,
			mode: 'Bytebeat', sampleRate: 8000, author: '', description: '' };
		const songdataBtn = codeBtn || fileBtn;
		if(songdataBtn && songdataBtn.dataset.songdata) {
			try {
				const d = JSON.parse(songdataBtn.dataset.songdata);
				if(d.mode) track.mode = d.mode;
				if(d.sampleRate) track.sampleRate = d.sampleRate;
			} catch(_) {}
		}
		if(codeBtn) {
			// textContent — NOT innerText. The MutationObserver fires
			// synchronously during the composer's `innerHTML = ...` and
			// before the browser does layout; innerText requires layout
			// and returns '' for elements that haven't been rendered yet
			// (this exact bug stopped Next/Prev after a track or two —
			// most entries' codes silently came up empty).
			track.code = codeBtn.textContent || '';
		}
		if(fileBtn) {
			track.codeFile = fileBtn.dataset.codeFile;
			track.codeType = fileBtn.dataset.type || 'minified';
		}
		// Author + description: walk up to the songs-block for author and
		// look for an inline <span>by <b>author</b></span> inside the entry.
		const songsBlock = entry.closest('.songs-block');
		if(songsBlock) {
			const authorEl = songsBlock.querySelector(':scope > .songs-header > b');
			if(authorEl) track.author = authorEl.textContent.trim();
		}
		const descAuthor = entry.querySelector(':scope > a, :scope > span');
		if(descAuthor) track.description = descAuthor.textContent.trim();

		this.universe.set(hash, track);

		// Inject chips.
		const r = this.radio.getRating(hash);
		const chips = document.createElement('div');
		chips.className = 'coderadio-chips coderadio-track-actions';
		chips.innerHTML =
			`<button class="coderadio-rate ${ r.rating === 'up' ? 'is-active' : '' }" data-chip="up" data-key="${ escAttr(hash) }" title="Thumbs up — boosts in shuffle">👍</button>` +
			`<button class="coderadio-rate ${ r.rating === 'down' ? 'is-active is-down' : '' }" data-chip="down" data-key="${ escAttr(hash) }" title="Thumbs down — never plays">👎</button>` +
			`<button class="coderadio-fav ${ r.favorite ? 'is-active' : '' }" data-chip="fav" data-key="${ escAttr(hash) }" title="Favorite — pin to top + lockable playlist">⭐</button>`;
		entry.appendChild(chips);
	}

	_refreshChipStateNear(key) {
		// After a rating mutation, sync any chip in the page for the same
		// track so visual state matches across favorites + library entries.
		const r = this.radio.getRating(key);
		document.querySelectorAll(`[data-chip][data-key="${ cssEsc(key) }"]`).forEach(btn => {
			const which = btn.dataset.chip;
			if(which === 'up')   btn.classList.toggle('is-active', r.rating === 'up');
			if(which === 'down') btn.classList.toggle('is-active', r.rating === 'down');
			if(which === 'down') btn.classList.toggle('is-down', r.rating === 'down');
			if(which === 'fav')  btn.classList.toggle('is-active', r.favorite);
		});
	}

	_onChipClick(e) {
		const btn = e.target.closest('[data-chip]');
		if(!btn) return;
		e.stopPropagation();
		e.preventDefault();
		const key = btn.dataset.key;
		// Resolve a track object for this key — try universe first
		// (composer library entries), then favorites store.
		let track = this.universe.get(key);
		if(!track) {
			const v = this.radio.ratings.get(key);
			if(v && v.track) track = v.track;
		}
		if(!track) return; // can't apply rating without metadata
		if(btn.dataset.chip === 'fav') this.radio.toggleFavorite(track);
		else this.radio.setRating(track, btn.dataset.chip);
	}

	// --- universe + current ------------------------------------------

	/// Exposed so index.mjs can wire radio.setUniverseProvider() to the
	/// track universe we maintain.
	getKnownTracks() {
		return [...this.universe.values()];
	}

	_updateCurrent() {
		const cur = this.radio.currentTrack;
		document.querySelectorAll('.entry.coderadio-current, .coderadio-track.coderadio-current')
			.forEach(el => el.classList.remove('coderadio-current'));
		if(!cur) return;
		const key = trackKey(cur);
		document.querySelectorAll(`.entry[data-hash="${ cssEsc(key) }"]`).forEach(el => el.classList.add('coderadio-current'));
		document.querySelectorAll(`.coderadio-track[data-fav-key="${ cssEsc(key) }"]`).forEach(el => el.classList.add('coderadio-current'));
		// Auto-scroll the highlighted row into view so the user can see
		// where they are after Next/Prev. Prefer the row in the context
		// they're navigating: Favorites if locked, library entry
		// otherwise. block:'nearest' means no scroll if already visible
		// and minimum-distance scroll when off-screen.
		const favSel = `.coderadio-track[data-fav-key="${ cssEsc(key) }"].coderadio-current`;
		const libSel = `.entry[data-hash="${ cssEsc(key) }"].coderadio-current`;
		const target = this.radio.modes.lockFavorites
			? (document.querySelector(favSel) || document.querySelector(libSel))
			: (document.querySelector(libSel) || document.querySelector(favSel));
		if(target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	_updateModeAttrs() {
		const root = document.documentElement;
		root.dataset.shuffle       = this.radio.modes.shuffle       ? '1' : '0';
		root.dataset.lockFavorites = this.radio.modes.lockFavorites ? '1' : '0';
	}
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
// CSS.escape isn't universal — small enough wrapper to be safe.
function cssEsc(s) {
	if(typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(s));
	return String(s).replace(/["\\]/g, '\\$&');
}
