// Butterchurn (Milkdrop) visualizer integration. Off by default — user
// toggles via the 👁 toolbar button. Lives on top of the oscilloscope
// canvas inside #canvas-container; when active, fades out the scope.
//
// Butterchurn is loaded as a UMD bundle via <script> in index.html and
// exposes window.butterchurn + window.butterchurnPresetsMinimal — no
// ES-module integration needed in our rollup pipeline.
//
// On first viz enable we LAZY-LOAD the four bigger preset packs from
// /vendor/ (Presets, Extra, Extra2, NonMinimal — ~2.5MB total, ~2600
// extra presets). Initial page weight stays minimal-only; the bigger
// library shows up on the first 🎲 or auto-cycle after the lazy fetch
// resolves.
//
// Auto-change (toolbar 🔁): hard-cuts the preset on bass kicks, with a
// MAX_INTERVAL safety net so it never sits still on quiet sections.
// Beat detection is a separate AnalyserNode tap (we don't reach into
// butterchurn internals) — bass-band RMS vs adaptive rolling average.

const STORAGE_ENABLED  = 'coderadio.viz.enabled';
const STORAGE_AUTO     = 'coderadio.viz.autoChange';
const BLEND_TIME       = 2.7;	// seconds (Butterchurn's blend in default)

// Auto-change tuning. Beat-cut intervals are conservative to avoid
// strobing on busy mixes; the max-interval forces a swap during
// breakdowns / sparse sections so the viz never feels frozen.
const BEAT_MIN_INTERVAL = 6000;	// ms — min gap between hard-cuts
const BEAT_MAX_INTERVAL = 18000;	// ms — forced blend swap when no beat
const BEAT_THRESH_MULT  = 1.45;	// bass energy must exceed avg * this
const BEAT_MIN_ENERGY   = 0.14;	// 0..1 — silence guard, no kicks below
const BEAT_MIN_GAP      = 250;	// ms — debounce individual beats
const BEAT_HISTORY_LEN  = 60;	// ~1s @ 60fps rolling average

// Lazy preset packs to fetch on first viz enable. Order matters only
// for dedup-key collisions (later packs win — we merge into one dict).
const EXTRA_PACKS = [
	{ src: './vendor/butterchurnPresets.min.js',           global: 'butterchurnPresets' },
	{ src: './vendor/butterchurnPresetsExtra.min.js',      global: 'butterchurnPresetsExtra' },
	{ src: './vendor/butterchurnPresetsExtra2.min.js',     global: 'butterchurnPresetsExtra2' },
	{ src: './vendor/butterchurnPresetsNonMinimal.min.js', global: 'butterchurnPresetsNonMinimal' },
];

export class Visualizer {
	constructor() {
		this.viz = null;
		this.canvas = null;
		this.audioContext = null;
		this.audioNode = null;
		this.presets = null;
		this.presetNames = null;
		this.currentPresetIdx = 0;
		this.enabled = false;
		this.autoChangeEnabled = false;
		this.rafId = 0;
		this._resizeObserver = null;
		this._extraPacksLoading = false;
		this._extraPacksLoaded = false;
		this._beatAnalyser = null;
		this._beatBuf = null;
		this._beatHistory = [];
		this._lastBeatTime = 0;
		this._lastSwap = 0;
	}

	initElements() {
		this.canvas = document.getElementById('coderadio-viz-canvas');
		if(!this.canvas) {
			console.warn('[viz] canvas #coderadio-viz-canvas missing');
			return;
		}
		const bc = (globalThis.butterchurn && globalThis.butterchurn.default) || globalThis.butterchurn;
		const bcPresets = (globalThis.butterchurnPresetsMinimal && globalThis.butterchurnPresetsMinimal.default)
			|| globalThis.butterchurnPresetsMinimal;
		const hasLib     = !!(bc && typeof bc.createVisualizer === 'function');
		const hasPresets = !!(bcPresets && typeof bcPresets.getPresets === 'function');
		console.log(`[viz] init — butterchurn:${ hasLib ? 'OK' : 'MISSING' } presets:${ hasPresets ? 'OK' : 'MISSING' }`);
		try {
			this.enabled = localStorage.getItem(STORAGE_ENABLED) === '1';
			this.autoChangeEnabled = localStorage.getItem(STORAGE_AUTO) === '1';
		} catch(_) {}
		this._syncToggleButton();
		this._syncAutoChangeButton();
		if(this.enabled && this.audioContext) this._setup();
	}

	/// Called by index.mjs after AudioContext + AudioWorkletNode are
	/// created. Safe to call multiple times — only first attachment wires
	/// the visualizer. If we were enabled before audio came up, this is
	/// where we actually start rendering.
	attachAudio(audioContext, audioNode) {
		this.audioContext = audioContext;
		this.audioNode = audioNode;
		if(this.enabled) this._setup();
	}

