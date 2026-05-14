// Compile a Graph back to a JS expression string suitable for the
// AudioWorklet. Walks backward from the output node through connections,
// emitting each node's source text with correct parenthesization.
//
// DAG fan-out (one node feeds multiple consumers) is handled by
// duplicating the expression text. For typical bytebeat graphs (<50 nodes,
// fan-out ≤ 3) this is cheap and correct.

const PREC = {
	'?:': 4, '||': 5, '&&': 6,
	'|': 7, '^': 8, '&': 9,
	'==': 11, '!=': 11, '===': 11, '!==': 11,
	'<': 12, '<=': 12, '>': 12, '>=': 12,
	'<<': 13, '>>': 13, '>>>': 13,
	'+': 14, '-': 14,
	'*': 15, '/': 15, '%': 15,
	unary: 17, atom: 22,
};

export class GraphCompiler {
	/**
	 * @param {import('./graph-model.mjs').Graph} graph
	 * @returns {string} — a JS expression that evaluates to the output value
	 */
	compile(graph) {
		const outId = graph.outputNodeId;
		if (outId == null) return '0';
		const outNode = graph.nodes.get(outId);
		if (!outNode || !outNode.inputs[0] || !outNode.inputs[0].connections.length) return '0';
		const conn = outNode.inputs[0].connections[0];
		return this._emit(graph, conn.sourceNodeId, 0);
	}

	_emit(graph, nodeId, parentPrec) {
		const node = graph.nodes.get(nodeId);
		if (!node) return '0';

		switch (node.type) {
		case 'number':
			return String(node.meta.value ?? 0);
		case 'variable':
			return node.meta.name || '0';
		case 'string':
			return JSON.stringify(node.meta.value || '');
		case 'array':
			return node.meta.text || '[]';
		case 'binary': {
			const p = PREC[node.meta.op] || 14;
			const left = this._emitInput(graph, node.inputs[0], p);
			const right = this._emitInput(graph, node.inputs[1], p + 1);
			const out = `${left} ${node.meta.op} ${right}`;
			return p < parentPrec && parentPrec > 0 ? `(${out})` : out;
		}
		case 'unary': {
			const p = PREC.unary;
			const operand = this._emitInput(graph, node.inputs[0], p);
			const op = node.meta.op === '×' ? '' : node.meta.op; // MulConst passthrough
			const out = `${op}${node.meta.op === '!' ? '' : ''}${operand}`;
			if (node.meta.op === '!' || node.meta.op === '~' || node.meta.op === '-' || node.meta.op === '+') {
				return p < parentPrec ? `(${out})` : out;
			}
			return out;
		}
		case 'conditional': {
			const p = PREC['?:'];
			const test = this._emitInput(graph, node.inputs[0], p + 1);
			const cons = this._emitInput(graph, node.inputs[1], 0);
			const alt = this._emitInput(graph, node.inputs[2], p);
			const out = `${test} ? ${cons} : ${alt}`;
			return p < parentPrec ? `(${out})` : out;
		}
		case 'call': {
			const callee = node.meta.callee || '';
			const args = node.inputs.map(ip => this._emitInput(graph, ip, 0)).join(', ');
			return `${callee}(${args})`;
		}
		case 'member': {
			const obj = this._emitInput(graph, node.inputs[0], PREC.atom);
			const prop = node.meta.text || '';
			if (prop.includes('[')) {
				// Index access: the first input is the object, the property
				// text is the full expression. Just emit the full text.
				return prop;
			}
			// Dot access: obj.prop — read property name from the second input.
			const propInput = node.inputs[1];
			const propName = propInput && propInput.connections.length
				? this._emit(graph, propInput.connections[0].sourceNodeId, PREC.atom)
				: '';
			return `${obj}.${propName}`;
		}
		case 'sequence': {
			const parts = node.inputs.map(ip => this._emitInput(graph, ip, 0));
			return parts.join(', ');
		}
		case 'assignment': {
			const target = this._emitInput(graph, node.inputs[0], 0);
			const source = this._emitInput(graph, node.inputs[1], 0);
			return `${target} ${node.meta.op || '='} ${source}`;
		}
		case 'function': {
			const params = (node.meta.params || []).join(', ');
			let body = '0';
			if (node.inputs.length) {
				const port = node.inputs[0];
				if (port && port.connections.length) {
					body = this._emit(graph, port.connections[0].sourceNodeId, 0);
				}
			}
			return `(${params}) => ${body}`;
		}
		case 'output':
			return this._emitInput(graph, node.inputs[0], 0);
		default:
			return '0';
		}
	}

	_emitInput(graph, port, parentPrec) {
		if (!port || !port.connections.length) return '0';
		return this._emit(graph, port.connections[0].sourceNodeId, parentPrec);
	}
}
