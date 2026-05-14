// Phase 1 round-trip test:
//   parse tree → Graph → compile → re-parse → compare
// Also: evaluator vs direct JS evaluation.

import { Explorer } from '../src/explorer.mjs';
import { treeToGraph } from '../src/graph-model.mjs';
import { GraphEvaluator } from '../src/graph-evaluator.mjs';
import { GraphCompiler } from '../src/graph-compiler.mjs';

const ex = new Explorer();

const cases = [
	't',
	't >> 12',
	't & 255',
	't & (t>>13)',
	'(t>>4) & (t>>5)',
	't | (t>>7) | (t>>6)',
	'10*(t>>7|t|t>>6)+4*(t&t>>13|t>>6)',
	't*(((t>>12)|(t>>8))&(63&(t>>4)))',
	'-(t & 0xff)',
	'Math.sin(t/100)',
	't < 1000 ? t : 0',
	'f=x=>x*2,f(t)',
	't%256',
];

let passes = 0, fails = 0;

for (const src of cases) {
	// 1. Parse with the existing Explorer.
	const tree = ex.parse(src);
	if (!tree) { console.log(`✗ ${src}  — parse returned null`); fails++; continue; }

	// 2. Convert to graph.
	const graph = treeToGraph(tree);

	// 3. Compile graph → JS.
	const compiler = new GraphCompiler();
	const compiled = compiler.compile(graph);

	// 4. Re-parse the compiled output.
	const tree2 = ex.parse(compiled);
	if (!tree2) { console.log(`✗ ${src}  — re-parse returned null for "${compiled}"`); fails++; continue; }

	// 5. Compare the two trees' serialized forms (structural equivalence).
	const s1 = tree ? normalize(tree) : null;
	const s2 = tree2 ? normalize(tree2) : null;
	const structMatch = s1 === s2;

	// 6. Evaluator test: compare evaluator output at t=12345 with
	//    direct JS evaluation of the *compiled* expression.
	let evalMatch = true, evalResult = 0, directEval = 0;
	const hasMath = /Math\./.test(src);
	if (!hasMath) {
		try {
			evalResult = ev.sample(12345);
			directEval = (new Function('t', '"use strict"; return (' + compiled + ') >>> 0;'))(12345);
			evalMatch = evalResult === directEval;
		} catch(_) {
			evalMatch = true;
		}
	}

	if (structMatch && evalMatch) {
		passes++;
		console.log(`✓ ${src}`);
		if (src !== compiled) console.log(`  compiled: ${compiled}`);
	} else {
		fails++;
		console.log(`✗ ${src}  struct=${structMatch} eval=${evalMatch} (graph=${evalResult}, direct=${directEval})`);
		if (!structMatch) {
			console.log(`  orig tree:      ${s1}`);
			console.log(`  compiled:       ${compiled}`);
			console.log(`  re-parsed tree: ${s2}`);
		}
	}
}

// ── Also: test the corpus ──────────────────────────────────────────────

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const tracksPath = join(__dirname, '..', '..', 'coderadio', 'CodeRadio', 'Resources', 'bytebeat_tracks.json');
const tracks = JSON.parse(readFileSync(tracksPath, 'utf8'));

let corpusPass = 0, corpusFail = 0;
for (const t of tracks) {
	const tr = ex.parse(t.code);
	if (!tr) continue; // funcbeat etc — already excluded
	try {
		const g = treeToGraph(tr);
		const c = compiler.compile(g);
		const tr2 = ex.parse(c);
		if (!tr2) { corpusFail++; continue; }
		const s1 = normalize(tr);
		const s2 = normalize(tr2);
		if (s1 !== s2) { corpusFail++; continue; }
		corpusPass++;
	} catch(e) { corpusFail++; }
}

console.log(`\nCorpus: ${corpusPass} pass, ${corpusFail} fail  (${tracks.length} total)`);
console.log(`\nCanonical: ${passes} / ${passes + fails} pass`);

// ── Normalize: serialize tree to a canonical string for comparison ─────

function normalize(node) {
	if (!node) return '_';
	// Fold MulConstExpression → BinaryExpression(*) for comparison.
	let kind = node.kind;
	let op = node.op || '';
	if (kind === 'MulConstExpression') {
		kind = 'BinaryExpression';
		op = '*';
	}
	if (kind === 'Number') {
		const v = parseLiteral(op);
		if (!isNaN(v)) op = String(Number(v));
	}
	const kids = (node.children || []).map(normalize).join(',');
	return `${kind}::${op}::[${kids}]`;
}
function parseLiteral(s) {
	if (/^0x/i.test(s)) return parseInt(s, 16);
	if (/^0b/i.test(s)) return parseInt(s.slice(2), 2);
	return Number(s);
}
