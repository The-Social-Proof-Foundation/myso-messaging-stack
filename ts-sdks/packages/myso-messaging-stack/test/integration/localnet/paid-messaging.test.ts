// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

import { createPaidMessagingClient } from '@socialproof/myso-messaging-stack';

import { createMySoMessagingStackClient, type MySoMessagingStackTestClient } from '../../helpers/index.js';

describe('paid messaging (localnet)', () => {
	let client: MySoMessagingStackTestClient;
	let keypair: Ed25519Keypair;

	beforeAll(() => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');
		const adminAccount = inject('adminAccount');

		keypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);
		client = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network: 'localnet',
			packageConfig: genesisConfig,
			keypair,
		});
	});

	it('sets paid messaging policy on-chain', async () => {
		const paid = createPaidMessagingClient({ messaging: client.messaging });
		const { digest } = await paid.setPolicy({
			signer: keypair,
			enabled: true,
			minCost: 1_000n,
		});
		expect(digest).toBeDefined();
	});

	it('reads policy via dev-inspect requires_payment_from', async () => {
		const paid = createPaidMessagingClient({ messaging: client.messaging });
		const policy = await paid.getOnChainPolicy(keypair.toMySoAddress());
		expect(policy.enabled).toBe(true);
		expect(policy.minCost).toBe(1_000n);
	});
});
