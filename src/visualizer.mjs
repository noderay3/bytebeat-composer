// Butterchurn (Milkdrop) visualizer integration. Off by default — user
// toggles via the 👁 toolbar button. Lives on top of the oscilloscope
// canvas inside #canvas-container; when active, fades out the scope.
//
// Butterchurn is loaded as a UMD bundle via <script> in index.html and
// exposes window.butterchurn + window.butterchurnPresetsMinimal — no
// ES-module integration needed in our rollup pipeline.
//
// Audio source: the bytebeat AudioWorkletNode. We attach later (not in
// initElements) because the AudioContext is created lazily when the
// user first hits play. index.mjs calls attachAudio() after the worklet
// is wired up.
//
// Preset rotation: random preset per attach + manual 🎲 button. We do
// NOT auto-switch on track change — Butterchurn's loadPreset triggers a
// short blend, which is distracting if happening every few seconds.

const STORAGE_ENABLED = 'coderadio.viz.enabled';
const BLEND_TIME      = 2.7;	// seconds (Butterchurn's blend in default)

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
		this.rafId = 0;
		this._resizeObserver = null;
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
		try { this.enabled = localStorage.getItem(STORAGE_ENABLED) === '1'; }
		catch(_) {}
		this._syncToggleButton();
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

	nextPreset() {
		if(!this.viz || !this.presetNames || this.presetNames.length === 0) return;
		this.currentPresetIdx = (this.currentPresetIdx + 1) % this.presetNames.length;
		this.viz.loadPreset(this.presets[this.presetNames[this.currentPresetIdx]], BLEND_TIME);
	}

	randomPreset() {
		if(!this.viz || !this.presetNames || this.presetNames.length === 0) return;
		this.currentPresetIdx = Math.floor(Math.random() * this.presetNames.length);
		this.viz.loadPreset(this.presets[this.presetNames[this.currentPresetIdx]], BLEND_TIME);
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
			// Resize on container changes — Butterchurn's setRendererSize
			// rebuilds GL state, so debounce.
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
			console.log('[viz] loaded', this.presetNames.length, 'presets');
		}
		if(this.presetNames && this.presetNames.length > 0) {
			this.randomPreset();
		}
		this._loop();
		console.log('[viz] running');
	}

	_teardown() {
		cancelAnimationFrame(this.rafId);
		this.rafId = 0;
		if(this.canvas) this.canvas.classList.remove('is-active');
		// Don't destroy the viz — keep it warm so retoggle is instant. The
		// rAF loop bails on !this.enabled so it just stops rendering.
	}

	_loop() {
		if(!this.enabled || !this.viz) return;
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
}
