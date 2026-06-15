// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for pagination edge cases.
// Tests pagination behavior:
// 1. beforeOrder parameter
// 2. Combined afterOrder and beforeOrder
// 3. Limit edge cases (0, very large)
// 4. Boundary cases (empty group, single message)
// 5. Order consistency across pages

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

import { setupTestGroup, type GroupSetupResult } from './helpers/setup-group.js';

describe('Pagination Edge Cases', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const genesisConfig = inject('genesisConfig');
	const adminAccount = inject('adminAccount');
	const mydataServerConfigs = inject('mydataServerConfigs');

	let group: GroupSetupResult;
	let messageOrders: number[] = [];

	const NUM_TEST_MESSAGES = 15;

	beforeAll(async () => {
		const adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);
		const mydataConfig =
			mydataServerConfigs.length > 0
				? { serverConfigs: mydataServerConfigs, verifyKeyServers: false }
				: undefined;

		group = await setupTestGroup({
			mysoClientUrl,
			network,
			packageConfig: genesisConfig,
			adminKeypair,
			relayerUrl,
			mydata: mydataConfig,
		});

		// Create test messages
		for (let i = 0; i < NUM_TEST_MESSAGES; i++) {
			await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: `Pagination test message ${i + 1}`,
			});
		}

		// Fetch all messages to get their orders
		const all = await group.member.client.messaging.getMessages({
			signer: group.member.keypair,
			groupRef: { uuid: group.uuid },
			limit: 100,
		});
		messageOrders = all.messages.map((m) => m.order);
	}, 300_000);

	describe('beforeOrder Parameter', () => {
		it('should fetch messages before a specific order', async () => {
			const middleOrder = messageOrders[Math.floor(messageOrders.length / 2)];

			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				beforeOrder: middleOrder,
				limit: 100,
			});

			for (const msg of result.messages) {
				expect(msg.order).toBeLessThan(middleOrder);
			}
		});

		it('should return empty when beforeOrder is less than first message', async () => {
			const minOrder = Math.min(...messageOrders);

			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				beforeOrder: minOrder,
			});

			expect(result.messages).toEqual([]);
			expect(result.hasNext).toBe(false);
		});
	});

	describe('Combined afterOrder and beforeOrder', () => {
		it('should fetch messages in a specific range', async () => {
			const sortedOrders = [...messageOrders].sort((a, b) => a - b);
			const afterOrder = sortedOrders[2];
			const beforeOrder = sortedOrders[sortedOrders.length - 2];

			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				afterOrder,
				beforeOrder,
				limit: 100,
			});

			for (const msg of result.messages) {
				expect(msg.order).toBeGreaterThan(afterOrder);
				expect(msg.order).toBeLessThan(beforeOrder);
			}
		});

		it('should return empty when afterOrder >= beforeOrder', async () => {
			const order = messageOrders[5] || 100;

			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				afterOrder: order,
				beforeOrder: order,
			});

			expect(result.messages).toEqual([]);
		});
	});

	describe('Limit Edge Cases', () => {
		it('should handle limit of 1', async () => {
			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				limit: 1,
			});

			expect(result.messages.length).toBe(1);
			expect(result.hasNext).toBe(true);
		});

		it('should cap very large limit to max allowed', async () => {
			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				limit: 10000,
			});

			// Should be capped to server MAX_PAGE_LIMIT (100)
			expect(result.messages.length).toBeLessThanOrEqual(100);
		});
	});

	describe('Boundary Cases', () => {
		it('should handle afterOrder greater than all messages', async () => {
			const maxOrder = Math.max(...messageOrders);
			const futureOrder = maxOrder + 1000;

			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				afterOrder: futureOrder,
			});

			expect(result.messages).toEqual([]);
			expect(result.hasNext).toBe(false);
		});
	});

	describe('Order Consistency', () => {
		it('should return messages in ascending order by default', async () => {
			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				limit: 100,
			});

			const messages = result.messages;
			for (let i = 1; i < messages.length; i++) {
				expect(messages[i].order).toBeGreaterThan(messages[i - 1].order);
			}
		});

		it('should maintain order across paginated requests', async () => {
			const PAGE_SIZE = 3;
			const allMessages: { order: number }[] = [];
			let afterOrder: number | undefined = undefined;
			let pageCount = 0;

			while (pageCount < 10) {
				const result = await group.member.client.messaging.getMessages({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					limit: PAGE_SIZE,
					afterOrder,
				});

				allMessages.push(...result.messages);
				pageCount++;

				if (!result.hasNext || result.messages.length === 0) break;
				afterOrder = result.messages[result.messages.length - 1].order;
			}

			// Verify global ascending order
			for (let i = 1; i < allMessages.length; i++) {
				expect(allMessages[i].order).toBeGreaterThan(allMessages[i - 1].order);
			}
		});
	});
});
