// Vibing-cat overlay — beat-reactive 264-frame sprite-sheet animation.
//
// Renders into a <canvas> inside #editor-container, layered above the
// Butterchurn viz canvas (z-index -1) but underneath the CodeMirror code
// text. The cat is bonafide cat-jam — bobs left/right on detected beats,
// uses one of Ray's projectM iOS dance engines + beat detectors.
//
// Pipeline per rAF:
//   AnalyserNode → detector.update() → engine.tick() → engine.displayedFrame
//   → drawImage from sprite atlas at (frame % 12, frame / 12) cell.
//
// Toolbar UX:
//   click 🐱 → toggle cat on/off
//   long-press 🐱 (while on) → cycle through 6 detector × engine combos
//     ("Hybrid + Expressive v3" → "Hybrid + Groove v2" → ... → back)
//   short toast top-center shows the active combo on each cycle.

import { BeatDetector } from './dance/beat-detector.mjs';
import { HybridDetector } from './dance/hybrid-detector.mjs';
import { DanceEngineV1 } from './dance/engine-v1.mjs';
import { DanceEngineV2 } from './dance/engine-v2.mjs';
import { DanceEngineV3 } from './dance/engine-v3.mjs';

const STORAGE_ENABLED = 'coderadio.cat.enabled';
const STORAGE_COMBO   = 'coderadio.cat.combo';
const LONG_PRESS_MS   = 550;
const TOAST_DURATION  = 1900;

// Sprite atlas constants — match CatMeta.swift / vibing_cat.json exactly.
const FRAME_COUNT = 264;
const FRAME_W     = 400;
const FRAME_H     = 360;
const COLS        = 12;
const SPRITE_URL  = './vendor/cat-sprite.webp';

// Detector + engine combinations, in cycle order. Long-press advances
// the index; click toggles on/off without affecting combo position.
const COMBOS = [
	{ name: 'Hybrid · Expressive v3', det: 'hybrid',   eng: 'v3' },
	{ name: 'Hybrid · Groove v2',     det: 'hybrid',   eng: 'v2' },
	{ name: 'Hybrid · Classic v1',    det: 'hybrid',   eng: 'v1' },
	{ name: 'Spectral · Expressive v3', det: 'spectral', eng: 'v3' },
	{ name: 'Spectral · Groove v2',   det: 'spectral', eng: 'v2' },
	{ name: 'Spectral · Classic v1',  det: 'spectral', eng: 'v1' },
];

export class VibingCat {
	constructor() {
		this.canvas = null;
		this.ctx = null;
		this.button = null;
		this.toast = null;
		this.enabled = false;
		this.comboIdx = 0;

		this.audioContext = null;
		this.audioNode = null;
		this._analyser = null;

		// Detectors and engines created lazily once audio is up.
		this._spectralDet = null;
		this._hybridDet = null;
		this._engV1 = null;
		this._engV2 = null;
		this._engV3 = null;

		this._sprite = new Image();
		this._spriteReady = false;
		this._sprite.onload = () => { this._spriteReady = true; };
		this._sprite.onerror = (e) => console.warn('[cat] sprite load failed', e);
		// Loading the sprite is delayed until first toggle-on to avoid
		// burning 1MB on visitors who never enable the cat.

		this._rafId = 0;
		this._lastTick = 0;

		// Long-press state
		this._pressTimer = 0;
		this._longPressFired = false;

		// Toast state
		this._toastTimer = 0;
	}

	initElements() {
		this.canvas = document.getElementById('coderadio-cat');
		this.button = document.getElementById('control-cat');
		this.toast = document.getElementById('coderadio-cat-toast');
		if(!this.canvas) {
			console.warn('[cat] #coderadio-cat canvas missing');
			return;
		}
		this.ctx = this.canvas.getContext('2d');
		try {
			this.enabled = localStorage.getItem(STORAGE_ENABLED) === '1';
			const stored = parseInt(localStorage.getItem(STORAGE_COMBO) || '0', 10);
			if(Number.isFinite(stored) && stored >= 0 && stored < COMBOS.length) {
				this.comboIdx = stored;
			}
		} catch(_) {}
		this._wireLongPress();
		this._sync();
		if(this.enabled) this._activate();
	}

	attachAudio(audioContext, audioNode) {
		this.audioContext = audioContext;
		this.audioNode = audioNode;
		if(this.enabled) this._initDanceSystem();
	}

	toggle() {
		// If a long-press just fired, suppress this toggle — the press was
		// the cycle action, not an on/off click.
		if(this._longPressFired) {
			this._longPressFired = false;
			return;
		}
		this.enabled = !this.enabled;
		console.log('[cat] toggle →', this.enabled ? 'ON' : 'OFF');
		try { localStorage.setItem(STORAGE_ENABLED, this.enabled ? '1' : '0'); }
		catch(_) {}
		this._sync();
		if(this.enabled) this._activate();
		else this._deactivate();
	}

	cycleCombo() {
		this.comboIdx = (this.comboIdx + 1) % COMBOS.length;
		try { localStorage.setItem(STORAGE_COMBO, String(this.comboIdx)); }
		catch(_) {}
		const combo = COMBOS[this.comboIdx];
		console.log('[cat] combo →', combo.name);
		this._showToast(combo.name);
	}

