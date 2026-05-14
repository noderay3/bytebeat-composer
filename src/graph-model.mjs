// Flat node-graph model that replaces the nested {kind,op,children} tree.
// Each node has typed input/output ports. Connections are stored as
// {sourceNodeId, sourcePortId, targetNodeId, targetPortId} records on
// the output port.
//
// This is the source of truth for the hybrid editor — the text and audio
// engine are derived from it.

let _nextId = 1;

export class Graph {
	constructor() {
		this.nodes = new Map();          // id → GraphNode
		this.outputNodeId = null;        // the synthetic output node
	}

	// ── Mutation ────────────────────────────────────────────────────

	addNode(type, label, meta = {}, position = { x: 0, y: 0 }) {
		const id = _nextId++;
		const node = {
			id, type, label, meta, position,
			inputs: [],     // GraphPort[]
			outputs: [],    // GraphPort[]
		};
		initPorts(node);
		this.nodes.set(id, node);
		return node;
	}

	removeNode(id) {
		const node = this.nodes.get(id);
		if (!node) return;
		// Remove all connections TO this node (incoming).
		for (const ip of node.inputs) {
			for (const conn of [...ip.connections]) {
				this._dropConn(conn);
			}
		}
		// Remove all connections FROM this node (outgoing).
		for (const op of node.outputs) {
			for (const conn of [...op.connections]) {
				this._dropConn(conn);
			}
		}
		this.nodes.delete(id);
	}

	connect(srcId, srcPortId, tgtId, tgtPortId) {
		const src = this.nodes.get(srcId);
		const tgt = this.nodes.get(tgtId);
		if (!src || !tgt) return false;
		const sp = src.outputs.find(p => p.id === srcPortId);
		const tp = tgt.inputs.find(p => p.id === tgtPortId);
		if (!sp || !tp) return false;
		// Value ports accept at most one incoming connection.
		if (tp.kind === 'value' && tp.connections.length) {
			this._dropConn(tp.connections[0]);
		}
		const conn = { sourceNodeId: srcId, sourcePortId: srcPortId, targetNodeId: tgtId, targetPortId: tgtPortId };
		sp.connections.push(conn);
		tp.connections.push(conn);
		return true;
	}

	disconnect(srcId, srcPortId, tgtId, tgtPortId) {
		const src = this.nodes.get(srcId);
		const tgt = this.nodes.get(tgtId);
		if (!src || !tgt) return false;
		const sp = src.outputs.find(p => p.id === srcPortId);
		const tp = tgt.inputs.find(p => p.id === tgtPortId);
		if (!sp || !tp) return false;
		const ci = sp.connections.findIndex(c => c.targetNodeId === tgtId && c.targetPortId === tgtPortId);
		if (ci >= 0) sp.connections.splice(ci, 1);
		const ti = tp.connections.findIndex(c => c.sourceNodeId === srcId && c.sourcePortId === srcPortId);
		if (ti >= 0) tp.connections.splice(ti, 1);
		return true;
	}

	// ── Queries ──────────────────────────────────────────────────────

	getNode(id) { return this.nodes.get(id); }

	findByType(type) {
		return [...this.nodes.values()].filter(n => n.type === type);
	}

	// ── Serialization ────────────────────────────────────────────────

	toJSON() {
		return {
			nodes: [...this.nodes.values()].map(n => ({
				id: n.id, type: n.type, label: n.label, meta: n.meta,
				position: n.position,
				inputs: n.inputs.map(p => ({
					id: p.id, kind: p.kind, name: p.name,
					connections: p.connections.map(c => ({ sourceNodeId: c.sourceNodeId, sourcePortId: c.sourcePortId, targetNodeId: c.targetNodeId, targetPortId: c.targetPortId })),
				})),
				outputs: n.outputs.map(p => ({
					id: p.id, kind: p.kind, name: p.name,
					connections: p.connections.map(c => ({ sourceNodeId: c.sourceNodeId, sourcePortId: c.sourcePortId, targetNodeId: c.targetNodeId, targetPortId: c.targetPortId })),
				})),
			})),
			outputNodeId: this.outputNodeId,
		};
	}

