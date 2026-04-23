// Print every node name Lezer surfaces inside a few representative
// expressions — used to figure out what token name covers an operator
// (e.g. `**`) before adding it to Explorer.isOperator.
import { javascriptLanguage } from '@codemirror/lang-javascript';

const exprs = [
	't >> 4',
	't ** 2',
	'2**8',
	't << 4',
	't >>> 4',
	't & 1',
	't | 1',
	't ^ 1',
	't + 1',
	't < 1 ? 0 : 1',
	'a && b'
];

for(const src of exprs) {
	console.log(`\n--- ${ src }`);
	const tree = javascriptLanguage.parser.parse(src);
	dump(tree.cursor(), 0, src);
}

function dump(c, depth, src) {
	const text = src.slice(c.from, c.to);
	console.log(`${ ' '.repeat(depth * 2) }${ c.name } "${ text }"`);
	if(c.firstChild()) {
		do { dump(c, depth + 1, src); } while(c.nextSibling());
		c.parent();
	}
}
