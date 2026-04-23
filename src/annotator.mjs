// Plain-language labels for bytebeat subtree shapes.
// Pattern table comes first (specific shapes win); generic fallback on the
// node kind otherwise. Add patterns at the top — first match wins.

const OP_NAMES = {
	'+': 'addition',
	'-': 'subtraction',
	'*': 'multiplication',
	'/': 'division',
	'%': 'modulo',
	'&': 'bitwise AND',
	'|': 'bitwise OR',
	'^': 'bitwise XOR',
	'<<': 'shift left',
	'>>': 'shift right (signed)',
	'>>>': 'shift right (unsigned)',
	'&&': 'logical AND',
	'||': 'logical OR',
	'==': 'equals',
	'===': 'strict equals',
	'!=': 'not equals',
	'!==': 'strict not equals',
	'<': 'less than',
	'<=': 'less or equal',
	'>': 'greater than',
	'>=': 'greater or equal',
	'~': 'bitwise NOT',
	'!': 'logical NOT'
};

const PATTERNS = [
	// t >> N — slowed t
	{
		match: n => isBinOp(n, '>>') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		label: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			const period = Math.pow(2, N) / Math.max(ctx.sampleRate, 1);
			return `t slowed ×2^${ N } — period ≈ ${ formatTime(period) }`;
		}
	},
	// t << N — sped up
	{
		match: n => isBinOp(n, '<<') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		label: n => `t sped up ×2^${ parseLiteral(n.children[1].op) }`
	},
	// t & N where N+1 is a power of 2 — mod counter
	{
		match: n => isBinOp(n, '&') && isVar(n.children[0], 't') && isLiteralInt(n.children[1])
			&& isPowerOf2(parseLiteral(n.children[1].op) + 1),
		label: n => `mod counter (mod ${ parseLiteral(n.children[1].op) + 1 })`
	},
	// t & (t >> N) — slow gate on fast t
	{
		match: n => isBinOp(n, '&') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		label: () => 'slow gate on fast t (modulator-shaped — sounds quiet alone)'
	},
	// (t >> A) & (t >> B) — beat between two slow clocks
	{
		match: n => isBinOp(n, '&') && isShiftedT(n.children[0]) && isShiftedT(n.children[1]),
		label: () => 'beat between slow clocks (modulator-shaped — sounds quiet alone)'
	},
	// t ^ (t >> N) — XOR phase
	{
		match: n => isBinOp(n, '^') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		label: () => 'XOR phase'
	},
	// t | (t>>A) | (t>>B) — bit-stacked harmonics (≥2 shifted-t in an OR chain)
	{
		match: n => isBinOp(n, '|') && allShiftedTOrT(n) && countTLeaves(n) >= 3,
		label: () => 'bit-stacked harmonics'
	},
	// t * N (literal, used as a non-top factor) — detune
	{
		match: (n, ctx) => isBinOp(n, '*') && isVar(n.children[0], 't') && isLiteralInt(n.children[1])
			&& !ctx.isTop,
		label: n => `detune by ${ n.children[1].op }`
	},
	// N * subtree at the top of a + (mix level)
	{
		match: (n, ctx) => isBinOp(n, '*') && isLiteralInt(n.children[0]) && ctx.isTopOfPlus,
		label: n => `mix level ${ n.children[0].op }`
	},
	// t % N — period in samples
	{
		match: n => isBinOp(n, '%') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		label: n => `period ${ n.children[1].op } samples`
	}
];