	static fromJSON(json) {
		const g = new Graph();
		g.outputNodeId = json.outputNodeId;
		for (const nd of json.nodes) {
			_nextId = Math.max(_nextId, nd.id + 1);
			g.nodes.set(nd.id, {
				id: nd.id, type: nd.type, label: nd.label, meta: nd.meta || {},
				position: nd.position || { x: 0, y: 0 },
				inputs: nd.inputs.map(p => ({ id: p.id, kind: p.kind, name: p.name, connections: [] })),
				outputs: nd.outputs.map(p => ({ id: p.id, kind: p.kind, name: p.name, connections: [] })),
			});
		}
		// Re-hydrate connections.
		for (const nd of json.nodes) {
			const node = g.nodes.get(nd.id);
			for (const pj of nd.inputs) {
				const port = node.inputs.find(p => p.id === pj.id);
				for (const cj of pj.connections) {
					const src = g.nodes.get(cj.sourceNodeId);
					if (!src) continue;
					const op = src.outputs.find(p => p.id === cj.sourcePortId);
					if (!op) continue;
					const conn = { sourceNodeId: cj.sourceNodeId, sourcePortId: cj.sourcePortId, targetNodeId: cj.targetNodeId, targetPortId: cj.targetPortId };
					port.connections.push(conn);
					op.connections.push(conn);
				}
			}
		}
		return g;
	}

	// ── Internal ─────────────────────────────────────────────────────

	_dropConn(conn) {
		const src = this.nodes.get(conn.sourceNodeId);
		const tgt = this.nodes.get(conn.targetNodeId);
		if (src) {
			const sp = src.outputs.find(p => p.id === conn.sourcePortId);
			if (sp) sp.connections = sp.connections.filter(c => c !== conn);
		}
		if (tgt) {
			const tp = tgt.inputs.find(p => p.id === conn.targetPortId);
			if (tp) tp.connections = tp.connections.filter(c => c !== conn);
		}
	}
}

// ── Port initialization per node type ──────────────────────────────────

function initPorts(node) {
	switch (node.type) {
	case 'number':
	case 'variable':
	case 'string':
	case 'array':
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'binary':
		node.inputs = [
			{ id: 'in-0', kind: 'value', name: 'left', connections: [] },
			{ id: 'in-1', kind: 'value', name: 'right', connections: [] },
		];
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'unary':
		node.inputs = [{ id: 'in-0', kind: 'value', name: 'operand', connections: [] }];
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'conditional':
		node.inputs = [
			{ id: 'in-0', kind: 'value', name: 'test', connections: [] },
			{ id: 'in-1', kind: 'value', name: 'consequent', connections: [] },
			{ id: 'in-2', kind: 'value', name: 'alternate', connections: [] },
		];
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'call':
		// Input ports are added dynamically — one per argument.
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'member':
		node.inputs = [
			{ id: 'in-0', kind: 'value', name: 'object', connections: [] },
			{ id: 'in-1', kind: 'value', name: 'property', connections: [] },
		];
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'sequence':
		// Inputs added dynamically per step.
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'assignment':
		node.inputs = [
			{ id: 'in-0', kind: 'value', name: 'target', connections: [] },
			{ id: 'in-1', kind: 'value', name: 'source', connections: [] },
		];
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'value', connections: [] }];
		break;
	case 'function':
		node.inputs = [{ id: 'in-0', kind: 'value', name: 'body', connections: [] }];
		node.outputs = [{ id: 'out-0', kind: 'value', name: 'fn', connections: [] }];
		break;
	case 'output':
		node.inputs = [{ id: 'in-0', kind: 'value', name: 'raw', connections: [] }];
		break;
	}
}

// ── Tree → Graph converter ─────────────────────────────────────────────

import { serialize } from './serializer.mjs';

/**
 * Convert the Explorer's simplified tree to a flat Graph.
 * The tree root connects to a synthetic "output" node.
 * @param {Object} tree — root of the simplified tree from Explorer.parse()
 * @param {string} mode  — 'Bytebeat' | 'Signed Bytebeat' | 'Floatbeat'
 * @returns {Graph}
 */
