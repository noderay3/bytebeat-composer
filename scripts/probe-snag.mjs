import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Explorer } from '../src/explorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tracks = JSON.parse(readFileSync(join(__dirname, '..', '..', 'coderadio',
	'CodeRadio', 'Resources', 'bytebeat_tracks.json'), 'utf8'));

for(const i of [315, 318, 326]) {
	console.log(`\n=== #${ i } ===`);
	console.log(tracks[i].code.slice(0, 200));
	const tree = new Explorer().parse(tracks[i].code);
	console.log('---');
	dumpOps(tree);
}

function dumpOps(node, depth = 0) {
	if(!node) {
		return;
	}
	if(node.kind === 'Operator') {
		console.log(`${ ' '.repeat(depth * 2) }🔍 Operator op="${ node.op }" text="${ node.text }"`);
	}
	if(node.children) for(const c of node.children) dumpOps(c, depth + 1);
}