// Short, in-rect annotation (1–4 words). Returned for the bottom line
// inside the SVG node — the longer prose label from annotate() goes in
// the detail panel. Empty string means "no inline label, just the op".
const SHORT_PATTERNS = [
	{
		match: n => isBinOp(n, '>>') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		label: () => 'slowed t'
	},
	{
		match: n => isBinOp(n, '<<') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		label: () => 'sped-up t'
	},
	{
		match: n => isBinOp(n, '&') && isVar(n.children[0], 't') && isLiteralInt(n.children[1])
			&& isPowerOf2(parseLiteral(n.children[1].op) + 1),
		label: n => `mod ${ parseLiteral(n.children[1].op) + 1 }`
	},
	{
		match: n => isBinOp(n, '&') && (isVar(n.children[0], 't') || allShiftedTOrT(n.children[0]))
			&& n.children.some(isShiftedT),
		label: () => 'slow gates fast'
	},
	{
		match: n => isBinOp(n, '|') && allShiftedTOrT(n) && countTLeaves(n) >= 3,
		label: n => `stack ${ n.children.length } waveforms`
	},
	{
		match: n => isBinOp(n, '^') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		label: () => 'XOR phase'
	},
	{
		match: n => isBinOp(n, '%') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		label: n => `period ${ n.children[1].op }`
	}
];

const SHORT_BY_KIND = {
	BinaryExpression: n => {
		switch(n.op) {
		case '+': return 'mix voices';
		case '|': return 'layer in ' + (n.children[1] ? '…' : '');
		case '&': return 'gate';
		case '^': return 'XOR';
		case '*': return 'multiply';
		default: return '';
		}
	},
	MulConstExpression: () => 'gain',
	UnaryExpression: () => '',
	ConditionalExpression: () => 'choose',
	CallExpression: () => 'call',
	MemberExpression: () => '',
	Number: () => '',
	Variable: n => n.op === 't' ? 'sample index' : ''
};

