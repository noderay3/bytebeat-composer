// Bytebeat radio core — manages per-track ratings + favorites + shuffle
// state, plus the next/previous queue logic. Pure logic; no DOM.
//
// IMPORTANT — this is the v2 design (after user feedback 2026-06-14):
//
// The radio does NOT own a hardcoded curated library anymore. Tracks come
// from the composer's existing library (the upstream Library class loads
// data/library/*.gz on demand) — we hook in via a `universeProvider`
// callback. The radio is just rating + state + queue logic; the source of
// truth for "what tracks exist" stays in the composer.
//
// Ratings + favorites are persisted to localStorage. Each rated/favorited
// track stores its FULL metadata alongside the rating, so the Favorites
// section renders correctly even before the composer has loaded its
// libraries (which it lazy-loads on user click).
//
// Spec (decisions locked on Trello card #36):
// - Rating model is ORTHOGONAL: rating ∈ {null,'up','down'} and favorite
//   ∈ {true,false} are independent per track.
// - 👎 thumbs down: excluded from the active pool when lock-favorites is
//   OFF. (No effect when lock-favorites is ON — only the favorites list
//   plays in that mode.)
// - 👍 thumbs up: weighted 3× more likely in shuffle (when
//   lock-favorites is OFF).
// - ⭐ favorite: track appears in the favorites list. When
//   lock-favorites is ON, only favorited tracks play in their saved
//   order; thumbs ratings are ignored entirely.
// - Sequential cursor moves on user track-click + next/prev. Next at end
//   of list wraps back to the start (no repeat button per user request —
//   keep behavior simple since there's no auto-advance).
// - Shuffle weighted-random from the active pool; previous walks back
//   through a ring-buffer history.

const STORAGE_RATINGS = 'coderadio.ratings';
const STORAGE_MODES   = 'coderadio.modes';
const STORAGE_LAST    = 'coderadio.lastTrack';

const SHUFFLE_HISTORY_MAX = 32;
const SHUFFLE_WEIGHT_UP   = 3;

/// trackKey(track) — the canonical identifier used by the rating store.
/// Prefer the composer's stable `hash` if present; fall back to the code
/// itself (only happens for our older curated-JSON entries which lacked
/// hashes — kept so legacy persisted ratings keep working).
export function trackKey(track) {
	if(!track) return null;
	return track.hash || track.code || null;
}

export class Radio {
	constructor() {
		this.ratings = new Map(); // key → { rating, favorite, track (metadata) }
		this.modes = { shuffle: false, lockFavorites: false };
		this.cursor = 0;
		this.shuffleHistory = []; // recently-played tracks (objects)
		this.currentTrack = null;
		this._listeners = new Set();
		this._universeProvider = () => [];
		this._loadRatings();
		this._loadModes();
	}

	/// Plug in a function that returns the array of all currently-known
	/// tracks. Called every time the active list is computed, so it
	/// reflects whatever the composer has loaded. Pure dependency-injection
	/// so we don't have to know anything about Library here.
	setUniverseProvider(fn) {
		this._universeProvider = typeof fn === 'function' ? fn : () => [];
		this._emit({ type: 'universe-changed' });
	}

	/// Restore the last-played track if we have one. Called by index.mjs
	/// after the universe provider is wired so we can look up the track.
	restoreLastTrack() {
		const lastKey = this._loadLastTrackKey();
		if(!lastKey) return;
		const universe = this._universeProvider();
		const idx = universe.findIndex(t => trackKey(t) === lastKey);
		if(idx >= 0) {
			this.currentTrack = universe[idx];
			const active = this.getActiveList();
			const ai = active.findIndex(t => trackKey(t) === lastKey);
			this.cursor = Math.max(0, ai);
		}
	}

	// --- listeners ----------------------------------------------------

	subscribe(fn) {
		this._listeners.add(fn);
		return () => this._listeners.delete(fn);
	}
	_emit(ev) {
		for(const fn of this._listeners) {
			try { fn(ev); } catch(e) { console.error('radio listener:', e); }
		}
	}

	// --- ratings ------------------------------------------------------

	getRating(key) {
		return this.ratings.get(key) || { rating: null, favorite: false };
	}

	/// Apply a thumbs rating to a track. Passing the SAME rating clears it
	/// (button is a toggle). `track` must include all metadata so the
	/// rating store can persist enough info to render the favorites list
	/// even when the underlying library hasn't been loaded.
	setRating(track, rating) {
		const key = trackKey(track);
		if(!key) return;
		const cur = this.getRating(key);
		const next = {
			...cur,
			rating: cur.rating === rating ? null : rating,
			track: this._slimTrack(track),
		};
		this._writeRating(key, next);
		this._emit({ type: 'rating', key, track });
	}

	toggleFavorite(track) {
		const key = trackKey(track);
		if(!key) return;
		const cur = this.getRating(key);
		const next = {
			...cur,
			favorite: !cur.favorite,
			track: this._slimTrack(track),
		};
		this._writeRating(key, next);
		this._emit({ type: 'rating', key, track });
	}

	_writeRating(key, value) {
		if(value.rating === null && !value.favorite) {
			this.ratings.delete(key);
		} else {
			this.ratings.set(key, value);
		}
		this._saveRatings();
	}