	toggle() {
		this.enabled = !this.enabled;
		console.log('[viz] toggle →', this.enabled ? 'ON' : 'OFF',
			'(audioContext:', this.audioContext ? 'ready' : 'NOT YET', ')');
		try { localStorage.setItem(STORAGE_ENABLED, this.enabled ? '1' : '0'); }
		catch(_) {}
		this._syncToggleButton();
		if(this.enabled) this._setup();
		else this._teardown();
	}

	toggleAutoChange() {
		this.autoChangeEnabled = !this.autoChangeEnabled;
		console.log('[viz] auto-change →', this.autoChangeEnabled ? 'ON' : 'OFF');
		try { localStorage.setItem(STORAGE_AUTO, this.autoChangeEnabled ? '1' : '0'); }
		catch(_) {}
		this._syncAutoChangeButton();
		this._lastSwap = performance.now();	// reset timer so next swap waits a full interval
		if(this.autoChangeEnabled && this.audioContext && this.audioNode) this._initBeatDetect();
	}

	nextPreset() {
		if(!this.viz || !this.presetNames || this.presetNames.length === 0) return;
		this.currentPresetIdx = (this.currentPresetIdx + 1) % this.presetNames.length;
		this.viz.loadPreset(this.presets[this.presetNames[this.currentPresetIdx]], BLEND_TIME);
	}

	randomPreset(blend = BLEND_TIME) {
		if(!this.viz || !this.presetNames || this.presetNames.length === 0) return;
		this.currentPresetIdx = Math.floor(Math.random() * this.presetNames.length);
		this.viz.loadPreset(this.presets[this.presetNames[this.currentPresetIdx]], blend);
	}

	// --- internals ----------------------------------------------------