// Long-form explanation for the detail panel. Returns three short
// paragraphs: what the operator does at a code level (`effect`), how
// that translates to sound (`sound`), and concrete numbers at the
// current sample rate (`numbers`). Empty strings are skipped by the
// renderer. New patterns: prefer adding here over the terse table.
const DETAIL_PATTERNS = [
	{
		match: n => isBinOp(n, '>>') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			const period = Math.pow(2, N) / Math.max(ctx.sampleRate, 1);
			const freq = 1 / period;
			return {
				effect: `Right-shifts t by ${ N } bits — drops the lowest ${ N } bits and exposes the slow ones to the bottom. The value only changes once every 2^${ N } = ${ Math.pow(2, N) } samples.`,
				sound: `t alone counts so fast its low bits sound like noise. Shifting it down turns it into a slow sawtooth — useful as an LFO, clock, or sub-bass.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: one cycle every ${ formatTime(period) }, ≈ ${ freq.toFixed(2) } Hz.`
			};
		}
	},
	{
		match: n => isBinOp(n, '<<') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			return {
				effect: `Left-shifts t by ${ N } bits — multiplies by 2^${ N } = ${ Math.pow(2, N) }, with low bits filling in as zeros.`,
				sound: `Same waveform as plain t but ticking ${ Math.pow(2, N) }× as fast — audible content moves up by ${ N } octaves.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: every bit-flip from t now happens 2^${ N } times more often.`
			};
		}
	},
	{
		match: n => isBinOp(n, '&') && isVar(n.children[0], 't') && isLiteralInt(n.children[1])
			&& isPowerOf2(parseLiteral(n.children[1].op) + 1),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op) + 1;
			const freq = ctx.sampleRate / N;
			return {
				effect: `Keeps only the low log2(${ N }) bits of t — t now counts 0…${ N - 1 } then wraps.`,
				sound: `A pure rising-then-snapping sawtooth wave. The fundamental tone is the wrap rate; harmonics fill in the timbre.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: wraps ${ freq.toFixed(2) } times per second → fundamental ≈ ${ freq.toFixed(2) } Hz (${ pitchHint(freq) }).`
			};
		}
	},
	{
		match: n => isBinOp(n, '&') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].children[1].op);
			const period = Math.pow(2, N) / Math.max(ctx.sampleRate, 1);
			return {
				effect: `Bitwise AND of fast t with a slowly counting copy of itself (t shifted right by ${ N }). A bit comes through only if both sides have a 1 there.`,
				sound: `The slow side acts like a stuttering gate on the audio-rate t — bursts of high-frequency content interrupted by gaps. Many "rhythmic" bytebeats live in this shape.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: the gating side toggles every ≈ ${ formatTime(period) }, giving a ≈ ${ (1 / period).toFixed(2) } Hz rhythmic envelope on top of the audio.`
			};
		}
	},
	{
		match: n => isBinOp(n, '&') && isShiftedT(n.children[0]) && isShiftedT(n.children[1]),
		make: (n, ctx) => {
			const a = parseLiteral(n.children[0].children[1].op);
			const b = parseLiteral(n.children[1].children[1].op);
			return {
				effect: `AND of two slow clocks (t shifted by ${ a } and ${ b }). The result is 1 only when both clocks are simultaneously 1.`,
				sound: `Two slow square-ish counters interfere — you get a polyrhythmic on/off pattern at the beat between them. Sounds like a percussive cross-rhythm.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: ≈ ${ (ctx.sampleRate / Math.pow(2, a)).toFixed(2) } Hz × ≈ ${ (ctx.sampleRate / Math.pow(2, b)).toFixed(2) } Hz interaction.`
			};
		}
	},
	{
		match: n => isBinOp(n, '^') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].children[1].op);
			return {
				effect: `XOR of t with t>>${ N }: bits flip in t wherever the slow copy has a 1.`,
				sound: `Periodically inverts groups of bits — the timbre morphs as the slow side counts up. Often produces tonal shifts and arpeggios.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: the inverter pattern advances once every ${ formatTime(Math.pow(2, N) / ctx.sampleRate) }.`
			};
		}
	},
	{
		match: n => isBinOp(n, '|') && allShiftedTOrT(n) && countTLeaves(n) >= 3,
		make: () => ({
			effect: `OR of several shifted t copies. A bit is 1 in the result if it's 1 in any of the inputs.`,
			sound: `Stacks waveforms at related frequencies — each shifted t is one octave lower than the previous. Bits "layer" rather than mix linearly, giving a buzzy, organ-like timbre.`,
			numbers: ''
		})
	},
	{
		match: n => isBinOp(n, '%') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			const freq = ctx.sampleRate / N;
			return {
				effect: `t modulo ${ N } — counts 0…${ N - 1 } then wraps. Same shape as t & (${ N - 1 }) when N is a power of 2.`,
				sound: `Sawtooth wave at the wrap rate.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: ≈ ${ freq.toFixed(2) } Hz (${ pitchHint(freq) }).`
			};
		}
	},
	{
		match: (n, ctx) => isBinOp(n, '*') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]) && !ctx.isTop,
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			return {
				effect: `Multiplies t by ${ N } — t now ticks ${ N }× as fast (still wraps to 32 bits eventually).`,
				sound: `Same shape as plain t, pitched ${ N }× higher. Common building block for melodic lines.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: a 1-Hz feature in t becomes a ${ N }-Hz feature here.`
			};
		}
	}
];

