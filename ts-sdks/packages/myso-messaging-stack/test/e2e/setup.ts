// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { TestProject } from 'vitest/node';
import { setupLocalnet } from './setup-localnet.js';
import { setupTestnet } from './setup-testnet.js';

/**
 * E2E globalSetup orchestrator.
 *
 * Delegates to testnet (default) or localnet based on `TEST_NETWORK` env var.
 *
 * - `testnet` (default): Connects to real MySo testnet, starts a relayer container
 *   (or uses a pre-deployed one via RELAYER_URL), and uses real MyData key servers.
 *   Requires: TEST_WALLET_PRIVATE_KEY (funded admin wallet).
 *   See setup-testnet.ts for all optional env var overrides.
 *
 * - `localnet`: NOT CURRENTLY FUNCTIONAL.
 *   The localnet setup requires gRPC event streaming between the relayer and the
 *   MySo localnet container. Testcontainers networking does not reliably support
 *   gRPC connections between containers, making the relayer unable to sync
 *   on-chain events. Use `test:integration` for localnet-only on-chain tests
 *   (without a relayer).
 */
export default async function setup(project: TestProject) {
	const network = (process.env.TEST_NETWORK ?? 'testnet') as 'localnet' | 'testnet';

	if (network === 'testnet') {
		await setupTestnet(project);
	} else {
		console.warn(
			'\n⚠️  Localnet E2E is not currently functional.\n' +
				'   The relayer requires gRPC event streaming from MySo localnet,\n' +
				'   which is not reliably supported with testcontainers networking.\n' +
				'   Use `pnpm test:integration` for localnet on-chain tests (no relayer).\n',
		);
		await setupLocalnet(project);
	}
}
