// Vibing-cat overlay. Off by default — user toggles via the 🐱 toolbar
// button. Bottom-right corner, transparent video (VP9-alpha for
// Chrome/FF/Edge, HEVC-alpha .mov for Safari), pointer-events:none so
// it never blocks the UI underneath.
//
// Audio-reactive scale pulse on bass kicks — same adaptive bass-band
// detector as the visualizer's auto-change but with its OWN analyser
// (the cat may run while the viz is off, so we don't depend on
// visualizer state). Updates a CSS custom property `--pulse` so the
// browser only repaints, no layout thrash.

const STORAGE_ENABLED = 'coderadio.cat.enabled';

const PULSE_PEAK       = 1.10;	// scale on a detected beat
const PULSE_DECAY      = 0.90;	// per-frame multiplicative pull-back to 1
const BEAT_THRESH_MULT = 1.4;
const BEAT_MIN_ENERGY  = 0.12;
const BEAT_MIN_GAP     = 200;	// ms
const BEAT_HISTORY_LEN = 50;	// ~0.83s @ 60fps

export class VibingCat {
	constructor() {
		this.video = null;
		this.button = null;
		this.enabled = false;
		this.audioContext = null;
		this.audioNode = null;
		this._analyser = null;
		this._buf = null;
		this._history = [];
		this._lastBeatTime = 0;
		this._pulse = 1;
		this._rafId = 0;
	}

	initElements() {
		this.video = document.getElementById('coderadio-cat');
		this.button = document.getElementById('control-cat');
		if(!this.video) {
			console.warn('[cat] #coderadio-cat missing');
			return;
		}
		try { this.enabled = localStorage.getItem(STORAGE_ENABLED) === '1'; }
		catch(_) {}
		this._sync();
		if(this.enabled) this._activate();
	}

	/// Same lazy-attach pattern as Visualizer — audio context comes up
	/// only after the user hits play, but the cat may have been enabled
	/// in a prior session.
	attachAudio(audioContext, audioNode) {
		this.audioContext = audioContext;
		this.audioNode = audioNode;
		if(this.enabled) this._initAnalyser();
	}

	toggle() {
		this.enabled = !this.enabled;
		console.log('[cat] toggle →', this.enabled ? 'ON' : 'OFF');
		try { localStorage.setItem(STORAGE_ENABLED, this.enabled ? '1' : '0'); }
		catch(_) {}
		this._sync();
		if(this.enabled) this._activate();
		else this._deactivate();
	}

	// --- internals ----------------------------------------------------

	_sync() {
		if(this.button) this.button.classList.toggle('is-active', this.enabled);
	}

	_activate() {
		if(!this.video) return;
		this.video.classList.add('is-active');
		// Browsers gate autoplay even for muted video until first user
		// gesture; the toggle click counts so this usually succeeds.
		this.video.play().catch(e => console.warn('[cat] video.play failed', e));
		if(this.audioContext && this.audioNode) this._initAnalyser();
		if(!this._rafId) this._loop();
	}

	_deactivate() {
		if(this.video) {
			this.video.classList.remove('is-active');
			this.video.pause();
			this.video.style.setProperty('--pulse', '1');
		}
		cancelAnimationFrame(this._rafId);
		this._rafId = 0;
		this._pulse = 1;
	}

	_initAnalyser() {
		if(this._analyser || !this.audioContext || !this.audioNode) return;
		const a = this.audioContext.createAnalyser();
		a.fftSize = 512;
		a.smoothingTimeConstant = 0.4;
		try { this.audioNode.connect(a); }
		catch(e) { console.warn('[cat] analyser connect failed', e); return; }
		this._analyser = a;
		this._buf = new Uint8Array(a.frequencyBinCount);
		this._history = [];
	}

	_loop() {
		if(!this.enabled) return;
		const now = performance.now();
		if(this._analyser) {
			this._analyser.getByteFrequencyData(this._buf);
			// Bass band: first 8 bins ≈ 0..690Hz @ 44.1kHz / fftSize 512
			let bassSum = 0;
			for(let i = 0; i < 8; i++) bassSum += this._buf[i];
			const bass = bassSum / (8 * 255);
			this._history.push(bass);
			if(this._history.length > BEAT_HISTORY_LEN) this._history.shift();
			let avg = 0;
			for(const v of this._history) avg += v;
			avg /= this._history.length;
			const isBeat = bass > avg * BEAT_THRESH_MULT
				&& bass > BEAT_MIN_ENERGY
				&& (now - this._lastBeatTime > BEAT_MIN_GAP);
			if(isBeat) {
				this._pulse = PULSE_PEAK;
				this._lastBeatTime = now;
			} else {
				// Exponential pull-back toward 1.0 so the cat doesn't snap.
				this._pulse = 1 + (this._pulse - 1) * PULSE_DECAY;
			}
		}
		if(this.video) this.video.style.setProperty('--pulse', this._pulse.toFixed(3));
		this._rafId = requestAnimationFrame(() => this._loop());
	}
}
