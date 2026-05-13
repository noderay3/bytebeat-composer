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

// Detail panel text — three per-node paragraphs. Written to be concrete
// and visual: "what does this do → what does it sound like → numbers."
// The mini-waveform in the detail panel does the visual heavy lifting;
// these paragraphs provide the mental model.
const DETAIL_PATTERNS = [
	{
		match: n => isBinOp(n, '>>') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			const period = Math.pow(2, N) / Math.max(ctx.sampleRate, 1);
			const freq = 1 / period;
			return {
				effect: `Divides t by ${ Math.pow(2, N).toLocaleString() } — keeps only the slow-changing high bits of the counter.`,
				sound: `A slow stair-step: the value sits still for thousands of samples, then ticks once. Used as a clock pulse, rhythm divider, or sub-bass foundation.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: ticks ≈ ${ freq.toFixed(2) }× per second — ${ freq < 20 ? 'felt as a pulsing rhythm, not heard as a tone' : pitchHint(freq) }.`
			};
		}
	},
	{
		match: n => isBinOp(n, '<<') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			return {
				effect: `Multiplies t by ${ Math.pow(2, N).toLocaleString() } — the waveform is the same shape as t, just ${ Math.pow(2, N) }× faster.`,
				sound: `Pitched up ${ N } octaves. Bits that were sub-audible (slow) in t now land in the audible range.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: every feature in t happens ${ Math.pow(2, N) }× more frequently.`
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
				effect: `Wraps t to the range 0…${ N - 1 }. Every ${ N } samples the counter resets to zero — creating a sawtooth ramp.`,
				sound: `A bright, buzzy sawtooth wave — the most common building block in bytebeat melody. The faster the wrap, the higher the pitch.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: wraps ${ freq.toFixed(0) }× per second → fundamental ≈ ${ freq.toFixed(1) } Hz (${ pitchHint(freq) }).`
			};
		}
	},
	{
		match: n => isBinOp(n, '&') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].children[1].op);
			const period = Math.pow(2, N) / Math.max(ctx.sampleRate, 1);
			return {
				effect: `Uses a slow copy of t (shifted right by ${ N }) as an on/off switch. Audio-rate t only passes through when the slow gate's bit is 1.`,
				sound: `A stuttering, rhythmic pulse — bursts of audio separated by silence. The gate opens ~${ (1 / period).toFixed(1) }× per second, creating a "chop" effect.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: gate opens every ≈ ${ formatTime(period) }, producing ${ (1 / period).toFixed(2) } Hz pulses on the carrier.`
			};
		}
	},
	{
		match: n => isBinOp(n, '&') && isShiftedT(n.children[0]) && isShiftedT(n.children[1]),
		make: (n, ctx) => {
			const a = parseLiteral(n.children[0].children[1].op);
			const b = parseLiteral(n.children[1].children[1].op);
			return {
				effect: `ANDs two slow clocks together — like two metronomes that only click when they coincide. Both must be 1 for the output to be 1.`,
				sound: `A sparse, percussive cross-rhythm. Hits land only on shared beats; every other moment is silence. Used for drum-like patterns.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: ≈ ${ (ctx.sampleRate / Math.pow(2, a)).toFixed(1) } Hz × ${ (ctx.sampleRate / Math.pow(2, b)).toFixed(1) } Hz interplay.`
			};
		}
	},
	{
		match: n => isBinOp(n, '^') && isVar(n.children[0], 't') && isShiftedT(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].children[1].op);
			return {
				effect: `Flips groups of bits in t wherever the slow copy (shifted right by ${ N }) has a 1. Like toggling bit-columns at a fixed rhythm.`,
				sound: `A morphing, phase-shifting timbre. As the slow clock advances, different bit-groups toggle, creating tonal ripples that sweep across the spectrum.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: the inversion pattern shifts every ${ formatTime(Math.pow(2, N) / ctx.sampleRate) }.`
			};
		}
	},
	{
		match: n => isBinOp(n, '|') && allShiftedTOrT(n) && countTLeaves(n) >= 3,
		make: n => ({
			effect: `ORs together ${ countTLeaves(n) } copies of t at different speeds. Each copy's 1-bits pile on independently — they never cancel, only add.`,
			sound: `A thick, organ-like timbre — multiple octaves of the same waveform stacked. Each shifted copy contributes one octave's worth of harmonic weight.`,
			numbers: ''
		})
	},
	{
		match: n => isBinOp(n, '%') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]),
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			const freq = ctx.sampleRate / N;
			return {
				effect: `Wraps t to 0 every ${ N } samples — equivalent to t & ${ N - 1 } when ${ N } is a power of 2, but works for any modulus.`,
				sound: `A sawtooth wave. Slower wraps = lower pitch; faster = higher. At this modulus, the fundamental ≈ ${ freq.toFixed(0) } Hz.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: ≈ ${ freq.toFixed(1) } Hz (${ pitchHint(freq) }).`
			};
		}
	},
	{
		match: (n, ctx) => isBinOp(n, '*') && isVar(n.children[0], 't') && isLiteralInt(n.children[1]) && !ctx.isTop,
		make: (n, ctx) => {
			const N = parseLiteral(n.children[1].op);
			return {
				effect: `Speeds t up by ${ N }× — same sawtooth shape as plain t, ticking ${ N }× faster per sample.`,
				sound: `Raises the pitch by a factor of ${ N }. Every frequency component in t shifts ${ N }× higher.`,
				numbers: `At ${ formatRate(ctx.sampleRate) }: t's lowest-bit flip (~${ formatRate(ctx.sampleRate / 2) }) is now at ~${ formatRate(ctx.sampleRate / 2 * N) }.`
			};
		}
	}
];


