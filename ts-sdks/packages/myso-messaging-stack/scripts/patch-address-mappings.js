#!/usr/bin/env node
// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Patches address_mapping.json to use MVR names for genesis framework dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEPENDENCY_MVR_MAPPINGS = {
	MySo: '0x2',
	MySocialContracts: '0x50c1',
};

const PACKAGE_SUMMARIES = [
	path.join(__dirname, '../../../../move/packages/messaging/package_summaries'),
];

function patchAddressMapping(summaryDir) {
	const mappingPath = path.join(summaryDir, 'address_mapping.json');

	if (!fs.existsSync(mappingPath)) {
		console.log(`Skipping ${summaryDir}: address_mapping.json not found`);
		return false;
	}

	const mappings = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
	let modified = false;

	for (const [pkgName, address] of Object.entries(DEPENDENCY_MVR_MAPPINGS)) {
		if (mappings[pkgName] && mappings[pkgName] !== address) {
			console.log(`  ${pkgName}: ${mappings[pkgName]} -> ${address}`);
			mappings[pkgName] = address;
			modified = true;
		}
	}

	if (modified) {
		fs.writeFileSync(mappingPath, JSON.stringify(mappings, null, 2) + '\n');
		return true;
	}

	return false;
}

function main() {
	console.log('Patching address mappings for genesis deps...\n');

	let patched = 0;
	for (const summaryDir of PACKAGE_SUMMARIES) {
		if (patchAddressMapping(summaryDir)) {
			patched++;
		}
	}

	if (patched > 0) {
		console.log(`\nPatched ${patched} address mapping file(s).`);
	} else {
		console.log('\nNo changes needed.');
	}
}

main();
