// Compute the repetition period (in samples) for every track in
// bytebeat_tracks.json.
//
// Two values per track:
//   period / duration       — EXACT mathematical period. For pure bitwise
//                              bytebeats, this is 2^(H+1) where H is the
//                              highest t-bit depended on. Cap: 2^32.
//   musicalPeriod / musicalDuration — heuristic for the radio player:
//                              picks the slowest rhythmic feature (deepest
//                              t>>N shift) that creates a perceptible cycle.
//
// Usage: node scripts/analyze-periods.mjs [--apply]

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Explorer } from '../src/explorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tracksPath = join(__dirname, '..', '..', 'coderadio',
	'CodeRadio', 'Resources', 'bytebeat_tracks.json');
const tracks = JSON.parse(readFileSync(tracksPath, 'utf8'));
const ex = new Explorer();
const apply = process.argv.includes('--apply');

let periodic = 0, stateful = 0, mathExpr = 0, funcbeat = 0;
const durations = [];

for (const t of tracks) {
	const tree = ex.parse(t.code);
	if (!tree) {
		t.period = null; t.duration = null;
		t.musicalPeriod = null; t.musicalDuration = null;
		t.periodNote = 'funcbeat / unsupported form';
		funcbeat++;
		continue;
	}

	const { hasMath, hasThis, hasState } = scanMisc(tree);

	if (hasThis || hasState) {
		t.period = null; t.duration = null;
		t.musicalPeriod = null; t.musicalDuration = null;
		t.periodNote = 'stateful (this.x or mutable globals)';
		stateful++;
		continue;
	}
	if (hasMath) {
		t.period = null; t.duration = null;
		t.musicalPeriod = null; t.musicalDuration = null;
		t.periodNote = 'Math.* — period depends on irrational arguments (no exact loop)';
		mathExpr++;
		continue;
	}

	const maxBit = computeMaxBit(tree);
	const rawShift = deepestShift(tree);
	const slowestShift = maxBit >= 0 ? Math.min(rawShift, maxBit) : rawShift;
	const sr = Math.max(t.sampleRate || 8000, 1);

	if (maxBit < 0) {
		// Constant — no t dependency. Every sample is identical.
		t.period = 1; t.duration = 1 / sr;
		t.musicalPeriod = 1; t.musicalDuration = 1 / sr;
		t.periodNote = slowestShift ? `constant + shift ${slowestShift}` : 'constant — no t dependency';
		periodic++;
	} else {
		const period = Math.pow(2, maxBit + 1);
		t.period = period; t.duration = period / sr;
		if (slowestShift > 0) {
			t.musicalPeriod = Math.pow(2, slowestShift);
			t.musicalDuration = t.musicalPeriod / sr;
		} else {
			t.musicalPeriod = period; t.musicalDuration = t.duration;
		}
		t.periodNote = slowestShift
			? `bit ${maxBit}, shift ${slowestShift}`
			: `bit ${maxBit}`;
		periodic++;
		durations.push(t.musicalDuration || t.duration || 0);
	}
}

// ── Summary ─────────────────────────────────────────────────────────

function fmt(secs) {
	if (!isFinite(secs)) return '∞';
	if (secs >= 86400) return (secs / 86400).toFixed(2) + ' days';
	if (secs >= 3600)  return (secs / 3600).toFixed(2) + ' hr';
	if (secs >= 60)    return (secs / 60).toFixed(1) + ' min';
	if (secs >= 1)     return secs.toFixed(2) + ' s';
	return (secs * 1000).toFixed(0) + ' ms';
}

const musDurations = tracks
	.filter(t => t.musicalDuration != null && isFinite(t.musicalDuration))
	.map(t => t.musicalDuration)
	.sort((a, b) => a - b);
const mid = musDurations[Math.floor(musDurations.length / 2)];

console.log(`${tracks.length} tracks`);
console.log(`  periodic (bitwise, exact): ${periodic}`);
console.log(`  Math.* (no exact loop):    ${mathExpr}`);
console.log(`  stateful (no fixed period): ${stateful}`);
console.log(`  funcbeat / unsupported:     ${funcbeat}`);

if (musDurations.length) {
	console.log(`\nMusical durations (${musDurations.length} with rhythmic features):`);
	console.log(`  min:       ${fmt(musDurations[0])}`);
	console.log(`  median:    ${fmt(mid)}`);
	console.log(`  max:       ${fmt(musDurations[musDurations.length - 1])}`);
	console.log(`  under  1s:  ${musDurations.filter(d => d < 1).length}`);
	console.log(`  under 10s:  ${musDurations.filter(d => d < 10).length}`);
	console.log(`  under  1m:  ${musDurations.filter(d => d < 60).length}`);
	console.log(`  under 10m:  ${musDurations.filter(d => d < 600).length}`);
	console.log(`  under  1h:  ${musDurations.filter(d => d < 3600).length}`);
	console.log(`  under  1d:  ${musDurations.filter(d => d < 86400).length}`);
}

