// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E load and stability tests.
// Tests system behavior under load:
// 1. Concurrent message sending
// 2. Sequential burst messaging
// 3. Concurrent read/write operations

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';
import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
	type AccountFunding,
} from '../helpers/index.js';

import type { GroupUser } from './helpers/setup-group.js';

describe('Load and Stability', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const genesisConfig = inject('genesisConfig');
	const adminAccount = inject('adminAccount');
	const mydataServerConfigs = inject('mydataServerConfigs');

	const SYNC_WAIT_TIME = 15_000;
	const CONCURRENT_USERS = 5;

	let users: GroupUser[];
	let uuid: string;
	let groupId: string;

	function buildClient(keypair: Ed25519Keypair): MySoMessagingStackTestClient {
		return createMySoMessagingStackClient({
			url: mysoClientUrl,
			network,
			packageConfig: genesisConfig,
			keypair,
			relayer: { relayerUrl },
			mydata:
				mydataServerConfigs.length > 0
					? { serverConfigs: mydataServerConfigs, verifyKeyServers: false }
					: undefined,
		});
	}

	beforeAll(async () => {
		const adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);
		const adminClient = buildClient(adminKeypair);
		const funding: AccountFunding = { client: adminClient, signer: adminKeypair };
		uuid = crypto.randomUUID();
		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Load Test Group',
		});
		groupId = adminClient.messaging.derive.groupId({ uuid });

		const messagingPerms = messagingPermissionTypes(genesisConfig.messaging.originalPackageId);
		const allPerms = Object.values(messagingPerms);

		// Create concurrent users
		users = [];
		for (let i = 0; i < CONCURRENT_USERS; i++) {
			const account = await createFundedAccount(funding);
			const user: GroupUser = {
				keypair: account.keypair,
				client: buildClient(account.keypair),
			};
			users.push(user);

			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: account.address,
				permissionTypes: allPerms,
			});
		}

		await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));
	}, 300_000);

	describe('Concurrent Message Sending', () => {
		it('should handle concurrent sends from multiple users', async () => {
			const promises = users.map((user, i) =>
				user.client.messaging.sendMessage({
					signer: user.keypair,
					groupRef: { uuid },
					text: `Concurrent message from user ${i}`,
				}),
			);

			const results = await Promise.all(promises);

			for (const result of results) {
				expect(result.messageId).toBeTruthy();
			}
		}, 30_000);

		it('should handle burst sends from a single user', async () => {
			const BURST_COUNT = 10;
			const user = users[0];
			const messageIds: string[] = [];

			for (let i = 0; i < BURST_COUNT; i++) {
				const result = await user.client.messaging.sendMessage({
					signer: user.keypair,
					groupRef: { uuid },
					text: `Burst message ${i + 1}`,
				});
				messageIds.push(result.messageId);
			}

			expect(messageIds.length).toBe(BURST_COUNT);
			// Verify all unique
			expect(new Set(messageIds).size).toBe(BURST_COUNT);
		}, 60_000);
	});

	describe('Sequential Load', () => {
		it('should handle 20 sequential messages', async () => {
			const COUNT = 20;
			const user = users[1];

			for (let i = 0; i < COUNT; i++) {
				const result = await user.client.messaging.sendMessage({
					signer: user.keypair,
					groupRef: { uuid },
					text: `Sequential load message ${i + 1}`,
				});
				expect(result.messageId).toBeTruthy();
			}

			// Verify all messages are retrievable
			const all = await user.client.messaging.getMessages({
				signer: user.keypair,
				groupRef: { uuid },
				limit: 100,
			});
			expect(all.messages.length).toBeGreaterThanOrEqual(COUNT);
		}, 120_000);
	});

	describe('Concurrent Read/Write', () => {
		it('should handle simultaneous reads and writes', async () => {
			const writer = users[2];
			const reader = users[3];

			// Send messages concurrently with reads
			const writePromises = Array.from({ length: 5 }, (_, i) =>
				writer.client.messaging.sendMessage({
					signer: writer.keypair,
					groupRef: { uuid },
					text: `Read/write test ${i}`,
				}),
			);

			const readPromises = Array.from({ length: 3 }, () =>
				reader.client.messaging.getMessages({
					signer: reader.keypair,
					groupRef: { uuid },
					limit: 10,
				}),
			);

			const [writeResults, readResults] = await Promise.all([
				Promise.all(writePromises),
				Promise.all(readPromises),
			]);

			// All writes should succeed
			for (const result of writeResults) {
				expect(result.messageId).toBeTruthy();
			}

			// All reads should succeed
			for (const result of readResults) {
				expect(result.messages.length).toBeGreaterThan(0);
			}
		}, 30_000);
	});
});
