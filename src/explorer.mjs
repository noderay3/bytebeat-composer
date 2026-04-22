import { javascriptLanguage } from '@codemirror/lang-javascript';

// Lezer node types we treat as transparent — descend through them without
// emitting a node in our simplified tree.
const TRANSPARENT = new Set([
	'Script',
	'ExpressionStatement',
	'ParenthesizedExpression'
]);

export class Explorer {
	constructor() {
		this.lastSource = '';
		this.lastTree = null;
	}
	// Parse a source string and return our simplified tree, or null if the
	// source isn't a single classic expression (e.g. function-body forms).
	parse(source) {
		this.lastSource = source;
		const tree = javascriptLanguage.parser.parse(source);
		const root = this.descend(tree.topNode);
		this.lastTree = root ? this.build(root, source) : null;
		return this.lastTree;
	}
	// Skip past Script / ExpressionStatement / ParenthesizedExpression wrappers
	// to reach the actual expression node we care about. The first child of
	// ParenthesizedExpression is the `(` token, not the inner expression — so
	// we also have to skip punctuation when descending.
	descend(node) {
		let cur = node;
		while(cur && TRANSPARENT.has(cur.name)) {
			let inner = cur.firstChild;
			while(inner && this.isPunctuation(inner)) {
				inner = inner.nextSibling;
			}
			if(!inner) {
				return null;
			}
			cur = inner;
		}
		return cur;
	}
	isPunctuation(node) {
		switch(node.name) {
		case '(': case ')':
		case '[': case ']':
		case '{': case '}':
		case ',': case ';': case ':': case '.': case '?':
			return true;
		}
		return false;
	}
	// Build a {op, kind, from, to, text, children} record for a Lezer node.
	build(node, src) {
		const { name, from, to } = node;
		const text = src.slice(from, to);
		switch(name) {
		case 'BinaryExpression': return this.buildBinary(node, src);
		case 'LogicOp': // some Lezer JS versions surface logical operators here
		case 'BitOp':
		case 'CompareOp':
		case 'ArithOp':
			// Operator-only leaf (shouldn't appear at this level — handled inside Binary)
			return { kind: 'Operator', op: text, text, from, to, children: [] };
		case 'UnaryExpression': return this.buildUnary(node, src);
		case 'ConditionalExpression': return this.buildConditional(node, src);
		case 'CallExpression': return this.buildCall(node, src);
		case 'MemberExpression': return this.buildMember(node, src);
		case 'ParenthesizedExpression': {
			let inner = node.firstChild;
			while(inner && this.isPunctuation(inner)) {
				inner = inner.nextSibling;
			}
			return inner ? this.build(inner, src) : null;
		}
		case 'Number': return { kind: 'Number', op: text, text, from, to, children: [] };
		case 'VariableName': return { kind: 'Variable', op: text, text, from, to, children: [] };
		case 'String': return { kind: 'String', op: text, text, from, to, children: [] };
		default:
			// Unknown form — capture verbatim so the tree still renders something
			// rather than silently dropping a subtree.
			return { kind: name, op: text.length > 32 ? name : text, text, from, to, children: [] };
		}
	}
	// BinaryExpression children come out as: <left> <operator-token> <right>.
	// The operator token is a leaf node (BitOp / ArithOp / CompareOp / LogicOp /
	// UpdateOp); everything else is an operand.
	buildBinary(node, src) {
		let left = null, op = '', right = null;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(this.isPunctuation(c)) {
				continue;
			}
			if(this.isOperator(c)) {
				op = src.slice(c.from, c.to);
			} else if(!left) {
				left = c;
			} else {
				right = c;
			}
		}
		const children = [];
		if(left) children.push(this.build(left, src));
		if(right) children.push(this.build(right, src));
		return {
			kind: 'BinaryExpression',
			op,
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: children.filter(Boolean)
		};
	}
	buildUnary(node, src) {
		let op = '', operand = null;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(this.isPunctuation(c)) {
				continue;
			}
			if(this.isOperator(c) && !operand) {
				op = src.slice(c.from, c.to);
			} else {
				operand = c;
			}
		}
		const child = operand ? this.build(operand, src) : null;
		return {
			kind: 'UnaryExpression',
			op,
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: child ? [child] : []
		};
	}
	buildConditional(node, src) {
		// children: <test> ? <then> : <else>  — punctuation nodes are skipped
		const exprs = [];
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(!this.isOperator(c) && c.name !== '?' && c.name !== ':') {
				exprs.push(c);
			}
		}
		return {
			kind: 'ConditionalExpression',
			op: '?:',
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: exprs.slice(0, 3).map(e => this.build(e, src)).filter(Boolean)
		};
	}
	buildCall(node, src) {
		// children: <callee> <ArgList>
		let callee = null, argList = null;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(c.name === 'ArgList') {
				argList = c;
			} else if(!callee) {
				callee = c;
			}
		}
		const calleeText = callee ? src.slice(callee.from, callee.to) : '';
		const args = [];
		if(argList) {
			for(let c = argList.firstChild; c; c = c.nextSibling) {
				if(c.name === '(' || c.name === ')' || c.name === ',') {
					continue;
				}
				args.push(this.build(c, src));
			}
		}
		return {
			kind: 'CallExpression',
			op: calleeText + '()',
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: args.filter(Boolean)
		};
	}
	buildMember(node, src) {
		// children: <object> . <property>   or   <object> [ <expr> ]
		const parts = [];
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(c.name === '.' || c.name === '[' || c.name === ']') {
				continue;
			}
			parts.push(this.build(c, src));
		}
		return {
			kind: 'MemberExpression',
			op: src.slice(node.from, node.to),
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: parts.filter(Boolean)
		};
	}
	isOperator(node) {
		switch(node.name) {
		case 'ArithOp':
		case 'BitOp':
		case 'CompareOp':
		case 'LogicOp':
		case 'UpdateOp':
		case 'TypeofOp':
			return true;
		}
		return false;
	}
}
