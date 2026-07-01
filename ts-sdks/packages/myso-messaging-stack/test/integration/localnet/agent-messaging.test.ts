// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

import {
	createPrincipalMessagingClient,
	createPrincipalOversightPolicy,
} from '@socialproof/myso-messaging-stack';

import {
	createMySoMessagingStackClient,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

describe('agent messaging helpers (localnet)', () => {
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

	it('human createAndShareGroup resolves MemoryAccount and succeeds', async () => {
		const uuid = crypto.randomUUID();
		const { digest } = await client.messaging.createAndShareGroup({
			signer: keypair,
			uuid,
			name: 'Human regression group',
		});
		expect(digest).toBeDefined();
	});

	it('builds principal oversight MyData policy', () => {
		const policy = createPrincipalOversightPolicy(client.messaging, {
			memoryAccountId: '0x0000000000000000000000000000000000000000000000000000000000000002',
			agentDerivedAddress: keypair.toMySoAddress(),
		});
		expect(policy.packageId).toBe(client.messaging.packageConfig.originalPackageId);
	});

	it('creates principal messaging client for listAgentConversations', () => {
		const principal = createPrincipalMessagingClient({
			messaging: client.messaging,
			humanSigner: keypair,
		});
		expect(principal.listAgentConversations).toBeTypeOf('function');
	});
});