const KIND_DETAILS = {
	BinaryExpression: (n, ctx) => {
		switch(n.op) {
		case '+': return {
			effect: `Adds the inputs as integers.`,
			sound: `Mixes voices — louder ones (with bigger numeric range) dominate. There's no normalization, so coefficients in front of each summand set the relative levels.`,
			numbers: ''
		};
		case '|': return {
			effect: `Bitwise OR — a bit is 1 in the result if it's 1 in EITHER input.`,
			sound: `Layers signals additively in bit-space rather than amplitude-space. Bits never cancel, so the result tends to sit higher numerically and sounds louder/brighter.`,
			numbers: ''
		};
		case '&': return {
			effect: `Bitwise AND — a bit is 1 only if it's 1 in BOTH inputs.`,
			sound: `Acts as a gate or mask. One side suppresses the other wherever its bit is 0. Produces silences and rhythmic gaps when one side toggles slowly.`,
			numbers: ''
		};
		case '^': return {
			effect: `Bitwise XOR — a bit is 1 if it's different between the inputs (1 in exactly one of them).`,
			sound: `Flips bits in one signal where the other is 1. Produces phase-like inversions and bit-pattern rearrangements as inputs evolve.`,
			numbers: ''
		};
		case '*': return {
			effect: `Integer multiplication.`,
			sound: `Scales the signal numerically. Used for gain (constant × subtree) or pitch shift (t × constant — t now ticks faster).`,
			numbers: ''
		};
		case '>>': return {
			effect: `Right-shift — divides by 2^N (signed), throwing away the lowest N bits.`,
			sound: `Slows down a signal — fewer bit changes per sample. Often used to derive low-rate modulators from t.`,
			numbers: ''
		};
		case '<<': return {
			effect: `Left-shift — multiplies by 2^N. Speeds bit changes up.`,
			sound: `Pitches a signal up by N octaves.`,
			numbers: ''
		};
		case '%': return {
			effect: `Modulo — wraps the left operand back to 0 every N steps.`,
			sound: `Produces a sawtooth at the wrap rate. Equivalent to & (N − 1) when N is a power of 2 but works for any N.`,
			numbers: ''
		};
		}
		return { effect: `Binary "${ n.op }" applied to two operands.`, sound: '', numbers: '' };
	},
	UnaryExpression: n => ({
		effect: `Unary "${ n.op }" applied to one operand. ~ inverts every bit; − negates; ! is logical NOT (returns 0 or 1).`,
		sound: '',
		numbers: ''
	}),
	MulConstExpression: (n, ctx) => {
		const k = parseLiteral(n.op.replace(/^×\s*/, ''));
		return {
			effect: `Multiplies the subtree by the constant ${ k }.`,
			sound: `Sets the relative volume of this voice in the final mix. Bigger values dominate when summed with other voices.`,
			numbers: isFinite(k) ? `Voice contributes proportionally — if another summand has constant K, this one is ${ (k / 1).toFixed(0) }/K of the mix.` : ''
		};
	},
	ConditionalExpression: () => ({
		effect: `If the test is truthy (non-zero), use the "then" branch; otherwise the "else" branch.`,
		sound: `Branches between two signals based on a condition. Lets you stitch sections together by time (e.g., t < 8000 ? sectionA : sectionB).`,
		numbers: ''
	}),
	CallExpression: n => ({
		effect: `Calls ${ n.op } with the listed arguments. Math functions (Math.sin, Math.floor, etc.) introduce continuous, non-bitwise behavior.`,
		sound: `Functions like Math.sin produce smooth periodic waveforms — purer tones than bitwise math. Often used in floatbeat code.`,
		numbers: ''
	}),
	Variable: n => n.op === 't' ? ({
		effect: `t is the sample counter — a 32-bit integer that increments by 1 every audio sample.`,
		sound: `On its own, t played at 8 kHz is a fast-rising sawtooth that wraps every 2^32/8000 ≈ 6.2 days. Its low bits are at audio rate (the lowest bit flips at half the sample rate); higher bits modulate slowly.`,
		numbers: ''
	}) : ({ effect: `Variable ${ n.op }.`, sound: '', numbers: '' }),
	Number: n => ({ effect: `The literal value ${ n.op }.`, sound: '', numbers: '' })
};

function formatRate(sr) {
	return sr >= 1000 ? (sr / 1000) + ' kHz' : sr + ' Hz';
}

function pitchHint(freq) {
	if(freq < 20) return 'sub-audible — felt as rhythm';
	if(freq < 60) return 'sub-bass';
	if(freq < 250) return 'bass register';
	if(freq < 1000) return 'mid range';
	if(freq < 4000) return 'treble';
	return 'high treble — near Nyquist';
}