	/// Strip the track down to the fields the rating store needs to play
	/// it back later — keeps localStorage compact for big libraries.
	_slimTrack(track) {
		if(!track) return null;
		return {
			hash:        track.hash || null,
			code:        track.code || '',
			author:      track.author || '',
			description: track.description || track.name || '',
			mode:        track.mode || 'Bytebeat',
			sampleRate:  track.sampleRate || 8000,
		};
	}

	// --- modes --------------------------------------------------------

	setMode(field, value) {
		if(!(field in this.modes)) return;
		this.modes[field] = !!value;
		this._saveModes();
		this._emit({ type: 'mode', field, value: this.modes[field] });
	}
	toggleMode(field) {
		this.setMode(field, !this.modes[field]);
	}

	// --- listing ------------------------------------------------------

	/// Tracks that have been favorited. Pulled from the rating store, so
	/// they're available even before the underlying library is loaded —
	/// each entry has its metadata stashed in the store.
	getFavoriteTracks() {
		const out = [];
		for(const [, v] of this.ratings) {
			if(v.favorite && v.track) out.push(v.track);
		}
		return out;
	}

	/// The pool the next/previous logic walks. Filtered by lock-favorites
	/// (only favorites) or by thumbs-down (excluded). Sequential and
	/// shuffle both draw from this.
	getActiveList() {
		if(this.modes.lockFavorites) return this.getFavoriteTracks();
		const universe = this._universeProvider();
		return universe.filter(t => {
			const key = trackKey(t);
			return this.getRating(key).rating !== 'down';
		});
	}

	// --- playback queue -----------------------------------------------

	setCurrent(track) {
		this.currentTrack = track;
		const active = this.getActiveList();
		const key = trackKey(track);
		const idx = active.findIndex(t => trackKey(t) === key);
		if(idx >= 0) this.cursor = idx;
		this._saveLastTrackKey(key);
		this._emit({ type: 'current', track });
	}

	next() {
		const pool = this.getActiveList();
		if(pool.length === 0) return null;
		if(this.modes.shuffle) {
			if(this.currentTrack) this._pushHistory(this.currentTrack);
			const pick = this._weightedRandom(pool);
			if(pick) this.setCurrent(pick);
			return pick;
		}
		// Sequential — wrap end-of-list back to the start. (No Repeat
		// button anymore; the user removed it since there's no auto-advance,
		// so the only sensible Next-at-end behavior is wrap.)
		const newIdx = (this.cursor + 1) % pool.length;
		this.cursor = newIdx;
		this.setCurrent(pool[newIdx]);
		return pool[newIdx];
	}

	previous() {
		const pool = this.getActiveList();
		if(pool.length === 0) return null;
		if(this.modes.shuffle) {
			const prev = this.shuffleHistory.pop();
			if(prev) {
				this.setCurrent(prev);
				return prev;
			}
			const pick = this._weightedRandom(pool);
			if(pick) this.setCurrent(pick);
			return pick;
		}
		const newIdx = (this.cursor - 1 + pool.length) % pool.length;
		this.cursor = newIdx;
		this.setCurrent(pool[newIdx]);
		return pool[newIdx];
	}

	// --- internals ----------------------------------------------------

	_weightedRandom(pool) {
		if(pool.length === 0) return null;
		const weights = pool.map(t => {
			const r = this.getRating(trackKey(t)).rating;
			return r === 'up' ? SHUFFLE_WEIGHT_UP : 1;
		});
		const total = weights.reduce((a, b) => a + b, 0);
		let r = Math.random() * total;
		for(let i = 0; i < pool.length; i++) {
			r -= weights[i];
			if(r <= 0) return pool[i];
		}
		return pool[pool.length - 1];
	}

	_pushHistory(track) {
		this.shuffleHistory.push(track);
		if(this.shuffleHistory.length > SHUFFLE_HISTORY_MAX) {
			this.shuffleHistory.shift();
		}
	}

	// --- persistence --------------------------------------------------

	_loadRatings() {
		try {
			const raw = localStorage.getItem(STORAGE_RATINGS);
			if(!raw) return;
			const obj = JSON.parse(raw);
			this.ratings = new Map(Object.entries(obj));
		} catch(_) {}
	}
	_saveRatings() {
		try {
			const obj = Object.fromEntries(this.ratings);
			localStorage.setItem(STORAGE_RATINGS, JSON.stringify(obj));
		} catch(_) {}
	}
	_loadModes() {
		try {
			const raw = localStorage.getItem(STORAGE_MODES);
			if(!raw) return;
			const obj = JSON.parse(raw);
			// Defensive — drop unknown fields (e.g. the removed `repeat` flag).
			this.modes = {
				shuffle:       !!obj.shuffle,
				lockFavorites: !!obj.lockFavorites,
			};
		} catch(_) {}
	}
	_saveModes() {
		try {
			localStorage.setItem(STORAGE_MODES, JSON.stringify(this.modes));
		} catch(_) {}
	}
	_loadLastTrackKey() {
		try { return localStorage.getItem(STORAGE_LAST); } catch(_) { return null; }
	}
	_saveLastTrackKey(key) {
		try { localStorage.setItem(STORAGE_LAST, key); } catch(_) {}
	}
}
