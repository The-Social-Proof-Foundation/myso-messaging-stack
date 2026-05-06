// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';

/**
 * Ensures recovery-transport.test.ts always runs last.
 * It depends on earlier tests having sent messages through the relayer → File Storage,
 * so the indexer has BlobCertified events to discover.
 */
class RecoveryLastSequencer extends BaseSequencer {
	async sort(files: Parameters<BaseSequencer['sort']>[0]) {
		const sorted = await super.sort(files);
		const idx = sorted.findIndex((f) => f.moduleId.includes('recovery-transport'));
		if (idx >= 0) {
			sorted.push(...sorted.splice(idx, 1));
		}
		return sorted;
	}
}

export default defineConfig({
	resolve: {
		alias: {
			'@publish-utils': resolve(__dirname, '../../../publish/src/utils/index.ts'),
		},
	},
	test: {
		name: 'messaging-groups-e2e',
		environment: 'node',
		globalSetup: ['./test/e2e/setup.ts'],
		include: ['./test/e2e/**/*.test.ts'],
		testTimeout: 120_000,
		hookTimeout: 180_000,
		fileParallelism: false,
		sequence: {
			sequencer: RecoveryLastSequencer,
		},
	},
});
