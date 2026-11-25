#!/usr/bin/env node
/**
 * n8n resolves `file:` icons relative to the compiled module and tsc does not
 * copy assets, so each SVG is placed next to the node and credential output.
 */
const fs = require('fs');
const path = require('path');

const ICONS = ['venmo.svg', 'venmo.dark.svg'];
const TARGETS = [
	{ from: 'nodes/Venmo', to: 'dist/nodes/Venmo' },
	{ from: 'credentials', to: 'dist/credentials' },
];

for (const { from, to } of TARGETS) {
	fs.mkdirSync(to, { recursive: true });
	for (const icon of ICONS) {
		fs.copyFileSync(path.join(from, icon), path.join(to, icon));
	}
}
