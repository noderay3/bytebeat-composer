// Scrollable bytebeat reference panel. Replaces the previous expression
// tree explorer (which is still on disk in explorer.mjs but no longer
// loaded). Lifecycle mirrors the explorer's so the existing panel
// chrome (#legend-panel + chevron handle + resizer) drives it the same
// way — index.mjs holds the instance and routes the toolbar click here.
//
// Content is static HTML built once at init. Inline SVG waveform previews
// are rendered by evaluating a small bytebeat-style expression for 256
// samples and tracing the path. "Try" buttons hand the example off to
// `globalThis.bytebeat.loadCode(...)`, which both swaps in the code and
// starts playback at the chosen mode/SR.

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
			// Pointer moves left → panel grows wider (panel pinned to right edge).
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

// --- helpers -----------------------------------------------------------

// Evaluate a bytebeat formula for `samples` values of t and emit an SVG
// polyline mapped into a w×h box. Result is the inline SVG string. Used
// for every operator example and idiom card so users SEE what each
// formula produces before they hit Try.
function waveSvg(formula, opts = {}) {
	const w = opts.w || 240;
	const h = opts.h || 44;
	const samples = opts.samples || 240;
	const tStart = opts.tStart || 0;
	const tStep = opts.tStep || 1;
	let f;
	try {
		f = new Function('t', 'sin', 'cos', 'tan', 'PI', 'abs', 'sqrt',
			`return (${ formula });`);
	} catch(_) {
		return errSvg(w, h, 'parse');
	}
	const M = Math;
	const points = [];
	for(let i = 0; i < samples; i++) {
		const t = tStart + i * tStep;
		let v;
		try { v = f(t, M.sin, M.cos, M.tan, M.PI, M.abs, M.sqrt); }
		catch(_) { v = 0; }
		if(!Number.isFinite(v)) v = 0;
		// 8-bit wrap to match Bytebeat output. Float values inside the
		// expression are floored then masked, same as the worklet.
		v = (((v | 0) % 256) + 256) % 256;
		const x = (i / (samples - 1)) * w;
		const y = h - (v / 255) * h;
		points.push(`${ x.toFixed(1) },${ y.toFixed(1) }`);
	}
	return `<svg viewBox="0 0 ${ w } ${ h }" class="legend-wave" preserveAspectRatio="none">`
		+ `<polyline points="${ points.join(' ') }" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

function errSvg(w, h, msg) {
	return `<svg viewBox="0 0 ${ w } ${ h }" class="legend-wave-err">`
		+ `<text x="6" y="${ h / 2 + 4 }" fill="currentColor" font-size="10">${ esc(msg) }</text></svg>`;
}

// 2-input truth table for AND/OR/XOR. ~4 rows, dense, monospace.
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
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
function escAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// --- content ----------------------------------------------------------

function buildLegendHtml() {
	return [
		sectionIntro(),
		sectionT(),
		sectionTruncation(),
		sectionOperators(),
		sectionIdioms(),
		sectionModes(),
		sectionSampleRate(),
		sectionGotchas(),
		sectionFurther(),
	].join('\n');
}

function sectionIntro() {
	return `
<section class="legend-section legend-section-hero">
	<h2>Bytebeat reference</h2>
	<p>One math expression in <code>t</code>, evaluated thousands of times per second. Each result is an audio sample. Bitwise ops produce rhythm and timbre; arithmetic shifts pitch and phase.</p>
	<p class="legend-tip">Hit <strong>Try</strong> on any example to load it into the editor.</p>
</section>`;
}

function sectionT() {
	return `
<section class="legend-section">
	<h2>The variable <code>t</code></h2>
	<p><code>t</code> is the sample counter — starts at 0, grows by 1 every audio frame. At 8 kHz that's 8,000/sec.</p>
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
	</div>
	<p class="legend-note">The 8-bit output truncates each sample to 0–255. <code>t</code> itself grows past that into a 32-bit counter, but the output wraps. At 8 kHz, <code>t</code> overflows after ~74 hours.</p>
</section>`;
}

function sectionTruncation() {
	return `
<section class="legend-section">
	<h2>8-bit truncation</h2>
	<p>Every Bytebeat output gets <code>&amp; 255</code> applied automatically — values wrap mod 256. That's why <code>t + 200</code> sounds identical to <code>t</code> (constant offsets evaporate after wrap) but <code>t &amp; 130</code> doesn't (different bits survive).</p>
	<pre class="legend-codeblock">t = 0    →  output 0
t = 50   →  output 50
t = 255  →  output 255
t = 256  →  output 0    ← wraps
t = 257  →  output 1
...</pre>
	<p class="legend-note">The mode selector changes this map: Signed treats the byte as −128..+127; Floatbeat skips truncation entirely and outputs floats.</p>
</section>`;
}

function sectionOperators() {
	return `
<section class="legend-section">
	<h2>Operators</h2>

	<details open class="legend-group">
		<summary>Bitwise — the heart of bytebeat</summary>
		<p class="legend-note">Bitwise ops act as <em>audio mixers</em>. <code>|</code> is the most "mixer-like"; <code>&amp;</code> masks; <code>^</code> distorts.</p>
		${ opCard('&', 'AND', 'bit is 1 only when both inputs are 1', [
			['t & 128', 'top bit picks one square wave'],
			['t & t/20', 'rising drone — t masked by slower t'],
			['t & 8192', '~1 Hz on/off pattern'],
		]) }
		${ opCard('|', 'OR', 'bit is 1 when either input is 1', [
			['t | t/20', 'videogame tune — most mixer-like'],
			['t | t<<4', 'thicker upper partials'],
			['t | t>>2', 'self-mix one octave down'],
		]) }
		${ opCard('^', 'XOR', 'bit is 1 when inputs differ', [
			['t ^ t/20', 'chaotic & distorted'],
			['t ^ t<<5', 'glitchy harmonics'],
		]) }
		${ opCard('<<', 'Left shift', 'multiply by 2^N — bits move up', [
			['t << 1', 'octave up'],
			['(t & 64) << 2', 'louder square'],
		], { noTruth: true }) }
		${ opCard('>>', 'Right shift', 'divide by 2^N — bits move down', [
			['t >> 1', 'octave down'],
			['t * (t >> 5 | t >> 8)', 'bright lead'],
		], { noTruth: true }) }
		${ opCard('~', 'NOT', 'invert all bits (unary)', [
			['~t & 255', 'mirror of t'],
		], { noTruth: true }) }
	</details>

	<details class="legend-group">
		<summary>Arithmetic</summary>
		${ opCard('*', 'Multiply', 'speeds t up — higher pitch', [
			['t * 2', 'octave up'],
			['t * 5', 'higher pitch'],
			['t * (t >> 13)', 'pitch sweeps ~1 sec'],
		], { noTruth: true }) }
		${ opCard('/', 'Divide', 'slows t down — lower pitch (integer)', [
			['t / 2', 'octave down'],
			['t / 3', 'minor pitch shift'],
		], { noTruth: true }) }
		${ opCard('+', 'Add', 'offsets the value (often silent — wrap eats it)', [
			['(t & 128) + (t >> 7 & 64)', 'two squares stacked'],
		], { noTruth: true }) }
		${ opCard('-', 'Subtract / negate', 'leading minus reverses; subtraction shifts', [
			['-t', 'descending saw'],
			['t - (t >> 1)', 'half-amplitude ramp'],
		], { noTruth: true }) }
		${ opCard('%', 'Modulo', 'wraps the value into 0..N−1', [
			['t % 128', 'tiny sawtooth, half amplitude'],
			['t % 255 + t % 64', 'phaser-like beat'],
		], { noTruth: true }) }
	</details>

	<details class="legend-group">
		<summary>Comparison &amp; ternary</summary>
		<p class="legend-note">Return 1 if true, 0 if false. Multiply them into expressions to gate sections by time.</p>
		${ opCard('>', 'Greater', 'true when left &gt; right', [
			['(t > 16000) * (t >> 7)', 'sound starts after 2 sec @ 8 kHz'],
		], { noTruth: true, noWave: true }) }
		${ opCard('==', 'Equal', 'one-sample click at exact t', [
			['(t == 16000) * t', 'click at sample 16000 only'],
		], { noTruth: true, noWave: true }) }
		${ opCard('?:', 'Ternary', 'inline if/else', [
			['t > 16000 ? t : t/2', 'pitch jumps up after 2 sec'],
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

function sectionIdioms() {
	const items = [
		['Kick-tempo gate', 't & 8192', 'On/off at ~1 Hz — drum-machine pulse'],
		['Square wave', '(t & 64) * 4', 'Pick one bit, scale up'],
		['Bit-shift melody', 't * (5 + (t >> 13) % 4)', 'Pitch changes every ~1 sec'],
		['Phase-mix phaser', 't % 255 + t % 64', 'Beating sweep'],
		['Sierpinski drone', 't & t >> 8', 'Self-similar fractal sound'],
		['Bell-ish', '((t >> 10) & 42) * t', 'Wide-spectrum bell tone'],
		['viznut "Crowd"', 't*(((t>>12)|(t>>8)) & (63 & (t>>4)))', 'Famous 1-liner'],
		['Phase-switched triangle', '((t%512>=256)*t | (t%512<256)*(-t-1)) & 255', 'Triangle via t/−t toggle'],
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
<section class="legend-section">
	<h2>Idioms — recipes</h2>
	<p>Concrete patterns you can drop into the editor and ride.</p>
	<div class="legend-wave-grid">${ cards }</div>
</section>`;
}

function sectionModes() {
	const modes = [
		{
			name: 'Bytebeat', mode: 'Bytebeat',
			range: '0..255 (wraps)',
			desc: 'Unsigned 8-bit. The classic mode from viznut’s 2011 article. Bitwise tricks shine; arithmetic offsets are eaten by the wrap.',
			example: 't * (t >> 5 | t >> 8)',
		},
		{
			name: 'Signed Bytebeat', mode: 'Signed Bytebeat',
			range: '−128..+127 (wraps)',
			desc: 'Signed 8-bit. Silence is 0 instead of 128 — needed for tracks written for C <code>signed char</code> output, like viznut’s "Longline Theory".',
			example: '(t * 9 & t >> 4 | t * 5 & t >> 7) - 128',
		},
		{
			name: 'Floatbeat', mode: 'Floatbeat',
			range: 'clamped −1..+1',
			desc: 'Float, no quantization. <code>sin</code>, <code>cos</code>, IIR filters, FM with arbitrary indices — all the DSP that 8-bit bytebeat fights against.',
			example: 'sin(t / 50) * 0.7',
		},
		{
			name: 'Funcbeat', mode: 'Funcbeat',
			range: 'clamped −1..+1',
			desc: 'Code body returns a function <code>f(t, sr)</code>. <code>t</code> is in <strong>seconds</strong>, not samples. State via closures; arrays, loops, helpers all welcome.',
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
			<pre class="legend-codeblock"><code>${ esc(m.example) }</code></pre>
			${ tryBtn(m.example, m.mode) }
		</div>`).join('');
	return `
<section class="legend-section">
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
<section class="legend-section">
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
</section>`;
}

function sectionGotchas() {
	return `
<section class="legend-section">
	<h2>Gotchas</h2>
	<ul class="legend-gotcha-list">
		<li><strong>Operator precedence:</strong> <code>t &gt;&gt; 10 * t</code> parses as <code>t &gt;&gt; (10 * t)</code>. Use parens: <code>(t &gt;&gt; 10) * t</code>.</li>
		<li><strong>AND</strong> can't exceed its smallest operand. <code>t &amp; 140</code> is always ≤ 140. <strong>OR</strong> can't go below it: <code>t | 140</code> is always ≥ 140.</li>
		<li><strong>Division ordering:</strong> <code>t / 2</code> ≠ <code>2 / t</code>.</li>
		<li><strong>Phase collision when toggling t and −t:</strong> both equal 0 at the seam, causing a click. Use <code>(-t - 1)</code> to offset by one.</li>
		<li><strong>Left-shift dead zones:</strong> <code>t &lt;&lt; 8</code> through <code>t &lt;&lt; 31</code> are silent at 8-bit (the bits get truncated away). Stick to small shifts.</li>
		<li><strong>Comma chains for variables:</strong> <code>a=10, b=6, t * (t &gt;&gt; a) | t * b</code> — comma separates assignments from the final expression.</li>
		<li><strong>Math without <code>Math.</code>:</strong> the worklet binds <code>sin</code>, <code>cos</code>, <code>tan</code>, <code>sqrt</code>, etc. as locals — both <code>sin(t/50)</code> and <code>Math.sin(t/50)</code> work.</li>
	</ul>
</section>`;
}

function sectionFurther() {
	return `
<section class="legend-section">
	<h2>Where to learn more</h2>
	<ul>
		<li>viznut's original article (2011): <em>Algorithmic symphonies from one line of code</em></li>
		<li>Greggman's html5bytebeat — most-used hosted player</li>
		<li>The two PDFs in <code>docs/</code>: TTNM beginner's guide and Ravary's RPN guide</li>
		<li>r/bytebeat on Reddit</li>
	</ul>
</section>`;
}
