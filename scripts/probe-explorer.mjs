// Manual smoke test for Phase 1: feed real bytebeat expressions through the
// Explorer and dump the simplified tree. Run with `node scripts/probe-explorer.mjs`.
import { Explorer } from '../src/explorer.mjs';

const exprs = [
	't*(((t>>12)|(t>>8))&(63&(t>>4)))',
	'10*(t>>7|t|t>>6)+4*(t&t>>13|t>>6)',
	't*(42&t>>10)',
	'(t>>4)*(t>>5)',
	't & (t>>13)',
	't ^ t>>8',
	'-(t & 0xff)',
	'Math.sin(t/100)',
	't < 1000 ? t : 0'
];

const ex = new Explorer();
for(const src of exprs) {
	const tree = ex.parse(src);
	console.log(`\n--- ${src}`);
	console.log(format(tree, 0));
}

function format(node, depth) {
	if(!node) return '  '.repeat(depth) + '(null)';
	const kids = (node.children || []).map(c => format(c, depth + 1));
	const head = `${ '  '.repeat(depth) }${ node.kind } op="${ node.op }" [${ node.from },${ node.to })`;
	return [head, ...kids].join('\n');
}
