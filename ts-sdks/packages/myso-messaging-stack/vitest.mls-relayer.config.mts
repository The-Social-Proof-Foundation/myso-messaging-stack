// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

/** Real-relayer MLS run: `cargo build --example mls_e2e_server` in relayer/, then `pnpm test:mls-relayer`. */
export default defineConfig({
	test: {
		name: 'mls-relayer-integration',
		environment: 'node',
		include: ['./test/integration/mls-relayer/**/*.test.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
