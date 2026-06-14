// Scrollable bytebeat reference panel. Replaces the previous expression
// tree explorer (which is still on disk in explorer.mjs but no longer
// loaded). Lifecycle mirrors the explorer's so the existing panel
// chrome (#legend-panel + chevron handle + resizer) drives it the same
// way — index.mjs holds the instance and routes the toolbar click here.
//
// Content is static HTML built once at init. Inline SVG waveform previews
// are rendered by evaluating a small bytebeat-style expression for 256
// samples and tracing the path. Preview eval is MODE-AWARE so Floatbeat
// and Funcbeat examples render correctly instead of getting & 255'd into
// flatlines. "Try" buttons hand the example off to
// `globalThis.bytebeat.loadCode(...)`, which both swaps in the code and
// starts playback at the chosen mode/SR.
//
// Every example in this file is verified audible by
// scripts/audit-legend.mjs — that script imports buildLegendHtml(),
// regex-extracts every data-try, evaluates each formula through the
// matching mode's output path, and checks variance. CI-grade safety net.

export class Legend {
	constructor() {
		this.panel = null;
		this.body = null;
		this.resizer = null;
		this.isOpen = false;
		this._rendered = false;
	}

	initElements() {
		this.panel = document.getElementById('legend-panel');
		if(!this.panel) return;
		this.body = this.panel.querySelector('.legend-scroll');
		this.resizer = document.getElementById('legend-resizer');
		this.panel.addEventListener('click', e => this._onClick(e));
		if(this.resizer) {
			this.resizer.addEventListener('mousedown', e => this._startResize(e));
		}
		this.restoreWidth();
		this._renderContent();
	}

	toggle() {
		this.isOpen ? this.close() : this.open();
	}
	open() {
		if(!this.panel) return;
		this.isOpen = true;
		this.panel.classList.remove('is-collapsed');
		if(!this._rendered) {
			this._renderContent();
		}
	}
	close() {
		this.isOpen = false;
		if(this.panel) this.panel.classList.add('is-collapsed');
	}

	_renderContent() {
		if(!this.body) return;
		this.body.innerHTML = buildLegendHtml();
		this._rendered = true;
	}

