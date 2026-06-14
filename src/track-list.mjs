// Renders the CodeRadio curated track list (Favorites pinned + main list)
// and wires per-row rating/favorite chips + click-to-play. Pure DOM —
// state lives in the Radio module; this is a view + delegate.
//
// Subscribes to Radio events:
//   'loaded'  → first full render
//   'rating'  → re-render (Favorites composition can change)
//   'current' → just re-highlight the playing row, no full re-render

export class TrackList {
	constructor(radio, onSelectTrack) {
		this.radio = radio;
		this.onSelectTrack = onSelectTrack; // (track) => void
		this.body = null;
		this.allList = null;
		this.favList = null;
		this.favCount = null;
		this.totalCount = null;
	}

	initElements() {
		this.body      = document.getElementById('coderadio-library-body');
		this.allList   = document.getElementById('coderadio-all-list');
		this.favList   = document.getElementById('coderadio-fav-list');
		this.favCount  = document.getElementById('coderadio-fav-count');
		this.totalCount = document.getElementById('coderadio-count');
		if(!this.body) return;
		this.body.addEventListener('click', e => this._onClick(e));
		this.radio.subscribe(ev => {
			if(ev.type === 'loaded' || ev.type === 'rating') this.render();
			else if(ev.type === 'current') this._updateCurrent();
			else if(ev.type === 'mode') this._updateModeAttrs();
		});
		// If radio already loaded (race-free) render immediately.
		if(this.radio.tracks.length > 0) this.render();
	}

	render() {
		if(!this.allList || !this.favList) return;
		const all = this.radio.getAllTracks();
		const favs = this.radio.getFavoriteTracks();
		this.totalCount.textContent = all.length;
		this.favCount.textContent = favs.length;
		// Use indices into the radio.tracks array as stable row keys —
		// avoids escaping the entire bytebeat code as a data-attribute value.
		this.allList.innerHTML = all.map(t => this._rowHtml(t, all.indexOf(t))).join('');
		this.favList.innerHTML = favs.length
			? favs.map(t => this._rowHtml(t, all.indexOf(t))).join('')
			: `<div class="coderadio-empty-fav">No favorites yet. Click ⭐ on a track to add one.</div>`;
		this._updateCurrent();
		this._updateModeAttrs();
	}

	_rowHtml(track, idx) {
		const r = this.radio.getRating(track.code);
		const desc = (track.description && track.description.trim()) ||
			(track.code.length > 60 ? track.code.slice(0, 58) + '…' : track.code);
		const author = track.author || 'unknown';
		const mode = track.mode || 'Bytebeat';
		return `
<div class="coderadio-track" data-idx="${ idx }">
	<div class="coderadio-track-meta">
		<div class="coderadio-track-desc">${ esc(desc) }</div>
		<div class="coderadio-track-sub">
			<span class="coderadio-track-author">${ esc(author) }</span>
			<span class="coderadio-track-mode">${ esc(mode) }</span>
		</div>
	</div>
	<div class="coderadio-track-actions">
		<button class="coderadio-rate ${ r.rating === 'up' ? 'is-active' : '' }" data-rate="up" title="Thumbs up — boosts in shuffle">👍</button>
		<button class="coderadio-rate ${ r.rating === 'down' ? 'is-active is-down' : '' }" data-rate="down" title="Thumbs down — never plays (unless locked to favorites)">👎</button>
		<button class="coderadio-fav ${ r.favorite ? 'is-active' : '' }" title="Favorite — pin to top + lockable playlist">⭐</button>
	</div>
</div>`;
	}

	_onClick(e) {
		const rateBtn = e.target.closest('.coderadio-rate');
		if(rateBtn) {
			e.stopPropagation();
			const row = rateBtn.closest('.coderadio-track');
			const track = this._trackFromRow(row);
			if(track) this.radio.setRating(track.code, rateBtn.dataset.rate);
			return;
		}
		const favBtn = e.target.closest('.coderadio-fav');
		if(favBtn) {
			e.stopPropagation();
			const row = favBtn.closest('.coderadio-track');
			const track = this._trackFromRow(row);
			if(track) this.radio.toggleFavorite(track.code);
			return;
		}
		const row = e.target.closest('.coderadio-track');
		if(row) {
			const track = this._trackFromRow(row);
			if(track && this.onSelectTrack) this.onSelectTrack(track);
		}
	}

	_trackFromRow(row) {
		if(!row) return null;
		const idx = +row.dataset.idx;
		if(!Number.isFinite(idx)) return null;
		return this.radio.tracks[idx] || null;
	}

	_updateCurrent() {
		const cur = this.radio.currentTrack;
		const all = this.radio.tracks;
		// Remove all current marks
		this.body.querySelectorAll('.coderadio-track.is-current')
			.forEach(el => el.classList.remove('is-current'));
		if(!cur) return;
		const idx = all.indexOf(cur);
		if(idx < 0) return;
		// Same idx is used in both pinned + main list rows.
		this.body.querySelectorAll(`.coderadio-track[data-idx="${ idx }"]`)
			.forEach(el => el.classList.add('is-current'));
		// Scroll current row into view (in the main list) gently.
		const inMain = this.allList.querySelector(`.coderadio-track[data-idx="${ idx }"]`);
		if(inMain) inMain.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	_updateModeAttrs() {
		// Project mode flags onto data-attributes so CSS can react.
		const root = document.documentElement;
		root.dataset.shuffle      = this.radio.modes.shuffle      ? '1' : '0';
		root.dataset.lockFavorites = this.radio.modes.lockFavorites ? '1' : '0';
		root.dataset.repeat       = this.radio.modes.repeat       ? '1' : '0';
	}
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
