import { javascriptLanguage } from '@codemirror/lang-javascript';
import { Annotator } from './annotator.mjs';
import { serialize } from './serializer.mjs';

// Lezer node types we treat as transparent — descend through them without
// emitting a node in our simplified tree.
const TRANSPARENT = new Set([
	'Script',
	'ExpressionStatement',
	'ParenthesizedExpression'
]);

// Verbose name shown on the top line of an operator node — matches the
// reference visual (e.g. "OR ( | )"). Anything not in this map falls back
// to the raw operator text.
const OP_VERBOSE = {
	'+': 'sum ( + )',
	'-': 'subtract ( − )',
	'*': 'multiply ( × )',
	'/': 'divide ( / )',
	'%': 'modulo ( % )',
	'&': 'AND ( & )',
	'|': 'OR ( | )',
	'^': 'XOR ( ^ )',
	'<<': 'shift left ( << )',
	'>>': 'shift right ( >> )',
	'>>>': 'unsigned shift ( >>> )',
	'&&': 'logical AND ( && )',
	'||': 'logical OR ( || )',
	'==': 'equals ( == )',
	'!=': 'not equals ( != )',
	'===': 'strict equals ( === )',
	'!==': 'strict not equals ( !== )',
	'<': 'less than ( < )',
	'<=': 'less or equal ( <= )',
	'>': 'greater than ( > )',
	'>=': 'greater or equal ( >= )'
};

// Role determines the node's color. Mirrors the reference legend:
// leaf = raw input (gray), op = combinator (blue), mul = constant gain (tan),
// sum = mix (teal), output = synthetic byte conversion (green).
function nodeRole(node) {
	if(isLeafShape(node)) {
		return 'leaf';
	}
	if(node.kind === 'MulConstExpression') {
		return 'mul';
	}
	if(node.kind === 'BinaryExpression' && node.op === '+') {
		return 'sum';
	}
	if(node.kind === 'FunctionExpression') {
		return 'func';
	}
	return 'op';
}

// "Leaf-shaped" for visualization purposes: bare literals / variables, and
// also `t >> N` / `t << N` — the canonical raw bytebeat inputs that appear
// as gray boxes in the reference. Plus a few compound forms that read
// better as one box than as a small subtree (Math.sin, this.foo, arrays).
function isLeafShape(node) {
	if(!node) {
		return false;
	}
	switch(node.kind) {
	case 'Number':
	case 'Variable':
	case 'String':
	case 'RegExp':
	case 'ParseError':
	case 'ArrayExpression':
	case 'ObjectExpression':
		return true;
	}
	if(node.kind === 'BinaryExpression' && (node.op === '>>' || node.op === '<<')
		&& node.children.length === 2
		&& node.children[0] && node.children[0].kind === 'Variable'
		&& node.children[0].op === 't'
		&& node.children[1] && node.children[1].kind === 'Number') {
		return true;
	}
	// Simple property access (Math.PI, this.foo) reads better as one leaf
	// than as object + property arrows. Index access (`arr[expr]`) keeps its
	// children so users can drill into the index expression.
	if(node.kind === 'MemberExpression' && !node.text.includes('[')
		&& node.text.length <= 24) {
		return true;
	}
	return false;
}

