import { Editor } from './editor.mjs';
import { Legend } from './legend.mjs';
import { Library } from './library.mjs';
import { Radio } from './radio.mjs';
import { Scope } from './scope.mjs';
import { TrackList } from './track-list.mjs';
import { UI } from './ui.mjs';
import { VibingCat } from './vibing-cat.mjs';
import { Visualizer } from './visualizer.mjs';
import { getCodeFromUrl, getUrlFromCode } from './url.mjs';

const editor = new Editor();
const legend = new Legend();
const library = new Library();
const radio = new Radio();
const scope = new Scope();
const ui = new UI();
const visualizer = new Visualizer();
const vibingCat = new VibingCat();
// Desktop F7/F8/F9 vs mobile Bluetooth AVRCP need OPPOSITE silent-audio
// keepalive strategies — see the long comment in playbackToggle().
const IS_MOBILE_PLATFORM = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
/// Load a track via the bytebeat composer, fetching its code from
/// data/songs/<type>/<hash>.js if it's a file-based library entry
/// (no inline code in the upstream library HTML). Without this fetch
/// step, Next/Prev would silently load empty code for file-based
/// entries — which is exactly the bug a user hit after the 3rd track,
/// where the 4th turned out to be file-based.
async function radioLoadAndPlay(track, autoPlay = true) {
	if(!track) return;
	let code = track.code;
	if(!code && track.codeFile) {
		try {
			const type = track.codeType || 'minified';
			const url = `./data/songs/${ type }/${ track.codeFile }`;
			const res = await fetch(url);
			code = await res.text();
		} catch(e) {
			console.error('[radio] failed to fetch track file:', e);
			return;
		}
	}
	if(!code) return;
	globalThis.bytebeat.loadCode({
		code,
		sampleRate: track.sampleRate || 8000,
		mode: track.mode || 'Bytebeat',
	}, autoPlay);
}

const trackList = new TrackList(radio, track => {
	// User clicked a row in the Favorites list → sync radio cursor + play.
	radio.setCurrent(track);
	radioLoadAndPlay(track);
});
// The radio's "universe" of tracks is whatever the composer's library
// has surfaced so far (TrackList watches every library container with a
// MutationObserver and records each `.entry` as the user expands it).
radio.setUniverseProvider(() => trackList.getKnownTracks());