export function treeToGraph(tree, mode = 'Bytebeat') {
	const g = new Graph();
	if (!tree) return g;

	// Walk the tree depth-first, creating graph nodes with explicit ids.
	const nodeMap = new Map(); // tree node → graph node id
	let nextId = 0;
	walk(tree);
	// Wire children → parent via ports.
	wire(tree);
	// Create a synthetic output node connected to the root.
	const rootGraphId = nodeMap.get(tree);
	if (rootGraphId != null) {
		const out = g.addNode('output', 'audio out', { mode });
		g.outputNodeId = out.id;
		g.connect(rootGraphId, 'out-0', out.id, 'in-0');
	}
	return g;

	function walk(tn) {
		if (!tn) return;
		// N-ary chains from flatten(): collapse into left-assoc binary nodes.
		if (tn.kind === 'BinaryExpression' && (tn.children || []).length > 2) {
			walkNary(tn);
			return;
		}
		// MulConstExpression: expand to `N * child` binary node.
		if (tn.kind === 'MulConstExpression') {
			walkMulConst(tn);
			return;
		}
		const { type, label, meta } = translate(tn);
		const gn = g.addNode(type, label, meta);
		nodeMap.set(tn, gn.id);
		if (type === 'call') {
			const argc = (tn.children || []).length;
			gn.inputs = [];
			for (let i = 0; i < argc; i++) {
				gn.inputs.push({ id: `in-${i}`, kind: 'value', name: `arg${i}`, connections: [] });
			}
		}
		if (type === 'sequence') {
			const steps = (tn.children || []).length;
			gn.inputs = [];
			for (let i = 0; i < steps; i++) {
				gn.inputs.push({ id: `in-${i}`, kind: 'value', name: `step${i}`, connections: [] });
			}
		}
		if (tn.children) for (const c of tn.children) walk(c);
		if (tn.callee) walk(tn.callee);
	}

	// Collapse n-ary into left-assoc binary chain: a|b|c → (a|b)|c
	function walkNary(tn) {
		const children = tn.children || [];
		if (children.length === 0) return;
		if (children.length === 1) { walk(children[0]); nodeMap.set(tn, nodeMap.get(children[0])); return; }
		// Build chain left-to-right.
		let left = children[0];
		walk(left);
		for (let i = 1; i < children.length; i++) {
			const right = children[i];
			walk(right);
			const gn = g.addNode('binary', tn.op, { op: tn.op });
			const lid = nodeMap.get(left);
			const rid = nodeMap.get(right);
			g.connect(lid, 'out-0', gn.id, 'in-0');
			g.connect(rid, 'out-0', gn.id, 'in-1');
			left = { _fake: true }; // synthetic wrapper for next iteration
			nodeMap.set(left, gn.id);
		}
		nodeMap.set(tn, nodeMap.get(left));
	}

	// Expand N × child into a binary * with a number literal on the left.
	function walkMulConst(tn) {
		const N = parseFloat(tn.op.replace(/^×\s*/, '')) || 1;
		const numNode = g.addNode('number', String(N), { value: N });
		if ((tn.children || []).length) {
			walk(tn.children[0]);
		}
		const gn = g.addNode('binary', '*', { op: '*' });
		g.connect(numNode.id, 'out-0', gn.id, 'in-0');
		if ((tn.children || []).length) {
			const cid = nodeMap.get(tn.children[0]);
			g.connect(cid, 'out-0', gn.id, 'in-1');
		}
		nodeMap.set(tn, gn.id);
	}

	function wire(tn) {
		if (!tn) return;
		// N-ary and MulConst nodes are already wired inside walkNary /
		// walkMulConst — but their CHILDREN are normal nodes that still
		// need wiring. Recurse, don't bail.
		if (tn.kind === 'BinaryExpression' && (tn.children || []).length > 2) {
			if (tn.children) for (const c of tn.children) wire(c);
			return;
		}
		if (tn.kind === 'MulConstExpression') {
			if (tn.children) for (const c of tn.children) wire(c);
			return;
		}
		const gid = nodeMap.get(tn);
		if (tn.children) {
			tn.children.forEach((c, i) => {
				const cid = nodeMap.get(c);
				if (cid != null && gid != null) {
					g.connect(cid, 'out-0', gid, `in-${i}`);
				}
			});
		}
		if (tn.children) for (const c of tn.children) wire(c);
		if (tn.callee) wire(tn.callee);
	}
}

// ── Tree → Graph type translation ───────────────────────────────────────

function translate(tn) {
	switch (tn.kind) {
	case 'Number':          return { type: 'number', label: tn.op, meta: { value: Number(tn.op) } };
	case 'Variable':        return { type: 'variable', label: tn.op, meta: { name: tn.op } };
	case 'String':          return { type: 'string', label: tn.op, meta: { value: tn.op } };
	case 'BinaryExpression': return { type: 'binary', label: tn.op, meta: { op: tn.op } };
	case 'UnaryExpression':  return { type: 'unary', label: tn.op, meta: { op: tn.op } };
	case 'ConditionalExpression': return { type: 'conditional', label: '?:', meta: {} };
	case 'CallExpression':
		return { type: 'call', label: tn.op, meta: { callee: tn.op.replace(/\(\)$/, '') } };
	case 'MemberExpression':
		return { type: 'member', label: tn.op, meta: { text: tn.text } };
	case 'SequenceExpression': return { type: 'sequence', label: ',', meta: {} };
	case 'AssignmentExpression': return { type: 'assignment', label: tn.op, meta: { op: tn.op } };
	case 'FunctionExpression': return { type: 'function', label: tn.op, meta: { params: tn.params || [] } };
	case 'MulConstExpression':
		return { type: 'unary', label: tn.op, meta: { op: '×' } };
	case 'ArrayExpression':
		return { type: 'array', label: tn.op, meta: { text: tn.text } };
	case 'ObjectExpression':
	case 'RegExp':
	case 'ParseError':
		return { type: 'variable', label: tn.op, meta: { name: tn.op } };
	default:
		return { type: 'variable', label: tn.kind || '?', meta: { name: tn.op || '?' } };
	}
}
