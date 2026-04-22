import { javascriptLanguage } from '@codemirror/lang-javascript';
import { Annotator } from './annotator.mjs';

// Lezer node types we treat as transparent — descend through them without
// emitting a node in our simplified tree.
const TRANSPARENT = new Set([
	'Script',
	'ExpressionStatement',
	'ParenthesizedExpression'
]);

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_HEIGHT = 26;
const NODE_PADDING = 14;
const CHAR_WIDTH = 7;
const SIBLING_GAP = 12;
const LEVEL_GAP = 22;

export class Explorer {
	constructor() {
		this.lastSource = '';
		this.lastTree = null;
		this.panel = null;
		this.svg = null;
		this.empty = null;
		this.detail = null;
		this.detailSource = null;
		this.detailAnnotation = null;
		this.isOpen = false;
		this.annotator = new Annotator();
		this.byId = new Map();
		this.selectedId = null;
	}
	initElements() {
		this.panel = document.getElementById('explorer-panel');
		this.svg = document.getElementById('explorer-svg');
		this.empty = document.getElementById('explorer-empty');
		this.detail = document.getElementById('explorer-detail');
		this.detailSource = this.detail.querySelector('.explorer-source');
		this.detailAnnotation = this.detail.querySelector('.explorer-annotation');
		this.svg.addEventListener('mouseover', e => this.onSvgMouseOver(e));
		this.svg.addEventListener('mouseout', e => this.onSvgMouseOut(e));
		this.svg.addEventListener('click', e => this.onSvgClick(e));
	}
	// Re-parse + re-render on editor changes, but only while the panel is open.
	// Debounced so rapid typing doesn't churn the SVG.
	onEditorChange(source) {
		if(!this.isOpen) {
			return;
		}
		clearTimeout(this._reparseTimer);
		this._reparseTimer = setTimeout(() => this.render(source), 200);
	}
	onSvgMouseOver(e) {
		const g = e.target.closest('[data-from]');
		if(!g) {
			return;
		}
		const from = +g.getAttribute('data-from');
		const to = +g.getAttribute('data-to');
		const ed = globalThis.bytebeat && globalThis.bytebeat.editor;
		if(ed) {
			ed.setExplorerHighlight(from, to);
		}
	}
	onSvgMouseOut(e) {
		const g = e.target.closest('[data-from]');
		if(!g) {
			return;
		}
		const ed = globalThis.bytebeat && globalThis.bytebeat.editor;
		if(ed) {
			ed.clearExplorerHighlight();
		}
	}
	onSvgClick(e) {
		const g = e.target.closest('[data-id]');
		if(!g) {
			return;
		}
		const id = +g.getAttribute('data-id');
		const node = this.byId.get(id);
		if(!node) {
			return;
		}
		this.selectedId = id;
		this.showDetail(node);
	}
	showDetail(node) {
		if(!this.detail) {
			return;
		}
		this.detail.classList.remove('hidden');
		this.detailSource.textContent = node.text;
		const ctx = {
			sampleRate: (globalThis.bytebeat && globalThis.bytebeat.sampleRate) || 8000,
			isTop: node === this.lastTree,
			isTopOfPlus: this.lastTree && this.lastTree.kind === 'BinaryExpression'
				&& this.lastTree.op === '+' && this.lastTree.children.includes(node)
		};
		this.detailAnnotation.textContent = this.annotator.annotate(node, ctx);
	}
	toggle(source) {
		this.isOpen ? this.close() : this.open(source);
	}
	open(source) {
		if(!this.panel) {
			return;
		}
		this.isOpen = true;
		this.panel.classList.remove('hidden');
		this.render(source);
	}
	close() {
		this.isOpen = false;
		if(this.panel) {
			this.panel.classList.add('hidden');
		}
	}
	render(source) {
		if(!this.svg) {
			return;
		}
		const tree = this.parse(source);
		this.svg.replaceChildren();
		this.byId.clear();
		this.selectedId = null;
		if(this.detail) {
			this.detail.classList.add('hidden');
		}
		if(!tree) {
			this.empty.classList.remove('hidden');
			this.svg.setAttribute('width', '0');
			this.svg.setAttribute('height', '0');
			return;
		}
		this.empty.classList.add('hidden');
		this.assignIds(tree, { n: 0 });
		this.measure(tree);
		this.position(tree, 0, 4);
		const totalW = tree._sw + 8;
		const totalH = this.depth(tree) * (NODE_HEIGHT + LEVEL_GAP) + NODE_HEIGHT + 8;
		this.svg.setAttribute('width', String(totalW));
		this.svg.setAttribute('height', String(totalH));
		this.svg.setAttribute('viewBox', `0 0 ${ totalW } ${ totalH }`);
		this.draw(tree);
	}
	assignIds(node, counter) {
		node._id = counter.n++;
		this.byId.set(node._id, node);
		for(const c of node.children) {
			this.assignIds(c, counter);
		}
	}
	measure(node) {
		node._w = Math.max(40, NODE_PADDING + this.label(node).length * CHAR_WIDTH);
		if(node.children.length === 0) {
			node._sw = node._w;
			return;
		}
		let total = 0;
		for(const c of node.children) {
			this.measure(c);
			total += c._sw;
		}
		total += SIBLING_GAP * (node.children.length - 1);
		node._sw = Math.max(node._w, total);
	}
	position(node, x, y) {
		node._x = x + (node._sw - node._w) / 2;
		node._y = y;
		if(node.children.length === 0) {
			return;
		}
		const total = node.children.reduce((s, c) => s + c._sw, 0)
			+ SIBLING_GAP * (node.children.length - 1);
		let cx = x + (node._sw - total) / 2;
		for(const c of node.children) {
			this.position(c, cx, y + NODE_HEIGHT + LEVEL_GAP);
			cx += c._sw + SIBLING_GAP;
		}
	}
	depth(node) {
		if(node.children.length === 0) {
			return 0;
		}
		return 1 + Math.max(...node.children.map(c => this.depth(c)));
	}
	draw(node) {
		// Edges first so rects sit on top
		for(const c of node.children) {
			const x1 = node._x + node._w / 2;
			const y1 = node._y + NODE_HEIGHT;
			const x2 = c._x + c._w / 2;
			const y2 = c._y;
			const my = (y1 + y2) / 2;
			const path = document.createElementNS(SVG_NS, 'path');
			path.setAttribute('class', 'explorer-edge');
			path.setAttribute('d', `M${ x1 } ${ y1 } C ${ x1 } ${ my }, ${ x2 } ${ my }, ${ x2 } ${ y2 }`);
			this.svg.appendChild(path);
		}
		// Wrap rect+text in a <g> carrying data-from/to + data-id so a single
		// SVG-level handler can resolve hover/click back to the source range
		// or to the canonical node record in this.byId.
		const g = document.createElementNS(SVG_NS, 'g');
		g.setAttribute('class', 'explorer-node');
		g.setAttribute('data-from', String(node.from));
		g.setAttribute('data-to', String(node.to));
		g.setAttribute('data-id', String(node._id));
		const rect = document.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('class', 'explorer-node-rect' + (node.children.length === 0 ? ' is-leaf' : ''));
		rect.setAttribute('x', String(node._x));
		rect.setAttribute('y', String(node._y));
		rect.setAttribute('width', String(node._w));
		rect.setAttribute('height', String(NODE_HEIGHT));
		rect.setAttribute('rx', '6');
		rect.setAttribute('ry', '6');
		g.appendChild(rect);
		const text = document.createElementNS(SVG_NS, 'text');
		text.setAttribute('class', 'explorer-node-text');
		text.setAttribute('x', String(node._x + node._w / 2));
		text.setAttribute('y', String(node._y + NODE_HEIGHT / 2));
		text.textContent = this.label(node);
		g.appendChild(text);
		this.svg.appendChild(g);
		for(const c of node.children) {
			this.draw(c);
		}
	}
	// Compact label for a node — what shows inside the rect.
	label(node) {
		switch(node.kind) {
		case 'BinaryExpression':
		case 'UnaryExpression': return node.op;
		case 'ConditionalExpression': return '?:';
		case 'CallExpression': return node.op; // already "Math.sin()" etc.
		case 'MemberExpression':
			return node.text.length > 16 ? node.text.slice(0, 14) + '…' : node.text;
		default:
			return node.op.length > 16 ? node.op.slice(0, 14) + '…' : node.op;
		}
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
