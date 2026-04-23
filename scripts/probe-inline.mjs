// Verify inline() expands helper assignments and IIFEs.
import { Explorer } from '../src/explorer.mjs';

const cases = [
	{
		src: 'f=x=>x*2,f(t)',
		expectInlined: 'MulConstExpression',
		check: tree => {
			// `x*2` was already specialized to MulConstExpression(× 2)[x],
			// so substitution gives × 2 [t] — equivalent and tighter than t*2.
			if(tree.kind !== 'SequenceExpression') return 'expected SequenceExpression';
			const last = tree.children[tree.children.length - 1];
			if(!last._inlined) return 'last child not marked _inlined';
			if(last.kind !== 'MulConstExpression') return 'expected MulConstExpression × 2';
			return null;
		}
	},
	{
		src: '((x)=>x*x)(t/100)',
		expectInlined: 'BinaryExpression', // x*x → (t/100)*(t/100)
		check: tree => {
			if(!tree._inlined) return 'IIFE result not marked _inlined';
			if(tree.kind !== 'BinaryExpression' || tree.op !== '*') return 'expected x*x → (t/100)*(t/100)';
			return null;
		}
	},
	{
		src: 'f=()=>5,f()',
		expectInlined: 'Number',
		check: tree => {
			const last = tree.children[tree.children.length - 1];
			if(!last._inlined) return 'no-arg helper not inlined';
			if(last.kind !== 'Number' || last.op !== '5') return 'expected literal 5';
			return null;
		}
	}
];

const ex = new Explorer();
for(const c of cases) {
	const tree = ex.parse(c.src);
	const err = c.check(tree);
	console.log(`${ err ? '✗' : '✓' }  ${ c.src }  →  ${ summarize(tree) }${ err ? '   [' + err + ']' : '' }`);
}

function summarize(node, depth = 0) {
	if(!node) return '(null)';
	const flag = node._inlined ? '*' : '';
	const head = `${ node.kind }${ flag }(${ node.op })`;
	if(!node.children || !node.children.length) return head;
	return head + '[' + node.children.map(c => summarize(c, depth + 1)).join(', ') + ']';
}
