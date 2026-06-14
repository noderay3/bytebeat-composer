import { javascriptLanguage } from '@codemirror/lang-javascript';
import { Annotator } from './annotator.mjs';
import { GraphCanvas, NODE_W, NODE_H } from './graph-canvas.mjs';
import { treeToGraph } from './graph-model.mjs';
import { instrument } from './instrumenter.mjs';
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

// Per-node normalized color. norm [0,1] = how "hot" this node is relative
// to its own recent range. delta [0,1] = how fast it's changing.
// Resting nodes stay cool blue; active/hot nodes shift toward warm.
function valueToHSL(norm, delta = 0) {
	norm = Math.max(0, Math.min(1, norm));
	delta = Math.max(0, Math.min(1, delta));
	const h = 220 - norm * 160 - delta * 60;
	const s = 40 + norm * 40 + delta * 20;
	const l = 5 + norm * 22 + delta * 6;
	return `hsl(${ h.toFixed(0) }, ${ s.toFixed(0) }%, ${ l.toFixed(0) }%)`;
}

// Ring buffer helpers for per-node value history.
function ringNew(cap = 64) { return { d: new Float64Array(cap), h: 0, n: 0, min: 0, max: 1 }; }
function ringPush(b, v) {
	b.d[b.h] = v; b.h = (b.h + 1) % b.d.length;
	if (b.n < b.d.length) b.n++;
	let mn = Infinity, mx = -Infinity;
	for (let i = 0; i < b.n; i++) { const x = b.d[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
	b.min = mn; b.max = mx === mn ? mn + 1 : mx;
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
		this.graph = null;           // current Graph instance
		this.canvas = null;          // GraphCanvas (lazy-init)
		this.useGraph = true;        // toggle: graph-driven layout vs tree
		// Position store — Map keyed by content-fingerprint of a subtree, value
		// is { x, y, locked }. Persisted to localStorage so manually-dragged
		// node positions (Phase G) survive across edits and reloads.
		this.positionStore = this._loadPositionStore();
		// Collapse store — Set of subtree fingerprints whose children are
		// hidden from layout + render. Click on a non-leaf node toggles
		// membership. Persisted so collapse state survives edits (where the
		// same fingerprint reappears) and reloads.
		this.collapseStore = this._loadCollapseStore();
		// Viewport transform applied to a <g> inside the SVG. tx/ty in the
		// SVG's pixel coordinate space; scale is dimensionless.
		this.tx = 0;
		this.ty = 0;
		this.scale = 1;
		this.minScale = 0.2;
		this.maxScale = 4;
		// Natural tree bounds — set by render() and used by fitToView().
		this.treeW = 0;
		this.treeH = 0;
		// Active pan gesture state.
		this.panning = null;
		// Live monitor: re-evaluates every subtree at the current sample
		// position and color-codes the node rects so you can SEE the
		// computation breathing in real time.
		this.isLive = false;
		this._liveRaf = 0;
		this._liveBuffers = null;
		this._liveNodes = null;
		this._liveFn = null;
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
		this.waveform = document.getElementById('explorer-waveform');
		this.detailEffect = this.detail.querySelector('.explorer-detail-effect');
		this.detailEffectRow = this.detailEffect.parentElement;
		this.detailSound = this.detail.querySelector('.explorer-detail-sound');
		this.detailSoundRow = this.detailSound.parentElement;
		this.detailNumbers = this.detail.querySelector('.explorer-detail-numbers');
		this.detailNumbersRow = this.detailNumbers.parentElement;
		this.soloBanner = document.getElementById('explorer-solo-banner');
		this.resizer = document.getElementById('explorer-resizer');
		this.tree = document.getElementById('explorer-tree');
		this.svg.addEventListener('mouseover', e => this.onSvgMouseOver(e));
		this.svg.addEventListener('mouseout', e => this.onSvgMouseOut(e));
		this.svg.addEventListener('click', e => this.onSvgClick(e));
		this.svg.addEventListener('mousedown', e => this.onSvgMouseDown(e));
		this.svg.addEventListener('wheel', e => this.onSvgWheel(e), { passive: false });
		// The panel sits outside <main id="content"> in the DOM, so the
		// composer's delegated click handler on #content doesn't see clicks
		// inside the panel. Bind directly here.
		this.panel.addEventListener('click', e => this.onPanelClick(e));
		if(this.resizer) {
			this.resizer.addEventListener('mousedown', e => this.startResize(e));
		}
		this.restoreWidth();
	}
	// --- Pan / zoom on the tree viewport ---------------------------------
	applyTransform() {
		if(this.viewport) {
			this.viewport.setAttribute('transform',
				`translate(${ this.tx } ${ this.ty }) scale(${ this.scale })`);
		}
	}
	fitToView() {
		if(!this.svg || !this.treeW || !this.treeH) return;
		const rect = this.svg.getBoundingClientRect();
		if(rect.width <= 0 || rect.height <= 0) return;
		const padding = 24;
		const sx = (rect.width - padding * 2) / this.treeW;
		const sy = (rect.height - padding * 2) / this.treeH;
		this.scale = Math.max(this.minScale, Math.min(this.maxScale, Math.min(sx, sy, 1)));
		this.tx = (rect.width - this.treeW * this.scale) / 2;
		this.ty = (rect.height - this.treeH * this.scale) / 2;
		this.applyTransform();
	}
	onSvgMouseDown(e) {
		// Left-button drag on empty space pans; over a node, defer to click.
		if(e.button !== 0) return;
		if(e.target.closest('[data-id]')) return;
		e.preventDefault();
		this.panning = { x: e.clientX, y: e.clientY, startTx: this.tx, startTy: this.ty };
		this.tree.classList.add('is-panning');
		const onMove = ev => {
			if(!this.panning) return;
			this.tx = this.panning.startTx + (ev.clientX - this.panning.x);
			this.ty = this.panning.startTy + (ev.clientY - this.panning.y);
			this.applyTransform();
		};
		const onUp = () => {
			this.panning = null;
			this.tree.classList.remove('is-panning');
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}
	onSvgWheel(e) {
		e.preventDefault();
		// Smooth multiplicative zoom keyed off scroll delta. ctrlKey is set
		// for trackpad pinch on macOS — same handler covers both gestures.
		const factor = Math.exp(-e.deltaY * 0.0015);
		const next = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
		if(next === this.scale) return;
		// Zoom around the cursor: keep the point under the pointer fixed.
		const rect = this.svg.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		const cy = e.clientY - rect.top;
		this.tx = cx - (cx - this.tx) * (next / this.scale);
		this.ty = cy - (cy - this.ty) * (next / this.scale);
		this.scale = next;
		this.applyTransform();
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
		case 'explorer-fit':
			this.fitToView();
			break;
		case 'explorer-live':
			this.toggleLive();
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
		// Plain click on a collapsable subtree → toggle collapse (hide its
		// children from layout + render). Shift-click → always show detail
		// (preserves the prior behavior for power users who want detail
		// without losing layout context). Click on a true visual leaf →
		// show detail (nothing to collapse). Graph mode bypasses collapse
		// entirely since the graph layout doesn't honor it.
		const collapsable = !this.useGraph
			&& node.children.length > 0
			&& !isLeafShape(node);
		if(e.shiftKey || !collapsable) {
			this.showDetail(node);
			return;
		}
		this._toggleCollapse(node);
	}
	showDetail(node) {
		if(!this.detail) {
			return;
		}
		this.detail.classList.remove('hidden');
		this.detailSource.textContent = node._inlined && node._inlinedFrom
			? `${ node._inlinedFrom }   ⟶ expanded ⟶   ${ node.text }`
			: node.text;
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
		this.renderMiniWaveform(node, ctx.sampleRate);
	}
	// Evaluate the serialized subtree for 64 sample values and draw a small
	// inline SVG waveform so you can SEE what the math produces — the single
	// biggest intuition unlock for bytebeat.
	renderMiniWaveform(node, sampleRate) {
		if(!this.waveform) return;
		this.waveform.classList.add('hidden');
		this.waveform.replaceChildren();
		// Stateful nodes (this.xx, assignments) can't be simulated cleanly.
		if(node.text.includes('this.')) return;
		let src;
		try { src = serialize(node); } catch(_) { return; }
		// Sequence + assignment expressions aren't single-value expressions.
		if(node.kind === 'SequenceExpression' || node.kind === 'AssignmentExpression') return;
		let fn;
		try {
			fn = new Function('t', '"use strict"; return (' + src + ') >>> 0;');
		} catch(_) { return; }
		const COUNT = 64, W = 224, H = 44, pad = 4;
		const values = new Float64Array(COUNT);
		let min = Infinity, max = -Infinity;
		for(let t = 0; t < COUNT; t++) {
			let v;
			try { v = Number(fn(t)) || 0; } catch(_) { v = 0; }
			values[t] = v;
			if(v < min) min = v;
			if(v > max) max = v;
		}
		const range = max - min || 1;
		const points = [];
		for(let i = 0; i < COUNT; i++) {
			const x = pad + (i / (COUNT - 1)) * (W - pad * 2);
			const y = pad + (1 - (values[i] - min) / range) * (H - pad * 2);
			points.push(`${ x.toFixed(1) },${ y.toFixed(1) }`);
		}
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${ W } ${ H }`);
		svg.setAttribute('width', String(W));
		svg.setAttribute('height', String(H));
		svg.setAttribute('class', 'explorer-waveform-svg');
		// center line
		const cl = document.createElementNS(SVG_NS, 'line');
		cl.setAttribute('x1', String(pad)); cl.setAttribute('y1', String(H / 2));
		cl.setAttribute('x2', String(W - pad)); cl.setAttribute('y2', String(H / 2));
		cl.setAttribute('stroke', '#5c636c'); cl.setAttribute('stroke-width', '0.5');
		cl.setAttribute('stroke-dasharray', '3 2');
		svg.appendChild(cl);
		const poly = document.createElementNS(SVG_NS, 'polyline');
		poly.setAttribute('points', points.join(' '));
		poly.setAttribute('fill', 'none');
		poly.setAttribute('stroke', '#4af');
		poly.setAttribute('stroke-width', '1.2');
		poly.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(poly);
		this.waveform.appendChild(svg);
		this.waveform.classList.remove('hidden');
	}
	// --- Live monitor: rAF-driven per-node evaluation --------------------
	toggleLive() {
		this.isLive ? this.stopLive() : this.startLive();
	}
	startLive() {
		if(!this.lastTree) return;
		const inst = instrument(this.lastTree);
		if(inst.count === 0) return;
		this.isLive = true;
		this._liveFn = inst.fn;
		this._liveNodes = inst.nodes;
		this._liveBuffers = inst.nodes.map(() => ({ cur: 0 }));
		// Anchor: capture the current sample position and wall-clock time.
		// We advance t from elapsed wall time so the colors move smoothly
		// at 60fps regardless of the audio worklet's message rate (~10 Hz).
		const sampleNow = this._readCurrentSample();
		this._liveStartT = sampleNow >= 0 ? sampleNow : 0;
		this._liveStartWall = performance.now();
		this._liveWasPlaying = !!(globalThis.bytebeat && globalThis.bytebeat.isPlaying);
		this.refreshLiveToggle();
		this._liveRaf = requestAnimationFrame(() => this._tickLive());
	}
	stopLive() {
		this.isLive = false;
		this.refreshLiveToggle();
		if (this._liveRaf) { cancelAnimationFrame(this._liveRaf); this._liveRaf = 0; }
		this._liveRings = null; this._livePrev = null; this._liveTick = 0;
		if (this.viewport) {
			this.viewport.querySelectorAll('.explorer-node-rect').forEach(r => r.removeAttribute('style'));
			this.viewport.querySelectorAll('.explorer-edge').forEach(e => e.removeAttribute('style'));
			this.viewport.querySelectorAll('.explorer-miniwave').forEach(w => w.remove());
		}
		const ed = globalThis.bytebeat && globalThis.bytebeat.editor;
		if (ed && ed.clearActiveRanges) ed.clearActiveRanges();
	}
	_tickLive() {
		if(!this.isLive) return;
		this._liveRaf = requestAnimationFrame(() => this._tickLive());
		const bb = globalThis.bytebeat;
		const isPlaying = !!(bb && bb.isPlaying);
		const sr = (bb && bb.sampleRate) || 8000;
		let t;
		if(isPlaying) {
			// Advance t from elapsed wall time for smooth 60fps color drift.
			// Only use the anchored start — if playback restarted, re-anchor.
			t = this._liveStartT + Math.round((performance.now() - this._liveStartWall) / 1000 * sr);
		} else {
			// Use the worklet's last-known position when paused.
			t = this._readCurrentSample();
			if(t < 0) return;
		}
		// Re-anchor when playback resumes so t doesn't jump.
		if(isPlaying && !this._liveWasPlaying) {
			const snap = this._readCurrentSample();
			if(snap >= 0) { this._liveStartT = snap; this._liveStartWall = performance.now(); }
			t = this._liveStartT;
		}
		this._liveWasPlaying = isPlaying;
		if(!this._liveFn || !this._liveBuffers) return;
		const values = new Uint32Array(this._liveBuffers.length);
		try { this._liveFn(t, values); } catch(_) { return; }
		for(let i = 0; i < values.length; i++) {
			this._liveBuffers[i].cur = values[i];
		}
		this._applyLiveColors(values);
	}
	_readCurrentSample() {
		const bb = globalThis.bytebeat;
		if(bb && typeof bb.byteSample === 'number') return bb.byteSample | 0;
		const el = document.getElementById('control-counter');
		if(!el) return -1;
		const v = parseFloat(el.value);
		return isFinite(v) ? Math.round(v) : -1;
	}
	_applyLiveColors(values) {
		if(!this.viewport) return;
		const mode = (globalThis.bytebeat && globalThis.bytebeat.mode) || 'Bytebeat';
		const masked = mode === 'Bytebeat' ? values.map(v => v & 0xff) : values;
		// Init ring buffers on first call.
		if (!this._liveRings) this._liveRings = values.map(() => ringNew(64));
		if (!this._livePrev) this._livePrev = new Float64Array(values.length);
		const rings = this._liveRings;
		const norms = new Float64Array(values.length);
		const deltas = new Float64Array(values.length);
		for (let i = 0; i < values.length; i++) {
			const v = masked[i];
			ringPush(rings[i], v);
			const r = rings[i];
			const range = r.max - r.min;
			norms[i] = range > 0 ? (v - r.min) / range : 0.5;
			const prev = this._livePrev[i];
			deltas[i] = range > 0 ? Math.abs(v - prev) / range : 0;
			this._livePrev[i] = v;
		}
		const gs = this.viewport.querySelectorAll('.explorer-node');
		let avgNorm = 0, matchN = 0;
		for (const g of gs) {
			const id = +g.getAttribute('data-id');
			if (isNaN(id)) continue;
			const node = this.byId.get(id);
			if (!node || node._liveId == null || node._liveId >= values.length) continue;
			const idx = node._liveId;
			const rect = g.querySelector('.explorer-node-rect');
			if (rect) rect.setAttribute('style', `fill:${ valueToHSL(norms[idx], deltas[idx]) }; stroke-width:${ 1 + deltas[idx] * 3 };`);
			avgNorm += norms[idx]; matchN++;
		}
		if (matchN) avgNorm /= matchN;
		// Edge pulsing.
		this.viewport.querySelectorAll('.explorer-edge').forEach(e => {
			e.setAttribute('style', `stroke-opacity:${ 0.15 + avgNorm * 0.85 };`);
		});
		// Push live-active source ranges to the editor (Strudel-style outline).
		// Take top-K by activity; dedup ranges produced by inlined sites; only
		// surface "meaningfully active" ranges (norm > 0.35) so the editor
		// isn't a permanent flicker of every node.
		const ed = globalThis.bytebeat && globalThis.bytebeat.editor;
		if (ed && ed.setActiveRanges) {
			const seen = new Set();
			const ranges = [];
			for (const [, node] of this.byId) {
				if (node._liveId == null || node._liveId >= values.length) continue;
				if (typeof node.from !== 'number' || typeof node.to !== 'number') continue;
				if (node.from >= node.to) continue;
				const n = norms[node._liveId];
				if (n < 0.35) continue;
				const key = node.from + ':' + node.to;
				if (seen.has(key)) continue;
				seen.add(key);
				ranges.push({
					from: node.from,
					to: node.to,
					color: valueToHSL(n, deltas[node._liveId]),
					norm: n
				});
			}
			ranges.sort((a, b) => b.norm - a.norm);
			ed.setActiveRanges(ranges.slice(0, 12));
		}
		// Mini-waveforms — every 3rd tick.
		if ((this._liveTick = ((this._liveTick || 0) + 1)) % 3 === 0) this._drawMiniWaves();
	}
	_drawMiniWaves() {
		const gs = this.viewport.querySelectorAll('.explorer-node');
		for (const g of gs) {
			const id = +g.getAttribute('data-id');
			if (isNaN(id)) continue;
			const node = this.byId.get(id);
			if (!node || node._liveId == null || !this._liveRings) continue;
			const ring = this._liveRings[node._liveId];
			if (!ring || ring.n < 2) continue;
			const rect = g.querySelector('.explorer-node-rect');
			if (!rect) continue;
			const rx = parseFloat(rect.getAttribute('x')), ry = parseFloat(rect.getAttribute('y'));
			const rw = parseFloat(rect.getAttribute('width')), rh = parseFloat(rect.getAttribute('height'));
			let wave = g.querySelector('.explorer-miniwave');
			if (!wave) {
				wave = document.createElementNS(SVG_NS, 'polyline');
				wave.setAttribute('class', 'explorer-miniwave');
				wave.setAttribute('fill', 'none');
				wave.setAttribute('stroke', 'rgba(255,255,255,0.45)');
				wave.setAttribute('stroke-width', '0.8');
				wave.setAttribute('stroke-linejoin', 'round');
				g.appendChild(wave);
			}
			const W = rw - 16, H = 12, wx = rx + 8, wy = ry + rh - 18;
			wave.setAttribute('transform', `translate(${ wx.toFixed(1) }, ${ wy.toFixed(1) })`);
			const range = ring.max - ring.min;
			const pts = [];
			for (let i = 0; i < ring.n; i++) {
				const x = (i / Math.max(ring.n - 1, 1)) * W;
				const nr = range > 0 ? (ring.d[i] - ring.min) / range : 0.5;
				pts.push(`${ x.toFixed(1) },${ ((1 - nr) * H).toFixed(1) }`);
			}
			wave.setAttribute('points', pts.join(' '));
		}
	}
	refreshLiveToggle() {
		const btn = document.getElementById('explorer-live');
		if(btn) btn.classList.toggle('is-active', this.isLive);
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
		this.stopLive();
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
		// Restore persisted collapse state before any layout sees the tree —
		// isVisualLeaf gates Buchheim on _collapsed.
		this._applyCollapseStore(tree);

		if (this.useGraph && this.graph && this.graph.nodes.size > 0) {
			// ── Graph-driven layout ──────────────────────────────
			this.svg.removeAttribute('viewBox');
			this.defineMarkers();
			this.viewport = document.createElementNS(SVG_NS, 'g');
			this.viewport.setAttribute('class', 'explorer-viewport');
			this.svg.appendChild(this.viewport);
			if (!this.canvas) {
				this.canvas = new GraphCanvas(this.svg, this.graph, {
					onHover: (from, to) => { /* graph nodes don't map to source ranges yet */ },
					onLeave: () => {},
					onClick: (node) => { /* detail panel */ },
				});
			}
			this.canvas.graph = this.graph;
			this.canvas.viewport = this.viewport;
			this.canvas.render();
			// Estimate tree bounds from node positions.
			let maxX = 0, maxY = 0;
			for (const [, pos] of this.canvas.nodePos) {
				if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W;
				if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H;
			}
			this.treeW = maxX + 16;
			this.treeH = maxY + 16 + OUTPUT_GAP + NODE_H;
			if (this._lastFittedSource !== source) {
				this.fitToView();
				this._lastFittedSource = source;
			} else {
				this.applyTransform();
			}
			// Re-instrument for live mode.
			if (this.isLive) { this.stopLive(); this.startLive(); }
			return;
		}

		// ── Tree-driven layout (fallback) ────────────────────
		this.measure(tree);
		// Bottom-up layout: leaves at y=top, root at y=bottom (signal flow).
		const treeDepth = this.depth(tree);
		const showVoices = tree.kind === 'BinaryExpression' && tree.op === '+' && tree.children.length >= 2;
		const top = LANE_LABEL_HEIGHT + 4;
		const rootY = top + treeDepth * (NODE_HEIGHT + LEVEL_GAP);
		const totalW = this.layout(tree, rootY);
		const totalH = rootY + NODE_HEIGHT + OUTPUT_GAP + NODE_HEIGHT + 8;
		this.treeW = totalW;
		this.treeH = totalH;
		// SVG fills the panel; the viewport <g> inside carries the pan/zoom
		// transform so the tree's own coordinates stay simple.
		this.svg.removeAttribute('viewBox');
		this.defineMarkers();
		this.viewport = document.createElementNS(SVG_NS, 'g');
		this.viewport.setAttribute('class', 'explorer-viewport');
		this.svg.appendChild(this.viewport);
		this.draw(tree);
		if(showVoices) {
			this.drawVoiceLabels(tree);
		}
		this.drawOutputNode(tree, totalW);
		// Auto-fit on first render of a given source; preserve user's zoom
		// during edit-driven re-renders so typing doesn't snap their view.
		if(this._lastFittedSource !== source) {
			this.fitToView();
			this._lastFittedSource = source;
		} else {
			this.applyTransform();
		}
		// Re-instrument for live mode when the tree changes (e.g., after solo,
		// inline expansion, or edit-driven re-parse).
		if(this.isLive) {
			this.stopLive();
			this.startLive();
		}
	}
	assignIds(node, counter) {
		node._id = counter.n++;
		this.byId.set(node._id, node);
		for(const c of node.children) {
			this.assignIds(c, counter);
		}
	}
	measure(node) {
		// Per-node width only. The prior layout packed siblings into a fixed
		// subtree slot (_sw); Buchheim places by contour, so the slot concept
		// is gone — siblings overlap horizontally where their contours allow.
		const { top, bottom } = this.labels(node);
		// CHAR_WIDTH suits the monospace top line; sans-serif bottom is a
		// touch wider than mono at the same px size so we use ~6.5.
		const topW = top.length * CHAR_WIDTH;
		const botW = Math.ceil(bottom.length * 6.5);
		node._w = Math.max(72, NODE_PADDING_X * 2 + Math.max(topW, botW));
		if(this.isVisualLeaf(node)) return;
		for(const c of node.children) this.measure(c);
	}
	// "Visual leaf" — no children drawn, even when the AST has them. Captures
	// raw bytebeat inputs like `t`, numbers, and `t >> N` / `t << N` /
	// `t & literal`, which we display as a single gray box matching their
	// source text instead of drilling into a 3-node subtree.
	isVisualLeaf(node) {
		// `_collapsed` short-circuits every layout/render traversal that gates
		// on isVisualLeaf — Buchheim helpers stop at this node, draw() emits
		// the box without recursing into children, _eachNode stops walking.
		// Net effect: collapsed subtrees are completely invisible to layout.
		if(node._collapsed) return true;
		return node.children.length === 0 || isLeafShape(node);
	}
	// Buchheim tidy-tree layout — linear time, minimum width, no overlapping
	// nodes, no overlapping subtrees. Reference: Buchheim/Jünger/Leipert 2002
	// "Improving Walker's Algorithm to Run in Linear Time." Children sit
	// ABOVE their parent (signal flows down into ops). Assigns _x/_y on every
	// node. Returns the canvas width needed; left edge is at 8px after shift.
	layout(root, rootY) {
		this._buchheimInit(root, null);
		this._firstWalk(root);
		this._secondWalk(root, -root._prelim);
		this._applyY(root, rootY);
		// Shift x so leftmost node is at 8px; collect bounding box.
		let minX = Infinity, maxX = -Infinity;
		this._eachNode(root, n => {
			if(n._x < minX) minX = n._x;
			if(n._x + n._w > maxX) maxX = n._x + n._w;
		});
		const dx = 8 - minX;
		this._eachNode(root, n => { n._x += dx; });
		this._applyStoredPositions(root);
		return (maxX - minX) + 16;
	}
	// Stable per-subtree identity = FNV-1a hash of source text + length. Same
	// subtree text → same fingerprint, so identical subtrees in different
	// branches share a slot (acceptable for v1 — refine when drag UX exists).
	// Any source edit invalidates the fingerprint of the changed subtree,
	// dropping stored positions for that range.
	_fingerprint(node) {
		if(!node || !node.text) return '';
		const t = node.text;
		let h = 0x811c9dc5;
		for(let i = 0; i < t.length; i++) {
			h ^= t.charCodeAt(i);
			h = (h * 0x01000193) >>> 0;
		}
		return h.toString(36) + ':' + t.length;
	}
	// Override _x/_y for nodes whose locked position is in the store. Runs
	// AFTER the canvas-shift so stored coords are absolute (post-shift).
	_applyStoredPositions(root) {
		if(this.positionStore.size === 0) return;
		this._eachNode(root, n => {
			const stored = this.positionStore.get(this._fingerprint(n));
			if(stored && stored.locked) {
				n._x = stored.x;
				n._y = stored.y;
				n._restored = true;
			}
		});
	}
	// Public API for Phase G drag: persist a user-placed node position.
	setManualPosition(node, x, y) {
		this.positionStore.set(this._fingerprint(node), { x, y, locked: true });
		this._savePositionStore();
	}
	_loadPositionStore() {
		try {
			const raw = localStorage.getItem('coderadio.explorer.positions');
			if(!raw) return new Map();
			return new Map(JSON.parse(raw));
		} catch(_) { return new Map(); }
	}
	_savePositionStore() {
		try {
			localStorage.setItem('coderadio.explorer.positions',
				JSON.stringify([...this.positionStore]));
		} catch(_) { /* private mode etc. */ }
	}
	_loadCollapseStore() {
		try {
			const raw = localStorage.getItem('coderadio.explorer.collapsed');
			if(!raw) return new Set();
			return new Set(JSON.parse(raw));
		} catch(_) { return new Set(); }
	}
	_saveCollapseStore() {
		try {
			localStorage.setItem('coderadio.explorer.collapsed',
				JSON.stringify([...this.collapseStore]));
		} catch(_) { /* private mode etc. */ }
	}
	// Walk every node in the tree (NOT short-circuiting on collapse) and set
	// `_collapsed` from the persisted store. Must run after assignIds and
	// before measure/layout so Buchheim sees the correct visual-leaf set.
	_applyCollapseStore(root) {
		const walk = n => {
			n._collapsed = this.collapseStore.has(this._fingerprint(n));
			for(const c of n.children) walk(c);
		};
		walk(root);
	}
	_countDescendants(node) {
		let n = 0;
		for(const c of node.children) {
			n += 1 + this._countDescendants(c);
		}
		return n;
	}
	// Flip a node's collapse state and redraw the tree (no re-parse, no
	// detail-panel reset). Persisted by fingerprint so the same subtree text
	// stays collapsed across edits.
	_toggleCollapse(node) {
		const fp = this._fingerprint(node);
		if(this.collapseStore.has(fp)) {
			this.collapseStore.delete(fp);
			node._collapsed = false;
		} else {
			this.collapseStore.add(fp);
			node._collapsed = true;
		}
		this._saveCollapseStore();
		this._redrawTree();
	}
	// Redraw `this.lastTree` after a collapse toggle, reusing the cached
	// parse. Mirrors the tree-driven branch of render() but skips the
	// re-parse, the selection clear, the detail-panel hide, and the
	// auto-fit (keeps the user's current pan/zoom).
	_redrawTree() {
		if(!this.lastTree || !this.svg || this.useGraph) return;
		this.svg.replaceChildren();
		this.byId.clear();
		this.assignIds(this.lastTree, { n: 0 });
		this._applyCollapseStore(this.lastTree);
		this.measure(this.lastTree);
		const treeDepth = this.depth(this.lastTree);
		const showVoices = this.lastTree.kind === 'BinaryExpression'
			&& this.lastTree.op === '+'
			&& this.lastTree.children.length >= 2;
		const top = LANE_LABEL_HEIGHT + 4;
		const rootY = top + treeDepth * (NODE_HEIGHT + LEVEL_GAP);
		const totalW = this.layout(this.lastTree, rootY);
		const totalH = rootY + NODE_HEIGHT + OUTPUT_GAP + NODE_HEIGHT + 8;
		this.treeW = totalW;
		this.treeH = totalH;
		this.svg.removeAttribute('viewBox');
		this.defineMarkers();
		this.viewport = document.createElementNS(SVG_NS, 'g');
		this.viewport.setAttribute('class', 'explorer-viewport');
		this.svg.appendChild(this.viewport);
		this.draw(this.lastTree);
		if(showVoices) this.drawVoiceLabels(this.lastTree);
		this.drawOutputNode(this.lastTree, totalW);
		this.applyTransform();
		if(this.isLive) { this.stopLive(); this.startLive(); }
	}
	_buchheimInit(node, parent) {
		node._prelim = 0;
		node._mod = 0;
		node._thread = null;
		node._ancestor = node;
		node._change = 0;
		node._shift = 0;
		node._parent = parent;
		if(this.isVisualLeaf(node)) return;
		for(const c of node.children) this._buchheimInit(c, node);
	}
	_firstWalk(v) {
		if(this.isVisualLeaf(v) || v.children.length === 0) {
			const ls = this._leftSibling(v);
			v._prelim = ls ? ls._prelim + this._distance(ls, v) : 0;
			return;
		}
		let defaultAncestor = v.children[0];
		for(const w of v.children) {
			this._firstWalk(w);
			defaultAncestor = this._apportion(w, defaultAncestor);
		}
		this._executeShifts(v);
		const first = v.children[0]._prelim;
		const last = v.children[v.children.length - 1]._prelim;
		const midpoint = (first + last) / 2;
		const ls = this._leftSibling(v);
		if(ls) {
			v._prelim = ls._prelim + this._distance(ls, v);
			v._mod = v._prelim - midpoint;
		} else {
			v._prelim = midpoint;
		}
	}
	_apportion(v, defaultAncestor) {
		const w = this._leftSibling(v);
		if(!w) return defaultAncestor;
		// vi*/vo* are the inner/outer right/left contour walkers.
		let vir = v, vor = v;
		let vil = w, vol = this._leftmostSibling(v);
		let sir = vir._mod, sor = vor._mod;
		let sil = vil._mod, sol = vol._mod;
		let nextL = this._nextLeft(vir), nextR = this._nextRight(vil);
		while(nextR && nextL) {
			vil = nextR;
			vir = nextL;
			vol = this._nextLeft(vol);
			vor = this._nextRight(vor);
			vor._ancestor = v;
			const shift = (vil._prelim + sil) - (vir._prelim + sir) + this._distance(vil, vir);
			if(shift > 0) {
				const a = this._buchheimAncestor(vil, v, defaultAncestor);
				this._moveSubtree(a, v, shift);
				sir += shift;
				sor += shift;
			}
			sil += vil._mod;
			sir += vir._mod;
			sol += vol._mod;
			sor += vor._mod;
			nextL = this._nextLeft(vir);
			nextR = this._nextRight(vil);
		}
		if(nextR && !this._nextRight(vor)) {
			vor._thread = nextR;
			vor._mod += sil - sor;
		}
		if(nextL && !this._nextLeft(vol)) {
			vol._thread = nextL;
			vol._mod += sir - sol;
			defaultAncestor = v;
		}
		return defaultAncestor;
	}
	_moveSubtree(wl, wr, shift) {
		const wlIdx = wl._parent ? wl._parent.children.indexOf(wl) : 0;
		const wrIdx = wr._parent ? wr._parent.children.indexOf(wr) : 0;
		const subtrees = wrIdx - wlIdx;
		if(subtrees === 0) return;
		wr._change -= shift / subtrees;
		wr._shift += shift;
		wl._change += shift / subtrees;
		wr._prelim += shift;
		wr._mod += shift;
	}
	_executeShifts(v) {
		let shift = 0, change = 0;
		for(let i = v.children.length - 1; i >= 0; i--) {
			const w = v.children[i];
			w._prelim += shift;
			w._mod += shift;
			change += w._change;
			shift += w._shift + change;
		}
	}
	_buchheimAncestor(vil, v, defaultAncestor) {
		if(v._parent && v._parent.children.indexOf(vil._ancestor) !== -1) {
			return vil._ancestor;
		}
		return defaultAncestor;
	}
	_nextLeft(v) {
		return (this.isVisualLeaf(v) || v.children.length === 0) ? v._thread : v.children[0];
	}
	_nextRight(v) {
		return (this.isVisualLeaf(v) || v.children.length === 0) ? v._thread : v.children[v.children.length - 1];
	}
	_leftSibling(v) {
		if(!v._parent) return null;
		const idx = v._parent.children.indexOf(v);
		return idx > 0 ? v._parent.children[idx - 1] : null;
	}
	_leftmostSibling(v) {
		if(!v._parent) return null;
		return v._parent.children[0];
	}
	_distance(a, b) {
		return (a._w + b._w) / 2 + SIBLING_GAP;
	}
	_secondWalk(v, m) {
		v._x = v._prelim + m;
		if(this.isVisualLeaf(v)) return;
		for(const c of v.children) this._secondWalk(c, m + v._mod);
	}
	_applyY(node, rootY) {
		const setY = (n, depth) => {
			n._y = rootY - depth * (NODE_HEIGHT + LEVEL_GAP);
			if(!this.isVisualLeaf(n)) {
				for(const c of n.children) setY(c, depth + 1);
			}
		};
		setY(node, 0);
	}
	_eachNode(node, cb) {
		cb(node);
		if(this.isVisualLeaf(node)) return;
		for(const c of node.children) this._eachNode(c, cb);
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
			this.viewport.appendChild(path);
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
		const cls = ['explorer-node', `role-${ role }`];
		if(node._inlined) cls.push('is-inlined');
		if(node._collapsed) cls.push('is-collapsed');
		g.setAttribute('class', cls.join(' '));
		g.setAttribute('data-from', String(node.from));
		g.setAttribute('data-to', String(node.to));
		g.setAttribute('data-id', String(node._id));
		// Native browser tooltip on hover — bottom line from labels() for
		// quick per-node context without clicking. When bottom is empty,
		// fall back to the node's kind and source range for orientation.
		const tip = bottom || `${ node.kind } [${ node.from }–${ node.to }]`;
		g.setAttribute('title', node.text.length > 60 ? node.text.slice(0, 58) + '… — ' + tip : tip);
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
		this.viewport.appendChild(g);
	}
	// Two-line label: top is the operator/value (verbose for combinators —
	// e.g. "OR ( | )"), bottom is the short annotation when we have one.
	// Visual leaves render their full source text on the top line ("t >> 7"
	// instead of just ">>") since we never expose their interior.
	labels(node) {
		const result = this._labelsCore(node);
		// Collapsed marker — overrides the bottom line so the user always
		// sees how many descendants are tucked away. `_countDescendants`
		// walks the AST (NOT the visual-leaf-gated traversal), so the count
		// reflects the actual hidden subtree size.
		if(node._collapsed) {
			result.bottom = `▸ ${ this._countDescendants(node) } hidden`;
		}
		return result;
	}
	_labelsCore(node) {
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
			this.viewport.appendChild(label);
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
		this.viewport.appendChild(path);
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
		this.viewport.appendChild(g);
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
		const shaped = raw ? specialize(flatten(raw)) : null;
		this.lastTree = shaped ? inline(shaped) : null;
		// Also build the graph model from the raw (pre-specialize) tree so the
		// graph canvas always starts from a clean, non-specialized structure.
		this.graph = raw ? treeToGraph(raw) : null;
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
		const calleeNode = callee ? this.build(callee, src) : null;
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
			callee: calleeNode,   // structured callee for inline()
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
			params,            // structured for inline()
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

// Walk the simplified tree, find named-helper assignments inside
// SequenceExpressions (`f = (x) => body, …, f(arg)`) and inline-IIFEs
// (`function(x){return body}(arg)` / `((x) => body)(arg)`), and substitute
// arguments into the body at every call site so the user can see the actual
// per-sample computation rather than an opaque `f(t)` leaf.
//
// Inlined nodes get `_inlined: true` so the renderer can mark them
// visually and the detail panel can mention "expanded from f(t)".
const MAX_INLINE_DEPTH = 4;
function inline(node, scope = new Map(), depth = 0) {
	if(!node) return node;
	// Sequence introduces a scope: pre-scan its children for helper bindings
	// (assign of variable to function), then expand children with that scope.
	if(node.kind === 'SequenceExpression') {
		const inner = new Map(scope);
		for(const c of node.children) {
			collectBinding(c, inner);
		}
		return Object.assign({}, node, {
			children: node.children.map(c => inline(c, inner, depth))
		});
	}
	if(node.kind === 'CallExpression') {
		const expandedArgs = node.children.map(c => inline(c, scope, depth));
		const expanded = expandCall(node, expandedArgs, scope, depth);
		if(expanded) return expanded;
		return Object.assign({}, node, {
			children: expandedArgs,
			callee: node.callee ? inline(node.callee, scope, depth) : null
		});
	}
	if(node.children && node.children.length) {
		return Object.assign({}, node, {
			children: node.children.map(c => inline(c, scope, depth))
		});
	}
	return node;
}
function collectBinding(child, scope) {
	if(child && child.kind === 'AssignmentExpression'
		&& child.children.length === 2
		&& child.children[0] && child.children[0].kind === 'Variable'
		&& child.children[1] && child.children[1].kind === 'FunctionExpression'
		&& child.children[1].children.length === 1) {
		const name = child.children[0].op;
		const fn = child.children[1];
		if(fn.params) {  // arity zero is fine — `f = () => 5` still inlines
			scope.set(name, { params: fn.params, body: fn.children[0] });
		}
	}
}
// Returns a substituted body if the call can be expanded, else null.
function expandCall(callNode, args, scope, depth) {
	if(depth >= MAX_INLINE_DEPTH || !callNode.callee) return null;
	let target = null;
	let params = null;
	const callee = callNode.callee;
	if(callee.kind === 'Variable') {
		const fn = scope.get(callee.op);
		if(fn) { target = fn.body; params = fn.params; }
	} else if(callee.kind === 'FunctionExpression'
		&& callee.children.length === 1
		&& callee.params) {
		// IIFE — inline the function body directly.
		target = callee.children[0];
		params = callee.params;
	}
	if(!target || !params || params.length !== args.length) return null;
	const paramMap = new Map();
	for(let i = 0; i < params.length; i++) paramMap.set(params[i], args[i]);
	const substituted = substitute(deepCopy(target), paramMap, callNode);
	const expanded = inline(substituted, scope, depth + 1);
	if(expanded) {
		expanded._inlined = true;
		expanded._inlinedFrom = callNode.text;
	}
	return expanded;
}
// Deep-copy node tree so substitution doesn't mutate the function body
// (which may be re-used across multiple call sites).
function deepCopy(node) {
	if(!node) return node;
	const copy = Object.assign({}, node);
	if(node.children) copy.children = node.children.map(deepCopy);
	if(node.callee) copy.callee = deepCopy(node.callee);
	return copy;
}
function substitute(node, paramMap, callSite) {
	if(!node) return node;
	if(node.kind === 'Variable' && paramMap.has(node.op)) {
		const arg = paramMap.get(node.op);
		// Anchor the substituted subtree's source range to the call site so
		// hover-highlight in the editor lights up the call, not the original
		// param reference inside the function body.
		const stamp = Object.assign({}, arg);
		if(callSite) {
			stamp.from = callSite.from;
			stamp.to = callSite.to;
		}
		return stamp;
	}
	if(node.children) {
		node.children = node.children.map(c => substitute(c, paramMap, callSite));
	}
	if(node.callee) {
		node.callee = substitute(node.callee, paramMap, callSite);
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
