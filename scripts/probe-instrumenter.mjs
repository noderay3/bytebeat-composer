// Smoke test: instrument a few canonical trees and verify they evaluate
// correctly at a known t.
import { instrument } from '../src/instrumenter.mjs';
import { Explorer } from '../src/explorer.mjs';

const ex = new Explorer();
const cases = [
	't',
	't >> 12',
	't & 255',
	't | (t>>7) | (t>>6)',
	'10*(t>>7|t|t>>6)+4*(t&t>>13|t>>6)',
];

for(const src of cases) {
	const tree = ex.parse(src);
	const inst = instrument(tree);
	const values = new Uint32Array(inst.count);
	inst.fn(123456, values);
	const summary = inst.nodes.map((n, i) =>
		`${ n.kind }(${ n.op })=${ values[i] }`).join(', ');
	console.log(`✓ ${ src }`);
	console.log(`  ${ inst.count } nodes: ${ summary.slice(0, 120) }${ summary.length > 120 ? '…' : '' }`);
}
