// Compile a simplified expression tree into a flat evaluation function
// that computes every subtree's output for a given `t` and writes results
// into a provided `Uint32Array` or `Float64Array`. Used by the live
// monitor to sample per-node values at ~60fps without touching the audio
// worklet.
//
// Stateful nodes (this.xxx, assignments in a sequence context) are
// skipped — their slots stay 0.

import { serialize } from './serializer.mjs';

const MAX_NODES = 128;

export function instrument(tree) {
	const nodes = [];
	assignIds(tree, nodes);
	if (nodes.length > MAX_NODES) nodes.length = MAX_NODES;
	const lines = nodes.map((n, i) => {
		if (isStateful(n)) {
			return `out[${ i }] = 0;  // (stateful — skipped)`;
		}
		try {
			const code = serialize(n);
			return `out[${ i }] = (${ code }) >>> 0;`;
		} catch(_) {
			return `out[${ i }] = 0;`;
		}
	});
	let fn;
	try {
		fn = new Function('t', 'out', '"use strict";\n' + lines.join('\n'));
	} catch(_) {
		fn = () => {};
	}
	// Warm up once to catch parse errors
	try { const tmp = new Uint32Array(nodes.length); fn(0, tmp); } catch(_) { fn = () => {}; }
	return { fn, count: nodes.length, nodes };
}

function assignIds(node, out) {
	if (!node) return;
	node._liveId = out.length;
	out.push(node);
	if (node.children) {
		for (const c of node.children) assignIds(c, out);
	}
	if (node.callee /* CallExpression */) {
		assignIds(node.callee, out);
	}
}

function isStateful(node) {
	if (!node) return true;
	// References to `this` imply per-instance mutable state — can't
	// meaningfully re-evaluate at an arbitrary t.
	if (node.text && node.text.includes('this.')) return true;
	if (node.kind === 'SequenceExpression') return true;
	if (node.kind === 'AssignmentExpression') return true;
	return false;
}
