// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@publish-utils': resolve(__dirname, '../../../publish/src/utils/index.ts'),
		},
	},
	test: {
		name: 'messaging-groups-integration-localnet',
		environment: 'node',
		globalSetup: ['./test/integration/localnet/setup.ts'],
		include: ['./test/integration/localnet/**/*.test.ts'],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