	_setup() {
		if(!this.canvas) { console.warn('[viz] _setup: no canvas'); return; }
		if(!this.audioContext) {
			console.warn('[viz] _setup: audioContext not ready yet — will retry on attachAudio');
			return;
		}
		// Butterchurn 2.x ships its UMD bundle as `{ default: <api> }` —
		// the createVisualizer function lives at `.default.createVisualizer`,
		// not at the top level. butterchurn-presets is shaped differently
		// (top-level getPresets). Resolve both safely.
		const bc = (globalThis.butterchurn && globalThis.butterchurn.default) || globalThis.butterchurn;
		const bcPresets = (globalThis.butterchurnPresetsMinimal && globalThis.butterchurnPresetsMinimal.default)
			|| globalThis.butterchurnPresetsMinimal;
		if(!bc || typeof bc.createVisualizer !== 'function') {
			console.error('[viz] butterchurn.createVisualizer not available', bc);
			return;
		}
		// CRITICAL: make the canvas visible BEFORE measuring its size. While
		// `display:none`, getBoundingClientRect returns 0×0 and Butterchurn
		// would init at 0×0 — WebGL state then gets wedged and the
		// ResizeObserver recovery is too late.
		this.canvas.classList.add('is-active');
		document.documentElement.classList.add('viz-active');
		if(!this.viz) {
			this._resizeCanvas();
			console.log('[viz] createVisualizer', this.canvas.width, '×', this.canvas.height);
			try {
				this.viz = bc.createVisualizer(this.audioContext, this.canvas, {
					width: this.canvas.width,
					height: this.canvas.height,
					pixelRatio: window.devicePixelRatio || 1,
				});
				this.viz.connectAudio(this.audioNode);
			} catch(e) {
				console.error('[viz] createVisualizer threw:', e);
				this.canvas.classList.remove('is-active');
				return;
			}
			let resizeTimer = 0;
			this._resizeObserver = new ResizeObserver(() => {
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					this._resizeCanvas();
					if(this.viz) this.viz.setRendererSize(this.canvas.width, this.canvas.height);
				}, 100);
			});
			this._resizeObserver.observe(this.canvas);
		}
		if(!this.presets && bcPresets && typeof bcPresets.getPresets === 'function') {
			this.presets = bcPresets.getPresets();
			this.presetNames = Object.keys(this.presets);
			console.log('[viz] loaded', this.presetNames.length, 'minimal presets');
		}
		if(this.presetNames && this.presetNames.length > 0) {
			this.randomPreset();
		}
		// Kick off the bigger preset packs once — they merge in when ready
		// and the next randomPreset draws from the full ~2700.
		this._lazyLoadExtraPacks();
		if(this.autoChangeEnabled) this._initBeatDetect();
		this._lastSwap = performance.now();
		this._loop();
		console.log('[viz] running');
	}

	_teardown() {
		cancelAnimationFrame(this.rafId);
		this.rafId = 0;
		if(this.canvas) this.canvas.classList.remove('is-active');
		document.documentElement.classList.remove('viz-active');
	}

	_loop() {
		if(!this.enabled || !this.viz) return;
		this._maybeAutoSwap();
		this.viz.render();
		this.rafId = requestAnimationFrame(() => this._loop());
	}

	_resizeCanvas() {
		if(!this.canvas) return;
		const dpr = window.devicePixelRatio || 1;
		const rect = this.canvas.getBoundingClientRect();
		const w = Math.max(1, Math.round(rect.width * dpr));
		const h = Math.max(1, Math.round(rect.height * dpr));
		this.canvas.width = w;
		this.canvas.height = h;
	}

	_syncToggleButton() {
		const el = document.getElementById('control-viz');
		if(el) el.classList.toggle('is-active', this.enabled);
	}

	_syncAutoChangeButton() {
		const el = document.getElementById('control-viz-auto');
		if(el) el.classList.toggle('is-active', this.autoChangeEnabled);
	}

	// --- lazy preset packs --------------------------------------------

	_lazyLoadExtraPacks() {
		if(this._extraPacksLoaded || this._extraPacksLoading) return;
		this._extraPacksLoading = true;
		const loadScript = (src) => new Promise((res, rej) => {
			const s = document.createElement('script');
			s.src = src;
			s.async = true;
			s.onload = () => res(src);
			s.onerror = () => rej(new Error('failed to load ' + src));
			document.head.appendChild(s);
		});
		(async () => {
			try {
				for(const { src } of EXTRA_PACKS) await loadScript(src);
				const merged = this.presets ? { ...this.presets } : {};
				for(const { global } of EXTRA_PACKS) {
					const pack = (globalThis[global] && globalThis[global].default) || globalThis[global];
					if(pack && typeof pack.getPresets === 'function') {
						Object.assign(merged, pack.getPresets());
					}
				}
				this.presets = merged;
				this.presetNames = Object.keys(merged);
				this._extraPacksLoaded = true;
				console.log('[viz] extra packs ready —', this.presetNames.length, 'presets total');
			} catch(e) {
				console.warn('[viz] extra preset pack load failed', e);
			} finally {
				this._extraPacksLoading = false;
			}
		})();
	}

	// --- beat detection / auto-change ---------------------------------

	_initBeatDetect() {
		if(this._beatAnalyser || !this.audioContext || !this.audioNode) return;
		const a = this.audioContext.createAnalyser();
		a.fftSize = 512;
		a.smoothingTimeConstant = 0.3;
		try { this.audioNode.connect(a); }
		catch(e) { console.warn('[viz] beat analyser connect failed', e); return; }
		this._beatAnalyser = a;
		this._beatBuf = new Uint8Array(a.frequencyBinCount);
		this._beatHistory = [];
		this._lastBeatTime = 0;
	}

	_pollBeat(now) {
		if(!this._beatAnalyser) return false;
		this._beatAnalyser.getByteFrequencyData(this._beatBuf);
		// Bass band: first 8 bins. At 44.1kHz w/ fftSize 512, each bin is
		// ~86Hz, so first 8 = 0..690Hz (kicks + sub).
		let bassSum = 0;
		for(let i = 0; i < 8; i++) bassSum += this._beatBuf[i];
		const bassNorm = bassSum / (8 * 255);
		this._beatHistory.push(bassNorm);
		if(this._beatHistory.length > BEAT_HISTORY_LEN) this._beatHistory.shift();
		let avg = 0;
		for(const v of this._beatHistory) avg += v;
		avg /= this._beatHistory.length;
		const isBeat = bassNorm > avg * BEAT_THRESH_MULT
			&& bassNorm > BEAT_MIN_ENERGY
			&& (now - this._lastBeatTime > BEAT_MIN_GAP);
		if(isBeat) this._lastBeatTime = now;
		return isBeat;
	}

	_maybeAutoSwap() {
		if(!this.autoChangeEnabled || !this.viz) return;
		const now = performance.now();
		const since = now - this._lastSwap;
		// Hard-cut on a beat after the minimum interval. Otherwise force a
		// soft blend swap once we hit the max so quiet sections don't
		// freeze the viz on one preset.
		const beat = this._pollBeat(now);
		if(beat && since > BEAT_MIN_INTERVAL) {
			this.randomPreset(0);	// hard cut
			this._lastSwap = now;
		} else if(since > BEAT_MAX_INTERVAL) {
			this.randomPreset(BLEND_TIME);
			this._lastSwap = now;
		}
	}
}