export class Annotator {
	detail(node, context) {
		if(!node) {
			return { effect: '', sound: '', numbers: '' };
		}
		const ctx = Object.assign({ sampleRate: 8000, isTop: false, isTopOfPlus: false }, context || {});
		for(const p of DETAIL_PATTERNS) {
			if(p.match(node, ctx)) {
				return p.make(node, ctx);
			}
		}
		const make = KIND_DETAILS[node.kind];
		return make ? make(node, ctx) : { effect: '', sound: '', numbers: '' };
	}
	shortLabel(node, context) {
		if(!node) {
			return '';
		}
		const ctx = Object.assign({ sampleRate: 8000, isTop: false, isTopOfPlus: false }, context || {});
		for(const p of SHORT_PATTERNS) {
			if(p.match(node, ctx)) {
				return p.label(node, ctx);
			}
		}
		const make = SHORT_BY_KIND[node.kind];
		return make ? make(node, ctx) : '';
	}
	annotate(node, context) {
		if(!node) {
			return '';
		}
		const ctx = Object.assign({ sampleRate: 8000, isTop: false, isTopOfPlus: false }, context || {});
		for(const p of PATTERNS) {
			if(p.match(node, ctx)) {
				return p.label(node, ctx);
			}
		}
		return this.fallback(node);
	}
	fallback(node) {
		switch(node.kind) {
		case 'BinaryExpression': return OP_NAMES[node.op] || `binary "${ node.op }"`;
		case 'UnaryExpression': {
			const name = OP_NAMES[node.op];
			return name ? `${ name } (unary)` : `unary "${ node.op }"`;
		}
		case 'ConditionalExpression': return 'conditional (if/else as expression)';
		case 'CallExpression': return `function call: ${ node.op }`;
		case 'MemberExpression': return `member access: ${ node.op }`;
		case 'Number': return `literal ${ node.op }`;
		case 'Variable':
			if(node.op === 't') {
				return 'time variable t (sample index — increments every sample)';
			}
			return `variable ${ node.op }`;
		default: return node.kind;
		}
	}
}

function isBinOp(n, op) {
	return n && n.kind === 'BinaryExpression' && n.op === op;
}
function isVar(n, name) {
	return n && n.kind === 'Variable' && n.op === name;
}
function isLiteralInt(n) {
	return n && n.kind === 'Number';
}
function parseLiteral(s) {
	if(/^0x/i.test(s)) {
		return parseInt(s, 16);
	}
	if(/^0b/i.test(s)) {
		return parseInt(s.slice(2), 2);
	}
	return Number(s);
}
function isPowerOf2(n) {
	return n > 0 && (n & (n - 1)) === 0;
}
function isShiftedT(n) {
	return isBinOp(n, '>>') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]);
}
// True if the subtree only consists of `t`, `t>>N`, and OR/AND combinators.
function allShiftedTOrT(n) {
	if(!n) {
		return false;
	}
	if(isShiftedT(n) || isVar(n, 't')) {
		return true;
	}
	if(isBinOp(n, '|') || isBinOp(n, '&')) {
		return n.children.length === 2 && allShiftedTOrT(n.children[0]) && allShiftedTOrT(n.children[1]);
	}
	return false;
}
function countTLeaves(n) {
	if(!n) {
		return 0;
	}
	if(isVar(n, 't')) {
		return 1;
	}
	if(isShiftedT(n)) {
		return 1;
	}
	if(n.children) {
		return n.children.reduce((s, c) => s + countTLeaves(c), 0);
	}
	return 0;
}
function formatTime(secs) {
	if(!isFinite(secs)) {
		return '?';
	}
	if(secs >= 1) {
		return secs.toFixed(2) + ' s';
	}
	if(secs >= 0.001) {
		return (secs * 1000).toFixed(1) + ' ms';
	}
	return (secs * 1e6).toFixed(0) + ' µs';
}