	_onClick(e) {
		const tryBtn = e.target.closest('[data-try]');
		if(tryBtn) {
			e.preventDefault();
			const code = tryBtn.getAttribute('data-try');
			const mode = tryBtn.getAttribute('data-mode') || 'Bytebeat';
			const sampleRate = +tryBtn.getAttribute('data-sr') || 8000;
			try {
				globalThis.bytebeat.loadCode({ code, mode, sampleRate });
			} catch(err) {
				console.error('legend try-it failed:', err);
			}
			return;
		}
		const tocLink = e.target.closest('[data-toc]');
		if(tocLink) {
			e.preventDefault();
			const id = tocLink.getAttribute('data-toc');
			const target = this.body.querySelector('#' + id);
			if(target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}
		if(e.target.closest('#legend-handle')) {
			this.toggle();
		}
	}

	_startResize(e) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = this.panel.getBoundingClientRect().width;
		this.panel.classList.add('is-resizing');
		const onMove = ev => {
			const w = Math.max(360, Math.min(window.innerWidth - 60, startW - (ev.clientX - startX)));
			this.panel.style.width = w + 'px';
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			this.panel.classList.remove('is-resizing');
			try {
				localStorage.setItem('coderadio.legend.width',
					this.panel.getBoundingClientRect().width.toFixed(0));
			} catch(_) { /* private mode etc. */ }
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}

	restoreWidth() {
		try {
			const v = +localStorage.getItem('coderadio.legend.width');
			if(v >= 360 && v <= window.innerWidth - 60) {
				this.panel.style.width = v + 'px';
			}
		} catch(_) { /* ignore */ }
	}
}

// --- preview rendering ------------------------------------------------

// Mode-aware waveform preview. Bytebeat & Signed eval to ints and wrap
// mod-256; Floatbeat clamps to ±1 and centers; Funcbeat runs the setup
// body, captures the closure, and samples it over a short window of
// audio time so the preview shows oscillations not a flat line.
function waveSvg(formula, opts = {}) {
	const mode = opts.mode || 'Bytebeat';
	const w = opts.w || 240;
	const h = opts.h || 44;
	const samples = opts.samples || 240;
	if(mode === 'Funcbeat') {
		return previewFuncbeat(formula, w, h, samples, opts.sr || 8000);
	}
	// Bind every Math property as a local parameter (same convention the
	// worklet uses), so any Math fn in a formula resolves without prefix.
	const mathKeys = Object.getOwnPropertyNames(Math);
	const mathVals = mathKeys.map(k => Math[k]);
	const params = [...mathKeys, 'int', 'window', 't'];
	const allVals = [...mathVals, Math.floor, {}];
	let raw;
	try {
		raw = new Function(...params, `return (${ formula });`);
	} catch(_) {
		return errSvg(w, h, 'parse');
	}
	const tStep = opts.tStep || 1;
	const points = [];
	for(let i = 0; i < samples; i++) {
		const t = i * tStep;
		let v;
		try { v = raw(...allVals, t); }
		catch(_) { v = 0; }
		if(!Number.isFinite(v)) v = 0;
		let norm;	// 0 = top of box, 1 = bottom
		if(mode === 'Bytebeat') {
			v = (((v | 0) % 256) + 256) % 256;
			norm = 1 - (v / 255);
		} else if(mode === 'Signed Bytebeat') {
			v = (((v | 0) + 128 + 1024) % 256) - 128;
			norm = 1 - ((v + 128) / 255);
		} else if(mode === 'Floatbeat') {
			v = Math.max(-1, Math.min(1, v));
			norm = 1 - ((v + 1) / 2);
		} else {
			norm = 0.5;
		}
		const x = (i / (samples - 1)) * w;
		const y = norm * h;
		points.push(`${ x.toFixed(1) },${ y.toFixed(1) }`);
	}
	return `<svg viewBox="0 0 ${ w } ${ h }" class="legend-wave" preserveAspectRatio="none">`
		+ `<polyline points="${ points.join(' ') }" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

function previewFuncbeat(code, w, h, samples, sr) {
	// Mirror the worklet's setup so closures see Math fns as locals.
	const params = Object.getOwnPropertyNames(Math);
	const values = params.map(k => Math[k]);
	params.push('int', 'window', 'sampleRate');
	values.push(Math.floor, {}, sr);
	let setup;
	try { setup = new Function(...params, code); }
	catch(_) { return errSvg(w, h, 'parse'); }
	let f;
	try { f = setup(...values); }
	catch(_) { return errSvg(w, h, 'setup'); }
	if(typeof f !== 'function') return errSvg(w, h, 'no fn');
	const points = [];
	// Sample 20 ms — long enough to see oscillation at common notes.
	const dt = 0.02 / samples;
	for(let i = 0; i < samples; i++) {
		const t = i * dt;
		let v;
		try { v = f(t, sr); }
		catch(_) { v = 0; }
		if(typeof v !== 'number' || !Number.isFinite(v)) v = 0;
		v = Math.max(-1, Math.min(1, v));
		const x = (i / (samples - 1)) * w;
		const y = h - ((v + 1) / 2) * h;
		points.push(`${ x.toFixed(1) },${ y.toFixed(1) }`);
	}
	return `<svg viewBox="0 0 ${ w } ${ h }" class="legend-wave" preserveAspectRatio="none">`
		+ `<polyline points="${ points.join(' ') }" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

function errSvg(w, h, msg) {
	return `<svg viewBox="0 0 ${ w } ${ h }" class="legend-wave-err">`
		+ `<text x="6" y="${ h / 2 + 4 }" fill="currentColor" font-size="10">${ esc(msg) }</text></svg>`;
}

// --- helpers ----------------------------------------------------------

function truthTable(op) {
	const rows = [];
	for(const a of [0, 1]) {
		for(const b of [0, 1]) {
			let r;
			switch(op) {
				case '&': r = a & b; break;
				case '|': r = a | b; break;
				case '^': r = a ^ b; break;
				default:  r = 0;
			}
			rows.push(`<tr><td>${ a }</td><td>${ b }</td><td><strong>${ r }</strong></td></tr>`);
		}
	}
	return `<table class="legend-truth">`
		+ `<thead><tr><th>a</th><th>b</th><th>a ${ esc(op) } b</th></tr></thead>`
		+ `<tbody>${ rows.join('') }</tbody></table>`;
}

function tryBtn(code, mode, sr) {
	const attrs = [
		`data-try="${ escAttr(code) }"`,
		mode ? `data-mode="${ escAttr(mode) }"` : '',
		sr ? `data-sr="${ sr }"` : '',
	].filter(Boolean).join(' ');
	return `<button class="legend-try-btn" ${ attrs } title="Load and play in editor">Try</button>`;
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

// --- content ----------------------------------------------------------

export function buildLegendHtml() {
	return [
		tocBlock(),
		sectionIntro(),
		sectionT(),
		sectionTruncation(),
		sectionOperators(),
		sectionMathFns(),
		sectionVariables(),
		sectionIdioms(),
		sectionMelody(),
		sectionModes(),
		sectionSampleRate(),
		sectionGotchas(),
		sectionFamous(),
		sectionFurther(),
	].join('\n');
}

function tocBlock() {
	const items = [
		['s-intro',    'What is bytebeat?'],
		['s-t',        'The variable t'],
		['s-trunc',    '8-bit truncation'],
		['s-ops',      'Operators'],
		['s-math',     'Math functions'],
		['s-vars',     'Variables & comments'],
		['s-idioms',   'Idioms'],
		['s-melody',   'Building a melody'],
		['s-modes',    'Modes'],
		['s-sr',       'Sample rate'],
		['s-gotchas',  'Gotchas'],
		['s-famous',   'Famous one-liners'],
		['s-further',  'Learn more'],
	];
	return `
<nav class="legend-toc" aria-label="Table of contents">
	<div class="legend-toc-label">Jump to</div>
	<div class="legend-toc-links">
		${ items.map(([id, label]) => `<a href="#${ id }" data-toc="${ id }">${ esc(label) }</a>`).join('') }
	</div>
</nav>`;
}

function sectionIntro() {
	return `
<section class="legend-section legend-section-hero" id="s-intro">
	<h2>Bytebeat reference</h2>
	<p>One math expression in <code>t</code>, evaluated thousands of times per second. Each result is an audio sample. Bitwise ops produce rhythm and timbre; arithmetic shifts pitch and phase.</p>
	<p class="legend-tip">Hit <strong>Try</strong> on any example to load it into the editor and play it.</p>
	<p class="legend-note">Built from <em>The Tuesday Night Machines' Beginner's Guide</em> and <em>Ravary's RPN Guide</em> — both PDFs live in <code>docs/</code>. Cross-checked against the dollchan bytebeat-composer worklet.</p>
</section>`;
}

function sectionT() {
	return `
<section class="legend-section" id="s-t">
	<h2>The variable <code>t</code></h2>
	<p><code>t</code> is the <strong>sample counter</strong>. It starts at 0 when playback begins and grows by 1 every audio frame. At the default 8 kHz sample rate, <code>t</code> grows by 8000/sec.</p>
	<p>Bytebeat treats <code>t</code> as a 32-bit integer internally, but the <strong>output</strong> gets truncated to 8 bits — so the audible value wraps from 255 back to 0 every 256 samples. That's why a bare <code>t</code> sounds like a sawtooth wave at 31.25 Hz (8000 ÷ 256).</p>
	<div class="legend-wave-row">
		<div class="legend-wave-card">
			${ waveSvg('t') }
			<code class="legend-wave-formula">t</code>
			<div class="legend-wave-caption">sawtooth — wraps at 256</div>
			${ tryBtn('t') }
		</div>
		<div class="legend-wave-card">
			${ waveSvg('-t') }
			<code class="legend-wave-formula">-t</code>
			<div class="legend-wave-caption">descending sawtooth</div>
			${ tryBtn('-t') }
		</div>
		<div class="legend-wave-card">
			${ waveSvg('t * 4') }
			<code class="legend-wave-formula">t * 4</code>
			<div class="legend-wave-caption">2 octaves up</div>
			${ tryBtn('t * 4') }
		</div>
		<div class="legend-wave-card">
			${ waveSvg('t / 2', { tStep: 2 }) }
			<code class="legend-wave-formula">t / 2</code>
			<div class="legend-wave-caption">1 octave down</div>
			${ tryBtn('t / 2') }
		</div>
	</div>
	<p class="legend-note">At 8 kHz, <code>t</code> grows to 32-bit max (≈2.1 billion) after about 74 hours. Beyond that, behavior depends on the player — most wrap or restart.</p>
</section>`;
}

function sectionTruncation() {
	return `
<section class="legend-section" id="s-trunc">
	<h2>8-bit truncation</h2>
	<p>Bytebeat applies <code>&amp; 255</code> to every output automatically — values wrap mod 256. That's why:</p>
	<ul>
		<li><code>t + 200</code> sounds <strong>identical to <code>t</code></strong> — the constant offset disappears after wrap, leaving the same sawtooth shape (with a phase shift, not a level shift)</li>
		<li><code>t &amp; 130</code> sounds <strong>different</strong> from <code>t</code> — different bits survive masking</li>
		<li>Multiplying by big numbers <em>still works</em>, because the multiplied value gets re-wrapped sample-by-sample to a fresh saw at a higher rate</li>
	</ul>
	<pre class="legend-codeblock">t = 0    →  output 0
t = 50   →  output 50
t = 255  →  output 255
t = 256  →  output 0    ← wraps
t = 257  →  output 1
...
t = 350  →  output 94   (350 % 256)
t = 400  →  output 144</pre>
	<p class="legend-note">Modes change this map: Signed treats the byte as −128..+127; Floatbeat skips truncation entirely and clamps to a ±1 float; Funcbeat is the same as Floatbeat but with <code>t</code> in <em>seconds</em>.</p>
</section>`;
}

function sectionOperators() {
	return `
<section class="legend-section" id="s-ops">
	<h2>Operators</h2>

	<details open class="legend-group">
		<summary>Bitwise — the heart of bytebeat</summary>
		<p class="legend-note">Bitwise ops act as <em>audio mixers</em>: <code>|</code> is the most mixer-like (per the TTNM guide); <code>&amp;</code> works as a masker; <code>^</code> tends to distort. The exact behavior comes from the bit pattern of the constants on the right-hand side.</p>

		${ opCard('&', 'AND', "Bit is 1 only when both inputs are 1. Result is bounded by the smaller operand: t & 140 is always ≤ 140.", [
			['t & 128', 'top bit picks a half-amplitude square wave'],
			['t & (t >> 6)', 't masked by a slower copy — rising drone'],
			['t & t/20', 'rising sound — the dividing copy moves slower'],
			['(t >> 6) & 128', 'bit 7 of (t/64) — full-amplitude square, one octave below t'],
		]) }

		${ opCard('|', 'OR', "Bit is 1 when either input is 1. Result is bounded below by the larger operand: t | 140 is always ≥ 140. Most 'audio-mixer-like' of the three.", [
			['t | t/20', 'videogame tune — t mixed with slower t'],
			['t | t<<4', 'thicker upper partials'],
			['t | t>>2', 'self-mix one octave down'],
		]) }

		${ opCard('^', 'XOR', "Bit is 1 when inputs differ. No min/max bound; result can land anywhere — that's why XOR tends to chaos.", [
			['t ^ t/20', 'chaotic & distorted'],
			['t ^ t<<5', 'glitchy harmonics'],
		]) }

		${ opCard('<<', 'Left shift', "Multiply by 2^N — bits move up. Audibly: each shift is an octave up.", [
			['t << 1', 'octave up — same as t * 2'],
			['t << 2', '2 octaves up'],
		], { noTruth: true }) }

		${ opCard('>>', 'Right shift', "Divide by 2^N — bits move down. Each shift is an octave down. Bitshift is usually faster than division at the same effect.", [
			['t >> 1', 'octave down — same as t / 2'],
			['t * (t >> 5 | t >> 8)', 'bright modulated lead'],
		], { noTruth: true }) }

		${ opCard('~', 'NOT', "Invert all bits (unary). For 8-bit-truncated output, ~t is the vertical mirror of t.", [
			['~t & 255', 'mirror of t — descending saw'],
		], { noTruth: true }) }
	</details>

	<details class="legend-group">
		<summary>Arithmetic</summary>
		${ opCard('*', 'Multiply', "Multiplying t by a constant N speeds time up by N — higher pitch. Each *2 is an octave up.", [
			['t * 2', 'octave up'],
			['t * 5', 'higher pitch'],
			['t * (t >> 13)', 'slow pitch sweep'],
		], { noTruth: true }) }

		${ opCard('/', 'Divide', "Slows t down (integer division). Each /2 is an octave down. Below audio rate, becomes a slow LFO.", [
			['t / 2', 'octave down'],
			['t / 3', '~7 semitones down from /2'],
		], { noTruth: true }) }

		${ opCard('+', 'Add', "Adding a constant is a PHASE SHIFT, not a level shift — the 8-bit wrap eats the offset. Silent alone, but combine two phase-shifted copies and they beat against each other.", [
			['t % 128 + t % 64',          'two saws of different periods — phaser-like beat'],
			['(t % 64) + ((t + 32) % 64)', 'same saw, offset by 32 samples — beating'],
			['(t & 128) + (t >> 7 & 64)', 'two squares stacked, different bits'],
		], { noTruth: true }) }

		${ opCard('-', 'Subtract / negate', "Leading minus reverses (descending saw). Internal subtraction shifts amplitude — still subject to wrap.", [
			['-t', 'descending saw'],
			['t - (t >> 1)', 'half-amplitude ramp'],
		], { noTruth: true }) }

		${ opCard('%', 'Modulo', "Wraps the value into 0..N−1. Acts as a 'range squisher' that ALSO produces sub-sawtooths if N < 256.", [
			['t % 128', 'tiny saw at half amplitude'],
			['t % 64',  'even tinier saw, faster cycle'],
			['t * 5 % 200', 'pitched + range-limited'],
		], { noTruth: true }) }
	</details>

	<details class="legend-group">
		<summary>Comparison &amp; ternary</summary>
		<p class="legend-note">Return 1 if true, 0 if false. The trick is to <strong>multiply</strong> them into expressions — that gates parts of your code by time, since <code>0*x</code> is silence and <code>1*x</code> passes through.</p>

		${ opCard('>', 'Greater', "Time gate that switches on at a sample number.", [
			['(t > 16000) * (t >> 7)', '2 seconds of silence @ 8 kHz, then plays'],
		], { noTruth: true, noWave: true }) }

		${ opCard('<', 'Less', "Time gate that switches off at a sample number — intros.", [
			['(t < 16000) * (t * 4) | (t >= 16000) * (t / 4)', 'high-pitched intro then drop'],
		], { noTruth: true, noWave: true }) }

		${ opCard('?:', 'Ternary', "Inline if/else. Same effect as multiply-gating but more readable for two-branch choices.", [
			['t > 16000 ? t : t/2',          'pitch jumps up after 2 sec'],
			['(t & 8192) ? t * 4 : t * 2',   'octave alternates ~once a second'],
		], { noTruth: true, noWave: true }) }
	</details>
</section>`;
}

function opCard(op, name, desc, examples, opts = {}) {
	const truth = !opts.noTruth && ['&', '|', '^'].includes(op) ? truthTable(op) : '';
	const cards = examples.map(([formula, descr]) => `
		<div class="legend-wave-card">
			${ opts.noWave ? '' : waveSvg(formula) }
			<code class="legend-wave-formula">${ esc(formula) }</code>
			<div class="legend-wave-caption">${ esc(descr) }</div>
			${ tryBtn(formula) }
		</div>`).join('');
	return `
	<div class="legend-op-card">
		<div class="legend-op-head">
			<code class="legend-op-symbol">${ esc(op) }</code>
			<span class="legend-op-name">${ esc(name) }</span>
			<span class="legend-op-desc">${ esc(desc) }</span>
		</div>
		${ truth }
		<div class="legend-wave-row">${ cards }</div>
	</div>`;
}

function sectionMathFns() {
	const floats = [
		['sin(2 * PI * 440 * t / 8000)', 'pure 440 Hz sine @ 8 kHz SR', 'Floatbeat'],
		['sin(t * 0.05) * 0.7', 'slow vibrato-ish wobble', 'Floatbeat'],
		['sin(t * 0.1 + sin(t * 0.003) * 4) * 0.6', 'FM bell — sine modulating a sine', 'Floatbeat'],
		['tanh(sin(t / 50) * 6)', 'soft-clipped sine — harmonics from saturation', 'Floatbeat'],
	];
	const cards = floats.map(([code, descr, mode]) => `
		<div class="legend-wave-card">
			${ waveSvg(code, { mode }) }
			<code class="legend-wave-formula">${ esc(code) }</code>
			<div class="legend-wave-caption">${ esc(descr) } <span class="legend-mode-tag">${ esc(mode) }</span></div>
			${ tryBtn(code, mode) }
		</div>`).join('');
	return `
<section class="legend-section" id="s-math">
	<h2>Math functions</h2>
	<p>The worklet binds every <code>Math</code> property as a local variable — both <code>sin(x)</code> and <code>Math.sin(x)</code> work. Same goes for <code>cos</code>, <code>tan</code>, <code>sqrt</code>, <code>abs</code>, <code>pow</code>, <code>floor</code>, <code>min</code>, <code>max</code>, etc. Plus <code>int</code> is a shortcut for <code>Math.floor</code>.</p>
	<p>In <strong>Bytebeat mode</strong>, <code>sin</code> returns a float in −1..+1, which gets <code>| 0</code> truncated to 0 — silent on its own. Scale and offset to make it audible:</p>
	<pre class="legend-codeblock">(sin(t / 50) * 127 + 128) | 0    // sine, range 1..255
(sin(t / 50) + 1) * 127           // same thing, simpler</pre>
	<p>In <strong>Floatbeat mode</strong> the sine pipes straight to audio — no scaling needed:</p>
	<div class="legend-wave-grid">${ cards }</div>
</section>`;
}

function sectionVariables() {
	return `
<section class="legend-section" id="s-vars">
	<h2>Variables &amp; comments</h2>
	<p>Long bytebeats are easier to read &mdash; and tweak &mdash; with named constants. Use a comma-separated chain:</p>
	<pre class="legend-codeblock">a=10,   // dividing copy → rising sound
b=6,    // higher pitch sound
c=10,   // shift amount
d=64,   // amplitude controller
t * (((t/a) | t*b) >> c) % d</pre>
	<p>The commas separate assignments; the final expression is what the worklet evaluates per sample. Drop a <code>// comment</code> after each line to remember what each knob controls.</p>
	<p>Multi-line code works too &mdash; the parser doesn't care about line breaks. Lines that <em>continue</em> an expression should start with the joining operator so the intent is obvious at a glance:</p>
	<pre class="legend-codeblock">t * 30                  // super high-pitched sawtooth
&amp; (t%3000 &lt; 1500) * t/10  // rhythmic gate
| -t &gt;&gt; 3 * t/100         // distorted underlayer</pre>
	<div class="legend-wave-row">
		<div class="legend-wave-card legend-wave-card-wide">
			${ waveSvg('a=10, b=6, c=10, d=64, t * (((t/a) | t*b) >> c) % d', { tStep: 2 }) }
			<code class="legend-wave-formula">a=10, b=6, c=10, d=64, t * (((t/a) | t*b) >> c) % d</code>
			<div class="legend-wave-caption">named-knob bytebeat from Ravary's "Fever Dream"</div>
			${ tryBtn('a=10, b=6, c=10, d=64, t * (((t/a) | t*b) >> c) % d') }
		</div>
	</div>
</section>`;
}

function sectionIdioms() {
	const items = [
		['Half-time time gate', '(t > 16000) * (t * 4)', '2 seconds silence then high-pitched saw — relational gating'],
		['Full-amplitude square', '((t >> 6) & 1) * 255', 'Pick one bit of t, scale to 0/255 — clean square'],
		['Bit-shift melody', 't * (5 + (t >> 13) % 4)', 'Multiplier toggles every ~1 sec → pitch changes'],
		['Phase-mix phaser', 't % 255 + t % 64', 'Two saws of different periods → beating sweep'],
		['Sierpinski drone', 't & t >> 8', 'Self-similar fractal — bare 5 chars'],
		['Bell-ish', '((t >> 10) & 42) * t', 'Wide-spectrum bell tone, slow envelope from the shifted mask'],
		['PWM square', '(t % 100 >= 50) * 255', '50% pulse-width — louder than t & 128'],
		['Sweeping PWM', '(t % 100 >= t/200 % 100) * 255', 'Pulse-width modulated by a slower counter'],
		['Triangle wave', '((t % 512 >= 256) * t | (t % 512 < 256) * (-t-1)) & 255', 't and -t toggling every 256 samples'],
		['Wave-folded triangle', '(((t*4 % 512 >= 256) * t*4 | (t*4 % 512 < 256) * (-t*4-1)) + t/60) & 255', 'Triangle slowly drifting up → wave-fold harmonics'],
	];
	const cards = items.map(([name, code, descr]) => `
		<div class="legend-wave-card legend-wave-card-wide">
			${ waveSvg(code, { tStep: 2 }) }
			<div class="legend-idiom-name">${ esc(name) }</div>
			<code class="legend-wave-formula">${ esc(code) }</code>
			<div class="legend-wave-caption">${ esc(descr) }</div>
			${ tryBtn(code) }
		</div>`).join('');
	return `
<section class="legend-section" id="s-idioms">
	<h2>Idioms &mdash; recipes</h2>
	<p>Concrete patterns you can drop into the editor and ride. Pick one and start mutating numbers.</p>
	<div class="legend-wave-grid">${ cards }</div>
</section>`;
}

function sectionMelody() {
	const code1 = '(t % 4000 >= 0) * (t * 3) | (t % 4000 >= 1000) * (t * 5) | (t % 4000 >= 2000) * (t * 8) | (t % 4000 >= 3000) * (t * 4)';
	const code2 = '((t % 4000 >= 0) * (t * 3) | (t % 4000 >= 1000) * (t * 5) | (t % 4000 >= 2000) * (t * 8) | (t % 4000 >= 3000) * (t * 4)) & 128';
	return `
<section class="legend-section" id="s-melody">
	<h2>Building a melody</h2>
	<p>The TTNM guide builds a step sequencer out of three pieces: a <strong>looping counter</strong>, <strong>relational gates</strong>, and a <strong>pitch multiplier</strong> per step. Here's the compressed 4-step version.</p>
	<ol class="legend-build-steps">
		<li><strong>Counter:</strong> <code>t % 4000</code> cycles 0→3999 (0.5 sec per cycle at 8 kHz)</li>
		<li><strong>Step gate:</strong> <code>(t % 4000 &gt;= 1000 &amp; t % 4000 &lt; 2000)</code> is true only during step 2</li>
		<li><strong>Pitch:</strong> multiply <code>t</code> by a different number per step → different note</li>
		<li><strong>Chain with <code>|</code>:</strong> only one gate is active at a time, so OR-ing them passes through the active one</li>
	</ol>
	<div class="legend-wave-card legend-wave-card-wide">
		${ waveSvg(code1, { tStep: 4 }) }
		<code class="legend-wave-formula">${ esc(code1) }</code>
		<div class="legend-wave-caption">4-step melody, sawtooth tones</div>
		${ tryBtn(code1) }
	</div>
	<div class="legend-wave-card legend-wave-card-wide">
		${ waveSvg(code2, { tStep: 4 }) }
		<code class="legend-wave-formula">${ esc(code2) }</code>
		<div class="legend-wave-caption">same melody, AND-128 turns each note into a square wave</div>
		${ tryBtn(code2) }
	</div>
	<p class="legend-note">The full 16-step build is in the TTNM PDF (p. 20–22). Same principle, longer chain.</p>
</section>`;
}

function sectionModes() {
	const modes = [
		{
			name: 'Bytebeat', mode: 'Bytebeat',
			range: '0..255 (wraps)',
			desc: "Unsigned 8-bit. The classic mode from viznut's 2011 article. Bitwise tricks shine; arithmetic offsets are eaten by the wrap.",
			example: 't * (t >> 5 | t >> 8)',
		},
		{
			name: 'Signed Bytebeat', mode: 'Signed Bytebeat',
			range: '−128..+127 (wraps)',
			desc: "Signed 8-bit. Silence is 0 instead of 128 &mdash; needed for tracks written for C <code>signed char</code> output (viznut's \"Longline Theory\").",
			example: '(t * 9 & t >> 4 | t * 5 & t >> 7) - 128',
		},
		{
			name: 'Floatbeat', mode: 'Floatbeat',
			range: 'clamped −1..+1',
			desc: "Float, no quantization. <code>sin</code>, <code>cos</code>, IIR filters, FM with arbitrary indices &mdash; all the DSP that 8-bit bytebeat fights against.",
			example: 'sin(t / 50) * 0.7',
		},
		{
			name: 'Funcbeat', mode: 'Funcbeat',
			range: 'clamped −1..+1',
			desc: "Code body returns a function <code>f(t, sr)</code>. <code>t</code> is in <strong>seconds</strong>, not samples. State via closures; arrays, loops, helpers all welcome.",
			example: 'return t => sin(2 * Math.PI * 440 * t)',
		},
	];
	const cards = modes.map(m => `
		<div class="legend-mode-card">
			<div class="legend-mode-head">
				<h3>${ esc(m.name) }</h3>
				<span class="legend-mode-range">${ m.range }</span>
			</div>
			<p>${ m.desc }</p>
			${ waveSvg(m.example, { mode: m.mode }) }
			<pre class="legend-codeblock"><code>${ esc(m.example) }</code></pre>
			${ tryBtn(m.example, m.mode) }
		</div>`).join('');
	return `
<section class="legend-section" id="s-modes">
	<h2>Modes</h2>
	<p>Select via the mode dropdown in the toolbar. The same <code>t</code>-expression sounds different in each, because the output mapping changes.</p>
	<div class="legend-mode-grid">${ cards }</div>
	<details class="legend-conv">
		<summary>Converting between modes</summary>
		<ul>
			<li>Bytebeat → Signed: subtract 128 from the final expression</li>
			<li>Bytebeat → Floatbeat: <code>(expr &amp; 255) / 128 - 1</code></li>
			<li>Signed → Floatbeat: <code>expr / 128</code></li>
			<li>Floatbeat → Funcbeat: replace samples <code>t</code> with seconds <code>t * sampleRate</code> (or rewrite in Hz)</li>
		</ul>
	</details>
	<p class="legend-note legend-note-aside">Bitbeat (1-bit output) exists in the Chasyxx/EnBeat fork but isn't supported here.</p>
</section>`;
}

function sectionSampleRate() {
	return `
<section class="legend-section" id="s-sr">
	<h2>Sample rate</h2>
	<p>Default is 8 kHz. A bare <code>t</code> sawtooth cycles at 31.25 Hz there. Doubling the SR doubles the pitch of everything without touching the formula.</p>
	<table class="legend-sr-table">
		<thead><tr><th>SR</th><th>1 second</th><th>1 beat @ 120 BPM</th></tr></thead>
		<tbody>
			<tr><td>8000</td><td>8,000 samples</td><td>4,000 samples</td></tr>
			<tr><td>11025</td><td>11,025</td><td>5,512</td></tr>
			<tr><td>22050</td><td>22,050</td><td>11,025</td></tr>
			<tr><td>32000</td><td>32,000</td><td>16,000</td></tr>
			<tr><td>44100</td><td>44,100</td><td>22,050</td></tr>
		</tbody>
	</table>
	<p class="legend-note">In <strong>Funcbeat</strong>, <code>t</code> is already in seconds, so the SR only changes the resolution at which the function is sampled. Pitch is set explicitly via Hz (e.g. <code>sin(2 * PI * 440 * t)</code>).</p>
</section>`;
}

function sectionGotchas() {
	return `
<section class="legend-section" id="s-gotchas">
	<h2>Gotchas</h2>
	<ul class="legend-gotcha-list">
		<li><strong>Operator precedence:</strong> <code>t &gt;&gt; 10 * t</code> parses as <code>t &gt;&gt; (10 * t)</code> &mdash; the bitshift binds <em>looser</em> than the multiply. Use parens: <code>(t &gt;&gt; 10) * t</code>.</li>
		<li><strong>AND can't exceed its smallest operand</strong> &mdash; <code>t &amp; 140</code> is always ≤ 140. <strong>OR can't go below it</strong> &mdash; <code>t | 140</code> is always ≥ 140. <strong>XOR has no bound</strong>.</li>
		<li><strong>Division ordering matters:</strong> <code>t / 2</code> ≠ <code>2 / t</code>.</li>
		<li><strong>Adding/subtracting a constant is silent on its own</strong> &mdash; the 8-bit wrap eats the offset. Becomes audible only when combined with phase-shifted copies.</li>
		<li><strong>Triangle phase collision:</strong> when toggling <code>t</code> and <code>-t</code>, both equal 0 at the seam, so the wave dips to 0 once per cycle. Use <code>(-t - 1)</code> instead of <code>-t</code> to offset by one sample.</li>
		<li><strong>Left-shift dead zones:</strong> in Bytebeat mode, <code>t &lt;&lt; 8</code> through <code>t &lt;&lt; 31</code> are silent &mdash; the meaningful bits get shifted past the 8-bit window. Stick to small shifts.</li>
		<li><strong>Numbers masked beyond 8 bits go silent:</strong> <code>t &amp; 8192</code> is silent in Bytebeat mode because 8192 has only its bit 13 set, and bit 13 truncates to 0 after <code>&amp; 255</code>. To use a high bit as a rhythmic gate, multiply: <code>(t &amp; 8192) ? x : 0</code>, not <code>t &amp; 8192</code> alone.</li>
		<li><strong>Math functions in Bytebeat:</strong> <code>sin(x)</code> returns −1..+1, which truncates to 0 in Bytebeat mode. Scale: <code>(sin(x) + 1) * 127 | 0</code>.</li>
		<li><strong>Single-sample events (<code>==</code>) are inaudible:</strong> <code>(t == 16000) * x</code> fires for one sample &mdash; below the ear's threshold. Use <code>(t % 1000 &lt; 100)</code> or a <code>&gt;</code>/<code>&lt;</code> gate for audible event windows.</li>
		<li><strong>Comma chains for variables:</strong> <code>a=10, b=6, t * (t &gt;&gt; a) | t * b</code> &mdash; the comma separates assignments from the final expression.</li>
		<li><strong><code>Math.</code> is optional but defensive:</strong> the worklet binds bare <code>sin</code>, <code>cos</code>, etc. &mdash; but writing <code>Math.sin</code> still works and doesn't break.</li>
	</ul>
</section>`;
}

function sectionFamous() {
	const items = [
		['viznut "Crowd"',     't*(((t>>12)|(t>>8)) & (63 & (t>>4)))',                    'The most-shared bytebeat one-liner. Originally 2011.', 'Bytebeat'],
		['viznut "Lullaby"',   '(t*5 & t>>7) | (t*3 & t>>10)',                            'Twinkly broken music-box.', 'Bytebeat'],
		['Sierpinski Harmony', 't & t>>8',                                                'Self-similar fractal — the shortest interesting bytebeat.', 'Bytebeat'],
		['"Fever Dream"',      'a=10, b=6, c=10, d=64, t * (((t/a) | t*b) >> c) % d',     'Ravary, 2021 — featured one-liner from the RPN guide.', 'Bytebeat'],
		['Bright lead',        't * (t >> 5 | t >> 8)',                                   'Wide-spectrum modulated lead.', 'Bytebeat'],
		['Floatbeat sine FM',  'sin(t * 0.1 + sin(t * 0.003) * 4) * 0.6',                 'A sine modulating another sine — classic FM bell.', 'Floatbeat'],
	];
	const cards = items.map(([name, code, descr, mode]) => `
		<div class="legend-wave-card legend-wave-card-wide">
			${ waveSvg(code, { mode, tStep: mode === 'Bytebeat' ? 2 : 1 }) }
			<div class="legend-idiom-name">${ esc(name) } <span class="legend-mode-tag">${ esc(mode) }</span></div>
			<code class="legend-wave-formula">${ esc(code) }</code>
			<div class="legend-wave-caption">${ esc(descr) }</div>
			${ tryBtn(code, mode) }
		</div>`).join('');
	return `
<section class="legend-section" id="s-famous">
	<h2>Famous one-liners</h2>
	<p>Curated for shock value. Try each, then read the formula — the surprise is that this much music falls out of so few characters.</p>
	<div class="legend-wave-grid">${ cards }</div>
</section>`;
}

function sectionFurther() {
	return `
<section class="legend-section" id="s-further">
	<h2>Where to learn more</h2>
	<ul>
		<li>viznut's original article (2011): <em>Algorithmic symphonies from one line of code &mdash; how and why?</em></li>
		<li>Greggman's html5bytebeat &mdash; most-used hosted player; README documents all modes</li>
		<li>The two PDFs in <code>docs/</code>: TTNM's beginner guide and Ravary's RPN guide</li>
		<li>r/bytebeat on Reddit &mdash; share what you make</li>
		<li>EnBeat (Chasyxx) &mdash; expanded fork with more exotic modes (Bitbeat, LogMode, etc.)</li>
	</ul>
</section>`;
}
