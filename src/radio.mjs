// Bytebeat radio core — manages the curated track library, per-track
// ratings, playback mode flags, and the next/previous queue logic.
//
// Pure logic — no DOM. The UI layer (index.mjs and the track list widget)
// subscribes for change events and calls bytebeat.loadCode(...) itself.
// That separation makes the radio testable in Node (see
// scripts/audit-radio.mjs).
//
// Spec (decisions locked on Trello card #36, ALIO8Thc):
// - Rating model is ORTHOGONAL: per track, `rating ∈ {null,'up','down'}`
//   AND `favorite ∈ {true,false}` are independent.
// - 👎 thumbs down: track is excluded from the active pool when
//   lock-favorites is OFF. (Has no effect when lock-favorites is ON.)
// - 👍 thumbs up: track is weighted 3× more likely in shuffle (when
//   lock-favorites is OFF).
// - ⭐ favorite: track appears in the favorites list. When
//   lock-favorites is ON, only favorited tracks play; thumbs ratings
//   are ignored entirely.
// - Sequential mode: walks the active list by index, using a cursor.
//   Cursor updates on user track-click OR on next/prev.
// - Shuffle mode: weighted-random pick from the active pool. Previous
//   walks back through a ~32-entry history ring.
// - Repeat (sequential only): wrap end-of-list back to start.
// - No auto-advance. Next is manually triggered.

const STORAGE_RATINGS = 'coderadio.ratings';
const STORAGE_MODES   = 'coderadio.modes';
const STORAGE_LAST    = 'coderadio.lastTrack';

const SHUFFLE_HISTORY_MAX = 32;
const SHUFFLE_WEIGHT_UP   = 3;

export class Radio {
	constructor() {
		this.tracks = [];
		this.ratings = new Map(); // code → { rating: 'up'|'down'|null, favorite: bool }
		this.modes = { shuffle: false, lockFavorites: false, repeat: false };
		this.cursor = 0;          // index into the active list for sequential mode
		this.shuffleHistory = []; // ring of recently-played tracks (objects)
		this.currentTrack = null;
		this._listeners = new Set();
		this._loadRatings();
		this._loadModes();
	}

	/// Load the curated track JSON. Idempotent — calling twice is fine but
	/// only the first load actually does the fetch.
	async load(url = './data/coderadio-tracks.json') {
		if(this.tracks.length > 0) return this.tracks;
		let res;
		try { res = await fetch(url); }
		catch(e) { throw new Error(`radio: fetch ${ url } threw: ${ e.message }`); }
		// Status 0 is what file:// returns even on success — don't gate on res.ok.
		// Validate via body parse instead.
		const text = await res.text();
		if(!text) throw new Error(`radio: ${ url } returned empty body (status ${ res.status })`);
		try { this.tracks = JSON.parse(text); }
		catch(e) { throw new Error(`radio: ${ url } not JSON: ${ e.message }`); }
		// Restore the last-played track if we have one — start the cursor there.
		const lastCode = this._loadLastTrackCode();
		if(lastCode) {
			const idx = this.tracks.findIndex(t => t.code === lastCode);
			if(idx >= 0) {
				this.currentTrack = this.tracks[idx];
				const active = this.getActiveList();
				const ai = active.findIndex(t => t.code === lastCode);
				this.cursor = Math.max(0, ai);
			}
		}
		this._emit({ type: 'loaded', tracks: this.tracks });
		console.log(`[radio] loaded ${ this.tracks.length } tracks from ${ url }`);
		return this.tracks;
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

	getRating(code) {
		return this.ratings.get(code) || { rating: null, favorite: false };
	}

	/// Apply a thumbs rating. Passing the SAME rating that's already set
	/// clears it (button acts as a toggle). `rating` is 'up' | 'down'.
	setRating(code, rating) {
		const cur = this.getRating(code);
		const next = { ...cur, rating: cur.rating === rating ? null : rating };
		this._writeRating(code, next);
		this._emit({ type: 'rating', code });
	}

	toggleFavorite(code) {
		const cur = this.getRating(code);
		const next = { ...cur, favorite: !cur.favorite };
		this._writeRating(code, next);
		this._emit({ type: 'rating', code });
	}

	_writeRating(code, value) {
		if(value.rating === null && !value.favorite) {
			this.ratings.delete(code);
		} else {
			this.ratings.set(code, value);
		}
		this._saveRatings();
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

	getAllTracks() {
		return this.tracks;
	}
	getFavoriteTracks() {
		return this.tracks.filter(t => this.getRating(t.code).favorite);
	}

	/// The pool the next/previous logic walks. Filtered by lock-favorites
	/// (only favorites) or by thumbs-down (excluded). Sequential and
	/// shuffle both draw from this.
	getActiveList() {
		if(this.modes.lockFavorites) return this.getFavoriteTracks();
		return this.tracks.filter(t => this.getRating(t.code).rating !== 'down');
	}

	// --- playback queue -----------------------------------------------

	/// Set the active track. UI calls this when the user clicks a row in
	/// the library; we sync the sequential cursor to wherever the click
	/// landed so that Next afterwards continues from the right spot.
	setCurrent(track) {
		this.currentTrack = track;
		const active = this.getActiveList();
		const idx = active.findIndex(t => t.code === track.code);
		if(idx >= 0) this.cursor = idx;
		this._saveLastTrackCode(track.code);
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
		const newIdx = this.cursor + 1;
		if(newIdx >= pool.length) {
			if(!this.modes.repeat) return null;
			this.cursor = 0;
			this.setCurrent(pool[0]);
			return pool[0];
		}
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
			// Empty history → just pick another random one (better than nothing).
			const pick = this._weightedRandom(pool);
			if(pick) this.setCurrent(pick);
			return pick;
		}
		const newIdx = this.cursor - 1;
		if(newIdx < 0) {
			if(!this.modes.repeat) return null;
			const last = pool.length - 1;
			this.cursor = last;
			this.setCurrent(pool[last]);
			return pool[last];
		}
		this.cursor = newIdx;
		this.setCurrent(pool[newIdx]);
		return pool[newIdx];
	}

	// --- internals ----------------------------------------------------

	_weightedRandom(pool) {
		if(pool.length === 0) return null;
		const weights = pool.map(t => {
			const r = this.getRating(t.code).rating;
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
		} catch(_) { /* private mode, malformed JSON, etc. */ }
	}
	_saveRatings() {
		try {
			const obj = Object.fromEntries(this.ratings);
			localStorage.setItem(STORAGE_RATINGS, JSON.stringify(obj));
		} catch(_) { /* quota exceeded, private mode, etc. */ }
	}
	_loadModes() {
		try {
			const raw = localStorage.getItem(STORAGE_MODES);
			if(!raw) return;
			const obj = JSON.parse(raw);
			this.modes = { ...this.modes, ...obj };
		} catch(_) {}
	}
	_saveModes() {
		try {
			localStorage.setItem(STORAGE_MODES, JSON.stringify(this.modes));
		} catch(_) {}
	}
	_loadLastTrackCode() {
		try { return localStorage.getItem(STORAGE_LAST); } catch(_) { return null; }
	}
	_saveLastTrackCode(code) {
		try { localStorage.setItem(STORAGE_LAST, code); } catch(_) {}
	}
}
