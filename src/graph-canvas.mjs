// Render a Graph as an interactive SVG canvas. Replaces the tree-viewer's
// draw() and drawNode() with graph-driven equivalents. Pan/zoom, hover
// highlight, and click-to-detail are preserved from the existing Explorer.
//
// Layout: hierarchical layout from the output node upward. Leaf nodes
// gather at the top, combinators below, output at the bottom.

const SVG_NS = 'http://www.w3.org/2000/svg';
export const NODE_W = 110;
export const NODE_H = 50;
const PORT_R = 5;
const H_GAP = 40;
const V_GAP = 28;

export class GraphCanvas {
	/**
	 * @param {SVGElement} svg — the #explorer-svg element
	 * @param {import('./graph-model.mjs').Graph} graph
	 * @param {Object} events — { onHover(from,to), onLeave(), onClick(node) }
	 */
	constructor(svg, graph, events = {}) {
		this.svg = svg;
		this.graph = graph;
		this.events = events;
		this.viewport = null;   // <g> for pan/zoom (set by caller)
		this.nodePos = new Map(); // graph node id → { x, y }
	}

	/** Full render — clear and redraw everything. */
	render() {
		if (!this.viewport) return;
		this.viewport.replaceChildren();
		this.nodePos.clear();
		if (!this.graph || this.graph.nodes.size === 0) return;

		// Build a depth map from the output node.
		const depths = this._computeDepths();

		// Group nodes by depth for lane assignment.
		const lanes = new Map(); // depth → [nodeId, ...]
		for (const [id] of this.graph.nodes) {
			const d = depths.get(id) ?? 0;
			if (!lanes.has(d)) lanes.set(d, []);
			lanes.get(d).push(id);
		}
		// Lane width = max nodes per depth.
		let maxW = 0;
		for (const [, ids] of lanes) maxW = Math.max(maxW, ids.length);

		// Assign positions: depth 0 at top, increasing downward.
		for (const [depth, ids] of lanes) {
			const rowW = ids.length * (NODE_W + H_GAP) - H_GAP;
			const baseX = 8 + (maxW * (NODE_W + H_GAP) - rowW) / 2;
			const y = 12 + depth * (NODE_H + V_GAP);
			ids.forEach((id, i) => {
				this.nodePos.set(id, { x: baseX + i * (NODE_W + H_GAP), y });
			});
		}

		// Draw edges first so rects sit on top.
		for (const [, node] of this.graph.nodes) {
			for (const ip of node.inputs) {
				for (const conn of ip.connections) {
					this._drawEdge(conn);
				}
			}
		}

		// Draw nodes.
		for (const [id, node] of this.graph.nodes) {
			this._drawNode(id, node);
		}
	}

	_computeDepths() {
		const depths = new Map();
		const visited = new Set();

		// Walk upward from the output node.
		const outId = this.graph.outputNodeId;
		if (outId == null) return depths;

		const visit = (id, depth) => {
			if (visited.has(id)) {
				depths.set(id, Math.max(depths.get(id) ?? 0, depth));
				return;
			}
			visited.add(id);
			depths.set(id, depth);
			const node = this.graph.nodes.get(id);
			if (!node) return;
			for (const ip of node.inputs) {
				for (const conn of ip.connections) {
					visit(conn.sourceNodeId, depth + 1);
				}
			}
		};

		// Start from the output node's inputs (the root expression).
		const outNode = this.graph.nodes.get(outId);
		if (outNode && outNode.inputs[0]) {
			for (const conn of outNode.inputs[0].connections) {
				visit(conn.sourceNodeId, 0);
			}
		}
		return depths;
	}

	_drawEdge(conn) {
		const src = this.nodePos.get(conn.sourceNodeId);
		const tgt = this.nodePos.get(conn.targetNodeId);
		if (!src || !tgt) return;

		const x1 = src.x + NODE_W / 2;
		const y1 = src.y + NODE_H;
		const x2 = tgt.x + NODE_W / 2;
		const y2 = tgt.y;
		const my = (y1 + y2) / 2;

		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('class', 'explorer-edge');
		path.setAttribute('marker-end', 'url(#explorer-arrow)');
		path.setAttribute('d', `M${ x1 } ${ y1 } C ${ x1 } ${ my }, ${ x2 } ${ my }, ${ x2 } ${ y2 }`);
		this.viewport.appendChild(path);
	}

	_drawNode(id, node) {
		const pos = this.nodePos.get(id);
		if (!pos) return;

		const role = this._role(node);
		const g = document.createElementNS(SVG_NS, 'g');
		g.setAttribute('class', `explorer-node role-${ role }`);
		g.setAttribute('data-id', String(id));
		g.setAttribute('data-from', String(-1)); // graph nodes don't map to source ranges
		g.setAttribute('data-to', String(-1));

		const rect = document.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('class', 'explorer-node-rect');
		rect.setAttribute('x', String(pos.x));
		rect.setAttribute('y', String(pos.y));
		rect.setAttribute('width', String(NODE_W));
		rect.setAttribute('height', String(NODE_H));
		rect.setAttribute('rx', '8');
		rect.setAttribute('ry', '8');
		g.appendChild(rect);

		const label = document.createElementNS(SVG_NS, 'text');
		label.setAttribute('class', 'explorer-node-top');
		label.setAttribute('x', String(pos.x + NODE_W / 2));
		label.setAttribute('y', String(pos.y + 20));
		label.textContent = node.label || node.type;
		g.appendChild(label);

		const sub = document.createElementNS(SVG_NS, 'text');
		sub.setAttribute('class', 'explorer-node-bottom');
		sub.setAttribute('x', String(pos.x + NODE_W / 2));
		sub.setAttribute('y', String(pos.y + 36));
		sub.textContent = node.type === 'output' ? 'audio out' : node.type === 'number' ? '' : node.type;
		g.appendChild(sub);

		// Port circles.
		node.inputs.forEach((p, i) => {
			const cy = pos.y + (i + 1) * NODE_H / (node.inputs.length + 1);
			const circle = document.createElementNS(SVG_NS, 'circle');
			circle.setAttribute('class', 'port port-input');
			circle.setAttribute('cx', String(pos.x));
			circle.setAttribute('cy', String(cy));
			circle.setAttribute('r', String(PORT_R));
			circle.setAttribute('data-port-id', p.id);
			circle.setAttribute('data-node-id', String(id));
			g.appendChild(circle);
		});
		if (node.outputs.length) {
			const cy = pos.y + NODE_H / 2;
			const circle = document.createElementNS(SVG_NS, 'circle');
			circle.setAttribute('class', 'port port-output');
			circle.setAttribute('cx', String(pos.x + NODE_W));
			circle.setAttribute('cy', String(cy));
			circle.setAttribute('r', String(PORT_R));
			circle.setAttribute('data-port-id', node.outputs[0].id);
			circle.setAttribute('data-node-id', String(id));
			g.appendChild(circle);
		}

		this.viewport.appendChild(g);
	}

	_role(node) {
		switch (node.type) {
		case 'number': case 'variable': case 'string': case 'array': return 'leaf';
		case 'binary': return node.meta && node.meta.op === '+' ? 'sum' : 'op';
		case 'unary': return node.meta && node.meta.op === '×' ? 'mul' : 'op';
		case 'conditional': case 'call': case 'member': return 'op';
		case 'output': return 'output';
		case 'function': return 'func';
		default: return 'op';
		}
	}
}