const KIND_DETAILS = {
	BinaryExpression: (n, ctx) => {
		switch(n.op) {
		case '+': return {
			effect: `Adds two numbers together. In bytebeat this is the mixer — each voice contributes its value to the sum. No normalization, no clipping.`,
			sound: `Mixing — the voice with the largest numeric range dominates. Coefficients (×10, ×4) are the "faders" for each term.`,
			numbers: ''
		};
		case '|': return {
			effect: `Bitwise OR — sets each bit to 1 if either input has a 1 there. Like stacking transparent sheets — no bits ever cancel.`,
			sound: `Layering — brighter and louder than + because bits pile up without subtraction. Creates thick, buzzy textures.`,
			numbers: ''
		};
		case '&': return {
			effect: `Bitwise AND — keeps only the bits that are 1 in both inputs. The second input acts as a mask on the first.`,
			sound: `Gating — where the mask is 0, the output silences. Where it's 1, signal passes. Creates rhythmic gaps when one side toggles.`,
			numbers: ''
		};
		case '^': return {
			effect: `Bitwise XOR — a bit is 1 if exactly one input has a 1. Like "flip wherever the second input says 1."`,
			sound: `Phase-shifting — partially inverts the signal in a pattern-driven way. Timbre evolves as the toggle pattern changes over time.`,
			numbers: ''
		};
		case '*': return {
			effect: `Integer multiplication. Scales the value — gain (N × voice = N× louder) or pitch shift (t × N = N× faster).`,
			sound: `Bigger numbers = louder (when used as a coefficient) or higher (when applied to t).`,
			numbers: ''
		};
		case '>>': return {
			effect: `Divides by a power of 2, discarding remainder. Each shift right halves the change rate.`,
			sound: `Slows the signal. A shift of 12 at 8 kHz means ~2 changes per second — felt as rhythm, not heard as a tone.`,
			numbers: ''
		};
		case '<<': return {
			effect: `Multiplies by a power of 2. Each shift left doubles the change rate — one octave per shift.`,
			sound: `Speeds the signal up. Each bit of shift = one octave higher.`,
			numbers: ''
		};
		case '%': return {
			effect: `Wrap-around division — the value resets to 0 every N steps. Never exceeds N-1.`,
			sound: `Creates a sawtooth wave. The wrap rate = sample rate ÷ N. At 8 kHz, t % 256 wraps 8000÷256 ≈ 31 Hz — a low bass note.`,
			numbers: ''
		};
		}
		return { effect: '', sound: '', numbers: '' };
	},
	UnaryExpression: n => ({
		effect: '~' === n.op ? `Bitwise NOT — flips every 0→1 and 1→0. Low values become high, high become low.` :
			'-' === n.op ? `Arithmetic negation. Positive→negative, negative→positive.` :
			'!' === n.op ? `Logical NOT — nonzero→0, zero→1. Reduces signal to binary on/off.` :
			`Unary "${ n.op }" applied to one operand.`,
		sound: '~' === n.op ? `Inverts the waveform — can flip a melody upside-down.` :
			'-' === n.op ? `Mirrors the waveform around zero — the sign flips.` :
			'!' === n.op ? `Reduces to square wave — only 0s and 1s.` : '',
		numbers: ''
	}),
	MulConstExpression: (n, ctx) => {
		const k = parseLiteral(n.op.replace(/^×\s*/, ''));
		return {
			effect: `Multiplies the subtree by ${ k } — a volume knob for this branch of the tree.`,
			sound: `A gain of ${ k }× makes this voice ${ k }× louder when summed into the mix. Bigger coefficients dominate over smaller ones.`,
			numbers: ''
		};
	},
	ConditionalExpression: () => ({
		effect: `Chooses between two values based on a test: if (test ≠ 0) → first branch, else → second branch.`,
		sound: `Switches between two signal paths at a threshold — e.g. t < 8000 ? intro : main stitches two sections back-to-back in time.`,
		numbers: ''
	}),
	CallExpression: n => ({
		effect: `Calls ${ n.op } with the arguments shown. Math functions (sin, cos, pow) operate on continuous values — they step outside pure bitwise math.`,
		sound: `Functions produce smooth, continuous tones — purer-sounding than bitwise operations alone. Math.sin(t/freq) gives a clean sine wave at the chosen frequency.`,
		numbers: ''
	}),
	Variable: n => n.op === 't' ? ({
		effect: `t is the sample clock — a 32-bit integer that counts 0,1,2,3… one increment per audio sample. At 8 kHz: 8,000 ticks per second.`,
		sound: `Plain t sounds like noise — its lowest bits flip at audio rate (every few samples). The magic comes from manipulating t's bit-pattern with shifts, masks, and combinators to shape it into tones and rhythms.`,
		numbers: ''
	}) : ({ effect: `Variable "${ n.op }" — stores a computed value for reuse.`, sound: '', numbers: '' }),
	Number: n => ({ effect: `The literal ${ n.op } — a constant, never changing over time.`, sound: '', numbers: '' }),
	SequenceExpression: () => ({
		effect: `Runs each step left-to-right, keeping only the last step's result.`,
		sound: `Earlier steps set up machinery (assigning helpers, computing tables). Only the final step directly produces the audio sample.`,
		numbers: ''
	}),
	AssignmentExpression: n => ({
		effect: `Stores the right-hand value into "${ n.op.split('=')[0] || n.op }". The assignment itself yields the stored value.`,
		sound: `Assignments don't make sound — they compute and stash intermediate results (pitches, envelopes, phase accumulators) that the final expression reads back.`,
		numbers: ''
	}),
	FunctionExpression: () => ({
		effect: `A named recipe — defines a computation that other code can call with different arguments.`,
		sound: `The function body (shown below this node) is what produces audio when called. Composers use functions to factor out repeating pattern generators.`,
		numbers: ''
	}),
	ArrayExpression: n => ({
		effect: `A lookup table of ${ n.arrayCount || 0 } values — typically pitches for a melody, dynamics for an envelope, or weights for a rhythm.`,
		sound: `The array alone is silent. It's indexed below (e.g. tbl[t>>13&7]) to pick one value per time-slot — stepping through the melody.`,
		numbers: ''
	}),
	ObjectExpression: () => ({
		effect: `A bag of named values — uncommon in classic bytebeat.`,
		sound: '',
		numbers: ''
	}),
	MemberExpression: n => ({
		effect: n.text.includes('[')
			? `Array lookup — reads element #index from the array. The index expression (in brackets) picks which value comes out.`
			: `Property access — reads a named field from an object (e.g. Math.PI → the number π).`,
		sound: n.text.includes('[')
			? `When the index is driven by t>>N, this selects a new table value every 2^N samples — stepping through a melody, one note at a time.`
			: '',
		numbers: ''
	}),
	RegExp: () => ({
		effect: `A regular expression — used in code-golf bytebeats to pack data compactly.`,
		sound: '',
		numbers: ''
	}),
	ParseError: () => ({
		effect: `The parser couldn't understand this part of the expression.`,
		sound: '',
		numbers: ''
	}),
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
// Handles n-ary OR/AND (after Explorer's flatten() collapses associative chains).
function allShiftedTOrT(n) {
	if(!n) {
		return false;
	}
	if(isShiftedT(n) || isVar(n, 't')) {
		return true;
	}
	if(isBinOp(n, '|') || isBinOp(n, '&')) {
		return n.children.length >= 2 && n.children.every(allShiftedTOrT);
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
