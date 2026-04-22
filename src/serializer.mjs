// Render a simplified-tree node back to JS source. Precedence is JS's, so
// the only paren we add is when a child operator binds looser than its
// parent (no decoration on equal-precedence left-assoc chains).

const PREC = {
	'?:': 4,
	'||': 5,
	'&&': 6,
	'|': 7,
	'^': 8,
	'&': 9,
	'==': 11,
	'!=': 11,
	'===': 11,
	'!==': 11,
	'<': 12,
	'>': 12,
	'<=': 12,
	'>=': 12,
	'<<': 13,
	'>>': 13,
	'>>>': 13,
	'+': 14,
	'-': 14,
	'*': 15,
	'/': 15,
	'%': 15,
	unary: 17,
	atom: 22
};

export function serialize(node) {
	return emit(node, 0);
}

function emit(node, parentPrec) {
	if(!node) {
		return '';
	}
	switch(node.kind) {
	case 'Number':
	case 'Variable':
	case 'String':
		return node.op;
	case 'BinaryExpression': {
		const p = PREC[node.op] || 14;
		// All bitwise/arith ops we care about are left-associative — RHS gets
		// p + 1 so that, e.g., (a - b) - c does not lose its parens, and
		// a + (b - c) does keep them.
		const left = emit(node.children[0], p);
		const right = emit(node.children[1], p + 1);
		const out = `${ left } ${ node.op } ${ right }`;
		return p < parentPrec ? `(${ out })` : out;
	}
	case 'UnaryExpression': {
		const p = PREC.unary;
		const operand = emit(node.children[0], p);
		const out = `${ node.op }${ operand }`;
		return p < parentPrec ? `(${ out })` : out;
	}
	case 'ConditionalExpression': {
		const p = PREC['?:'];
		const test = emit(node.children[0], p + 1);
		const cons = emit(node.children[1], 0);
		const alt = emit(node.children[2], p);
		const out = `${ test } ? ${ cons } : ${ alt }`;
		return p < parentPrec ? `(${ out })` : out;
	}
	case 'CallExpression': {
		const callee = node.op.replace(/\(\)$/, '');
		const args = node.children.map(c => emit(c, 0)).join(', ');
		return `${ callee }(${ args })`;
	}
	case 'MemberExpression':
		// Member text round-trips losslessly; cheaper than re-emitting.
		return node.text;
	default:
		return node.text;
	}
}
