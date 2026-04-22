// Round-trip a few expressions through Explorer + serializer and verify the
// emitted source parses back to a structurally identical tree.
import { Explorer } from '../src/explorer.mjs';
import { serialize } from '../src/serializer.mjs';

const cases = [
	't',
	't >> 13',
	't & (t>>13)',
	'(t>>4) & (t>>5)',
	't | (t>>7) | (t>>6)',
	'10*(t>>7|t|t>>6)+4*(t&t>>13|t>>6)',
	't*(((t>>12)|(t>>8))&(63&(t>>4)))',
	'-(t & 0xff)',
	'Math.sin(t/100)',
	't < 1000 ? t : 0'
];

const ex = new Explorer();
for(const src of cases) {
	const tree = ex.parse(src);
	const out = serialize(tree);
	const tree2 = ex.parse(out);
	const same = same2(tree, tree2);
	console.log(`${ same ? '✓' : '✗' }  in:  ${ src }`);
	console.log(`   out: ${ out }`);
	if(!same) {
		console.log(`   trees differ`);
	}
}

function same2(a, b) {
	if(a == null && b == null) return true;
	if(!a || !b) return false;
	if(a.kind !== b.kind || a.op !== b.op) return false;
	if((a.children || []).length !== (b.children || []).length) return false;
	for(let i = 0; i < (a.children || []).length; i++) {
		if(!same2(a.children[i], b.children[i])) return false;
	}
	return true;
}