globalThis.bytebeat = new class {
	constructor() {
		this.audioCtx = null;
		this.audioGain = null;
		this.audioRecordChunks = [];
		this.audioRecorder = null;
		this.audioWorkletNode = null;
		this.byteSample = 0;
		this.defaultSettings = {
			codeStyle: 'Atom Dark',
			colorDiagram: '#0080ff',
			colorStereo: 1,
			colorTimeCursor: '#80bbff',
			colorWaveform: '#ffffff',
			drawMode: scope.drawMode,
			drawScale: scope.drawScale,
			fftSize: scope.fftSize,
			isSeconds: false,
			showAllSongs: library.showAllSongs,
			srDivisor: 1,
			themeStyle: 'Default Dark',
			volume: .5
		};
		this.isCompilationError = false;
		this.isNeedClear = false;
		this.isLagging = false;
		this.isPlaying = false;
		this.isRecording = false;
		this.lastUpdateTime = 0;
		this.mode = 'Bytebeat';
		this.playbackSpeed = 1;
		this.sampleRate = 8000;
		this.settings = this.defaultSettings;
		this.updateCounter = 0;
		this.init();
	}
	handleEvent(event) {
		let elem = event.target;
		const { classList } = elem;
		switch(event.type) {
		case 'change':
			switch(elem.id) {
			case 'control-code-style': this.setCodeStyle(elem.value); break;
			case 'control-color-diagram': this.setColorDiagram(elem.value); break;
			case 'control-color-stereo':
				this.setColorStereo(+elem.value);
				ui.controlColorDiagramInfo.innerHTML = scope.getColorTest('colorDiagram');
				ui.controlColorWaveformInfo.innerHTML = scope.getColorTest('colorWaveform');
				break;
			case 'control-color-timecursor': this.setColorTimeCursor(elem.value); break;
			case 'control-color-waveform': this.setColorWaveform(elem.value); break;
			case 'control-drawmode': this.setDrawMode(elem.value); break;
			case 'control-mode': this.setPlaybackMode(elem.value); break;
			case 'control-samplerate':
			case 'control-samplerate-select': this.setSampleRate(+elem.value); break;
			case 'control-theme-style': this.setThemeStyle(elem.value); break;
			case 'library-show-all':
				library.toggleAll(elem, elem.checked);
				this.saveSettings();
				break;
			}
			return;
		case 'click':
			switch(elem.tagName) {
			case 'svg': elem = elem.parentNode; break;
			case 'use': elem = elem.parentNode.parentNode; break;
			default:
				if(classList.contains('control-fast-multiplier')) {
					elem = elem.parentNode;
				}
			}
			switch(elem.id) {
			case 'canvas-container':
			case 'canvas-main':
			case 'canvas-play':
			case 'canvas-timecursor': this.playbackToggle(!this.isPlaying); break;
			case 'control-counter':
			case 'control-pause': this.playbackToggle(false); break;
			case 'control-expand': ui.expandEditor(); break;
			case 'control-legend':
			case 'legend-handle':
				legend.toggle();
				break;
			case 'control-link': ui.copyLink(); break;
			case 'control-play-backward': this.playbackToggle(true, true, -1); break;
			case 'control-play-forward': this.playbackToggle(true, true, 1); break;
			case 'control-next-track': this.radioAdvance(1); break;
			case 'control-prev-track': this.radioAdvance(-1); break;
			case 'control-shuffle':
				radio.toggleMode('shuffle');
				this._syncRadioToolbar();
				break;
			case 'control-lock-fav':
				radio.toggleMode('lockFavorites');
				this._syncRadioToolbar();
				break;
			case 'control-viz': visualizer.toggle(); break;
			case 'control-viz-next': visualizer.nextPreset(); break;
			case 'control-viz-auto': visualizer.toggleAutoChange(); break;
			case 'control-cat': vibingCat.toggle(); break;
			case 'control-help': this._toggleHelpModal(true); break;
			case 'control-compact': {
				const on = !document.body.classList.contains('compact-mode');
				document.body.classList.toggle('compact-mode', on);
				try { localStorage.setItem('coderadio.compact', on ? '1' : '0'); } catch(_) {}
				break;
			}
			case 'control-rate-up':
				if(radio.currentTrack) radio.setRating(radio.currentTrack, 'up');
				break;
			case 'control-rate-down':
				if(radio.currentTrack) radio.setRating(radio.currentTrack, 'down');
				break;
			case 'control-rate-fav':
				if(radio.currentTrack) radio.toggleFavorite(radio.currentTrack);
				break;
			case 'control-rec': this.toggleRecording(); break;
			case 'control-reset': this.resetTime(); break;
			case 'control-scale': this.resetScopeAdjustment(); break;
			case 'control-scaledown': this.setScopeAdjustment(-1, elem); break;
			case 'control-scaleup': this.setScopeAdjustment(1); break;
			case 'control-srdivisor-down': this.setSRDivisor(-1); break;
			case 'control-srdivisor-up': this.setSRDivisor(1); break;
			case 'control-stop': this.playbackStop(); break;
			case 'control-counter-units': this.toggleCounterUnits(); break;
			default:
				switch(true) {
				case classList.contains('code-text'):
					this._radioMarkFromEntry(elem);
					this.loadCode(Object.assign({ code: elem.innerText },
						elem.hasAttribute('data-songdata') ? JSON.parse(elem.dataset.songdata) : {}));
					break;
				case classList.contains('code-load'):
					this._radioMarkFromEntry(elem);
					library.onclickCodeLoadButton(elem);
					break;
				case classList.contains('code-remix-load'): library.onclickRemixLoadButton(elem); break;
				case classList.contains('library-header'): library.onclickLibraryHeader(elem); break;
				case elem.parentNode.classList.contains('library-header'):
					library.onclickLibraryHeader(elem.parentNode);
					break;
				case classList.contains('song-hash'):
					navigator.clipboard.writeText(elem.dataset.hash);
					event.preventDefault();
					break;
				}
			}
			return;
		case 'input':
			switch(elem.id) {
			case 'control-counter': this.oninputCounter(event); break;
			case 'control-volume': this.setVolume(false); break;
			}
			return;
		case 'keydown':
			if(elem.id === 'control-counter') {
				this.oninputCounter(event);
			}
			return;
		case 'mouseover':
			switch(true) {
			case classList.contains('code-load'):
				elem.title = `Click to play the ${ elem.dataset.type } code`;
				break;
			case classList.contains('code-text'): elem.title = 'Click to play this code'; break;
			case classList.contains('songs-header'): elem.title = 'Click to show/hide the songs'; break;
			case classList.contains('song-hash'):
				elem.title = 'Click to copy the song hash into clipboard';
				break;
			case classList.contains('tag-c'): elem.title = 'C-compatible code'; break;
			case classList.contains('tag-console'):
				elem.title = 'Outputs messages in the error console';
				break;
			case classList.contains('tag-drawing'):
				elem.title = 'Generates art in the visualiser\'s scope';
				break;
			case classList.contains('tag-sample'):
				elem.title = 'Uses encoded audio samples (PCM, for example)';
				break;
			case classList.contains('tag-slow'):
				elem.title = 'May be performance issues. Try switching Chrome/Firefox.';
				break;
			}
			return;
		}
	}
	async init() {
		try {
			this.settings = JSON.parse(localStorage.settings);
			scope.drawMode = this.settings.drawMode;
			scope.drawScale = this.settings.drawScale;
			scope.setFFTSize(+this.settings.fftSize || 10);
			library.showAllSongs = this.settings.showAllSongs;
		} catch(err) {
			this.saveSettings();
		}
		this.setThemeStyle();
		await this.initAudio();
		if(document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => this.initAfterDom());
			return;
		}
		this.initAfterDom();
	}
	initAfterDom() {
		editor.init();
		// Expose editor + legend on the global so devtools can poke around
		// and so callers (e.g. legend "Try" buttons) reach the editor.
		this.editor = editor;
		this.legend = legend;
		legend.initElements();
		// Radio core — the universe is the composer's existing library
		// entries (captured by TrackList's MutationObserver as the user
		// expands each library section). Favorites + ratings persist to
		// localStorage with their metadata, so the Favorites panel works
		// regardless of which libraries the user has loaded.
		this.radio = radio;
		this.trackList = trackList;
		this.visualizer = visualizer;
		this.vibingCat = vibingCat;
		trackList.initElements();
		visualizer.initElements();
		vibingCat.initElements();
		this._syncRadioToolbar();
		// Compact mode — minimal UI showing only the radio controls.
		// Default: ON for mobile-sized viewports (≤ 768px), OFF for
		// desktop. Saved preference always wins after first interaction.
		(function applyCompactMode() {
			const saved = localStorage.getItem('coderadio.compact');
			let on;
			if(saved !== null) {
				on = saved === '1';
			} else {
				on = window.matchMedia('(max-width: 768px)').matches;
			}
			document.body.classList.toggle('compact-mode', on);
		})();
		// Auto-load the Classic library on first page open so radio
		// Next/Prev has tracks immediately. Without this, the universe
		// stays empty until the user manually expands a library section,
		// and the radio buttons appear non-functional.
		//
		// This is async (fetch + ungzip + innerHTML), so everything that
		// depends on the universe being populated — restoreLastTrack,
		// _syncNowRating, _updateCurrent — must wait for it to resolve.
		(async () => {
			const classicContainer = document.getElementById('library-classic');
			if(classicContainer) {
				const summary = classicContainer.previousElementSibling;
				if(summary && summary.classList.contains('library-header')) {
					try { await library.onclickLibraryHeader(summary); }
					catch(e) { console.error('auto-load Classic failed:', e); }
				}
			}
			// Now the universe is seeded. Try to resume the last-played
			// track. If this is a fresh session (incognito / first visit),
			// default to "the 42 melody" — the canonical bytebeat one-liner.
			radio.restoreLastTrack();
			if(!radio.currentTrack) {
				const universe = trackList.getKnownTracks();
				const def = universe.find(t => t.hash === "e295af172c127b1f527c823ad0aeaeda");
				if(def) radio.setCurrent(def);
			}
			// Default shuffle ON for new sessions so visitors land in
			// radio mode immediately. The first click of 🔀 toggles it off.
			if(localStorage.getItem("coderadio.modes") === null) {
				radio.setMode("shuffle", true);
			}
			this._syncRadioToolbar();
			this._syncNowRating();
			trackList._updateCurrent();
			// Load the restored/default track's code into the editor so the
			// user sees it immediately, but DON'T auto-start playback — the
			// browser's autoplay policy keeps the AudioContext suspended
			// until a user gesture. Auto-playing would toggle the button
			// to "pause" while the AudioContext is still locked, making the
			// user click twice (once to sync state, once to actually play).
			if(!this.isPlaying && radio.currentTrack) {
				radioLoadAndPlay(radio.currentTrack, false);
			}
			})();
		// Keep the player-area rating chips in sync with the current track's
		// state — on 'current' (a new track loaded) or 'rating' (chip
		// clicked, either from the player or from a library row).
		radio.subscribe(ev => {
			if(ev.type === 'current' || ev.type === 'rating') this._syncNowRating();
		});
		// Global spacebar → next random visualizer preset, gated on no
		// editable element being focused. Mirrors the macOS CodeRadio
		// app's space-key behavior. CodeMirror's editor area is
		// contenteditable, so typing space inside it still inserts a
		// space. randomPreset is a no-op when the viz isn't running, so
		// pressing space when the viz is off does nothing.
		window.addEventListener('keydown', e => {
			if(e.code !== 'Space' && e.key !== ' ') return;
			const ae = document.activeElement;
			const editable = ae && (
				ae.isContentEditable
				|| ae.tagName === 'INPUT' && !ae.disabled && !ae.readOnly
				|| ae.tagName === 'TEXTAREA' && !ae.disabled && !ae.readOnly
			);
			if(editable) return;
			e.preventDefault();
			visualizer.randomPreset();
		});
	}

	_syncNowRating() {
		const cur = radio.currentTrack;
		const up   = document.getElementById('control-rate-up');
		const down = document.getElementById('control-rate-down');
		const fav  = document.getElementById('control-rate-fav');
		if(!up || !down || !fav) return;
		const disabled = !cur;
		[up, down, fav].forEach(b => b.disabled = disabled);
		if(!cur) {
			[up, down, fav].forEach(b => b.classList.remove('is-active', 'is-down'));
			return;
		}
		const r = radio.getRating(cur.hash || cur.code);
		up.classList.toggle('is-active', r.rating === 'up');
		down.classList.toggle('is-active', r.rating === 'down');
		down.classList.toggle('is-down', r.rating === 'down');
		fav.classList.toggle('is-active', r.favorite);
	}

	/// Next / Prev clicks → ask radio for the next track in the active list
	/// (sequential or shuffle, lock-favorites respected; sequential wraps
	/// end-to-start since there's no Repeat button). Then load + play.
	/// dir is +1 (next) or -1 (previous).
	radioAdvance(dir) {
		const track = dir > 0 ? radio.next() : radio.previous();
		if(!track) return;
		radioLoadAndPlay(track);
	}

	/// Bridge composer library clicks → radio.currentTrack. The user clicked
	/// a code-text or code-load button inside a `.entry`; walk up to the
	/// entry, read its data-hash, look up the track metadata in trackList's
	/// universe, and tell the radio so the player-area rating chips and
	/// sequential cursor know what's playing.
	_radioMarkFromEntry(elem) {
		const entry = elem.closest('.entry');
		if(!entry || !entry.dataset.hash) return;
		const track = trackList.universe.get(entry.dataset.hash);
		if(track) radio.setCurrent(track);
	}

	/// Mirror the toolbar mode buttons' `.is-active` class from radio.modes.
	_syncRadioToolbar() {
		const apply = (id, on) => {
			const el = document.getElementById(id);
			if(el) el.classList.toggle('is-active', !!on);
		};
		apply('control-shuffle',  radio.modes.shuffle);
		apply('control-lock-fav', radio.modes.lockFavorites);
		ui.initElements();
		scope.initElements();
		library.initElements();
		this.setVolume(true);
		this.setCounterUnits();
		this.setCodeStyle();
		this.setColorStereo();
		this.setColorDiagram();
		this.setColorWaveform();
		this.setColorTimeCursor();
		this.setScopeAdjustment(0);
		this.parseUrl();
		this.sendData({ drawMode: scope.drawMode });
		ui.controlDrawMode.value = scope.drawMode;
		ui.controlThemeStyle.value = this.settings.themeStyle;
		ui.controlCodeStyle.value = this.settings.codeStyle;
		ui.mainElem.addEventListener('click', this);
		ui.mainElem.addEventListener('change', this);
		ui.containerFixed.addEventListener('input', this);
		ui.containerFixed.addEventListener('keydown', this);
		ui.containerScroll.addEventListener('mouseover', this);
		this.setupMediaSession();
		this._setupHelpModal();
	}
	// Hook hardware media keys + Control Center / Touch Bar Now Playing.
	// macOS routes media keys to whichever process owns the active audio
	// session — that's WebKit for us, so we have to handle them in JS via
	// the Web MediaSession API rather than relying on the native
	// MPRemoteCommandCenter wired on the Swift side.
	_setupHelpModal() {
		const modal = document.getElementById('coderadio-help-modal');
		if(!modal) return;
		modal.addEventListener('click', (e) => {
			// Dismiss only when the click hits the backdrop or the X
			// (both tagged with data-help-dismiss). Clicks on the card's
			// content shouldn't close.
			if(e.target.closest('[data-help-dismiss]')) {
				this._toggleHelpModal(false);
			}
		});
		document.addEventListener('keydown', (e) => {
			if(e.key === 'Escape' && !modal.classList.contains('is-hidden')) {
				this._toggleHelpModal(false);
			}
		});
	}
	_toggleHelpModal(show) {
		const modal = document.getElementById('coderadio-help-modal');
		if(!modal) return;
		modal.classList.toggle('is-hidden', !show);
	}
	setupMediaSession() {
		if(!('mediaSession' in navigator)) {
			return;
		}
		const ms = navigator.mediaSession;
		// Play / Pause: composer's built-in audio toggle. The
		// playbackState writes keep the OS Now Playing widget's
		// play/pause icon accurate.
		ms.setActionHandler('play', () => {
			this.playbackToggle(true, true);
			ms.playbackState = 'playing';
		});
		ms.setActionHandler('pause', () => {
			this.playbackToggle(false, true);
			ms.playbackState = 'paused';
		});
		// Some OSes route to a single toggle action instead of separate
		// play/pause. Register the toggle as a safety net so a single
		// keypress always flips state correctly.
		try {
			ms.setActionHandler('togglePlayPause', () => {
				const next = !this.isPlaying;
				this.playbackToggle(next, true);
				ms.playbackState = next ? 'playing' : 'paused';
			});
		} catch(e) {}
		// Next / Previous: walk the radio's active library list
		// (sequential or weighted-shuffle depending on mode).
		try {
			ms.setActionHandler('nexttrack',     () => this.radioAdvance(1));
			ms.setActionHandler('previoustrack', () => this.radioAdvance(-1));
		} catch(e) { /* unsupported in older browsers */ }
		// Silent <audio> element — iOS Safari needs a real media element
		// (not just WebAudio) to render the lock screen / Control Center
		// Now Playing widget AND to keep the audio session alive when the
		// user leaves the tab. The src is an inline base64 PCM-zeros WAV
		// (silent, ~120 bytes); it loops forever while bytebeat is
		// playing. playbackToggle wires the play/pause.
		const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
		const silent = document.createElement('audio');
		silent.src = SILENT_WAV;
		silent.loop = true;
		silent.preload = 'auto';
		silent.setAttribute('playsinline', '');
		silent.setAttribute('aria-hidden', 'true');
		silent.style.display = 'none';
		document.body.appendChild(silent);
		this._silentAudio = silent;
		// Keep the OS widget's metadata + play state in sync with
		// whatever the radio just loaded. Fires on Next/Prev, user
		// track-clicks, and last-track restore on page open.
		radio.subscribe(ev => {
			if(ev.type !== 'current' || !ev.track) return;
			const t = ev.track;
			const title = (t.description && String(t.description).trim()) ||
				(t.code ? String(t.code).slice(0, 60) : 'bytebeat');
			try {
				ms.metadata = new MediaMetadata({
					title,
					artist: t.author || 'unknown',
					album:  'bytebeat-composer',
				});
			} catch(_) {}
			ms.playbackState = 'playing';
		});
	}
	// Bridge to CodeRadio's RadioStation. No-op when running in a browser
	// without the WKScriptMessageHandler registered (e.g. dev preview).
	postCoderadio(action) {
		if(globalThis.webkit && globalThis.webkit.messageHandlers
			&& globalThis.webkit.messageHandlers.coderadio) {
			globalThis.webkit.messageHandlers.coderadio.postMessage(action);
		}
	}
	async initAudio() {
		this.audioCtx = new AudioContext({ latencyHint: 'balanced', sampleRate: 48000 });
		this.audioGain = new GainNode(this.audioCtx);
		this.audioGain.connect(this.audioCtx.destination);
		// Analyser for FFT mode
		scope.analyser = [this.audioCtx.createAnalyser(), this.audioCtx.createAnalyser()];
		scope.analyser[0].minDecibels = scope.analyser[1].minDecibels = scope.minDecibels;
		scope.analyser[0].maxDecibels = scope.analyser[1].maxDecibels = scope.maxDecibels;
		scope.setFFTAnalyzer();
		const splitter = this.audioCtx.createChannelSplitter(2);
		splitter.connect(scope.analyser[0], 0);
		splitter.connect(scope.analyser[1], 1);
		const analyserGain = new GainNode(this.audioCtx);
		analyserGain.connect(splitter);
		// AudioWorklet for main calculations processing
		await this.audioCtx.audioWorklet.addModule('./build/audio-processor.mjs');
		this.audioWorkletNode = new AudioWorkletNode(this.audioCtx, 'audioProcessor',
			{ outputChannelCount: [2] });
		this.audioWorkletNode.port.addEventListener('message', event => this.receiveData(event.data));
		this.audioWorkletNode.port.start();
		this.audioWorkletNode.connect(this.audioGain);
		this.audioWorkletNode.connect(analyserGain);
		// Hook Butterchurn to the audio output, now that the AudioContext +
		// worklet exist. If the user has the viz toggled on (preference
		// persisted), this will kick off the render loop immediately.
		visualizer.attachAudio(this.audioCtx, this.audioWorkletNode);
		vibingCat.attachAudio(this.audioCtx, this.audioWorkletNode);
		// Recorder for recording audio files
		const mediaDest = this.audioCtx.createMediaStreamDestination();
		const audioRecorder = this.audioRecorder = new MediaRecorder(mediaDest.stream);
		audioRecorder.addEventListener('dataavailable', event => this.audioRecordChunks.push(event.data));
		audioRecorder.addEventListener('stop', () => {
			let fileName, type;
			const types = ['audio/webm', 'audio/ogg'];
			const files = ['track.webm', 'track.ogg'];
			while((fileName = files.pop()) && !MediaRecorder.isTypeSupported(type = types.pop())) {
				if(types.length === 0) {
					console.error('Recording is not supported in this browser!');
					break;
				}
			}
			const url = URL.createObjectURL(new Blob(this.audioRecordChunks, { type }));
			ui.downloader.href = url;
			ui.downloader.download = fileName;
			ui.downloader.click();
			setTimeout(() => window.URL.revokeObjectURL(url));
		});
		this.audioGain.connect(mediaDest);
	}
	loadCode({ code, sampleRate, mode, drawMode, scale }, isPlay = true) {
		this.mode = ui.controlPlaybackMode.value = mode = mode || 'Bytebeat';
		editor.setValue(code);
		this.setSampleRate(ui.controlSampleRate.value = +sampleRate || 8000, false);
		this.setSRDivisor(0);
		const data = {
			mode,
			sampleRate: this.sampleRate,
			sampleRatio: this.sampleRate / this.audioCtx.sampleRate
		};
		if(isPlay) {
			data.playbackSpeed = this.playbackSpeed = 1;
			this.playbackToggle(true, false);
			data.resetTime = true;
			data.isPlaying = isPlay;
		}
		data.setFunction = code;
		if(drawMode) {
			ui.controlDrawMode.value = scope.drawMode = drawMode;
			scope.toggleTimeCursor();
			scope.clearCanvas();
			this.saveSettings();
		}
		if(scale !== undefined) {
			this.setScale(scale - scope.drawScale);
		}
		this.sendData(data);
	}
	oninputCounter(event) {
		if(event.key === 'Enter') {
			ui.controlTime.blur();
			this.playbackToggle(true);
			return;
		}
		const byteSample = this.settings.isSeconds ? Math.round(ui.controlTime.value * this.sampleRate) :
			ui.controlTime.value;
		this.setByteSample(byteSample);
		this.sendData({ byteSample });
	}
	parseUrl() {
		let urlHash = window.location.hash;
		if(!urlHash) {
			this.updateUrl();
			urlHash = window.location.hash;
		}
		this.loadCode(getCodeFromUrl(urlHash) || { code: editor.value }, false);
	}
	playbackStop() {
		this.playbackToggle(false, false);
		this.sendData({ isPlaying: false, resetTime: true });
	}
	playbackToggle(isPlaying, isSendData = true, speedIncrement = 0) {
		const isReverse = speedIncrement ? speedIncrement < 0 : this.playbackSpeed < 0;
		const buttonElem = isReverse ? ui.controlPlayBackward : ui.controlPlayForward;
		if(speedIncrement && buttonElem.getAttribute('disabled')) {
			return;
		}
		const multiplierElem = buttonElem.firstElementChild;
		const speed = speedIncrement ? +multiplierElem.textContent : 1;
		multiplierElem.classList.toggle('control-fast-multiplier-large', speed >= 8);
		const nextSpeed = speed === 64 ? 0 : speed * 2;
		ui.setPlayButton(ui.controlPlayBackward, isPlaying && isReverse ? nextSpeed : 1);
		ui.setPlayButton(ui.controlPlayForward, isPlaying && !isReverse ? nextSpeed : 1);
		if(speedIncrement || !isPlaying) {
			this.playbackSpeed = isPlaying ? speedIncrement * speed : Math.sign(this.playbackSpeed);
		}
		scope.canvasContainer.title = isPlaying ? `Click to ${
			this.isRecording ? 'pause and stop recording' : 'pause' }` :
			`Click to play${ isReverse ? ' in reverse' : '' }`;
		scope.canvasPlayButton.classList.toggle('canvas-play-backward', isReverse);
		scope.canvasPlayButton.classList.toggle('canvas-play', !isPlaying);
		scope.canvasPlayButton.classList.toggle('canvas-pause', isPlaying);
		if(isPlaying) {
			scope.canvasPlayButton.classList.remove('canvas-initial');
			if(this.audioCtx.resume) {
				this.audioCtx.resume();
				scope.requestAnimationFrame(); // Main call for drawing in the scope
			}
		} else {
			this.lastUpdateTime = 0;
			this.updateCounter = 0;
			this.isLagging = false;
			ui.controlLag.innerText = '---';
			ui.controlLag.classList.remove('control-lag-red');
			if(this.isRecording) {
				this.isRecording = false;
				ui.controlRecord.classList.remove('control-recording');
				ui.controlRecord.title = 'Record to file';
				this.audioRecorder.stop();
			}
		}
		this.isPlaying = isPlaying;
		if(isSendData) {
			this.sendData({ isPlaying, playbackSpeed: this.playbackSpeed });
		} else {
			this.isNeedClear = true;
		}
		// Keep the OS Now Playing widget in sync regardless of how
		// play/pause was triggered (toolbar button, canvas click, media
		// keys, etc). Without this, macOS Now Playing routes F8 to the
		// stale state — e.g. you pause via the on-screen button, then
		// F8 fires 'pause' again instead of 'play'.
		if('mediaSession' in navigator) {
			navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
		}
		// Drive a silent <audio> element so iOS Safari renders the lock
		// screen / Control Center Now Playing widget (it ignores pure
		// WebAudio for that purpose) and keeps the audio session alive
		// when the user leaves the tab.
		//
		// Desktop vs mobile need OPPOSITE behavior here, because each
		// platform uses a different signal to decide what a hardware
		// media-key press means:
		//
		// - Desktop (macOS F7/F8/F9): Chrome/Safari route the key based
		//   on whether an <audio> element is ACTUALLY producing samples,
		//   not on navigator.mediaSession.playbackState. If we leave the
		//   silent element playing while paused, the OS thinks the page
		//   is still "playing" and F8 always sends 'pause' — you can
		//   never resume from the keyboard. So on desktop we pause it
		//   in lockstep with bytebeat. Trade-off: while paused, another
		//   app (Music.app, VLC, Spotify) can take the macOS media-key
		//   slot — documented in the README.
		// - Mobile (Bluetooth AVRCP / lock-screen widget): the opposite
		//   problem. Once the silent element is actually .pause()'d,
		//   iOS/Android tear down the active media session entirely —
		//   the Now Playing widget disappears and there's no live
		//   session left for the earbuds' "play" button to reach. So on
		//   mobile we keep the silent loop running through pause/resume
		//   and rely on mediaSession.playbackState alone for the OS
		//   widget's play/pause icon.
		if(this._silentAudio) {
			if(isPlaying) {
				this._silentAudio.play().catch(() => {});
			} else if(!IS_MOBILE_PLATFORM) {
				this._silentAudio.pause();
			}
		}
	}
	receiveData(data) {
		const { byteSample, drawBuffer, error } = data;
		if(typeof byteSample === 'number') {
			this.setCounterValue(byteSample);
			this.setByteSample(byteSample);
		}
		if(data.pcm) {
			this.postCoderadio({ pcm: Array.from(data.pcm) });
		}
		if(Array.isArray(drawBuffer)) {
			scope.drawBuffer = scope.drawBuffer.concat(drawBuffer);
			const limit = scope.canvasWidth * (1 << scope.drawScale) - 1;
			if(scope.drawBuffer.length > limit) {
				scope.drawBuffer = scope.drawBuffer.slice(-limit);
			}
		}
		if(error !== undefined) {
			let isUpdate = false;
			if(error.isCompiled === false) {
				isUpdate = true;
				this.isCompilationError = true;
			} else if(error.isCompiled === true) {
				isUpdate = true;
				this.isCompilationError = false;
			} else if(error.isRuntime === true && !this.isCompilationError) {
				isUpdate = true;
			}
			if(isUpdate) {
				editor.errorElem.innerText = error.message;
				this.sendData({ errorDisplayed: true });
			}
			if(data.updateUrl !== true) {
				ui.setCodeSize(editor.value);
			}
		}
		if(data.updateUrl === true) {
			this.updateUrl();
		}
	}
	resetScopeAdjustment() {
		if(scope.drawMode === 'FFT') {
			this.setFFTBins(-scope.fftSize + 10);
		} else {
			this.setScale(-scope.drawScale);
		}
	}
	resetTime() {
		this.isNeedClear = true;
		this.sendData({ resetTime: true, playbackSpeed: this.playbackSpeed });
	}
	saveSettings() {
		this.settings.drawMode = scope.drawMode;
		this.settings.drawScale = scope.drawScale;
		this.settings.fftSize = scope.fftSize;
		this.settings.showAllSongs = library.showAllSongs;
		localStorage.settings = JSON.stringify(this.settings);
	}
	sendData(data) {
		this.audioWorkletNode.port.postMessage(data);
	}
	setByteSample(value) {
		this.byteSample = +value || 0;
		if(this.isNeedClear && value === 0) {
			this.isNeedClear = false;
			scope.drawBuffer = [];
			scope.canvasTimeCursor.style.left = 0;
			scope.clearCanvas();
			if(!this.isPlaying) {
				scope.canvasPlayButton.classList.add('canvas-initial');
			}
		}
	}
	setCodeStyle(value) {
		if(value !== undefined) {
			this.settings.codeStyle = value;
			this.saveSettings();
		} else if((value = this.settings.codeStyle) === undefined) {
			value = this.settings.codeStyle = this.defaultSettings.codeStyle;
			this.saveSettings();
		}
		document.documentElement.dataset.syntax = value;
		document.documentElement.dataset.syntaxType = value.endsWith('Light') ? 'light' : 'dark';
	}
	setColorDiagram(value) {
		if(value !== undefined) {
			this.settings.colorDiagram = value;
			this.saveSettings();
		} else if((value = this.settings.colorDiagram) === undefined) {
			value = this.settings.colorDiagram = this.defaultSettings.colorDiagram;
			this.saveSettings();
		}
		ui.controlColorDiagram.value = value;
		ui.controlColorDiagramInfo.innerHTML = scope.getColorTest('colorDiagram', value);
	}
	setColorStereo(value) {
		// value: Red=0, Green=1, Blue=2
		if(value !== undefined) {
			this.settings.colorStereo = value;
			this.saveSettings();
		} else if((value = this.settings.colorStereo) === undefined) {
			value = this.settings.colorStereo = this.defaultSettings.colorStereo;
			this.saveSettings();
		}
		ui.controlColorStereo.value = value;
		switch(value) {
		// [Left, Right1, Right2]
		case 0: scope.colorChannels = [0, 1, 2]; break;
		case 2: scope.colorChannels = [2, 0, 1]; break;
		default: scope.colorChannels = [1, 0, 2];
		}
		if(scope.colorWaveform) {
			scope.setStereoColors();
		}
	}
	setColorTimeCursor(value) {
		if(value !== undefined) {
			this.settings.colorTimeCursor = value;
			this.saveSettings();
		} else if((value = this.settings.colorTimeCursor) === undefined) {
			value = this.settings.colorTimeCursor = this.defaultSettings.colorTimeCursor;
			this.saveSettings();
		}
		ui.controlColorTimeCursor.value = value;
		scope.canvasTimeCursor.style.borderLeft = '2px solid ' + value;
	}
	setColorWaveform(value) {
		if(value !== undefined) {
			this.settings.colorWaveform = value;
			this.saveSettings();
		} else if((value = this.settings.colorWaveform) === undefined) {
			value = this.settings.colorWaveform = this.defaultSettings.colorWaveform;
			this.saveSettings();
		}
		ui.controlColorWaveform.value = value;
		ui.controlColorWaveformInfo.innerHTML = scope.getColorTest('colorWaveform', value);
		scope.setStereoColors();
	}
	setCounterUnits() {
		ui.controlTimeUnits.textContent = this.settings.isSeconds ? 'sec' : 't';
		this.setCounterValue(this.byteSample);
	}
	setCounterValue(value) {
		ui.controlTime.value = this.settings.isSeconds ? (value / this.sampleRate).toFixed(2) : value;
		// Lag detection
		this.updateCounter++;
		if(this.updateCounter === 400) {
			this.updateCounter = 0;
			const time = Date.now();
			if(this.lastUpdateTime) {
				const lag =
					Math.min(Math.max(Math.round((time - this.lastUpdateTime) * 37.5 / 400) - 100, 0), 999);
				ui.controlLag.innerText = lag + '%';
				if(lag > 3) {
					if(!this.isLagging) {
						this.isLagging = true;
						ui.controlLag.classList.add('control-lag-red');
					}
				} else if(this.isLagging) {
					this.isLagging = false;
					ui.controlLag.classList.remove('control-lag-red');
				}
			}
			this.lastUpdateTime = time;
		}
	}
	setDrawMode(drawMode) {
		scope.drawMode = drawMode;
		this.setScopeAdjustment(0);
		scope.toggleTimeCursor();
		scope.clearCanvas();
		this.saveSettings();
		this.sendData({ drawMode });
	}
	setFFTBins(amount, buttonElem) {
		if(buttonElem?.getAttribute('disabled')) {
			return;
		}
		scope.setFFTSize(scope.fftSize + amount);
		scope.setFFTAnalyzer();
		scope.clearCanvas();
		this.saveSettings();
		ui.setControlScale(scope.fftSize >= 15, scope.fftSize <= 5,
			scope.fftSize < 10 ? 2 ** scope.fftSize : `<sub>2</sub>${ scope.fftSize }`);
	}
	setPlaybackMode(mode) {
		this.mode = mode;
		this.updateUrl();
		this.sendData({ mode, setFunction: editor.value });
	}
	setSampleRate(sampleRate, isSendData = true) {
		if(!sampleRate || !isFinite(sampleRate) ||
			// Float32 limit
			(sampleRate = Number(parseFloat(Math.abs(sampleRate)).toFixed(3))) > 3.4028234663852886E+38
		) {
			sampleRate = 8000;
		}
		sampleRate = Math.max(0.1, sampleRate);
		switch(sampleRate) {
		case 8000:
		case 11025:
		case 16000:
		case 22050:
		case 32000:
		case 44100:
		case 48000: ui.controlSampleRateSelect.value = sampleRate; break;
		default: ui.controlSampleRateSelect.selectedIndex = -1;
		}
		const oldSampleRate = this.sampleRate;
		ui.controlSampleRate.value = this.sampleRate = sampleRate;
		ui.controlSampleRate.blur();
		ui.controlSampleRateSelect.blur();
		scope.toggleTimeCursor();
		if(isSendData) {
			const data = {
				sampleRate: this.sampleRate,
				sampleRatio: this.sampleRate / this.audioCtx.sampleRate
			};
			if(this.mode === 'Funcbeat') {
				data.byteSample = Math.round(ui.controlTime.value * sampleRate /
					(this.settings.isSeconds ? 1 : oldSampleRate));
				this.setCounterValue(data.byteSample);
				this.setByteSample(data.byteSample);
			}
			this.updateUrl();
			this.sendData(data);
		}
	}
	setScale(amount, buttonElem) {
		if(buttonElem?.getAttribute('disabled')) {
			return;
		}
		scope.drawScale = Math.min(Math.max(scope.drawScale + amount, 0), 20);
		scope.toggleTimeCursor();
		scope.clearCanvas();
		this.saveSettings();
		ui.setControlScale(scope.drawScale <= 0, scope.drawScale >= 20,
			!scope.drawScale ? '1x' :
			scope.drawScale < 7 ? `1/${ 2 ** scope.drawScale }${ scope.drawScale < 4 ? 'x' : '' }` :
			`<sub>2</sub>-${ scope.drawScale }`);
	}
	setScopeAdjustment(amount, buttonElem) {
		if(scope.drawMode === 'FFT') {
			ui.controlScaleDown.title = 'Use more FFT bins';
			ui.controlScaleUp.title = 'Use less FFT bins';
			ui.controlScale.title = 'FFT bins. Click to reset to 1024';
			this.setFFTBins(-amount, buttonElem);
		} else {
			ui.controlScaleDown.title = 'Zoom in the scope';
			ui.controlScaleUp.title = 'Zoom out the scope';
			ui.controlScale.title = 'Scope zoom factor. Click to reset to 1.';
			this.setScale(amount, buttonElem);
		}
	}
	setSRDivisor(increment) {
		const value = (this.settings.srDivisor || 1) + increment;
		if(value === 0) {
			return;
		}
		ui.controlSRDivisor.textContent = this.settings.srDivisor = value;
		this.saveSettings();
		this.sendData({ srDivisor: value });
	}
	setThemeStyle(value) {
		if(value === undefined) {
			if((value = this.settings.themeStyle) === undefined) {
				value = this.settings.themeStyle = this.defaultSettings.themeStyle;
				this.saveSettings();
			}
			document.documentElement.dataset.theme = value;
			document.documentElement.dataset.themeType = value.endsWith('Light') ? 'light' : 'dark';
			return;
		}
		document.documentElement.dataset.theme = this.settings.themeStyle = value;
		document.documentElement.dataset.themeType = value.endsWith('Light') ? 'light' : 'dark';
		let colorCursor, colorDiagram;
		let colorStereo = 1; // Red=0, Green=1, Blue=2
		switch(value) {
		case 'Cake Dark':
			colorCursor = '#40ffff';
			colorDiagram = '#c000c0';
			colorStereo = 0;
			break;
		case 'Green Dark':
			colorCursor = '#00ffa8';
			colorDiagram = '#00a080';
			break;
		case 'Orange Dark':
			colorCursor = '#ffff80';
			colorDiagram = '#8000ff';
			colorStereo = 0;
			break;
		case 'Purple Dark':
			colorCursor = '#ff50ff';
			colorDiagram = '#a040ff';
			colorStereo = 0;
			break;
		case 'Teal Dark':
			colorCursor = '#80c0ff';
			colorDiagram = '#00a0c0';
			break;
		default: // Blue Dark, Dusk Dark, Default Dark, Default Light
			colorCursor = '#80c0ff';
			colorDiagram = '#0080ff';
		}
		this.setColorTimeCursor(colorCursor);
		this.setColorStereo(colorStereo);
		ui.controlColorWaveformInfo.innerHTML = scope.getColorTest('colorWaveform');
		this.setColorDiagram(ui.controlColorDiagram.value = colorDiagram); // Contains this.saveSettings();
	}
	setVolume(isInit) {
		let volumeValue = NaN;
		if(isInit) {
			volumeValue = parseFloat(this.settings.volume);
		}
		if(isNaN(volumeValue)) {
			volumeValue = ui.controlVolume.value / ui.controlVolume.max;
		}
		ui.controlVolume.value = this.settings.volume = volumeValue;
		ui.controlVolume.title = `Volume: ${ (volumeValue * 100).toFixed(2) }%`;
		this.saveSettings();
		this.audioGain.gain.value = volumeValue * volumeValue;
	}
	toggleCounterUnits() {
		this.settings.isSeconds = !this.settings.isSeconds;
		this.saveSettings();
		this.setCounterUnits();
	}
	toggleRecording() {
		if(!this.audioCtx) {
			return;
		}
		if(this.isRecording) {
			this.playbackToggle(false);
			return;
		}
		this.isRecording = true;
		ui.controlRecord.classList.add('control-recording');
		ui.controlRecord.title = 'Pause and stop recording';
		this.audioRecorder.start();
		this.audioRecordChunks = [];
		this.playbackToggle(true);
	}
	updateUrl() {
		const code = editor.value;
		ui.setCodeSize(code);
		getUrlFromCode(code, this.mode, this.sampleRate);
	}
}();