// Mode-aware label for the synthetic output node at the bottom of the tree.
// Reflects how the composer actually interprets the final value per mode.
function describeOutput(mode, sr) {
	const rate = sr >= 1000 ? (sr / 1000) + ' kHz' : sr + ' Hz';
	switch(mode) {
	case 'Signed Bytebeat':
		return {
			title: '8-bit signed sample',
			detail: '(result & 255) − 128, at ' + rate
		};
	case 'Floatbeat':
		return {
			title: 'floatbeat sample',
			detail: 'expected in [−1, 1], at ' + rate
		};
	case 'Funcbeat':
		return {
			title: 'funcbeat function',
			detail: 'returned function called per-sample, at ' + rate
		};
	default:
		return {
			title: '8-bit audio sample',
			detail: 'result & 255, at ' + rate
		};
	}
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_HEIGHT = 50;        // taller — fits operator + annotation lines
const NODE_PADDING_X = 16;
const CHAR_WIDTH = 7;
const SIBLING_GAP = 14;
const LEVEL_GAP = 36;
const LANE_LABEL_HEIGHT = 18;  // headroom for "Voice A / B" labels above the top row
const OUTPUT_GAP = 14;         // extra space before the synthetic 8-bit-output node

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
		// When a subtree is soloed, the original full source goes here so we
		// can restore it on Unsolo. null when no solo is active.
		this.preSoloSource = null;
		// Snapshot of the subtree we soloed — render() compares against this
		// so editor-driven re-render doesn't strand us in solo mode.
		this.soloedNodeText = null;
	}
	initElements() {
		this.panel = document.getElementById('explorer-panel');
		this.svg = document.getElementById('explorer-svg');
		this.empty = document.getElementById('explorer-empty');
		this.detail = document.getElementById('explorer-detail');
		this.detailSource = this.detail.querySelector('.explorer-source');
		this.detailEffect = this.detail.querySelector('.explorer-detail-effect');
		this.detailEffectRow = this.detailEffect.parentElement;
		this.detailSound = this.detail.querySelector('.explorer-detail-sound');
		this.detailSoundRow = this.detailSound.parentElement;
		this.detailNumbers = this.detail.querySelector('.explorer-detail-numbers');
		this.detailNumbersRow = this.detailNumbers.parentElement;
		this.soloBanner = document.getElementById('explorer-solo-banner');
		this.resizer = document.getElementById('explorer-resizer');
		this.svg.addEventListener('mouseover', e => this.onSvgMouseOver(e));
		this.svg.addEventListener('mouseout', e => this.onSvgMouseOut(e));
		this.svg.addEventListener('click', e => this.onSvgClick(e));
		// The panel sits outside <main id="content"> in the DOM, so the
		// composer's delegated click handler on #content doesn't see clicks
		// inside the panel. Bind directly here.
		this.panel.addEventListener('click', e => this.onPanelClick(e));
		if(this.resizer) {
			this.resizer.addEventListener('mousedown', e => this.startResize(e));
		}
		this.restoreWidth();
	}
	startResize(e) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = this.panel.getBoundingClientRect().width;
		this.panel.classList.add('is-resizing');
		const onMove = ev => {
			// Pointer moves left → panel grows wider (panel sits on the right).
			const w = Math.max(320, Math.min(window.innerWidth - 60, startW - (ev.clientX - startX)));
			this.panel.style.width = w + 'px';
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			this.panel.classList.remove('is-resizing');
			try {
				localStorage.setItem('coderadio.explorer.width',
					this.panel.getBoundingClientRect().width.toFixed(0));
			} catch(_) { /* private mode etc. */ }
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}
	restoreWidth() {
		try {
			const v = +localStorage.getItem('coderadio.explorer.width');
			if(v >= 320 && v <= window.innerWidth - 60) {
				this.panel.style.width = v + 'px';
			}
		} catch(_) { /* ignore */ }
	}
	onPanelClick(e) {
		const btn = e.target.closest('button');
		if(!btn) {
			return;
		}
		switch(btn.id) {
		case 'explorer-handle':
			this.toggle(globalThis.bytebeat && globalThis.bytebeat.editor && globalThis.bytebeat.editor.value);
			break;
		case 'explorer-solo':
			// In-detail Solo always solos the currently selected node
			// (chains deeper while already soloed). Use the header Unsolo
			// to restore the original.
			this.soloSelected();
			break;
		case 'explorer-unsolo':
			this.unsolo();
			break;
		}
	}
	updateSoloBanner() {
		if(!this.soloBanner) {
			return;
		}
		this.soloBanner.classList.toggle('hidden', this.preSoloSource === null);
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
		// Click only shows detail. Layout-changing collapse on click was
		// confusing — the tree shifted under the user's pointer.
		this.showDetail(node);
	}
	relayout() {
		if(!this.lastTree || !this.svg) {
			return;
		}
		this.svg.replaceChildren();
		this.measure(this.lastTree);
		this.position(this.lastTree, 0, 4);
		const totalW = this.lastTree._sw + 8;
		const totalH = this.depth(this.lastTree) * (NODE_HEIGHT + LEVEL_GAP) + NODE_HEIGHT + 8;
		this.svg.setAttribute('width', String(totalW));
		this.svg.setAttribute('height', String(totalH));
		this.svg.setAttribute('viewBox', `0 0 ${ totalW } ${ totalH }`);
		this.draw(this.lastTree);
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
		const d = this.annotator.detail(node, ctx);
		this.detailEffect.textContent = d.effect;
		this.detailSound.textContent = d.sound;
		this.detailNumbers.textContent = d.numbers;
		this.detailEffectRow.classList.toggle('hidden', !d.effect);
		this.detailSoundRow.classList.toggle('hidden', !d.sound);
		this.detailNumbersRow.classList.toggle('hidden', !d.numbers);
	}
	soloSelected() {
		if(this.selectedId == null) {
			return;
		}
		const node = this.byId.get(this.selectedId);
		if(!node) {
			return;
		}
		const ed = globalThis.bytebeat && globalThis.bytebeat.editor;
		if(!ed) {
			return;
		}
		const sub = serialize(node);
		// Save the original on first solo only — chained solos drill deeper
		// without forgetting the way back out.
		if(this.preSoloSource === null) {
			this.preSoloSource = this.lastSource;
		}
		this.soloedNodeText = sub;
		ed.setValue(sub);
		this.updateSoloBanner();
	}
	unsolo() {
		if(this.preSoloSource === null) {
			return;
		}
		const ed = globalThis.bytebeat && globalThis.bytebeat.editor;
		if(!ed) {
			return;
		}
		const restored = this.preSoloSource;
		this.preSoloSource = null;
		this.soloedNodeText = null;
		ed.setValue(restored);
		this.updateSoloBanner();
	}
	toggle(source) {
		this.isOpen ? this.close() : this.open(source);
	}
	open(source) {
		if(!this.panel) {
			return;
		}
		this.isOpen = true;
		this.panel.classList.remove('is-collapsed');
		this.updateHandleTitle();
		this.render(source);
	}
	close() {
		this.isOpen = false;
		if(this.panel) {
			this.panel.classList.add('is-collapsed');
			this.updateHandleTitle();
		}
	}
	updateHandleTitle() {
		const handle = document.getElementById('explorer-handle');
		if(handle) {
			handle.title = this.isOpen ? 'Close expression tree' : 'Open expression tree';
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
		this.updateSoloBanner();
		if(!tree) {
			this.empty.classList.remove('hidden');
			this.svg.setAttribute('width', '0');
			this.svg.setAttribute('height', '0');
			return;
		}
		this.empty.classList.add('hidden');
		this.assignIds(tree, { n: 0 });
		this.measure(tree);
		// Bottom-up layout: leaves at y=top, root at y=bottom (signal flow).
		const treeDepth = this.depth(tree);
		const showVoices = tree.kind === 'BinaryExpression' && tree.op === '+' && tree.children.length >= 2;
		const top = LANE_LABEL_HEIGHT + 4;
		const rootY = top + treeDepth * (NODE_HEIGHT + LEVEL_GAP);
		this.position(tree, 0, rootY);
		const totalW = tree._sw + 16;
		const totalH = rootY + NODE_HEIGHT + OUTPUT_GAP + NODE_HEIGHT + 8;
		this.svg.setAttribute('width', String(totalW));
		this.svg.setAttribute('height', String(totalH));
		this.svg.setAttribute('viewBox', `0 0 ${ totalW } ${ totalH }`);
		this.defineMarkers();
		this.draw(tree);
		if(showVoices) {
			this.drawVoiceLabels(tree);
		}
		this.drawOutputNode(tree, totalW);
	}
	assignIds(node, counter) {
		node._id = counter.n++;
		this.byId.set(node._id, node);
		for(const c of node.children) {
			this.assignIds(c, counter);
		}
	}
	measure(node) {
		const { top, bottom } = this.labels(node);
		// CHAR_WIDTH suits the monospace top line; sans-serif bottom is a
		// touch wider than mono at the same px size so we use ~6.5.
		const topW = top.length * CHAR_WIDTH;
		const botW = Math.ceil(bottom.length * 6.5);
		node._w = Math.max(72, NODE_PADDING_X * 2 + Math.max(topW, botW));
		if(this.isVisualLeaf(node)) {
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
	// "Visual leaf" — no children drawn, even when the AST has them. Captures
	// raw bytebeat inputs like `t`, numbers, and `t >> N` / `t << N` /
	// `t & literal`, which we display as a single gray box matching their
	// source text instead of drilling into a 3-node subtree.
	isVisualLeaf(node) {
		return node.children.length === 0 || isLeafShape(node);
	}
	position(node, x, y) {
		node._x = x + (node._sw - node._w) / 2;
		node._y = y;
		if(this.isVisualLeaf(node)) {
			return;
		}
		const total = node.children.reduce((s, c) => s + c._sw, 0)
			+ SIBLING_GAP * (node.children.length - 1);
		let cx = x + (node._sw - total) / 2;
		for(const c of node.children) {
			// Children sit ABOVE the parent — signal flows down into the parent.
			this.position(c, cx, y - NODE_HEIGHT - LEVEL_GAP);
			cx += c._sw + SIBLING_GAP;
		}
	}
	depth(node) {
		if(this.isVisualLeaf(node)) {
			return 0;
		}
		return 1 + Math.max(...node.children.map(c => this.depth(c)));
	}
	draw(node) {
		// Visual leaves draw their own box; no children are recursed into,
		// so a `t >> 7` shows up as one gray rect rather than a 3-deep tree.
		if(this.isVisualLeaf(node)) {
			this.drawNode(node);
			return;
		}
		// Edges go from each child's bottom into this node's top (downward
		// signal flow, arrowhead at the parent end).
		for(const c of node.children) {
			const x1 = c._x + c._w / 2;
			const y1 = c._y + NODE_HEIGHT;
			const x2 = node._x + node._w / 2;
			const y2 = node._y;
			const my = (y1 + y2) / 2;
			const path = document.createElementNS(SVG_NS, 'path');
			path.setAttribute('class', 'explorer-edge');
			path.setAttribute('marker-end', 'url(#explorer-arrow)');
			path.setAttribute('d', `M${ x1 } ${ y1 } C ${ x1 } ${ my }, ${ x2 } ${ my }, ${ x2 } ${ y2 }`);
			this.svg.appendChild(path);
		}
		this.drawNode(node);
		for(const c of node.children) {
			this.draw(c);
		}
	}
	drawNode(node) {
		const role = nodeRole(node);
		const { top, bottom } = this.labels(node);
		const g = document.createElementNS(SVG_NS, 'g');
		g.setAttribute('class', `explorer-node role-${ role }`);
		g.setAttribute('data-from', String(node.from));
		g.setAttribute('data-to', String(node.to));
		g.setAttribute('data-id', String(node._id));
		const rect = document.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('class', 'explorer-node-rect');
		rect.setAttribute('x', String(node._x));
		rect.setAttribute('y', String(node._y));
		rect.setAttribute('width', String(node._w));
		rect.setAttribute('height', String(NODE_HEIGHT));
		rect.setAttribute('rx', '8');
		rect.setAttribute('ry', '8');
		g.appendChild(rect);
		const topText = document.createElementNS(SVG_NS, 'text');
		topText.setAttribute('class', 'explorer-node-top');
		topText.setAttribute('x', String(node._x + node._w / 2));
		topText.setAttribute('y', String(node._y + (bottom ? 18 : NODE_HEIGHT / 2 + 4)));
		topText.textContent = top;
		g.appendChild(topText);
		if(bottom) {
			const botText = document.createElementNS(SVG_NS, 'text');
			botText.setAttribute('class', 'explorer-node-bottom');
			botText.setAttribute('x', String(node._x + node._w / 2));
			botText.setAttribute('y', String(node._y + 35));
			botText.textContent = bottom;
			g.appendChild(botText);
		}
		this.svg.appendChild(g);
	}
	// Two-line label: top is the operator/value (verbose for combinators —
	// e.g. "OR ( | )"), bottom is the short annotation when we have one.
	// Visual leaves render their full source text on the top line ("t >> 7"
	// instead of just ">>") since we never expose their interior.
	labels(node) {
		if(isLeafShape(node) && node.children.length > 0) {
			return { top: node.text.length > 24 ? node.text.slice(0, 22) + '…' : node.text, bottom: '' };
		}
		const ann = this.annotator.shortLabel
			? this.annotator.shortLabel(node, this.annotateContext(node))
			: '';
		switch(node.kind) {
		case 'BinaryExpression': {
			const verbose = OP_VERBOSE[node.op] || node.op;
			return { top: verbose, bottom: ann };
		}
		case 'UnaryExpression': return { top: 'unary ' + node.op, bottom: ann };
		case 'ConditionalExpression': return { top: '? :', bottom: 'if/else' };
		case 'CallExpression': return { top: node.op, bottom: ann };
		case 'MulConstExpression': return { top: node.op, bottom: ann };
		case 'SequenceExpression': return { top: 'sequence ( , )', bottom: 'do then return last' };
		case 'AssignmentExpression': return { top: 'assign ( ' + node.op + ' )', bottom: 'set variable' };
		case 'FunctionExpression': return { top: node.op, bottom: 'function literal' };
		case 'MemberExpression':
			return { top: node.text.length > 18 ? node.text.slice(0, 16) + '…' : node.text, bottom: '' };
		case 'Number': return { top: node.op, bottom: '' };
		case 'Variable':
			return { top: node.op, bottom: node.op === 't' ? 'sample index' : '' };
		default:
			return { top: node.op.length > 18 ? node.op.slice(0, 16) + '…' : node.op, bottom: '' };
		}
	}
	annotateContext(node) {
		return {
			sampleRate: (globalThis.bytebeat && globalThis.bytebeat.sampleRate) || 8000,
			isTop: node === this.lastTree,
			isTopOfPlus: this.lastTree && this.lastTree.kind === 'BinaryExpression'
				&& this.lastTree.op === '+' && this.lastTree.children.includes(node)
		};
	}
	defineMarkers() {
		const defs = document.createElementNS(SVG_NS, 'defs');
		defs.innerHTML = `<marker id="explorer-arrow" viewBox="0 0 10 10" refX="9" refY="5"
			markerWidth="6" markerHeight="6" orient="auto-start-reverse">
			<path d="M 0 0 L 10 5 L 0 10 z" class="explorer-arrowhead" />
		</marker>`;
		this.svg.appendChild(defs);
	}
	// Voice A / B / C labels above each top-level summand of a `+` root.
	drawVoiceLabels(root) {
		root.children.forEach((c, i) => {
			const label = document.createElementNS(SVG_NS, 'text');
			label.setAttribute('class', 'explorer-voice-label');
			// Find the top-most node in this child's subtree to anchor above.
			const topY = this.subtreeTopY(c);
			label.setAttribute('x', String(c._x + c._w / 2));
			label.setAttribute('y', String(Math.max(LANE_LABEL_HEIGHT - 2, topY - 4)));
			label.textContent = 'Voice ' + String.fromCharCode(65 + i);
			this.svg.appendChild(label);
		});
	}
	subtreeTopY(node) {
		if(node.children.length === 0) {
			return node._y;
		}
		return Math.min(node._y, ...node.children.map(c => this.subtreeTopY(c)));
	}
	drawOutputNode(root, totalW) {
		const w = 200;
		const x = root._x + root._w / 2 - w / 2;
		const y = root._y + NODE_HEIGHT + OUTPUT_GAP;
		// Edge from root down into the output node
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('class', 'explorer-edge');
		path.setAttribute('marker-end', 'url(#explorer-arrow)');
		const x1 = root._x + root._w / 2;
		const y1 = root._y + NODE_HEIGHT;
		const x2 = x + w / 2;
		const my = (y1 + y) / 2;
		path.setAttribute('d', `M${ x1 } ${ y1 } C ${ x1 } ${ my }, ${ x2 } ${ my }, ${ x2 } ${ y }`);
		this.svg.appendChild(path);
		const g = document.createElementNS(SVG_NS, 'g');
		g.setAttribute('class', 'explorer-node role-output');
		const rect = document.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('class', 'explorer-node-rect');
		rect.setAttribute('x', String(x));
		rect.setAttribute('y', String(y));
		rect.setAttribute('width', String(w));
		rect.setAttribute('height', String(NODE_HEIGHT));
		rect.setAttribute('rx', '8');
		rect.setAttribute('ry', '8');
		g.appendChild(rect);
		const sr = (globalThis.bytebeat && globalThis.bytebeat.sampleRate) || 8000;
		const mode = (globalThis.bytebeat && globalThis.bytebeat.mode) || 'Bytebeat';
		const desc = describeOutput(mode, sr);
		const top = document.createElementNS(SVG_NS, 'text');
		top.setAttribute('class', 'explorer-node-top');
		top.setAttribute('x', String(x + w / 2));
		top.setAttribute('y', String(y + 18));
		top.textContent = desc.title;
		g.appendChild(top);
		const bottom = document.createElementNS(SVG_NS, 'text');
		bottom.setAttribute('class', 'explorer-node-bottom');
		bottom.setAttribute('x', String(x + w / 2));
		bottom.setAttribute('y', String(y + 35));
		bottom.textContent = desc.detail;
		g.appendChild(bottom);
		this.svg.appendChild(g);
	}
	// Parse a source string and return our simplified tree (post-processed
	// for visualization: associative chains flattened, N*subtree collapsed
	// to a "× N" unary), or null if the source isn't a single classic
	// expression (e.g. function-body forms).
	parse(source) {
		this.lastSource = source;
		const tree = javascriptLanguage.parser.parse(source);
		const root = this.descend(tree.topNode);
		const raw = root ? this.build(root, source) : null;
		this.lastTree = raw ? specialize(flatten(raw)) : null;
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
		case 'SequenceExpression': return this.buildSequence(node, src);
		case 'AssignmentExpression': return this.buildAssignment(node, src);
		case 'ArrayExpression': return this.buildArray(node, src);
		case 'ObjectExpression': return this.buildObject(node, src);
		case 'PostfixExpression': return this.buildUnary(node, src);
		case 'this':
			// `this` is a keyword in Lezer's JS grammar — bytebeats use it for
			// per-instance state (this.foo = …). Treat as a variable for display.
			return { kind: 'Variable', op: 'this', text: 'this', from, to, children: [] };
		case 'PropertyName':
			// Right side of `obj.prop` — Lezer surfaces the bare identifier as
			// PropertyName. Render as a variable leaf so MemberExpression's two
			// children don't blow up the renderer.
			return { kind: 'Variable', op: text, text, from, to, children: [] };
		case 'RegExp':
			return { kind: 'RegExp', op: text.length > 24 ? text.slice(0, 22) + '…' : text, text, from, to, children: [] };
		case 'ArrowFunction':
		case 'FunctionExpression':
		case 'FunctionDeclaration':
			return this.buildFunctionExpr(node, src);
		case '⚠':
			// Lezer inserts this when the parser can't reconcile the source.
			// Surface as a marked leaf so the rest of the tree still renders.
			return { kind: 'ParseError', op: '⚠ unparsed', text, from, to, children: [] };
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
		// Handles both prefix (-x, ~x, !x) and postfix (x++, x--) — operator
		// can come before OR after the operand, so don't assume ordering.
		let op = '', operand = null;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(this.isPunctuation(c)) {
				continue;
			}
			if(this.isOperator(c)) {
				op = src.slice(c.from, c.to);
			} else if(!operand) {
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
	// ArrowFunction / FunctionExpression / FunctionDeclaration — render as a
	// "λ (params)" wrapper with the body's return expression as its single
	// child. Block bodies get unwrapped via the ReturnStatement; concise
	// arrow bodies (`t => expr`) use the expression directly. The function
	// itself doesn't make sound — its body does, when called from elsewhere.
	buildFunctionExpr(node, src) {
		const params = [];
		let body = null;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(this.isPunctuation(c)) continue;
			switch(c.name) {
			case 'Arrow':       // Lezer's name for the `=>` token
			case '=>':
			case 'function':
			case 'async':
				continue;
			case 'ParamList':
				for(let p = c.firstChild; p; p = p.nextSibling) {
					if(p.name === 'VariableDefinition') {
						params.push(src.slice(p.from, p.to));
					}
				}
				continue;
			case 'VariableDefinition':
				// Bare arrow param like `t => …` or function name in
				// `function name(){}`. Treat the first as a param.
				params.push(src.slice(c.from, c.to));
				continue;
			case 'Block':
			case 'BlockStatement':
				body = this.extractReturnExpr(c, src);
				continue;
			}
			if(!body) {
				body = this.build(c, src);
			}
		}
		const paramStr = params.length ? '( ' + params.join(', ') + ' )' : '( )';
		return {
			kind: 'FunctionExpression',
			op: 'λ ' + paramStr,
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: body ? [body] : []
		};
	}
	// Walk a block's statements to find the first ReturnStatement and pull
	// out its expression. Side-effect-only blocks (no return) yield null.
	extractReturnExpr(blockNode, src) {
		for(let c = blockNode.firstChild; c; c = c.nextSibling) {
			if(c.name !== 'ReturnStatement') continue;
			for(let r = c.firstChild; r; r = r.nextSibling) {
				if(r.name === 'return' || this.isPunctuation(r)) continue;
				return this.build(r, src);
			}
		}
		return null;
	}
	// Array literal `[1, 2, 3]` — usually a melody / parameter table that
	// gets indexed below (`tbl[t>>13&15]`). The internals aren't musically
	// interesting, so render as one leaf with an abbreviated label and full
	// text in the detail panel.
	buildArray(node, src) {
		let count = 0;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(c.name === '[' || c.name === ']' || c.name === ',') continue;
			count++;
		}
		const text = src.slice(node.from, node.to);
		const label = count <= 4 && text.length <= 28 ? text : `[ ${ count } values ]`;
		return {
			kind: 'ArrayExpression',
			op: label,
			text,
			from: node.from,
			to: node.to,
			children: [],
			arrayCount: count
		};
	}
	buildObject(node, src) {
		let count = 0;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(c.name === '{' || c.name === '}' || c.name === ',') continue;
			count++;
		}
		const text = src.slice(node.from, node.to);
		return {
			kind: 'ObjectExpression',
			op: count === 0 ? '{}' : `{ ${ count } props }`,
			text,
			from: node.from,
			to: node.to,
			children: []
		};
	}
	// SequenceExpression is the JS comma operator: evaluates each child in
	// order and yields the last one's value. In bytebeat it shows up as
	// `(a = foo, b = bar, finalSample)` — assignments + a final result.
	buildSequence(node, src) {
		const exprs = [];
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(this.isPunctuation(c)) {
				continue;
			}
			const built = this.build(c, src);
			if(built) {
				exprs.push(built);
			}
		}
		return {
			kind: 'SequenceExpression',
			op: ',',
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: exprs
		};
	}
	// AssignmentExpression: `name = value` (or `+=` / `*=` / etc.). Value is
	// evaluated and stored; the expression itself yields the assigned value.
	buildAssignment(node, src) {
		let left = null, op = '=', right = null;
		for(let c = node.firstChild; c; c = c.nextSibling) {
			if(this.isPunctuation(c)) {
				continue;
			}
			if(this.isAssignmentOp(c)) {
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
			kind: 'AssignmentExpression',
			op,
			text: src.slice(node.from, node.to),
			from: node.from,
			to: node.to,
			children: children.filter(Boolean)
		};
	}
	isAssignmentOp(node) {
		switch(node.name) {
		case '=':
		case 'AssignmentOp':
			return true;
		}
		return false;
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

// Flatten left-leaning chains of the same associative+commutative operator
// (`+`, `|`, `&`, `^`, `*`) into n-ary nodes so the renderer can show all
// operands feeding into one combinator (matches the reference's "OR with
// three inputs" rather than nested binaries).
const ASSOC_OPS = new Set(['+', '|', '&', '^', '*']);
function flatten(node) {
	if(!node) {
		return node;
	}
	if(node.kind === 'BinaryExpression' && ASSOC_OPS.has(node.op)) {
		const flat = [];
		const collect = n => {
			if(n.kind === 'BinaryExpression' && n.op === node.op) {
				for(const c of n.children) {
					collect(c);
				}
			} else {
				flat.push(flatten(n));
			}
		};
		for(const c of node.children) {
			collect(c);
		}
		return Object.assign({}, node, { children: flat });
	}
	if(node.children) {
		return Object.assign({}, node, { children: node.children.map(flatten) });
	}
	return node;
}

// Re-shape `N * subtree` (or `subtree * N`) into a single MulConstExpression
// with one child — renders as a "× N" gain box like the reference image.
// Only one literal factor; if both sides are subtrees, leave it as a normal
// BinaryExpression `*`. After flatten() above, n-ary `*` chains may have a
// literal among siblings — pull it out.
function specialize(node) {
	if(!node) {
		return node;
	}
	if(node.kind === 'BinaryExpression' && node.op === '*' && node.children.length >= 2) {
		const literals = node.children.filter(c => c && c.kind === 'Number');
		const others = node.children.filter(c => c && c.kind !== 'Number');
		if(literals.length === 1 && others.length >= 1) {
			const lit = literals[0];
			const inner = others.length === 1
				? specialize(others[0])
				: specialize(Object.assign({}, node, { children: others }));
			return Object.assign({}, node, {
				kind: 'MulConstExpression',
				op: '× ' + lit.op,
				children: [inner]
			});
		}
	}
	if(node.children) {
		return Object.assign({}, node, { children: node.children.map(specialize) });
	}
	return node;
}
