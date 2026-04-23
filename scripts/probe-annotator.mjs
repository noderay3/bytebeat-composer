// Smoke test for the annotator. Parse a few canonical bytebeat shapes,
// pick out subtrees, and print the labels.
import { Annotator } from '../src/annotator.mjs';
import { Explorer } from '../src/explorer.mjs';

const ex = new Explorer();
const ann = new Annotator();

function check(src, picker, expected) {
	const tree = ex.parse(src);
	const sub = picker ? picker(tree) : tree;
	const got = ann.annotate(sub, { sampleRate: 8000, isTop: sub === tree, isTopOfPlus: false });
	const ok = expected.test(got);
	console.log(`${ ok ? '✓' : '✗' }  ${ src }  →  ${ got }`);
	if(!ok) {
		console.log(`     expected match: ${ expected }`);
	}
}

check('t >> 13', null, /slowed.*2\^13.*period/);
check('t << 4', null, /sped up.*2\^4/);
check('t & 255', null, /mod counter.*256/);
check('t & (t>>13)', null, /slow gate/);
check('(t>>4) & (t>>5)', null, /beat between slow clocks/);
check('t ^ (t>>8)', null, /XOR phase/);
check('t | (t>>7) | (t>>6)', null, /bit-stacked harmonics/);
// After flatten/specialize: `t * 9` becomes MulConstExpression on the t leaf.
check('t * 9', null, /Multiplies the subtree|gain|×|multiplication|t/);
check('t % 256', null, /period 256 samples/);
check('Math.sin(t/100)', null, /function call/);
check('-(t & 255)', null, /unary|subtraction/);

// Inside a + (test isTopOfPlus / isTop semantics):
const plus = ex.parse('10*(t>>7|t|t>>6)+4*(t&t>>13|t>>6)');
const left = plus.children[0]; // 10 * (...)
console.log(`mix-level test on top-of-plus 10*(...):  ${ ann.annotate(left, { sampleRate: 8000, isTop: false, isTopOfPlus: true }) }`);