if (!apply) {
	console.log('\nDry run — use --apply to write JSON');
} else {
	writeFileSync(tracksPath, JSON.stringify(tracks, null, '\t'));
	console.log(`\nWrote ${tracksPath}`);
}

// ── Bit-dependency analysis ──────────────────────────────────────────

function computeMaxBit(node) {
	if (!node) return -1;
	switch (node.kind) {
	case 'Variable':          return node.op === 't' ? 31 : -1;
	case 'Number': case 'String': case 'RegExp':
	case 'ArrayExpression': case 'ObjectExpression':
	case 'ParseError':        return -1;
	case 'UnaryExpression':   return node.children.length ? computeMaxBit(node.children[0]) : -1;
	case 'ConditionalExpression': return maxBitOfChildren(node);
	case 'CallExpression':    return maxBitOfChildren(node);
	case 'SequenceExpression': {
		const last = node.children[node.children.length - 1];
		return last ? computeMaxBit(last) : -1;
	}
	case 'AssignmentExpression':
		return node.children.length >= 2 ? computeMaxBit(node.children[1]) : -1;
	case 'FunctionExpression':
		return node.children.length ? computeMaxBit(node.children[0]) : -1;
	case 'MemberExpression':  return maxBitOfChildren(node);
	case 'MulConstExpression': return node.children.length ? computeMaxBit(node.children[0]) : -1;
	case 'BinaryExpression':  return computeMaxBitBinary(node);
	default: return 31;
	}
}

function maxBitOfChildren(node) {
	if (!node.children || !node.children.length) return -1;
	const bits = node.children.map(computeMaxBit).filter(b => b >= 0);
	return bits.length ? Math.max(...bits) : -1;
}

function computeMaxBitBinary(node) {
	if (!node.children || node.children.length < 2) return maxBitOfChildren(node);
	const op = node.op;

	// & with literal power-of-2-minus-1 mask: constrains bits to [0, k-1].
	if (op === '&') {
		const left = computeMaxBit(node.children[0]);
		const mask = effectiveMask(node.children[1]);
		if (mask !== null) return left < 0 ? mask.bits - 1 : Math.min(left, mask.bits - 1);
		return Math.max(left, computeMaxBit(node.children[1]));
	}
	// % N constrains range to [0, N-1].
	if (op === '%') {
		const left = computeMaxBit(node.children[0]);
		const mod = literalValue(node.children[1]);
		if (mod > 0) {
			const k = Math.ceil(Math.log2(mod + 1));
			return left < 0 ? k - 1 : Math.min(left, k - 1);
		}
		return 31;
	}
	// Shifts: reposition bits but don't change which t-bits are depended on.
	if (op === '>>' || op === '<<' || op === '>>>') return computeMaxBit(node.children[0]);
	// All other binary ops: union of child bit sets.
	return Math.max(computeMaxBit(node.children[0]), computeMaxBit(node.children[1]));
}

function effectiveMask(node) {
	if (!node) return null;
	let v;
	if (node.kind === 'Number') v = parseLiteral(node.op);
	else if (node.kind === 'UnaryExpression' && node.op === '-'
		&& node.children[0] && node.children[0].kind === 'Number')
		v = -parseLiteral(node.children[0].op);
	else return null;
	if (v < 0 || !Number.isInteger(v)) return null;
	const bits = Math.floor(Math.log2(v + 1));
	return (1 << bits) - 1 === v ? { bits } : null;
}

function literalValue(node) {
	if (!node) return NaN;
	if (node.kind === 'Number') return parseLiteral(node.op);
	return NaN;
}

// Slowest t>>N shift depth — the practical loop point.
function deepestShift(node) {
	if (!node) return 0;
	let max = 0;
	if (node.kind === 'BinaryExpression' && (node.op === '>>' || node.op === '>>>')
		&& node.children.length === 2
		&& node.children[0] && node.children[0].kind === 'Variable'
		&& node.children[0].op === 't'
		&& node.children[1] && node.children[1].kind === 'Number') {
		max = parseLiteral(node.children[1].op) || 0;
	}
	if (node.children) for (const c of node.children) max = Math.max(max, deepestShift(c));
	if (node.callee) max = Math.max(max, deepestShift(node.callee));
	return max;
}

function parseLiteral(s) {
	if (/^0x/i.test(s)) return parseInt(s, 16);
	if (/^0b/i.test(s)) return parseInt(s.slice(2), 2);
	return Number(s);
}

function scanMisc(node) {
	let hasMath = false, hasThis = false, hasState = false;
	(function walk(n) {
		if (!n) return;
		if (n.kind === 'CallExpression' && /^Math\./.test(n.op)) hasMath = true;
		if (n.text && n.text.includes('this.')) hasThis = true;
		if (n.text && /\bnew\b/.test(n.text)) hasState = true;
		if (n.children) for (const c of n.children) walk(c);
	})(node);
	return { hasMath, hasThis, hasState };
}
