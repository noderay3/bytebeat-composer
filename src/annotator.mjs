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

export class Annotator {
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