	// --- internals ----------------------------------------------------

	_sync() {
		if(this.button) this.button.classList.toggle('is-active', this.enabled);
		document.documentElement.classList.toggle('cat-active', this.enabled);
		if(this.canvas) this.canvas.classList.toggle('is-active', this.enabled);
	}

	_activate() {
		if(!this._spriteReady && !this._sprite.src) this._sprite.src = SPRITE_URL;
		if(this.audioContext && this.audioNode) this._initDanceSystem();
		if(!this._rafId) {
			this._lastTick = performance.now() / 1000;
			this._loop();
		}
	}

	_deactivate() {
		cancelAnimationFrame(this._rafId);
		this._rafId = 0;
		if(this.ctx && this.canvas.width > 0) {
			this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		}
	}

	_initDanceSystem() {
		if(this._analyser) return;
		const a = this.audioContext.createAnalyser();
		a.fftSize = 1024;
		// smoothingTimeConstant 0 — detectors do their own smoothing and
		// need raw per-frame magnitudes.
		a.smoothingTimeConstant = 0;
		try { this.audioNode.connect(a); }
		catch(e) { console.warn('[cat] analyser connect failed', e); return; }
		this._analyser = a;
		const sr = this.audioContext.sampleRate;
		this._spectralDet = new BeatDetector(sr);
		this._hybridDet = new HybridDetector(sr);
		this._engV1 = new DanceEngineV1();
		this._engV2 = new DanceEngineV2();
		this._engV3 = new DanceEngineV3();
	}

	_currentDetector() {
		return COMBOS[this.comboIdx].det === 'hybrid' ? this._hybridDet : this._spectralDet;
	}

	_currentEngine() {
		const e = COMBOS[this.comboIdx].eng;
		return e === 'v3' ? this._engV3 : e === 'v2' ? this._engV2 : this._engV1;
	}

	_loop() {
		if(!this.enabled) return;
		this._rafId = requestAnimationFrame(() => this._loop());

		if(!this._spriteReady) return;	// wait for atlas

		const now = performance.now() / 1000;
		const rawDt = now - this._lastTick;
		this._lastTick = now;
		// Clamp dt — long stalls (tab backgrounded) shouldn't flush engine
		// state with huge phase advances.
		const dt = Math.max(0.001, Math.min(0.05, rawDt));

		if(this._analyser && this._spectralDet) {
			const det = this._currentDetector();
			const eng = this._currentEngine();
			det.update(this._analyser, dt, now);
			eng.tick(dt, det, now);
			this._drawFrame(eng.displayedFrame | 0, eng.currentScale || 1);
		} else if(this._spriteReady) {
			// No audio yet — show frame 0 (rest pose).
			this._drawFrame(0, 1);
		}
	}

	_drawFrame(frameIdx, scale) {
		if(!this.ctx) return;
		const idx = ((frameIdx % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
		const col = idx % COLS;
		const row = (idx / COLS) | 0;

		// Resize backing store on layout change.
		const rect = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const cw = Math.max(1, Math.round(rect.width * dpr));
		const ch = Math.max(1, Math.round(rect.height * dpr));
		if(this.canvas.width !== cw || this.canvas.height !== ch) {
			this.canvas.width = cw;
			this.canvas.height = ch;
		}

		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		// Fit the cat into the canvas preserving aspect ratio. Scale lets
		// V3's spring-overshoot pump the size on strong beats.
		const catAR = FRAME_W / FRAME_H;
		const canvAR = this.canvas.width / this.canvas.height;
		let dw, dh;
		if(canvAR > catAR) {
			dh = this.canvas.height * scale;
			dw = dh * catAR;
		} else {
			dw = this.canvas.width * scale;
			dh = dw / catAR;
		}
		const dx = (this.canvas.width - dw) / 2;
		const dy = (this.canvas.height - dh) / 2;
		this.ctx.drawImage(
			this._sprite,
			col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H,
			dx, dy, dw, dh
		);
	}

	// --- long-press detection -----------------------------------------

	_wireLongPress() {
		if(!this.button) return;
		const start = (e) => {
			if(!this.enabled) return;	// only cycle when cat is ON
			clearTimeout(this._pressTimer);
			this._longPressFired = false;
			this._pressTimer = setTimeout(() => {
				this.cycleCombo();
				this._longPressFired = true;
			}, LONG_PRESS_MS);
		};
		const cancel = () => clearTimeout(this._pressTimer);
		this.button.addEventListener('mousedown', start);
		this.button.addEventListener('touchstart', start, { passive: true });
		this.button.addEventListener('mouseup', cancel);
		this.button.addEventListener('mouseleave', cancel);
		this.button.addEventListener('touchend', cancel);
		this.button.addEventListener('touchcancel', cancel);
	}

	// --- toast --------------------------------------------------------

	_showToast(text) {
		if(!this.toast) return;
		this.toast.textContent = text;
		this.toast.classList.add('is-visible');
		clearTimeout(this._toastTimer);
		this._toastTimer = setTimeout(() => {
			this.toast.classList.remove('is-visible');
		}, TOAST_DURATION);
	}
}
