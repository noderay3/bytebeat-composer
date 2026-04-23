// Run every track in CodeRadio's bytebeat_tracks.json through the Explorer
// and report any unhandled Lezer node kinds — anything that fell through
// build()'s default case and got captured as a verbatim leaf rather than a
// proper structured node. Iterate: add support, re-run, repeat until clean.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Explorer } from '../src/explorer.mjs';

// Kinds the renderer knows how to draw + label. Anything else is a snag.
const HANDLED = new Set([
	'BinaryExpression', 'UnaryExpression', 'ConditionalExpression',
	'CallExpression', 'MemberExpression', 'MulConstExpression',
	'SequenceExpression', 'AssignmentExpression', 'FunctionExpression',
	'ArrayExpression', 'ObjectExpression',
	'Number', 'Variable', 'String', 'RegExp', 'ParseError'
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const tracksPath = join(__dirname, '..', '..', 'coderadio',
	'CodeRadio', 'Resources', 'bytebeat_tracks.json');
const tracks = JSON.parse(readFileSync(tracksPath, 'utf8'));

const ex = new Explorer();
const offenders = new Map(); // unhandled kind → [{ idx, code }]
let nullCount = 0;
const nullSamples = [];

for(let i = 0; i < tracks.length; i++) {
	const t = tracks[i];
	const tree = ex.parse(t.code);
	if(!tree) {
		nullCount++;
		if(nullSamples.length < 5) {
			nullSamples.push({ idx: i, code: t.code.slice(0, 100) });
		}
		continue;
	}
	walk(tree, kind => {
		if(HANDLED.has(kind)) return;
		const list = offenders.get(kind) || [];
		if(list.length < 5) {
			list.push({ idx: i, code: t.code.slice(0, 100) });
		}
		list._count = (list._count || 0) + 1;
		offenders.set(kind, list);
	});
}

function walk(node, fn) {
	if(!node) return;
	fn(node.kind);
	if(node.children) for(const c of node.children) walk(c, fn);
}

console.log(`tracks:    ${ tracks.length }`);
console.log(`null tree: ${ nullCount } (unsupported form — funcbeat / function body / arrow)`);
for(const { idx, code } of nullSamples) {
	console.log(`  #${ idx }: ${ code }`);
}

const sorted = [...offenders.entries()].sort((a, b) => b[1]._count - a[1]._count);
if(sorted.length === 0) {
	console.log(`\n✓ no unhandled node kinds — corpus parses cleanly`);
} else {
	console.log(`\nunhandled node kinds (${ sorted.length }):`);
	for(const [kind, list] of sorted) {
		console.log(`\n  ${ kind }  (${ list._count } occurrences)`);
		for(const { idx, code } of list) {
			console.log(`    #${ idx }: ${ code }`);
		}
	}
}
