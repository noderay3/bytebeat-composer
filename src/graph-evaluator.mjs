// Evaluate a Graph in JS for the live monitor. Topological sort (Kahn)
// produces a flat evaluation order; evaluate() walks that order at each
// frame, computing every node's output from its inputs.
//
// The audio engine still uses the compiled text expression (via
// graph-compiler.mjs → AudioWorklet). This evaluator runs in parallel at
// 60fps to drive per-node RGB coloring and mini-waveforms.

export class GraphEvaluator {
	/**
	 * @param {import('./graph-model.mjs').Graph} graph
	 * @param {{ mode: string, sampleRate: number }} ctx
	 */
	constructor(graph, ctx = {}) {
		this.graph = graph;
		this.ctx = { mode: 'Bytebeat', sampleRate: 8000, ...ctx };
		this.order = null;     // [nodeId, ...] — cached topo sort
		this._dirty = true;
	}

	/** Recompute topological order. Call after graph mutations. */
	invalidate() { this._dirty = true; }

	_sort() {
		if (!this._dirty && this.order) return this.order;
		const indeg = new Map();
		const queue = [];
		const order = [];
		for (const [id, n] of this.graph.nodes) {
			const deg = n.inputs.filter(p => p.connections.length > 0).length;
			indeg.set(id, deg);
			if (deg === 0) queue.push(id);
		}
		while (queue.length) {
			const id = queue.shift();
			order.push(id);
			const node = this.graph.nodes.get(id);
			for (const op of node.outputs) {
				for (const conn of op.connections) {
					const d = (indeg.get(conn.targetNodeId) || 1) - 1;
					indeg.set(conn.targetNodeId, d);
					if (d === 0) queue.push(conn.targetNodeId);
				}
			}
		}
		this.order = order;
		this._dirty = false;
		return order;
	}

	/**
	 * Evaluate all nodes at time t.
	 * @param {number} t — sample position
	 * @returns {Map<number, number>} nodeId → value
	 */
	evaluate(t) {
		const order = this._sort();
		const values = new Map();
		const resolvePort = port => {
			if (!port.connections.length) return 0;
			return values.get(port.connections[0].sourceNodeId) ?? 0;
		};

		for (const id of order) {
			const node = this.graph.nodes.get(id);
			if (!node) continue;
			const inputs = node.inputs.map(resolvePort);
			let v = 0;
			switch (node.type) {
			case 'number':
				v = node.meta.value ?? 0;
				break;
			case 'variable':
				v = node.meta.name === 't' ? t : 0;
				break;
			case 'string':
			case 'array':
				v = 0;
				break;
			case 'binary':
				v = binOp(inputs[0], inputs[1], node.meta.op);
				break;
			case 'unary':
				v = unOp(inputs[0], node.meta.op);
				break;
			case 'conditional':
				v = inputs[0] ? inputs[1] : inputs[2];
				break;
			case 'call':
				v = callOp(node.meta.callee, inputs);
				break;
			case 'member':
				// Return the first input as-is (structural, not numeric).
				v = inputs[0];
				break;
			case 'sequence':
				v = inputs[inputs.length - 1] ?? 0;
				break;
			case 'assignment':
				v = inputs[1];
				break;
			case 'function':
				v = 0;
				break;
			case 'output':
				v = inputs[0];
				break;
			}
			values.set(id, v >>> 0);
		}
		return values;
	}

	/** Return the output value (what goes to the speaker) at time t. */
	sample(t) {
		const outId = this.graph.outputNodeId;
		if (outId == null) return 0;
		const vals = this.evaluate(t);
		return vals.get(outId) ?? 0;
	}
}

// ── Operator evaluation ────────────────────────────────────────────────

function binOp(a, b, op) {
	a = a | 0; b = b | 0;
	switch (op) {
	case '+':  return a + b;
	case '-':  return a - b;
	case '*':  return Math.imul(a, b);
	case '/':  return b ? (a / b) | 0 : 0;
	case '%':  return b ? a % b : 0;
	case '&':  return a & b;
	case '|':  return a | b;
	case '^':  return a ^ b;
	case '<<': return a << b;
	case '>>': return a >> b;
	case '>>>':return a >>> b;
	case '&&': return (a && b) ? 1 : 0;
	case '||': return (a || b) ? 1 : 0;
	case '<':  return a < b ? 1 : 0;
	case '<=': return a <= b ? 1 : 0;
	case '>':  return a > b ? 1 : 0;
	case '>=': return a >= b ? 1 : 0;
	case '==': return a == b ? 1 : 0;
	case '!=': return a != b ? 1 : 0;
	case '===':return a === b ? 1 : 0;
	case '!==':return a !== b ? 1 : 0;
	default:   return 0;
	}
}

function unOp(a, op) {
	a = a | 0;
	switch (op) {
	case '-':  return -a;
	case '~':  return ~a;
	case '!':  return a ? 0 : 1;
	case '+':  return +a;
	case '++': return a + 1;
	case '--': return a - 1;
	case '×':  return a; // MulConstExpression passthrough
	default:   return a;
	}
}

function callOp(name, args) {
	switch (name) {
	case 'Math.sin':   return Math.sin(args[0] || 0) * 127 + 128;
	case 'Math.cos':   return Math.cos(args[0] || 0) * 127 + 128;
	case 'Math.tan':   return Math.tan(args[0] || 0) * 127 + 128;
	case 'Math.abs':   return Math.abs(args[0] || 0);
	case 'Math.floor': return Math.floor(args[0] || 0);
	case 'Math.round': return Math.round(args[0] || 0);
	case 'Math.sqrt':  return Math.sqrt(Math.abs(args[0] || 0));
	case 'Math.pow':   return Math.pow(args[0] || 0, args[1] || 1);
	case 'Math.max':   return Math.max(...args.filter(a => isFinite(a)));
	case 'Math.min':   return Math.min(...args.filter(a => isFinite(a)));
	case 'Math.PI':    return Math.PI;
	case 'Math.random':return Math.random() * 255;
	case 'Math.log':   return Math.log(Math.abs(args[0] || 1));
	case 'Math.exp':   return Math.exp(args[0] || 0);
	case 'sin':   return Math.sin(args[0] || 0) * 127 + 128;
	case 'cos':   return Math.cos(args[0] || 0) * 127 + 128;
	case 'tan':   return Math.tan(args[0] || 0) * 127 + 128;
	case 'abs':   return Math.abs(args[0] || 0);
	case 'int':   return (args[0] || 0) | 0;
	case 'pow':   return Math.pow(args[0] || 0, args[1] || 1);
	default:
		// Unknown call — return first arg (identity passthrough).
		return args[0] || 0;
	}
}
