// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for message CRUD operations.
// Tests the full SDK flow: encrypt → send → fetch → decrypt → edit → delete
// through a real relayer (testcontainers) and on-chain group.

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import {
	RelayerTransportError,
	EncryptionAccessDeniedError,
} from '@socialproof/myso-messaging-stack';

import { setupTestGroup, type GroupSetupResult } from './helpers/setup-group.js';

describe('Message CRUD Operations', () => {
	let group: GroupSetupResult;
	let createdMessageId: string;

	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const genesisConfig = inject('genesisConfig');
	const adminAccount = inject('adminAccount');
	const mydataServerConfigs = inject('mydataServerConfigs');

	beforeAll(async () => {
		const adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		group = await setupTestGroup({
			mysoClientUrl,
			network,
			packageConfig: genesisConfig,
			adminKeypair,
			relayerUrl,
			mydata:
				mydataServerConfigs.length > 0
					? { serverConfigs: mydataServerConfigs, verifyKeyServers: false }
					: undefined,
		});
	}, 180_000);

	describe('Health Check', () => {
		it('should return healthy status', async () => {
			const response = await fetch(`${relayerUrl}/health_check`);
			expect(response.status).toBe(200);
		});
	});

	describe('sendMessage', () => {
		it('creates a message and returns a UUID message_id', async () => {
			const result = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Hello, World!',
			});

			expect(result.messageId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			createdMessageId = result.messageId;
		});

		it('rejects a non-member with EncryptionAccessDeniedError', async () => {
			await expect(
				group.nonMember.client.messaging.sendMessage({
					signer: group.nonMember.keypair,
					groupRef: { uuid: group.uuid },
					text: 'Unauthorized message',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});
	});

	describe('getMessage', () => {
		it('retrieves and decrypts the message we just created', async () => {
			const msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId: createdMessageId,
			});

			expect(msg.messageId).toBe(createdMessageId);
			expect(msg.groupId).toBe(group.groupId);
			expect(msg.senderAddress).toBe(group.member.keypair.toMySoAddress());
			expect(msg.text).toBe('Hello, World!');
			expect(msg.isEdited).toBe(false);
			expect(msg.isDeleted).toBe(false);
			expect(msg.order).toBeGreaterThan(0);
			expect(msg.createdAt).toBeGreaterThan(0);
		});

		it('returns 404 for a non-existent message', async () => {
			await expect(
				group.member.client.messaging.getMessage({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					messageId: '00000000-0000-0000-0000-000000000000',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 404;
			});
		});
	});

	describe('getMessages', () => {
		beforeAll(async () => {
			for (let i = 0; i < 3; i++) {
				await group.member.client.messaging.sendMessage({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					text: `Pagination test message ${i + 1}`,
				});
			}
		}, 30_000);

		it('fetches messages with limit and hasNext', async () => {
			const result = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				limit: 2,
			});

			expect(result.messages.length).toBe(2);
			expect(result.hasNext).toBe(true);
			expect(result.messages[0].text).toBeTruthy();
		});

		it('paginates with afterOrder (no overlap between pages)', async () => {
			const page1 = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				limit: 2,
			});
			const lastOrder = page1.messages[page1.messages.length - 1].order;

			const page2 = await group.member.client.messaging.getMessages({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				afterOrder: lastOrder,
				limit: 2,
			});

			expect(page2.messages[0].order).toBeGreaterThan(lastOrder);

			const page1Ids = page1.messages.map((m) => m.messageId);
			const page2Ids = page2.messages.map((m) => m.messageId);
			for (const id of page2Ids) {
				expect(page1Ids).not.toContain(id);
			}
		});
	});

	describe('editMessage', () => {
		it('updates a message and sets isEdited to true', async () => {
			await group.member.client.messaging.editMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId: createdMessageId,
				text: 'Updated message!',
			});

			const updated = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId: createdMessageId,
			});

			expect(updated.text).toBe('Updated message!');
			expect(updated.isEdited).toBe(true);
			expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
		});

		it('rejects update from non-member with EncryptionAccessDeniedError', async () => {
			await expect(
				group.nonMember.client.messaging.editMessage({
					signer: group.nonMember.keypair,
					groupRef: { uuid: group.uuid },
					messageId: createdMessageId,
					text: 'Hijacked message!',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});
	});

	describe('deleteMessage', () => {
		it('soft-deletes a message and sets isDeleted to true', async () => {
			await group.member.client.messaging.deleteMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId: createdMessageId,
			});

			const deleted = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId: createdMessageId,
			});

			expect(deleted.isDeleted).toBe(true);
		});
	});

	describe('subscribe', () => {
		it('receives new messages via polling and decrypts them', async () => {
			const controller = new AbortController();
			const received: string[] = [];

			// Fetch all existing messages to find the highest order so subscribe only sees new ones
			let lastOrder: number | undefined;
			let hasNext = true;
			let afterOrder: number | undefined;
			while (hasNext) {
				const page = await group.member.client.messaging.getMessages({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					afterOrder,
					limit: 100,
				});
				if (page.messages.length > 0) {
					lastOrder = page.messages[page.messages.length - 1].order;
					afterOrder = lastOrder;
				}
				hasNext = page.hasNext;
			}

			const subscribePromise = (async () => {
				for await (const event of group.member.client.messaging.subscribe({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					afterOrder: lastOrder,
					signal: controller.signal,
				})) {
					if (event.type !== 'message') continue;
					received.push(event.message.text);
					if (received.length >= 2) {
						controller.abort();
					}
				}
			})();

			await new Promise((r) => setTimeout(r, 200));
			await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Subscribe test 1',
			});
			await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Subscribe test 2',
			});

			await subscribePromise;
			expect(received).toHaveLength(2);
			expect(received).toContain('Subscribe test 1');
			expect(received).toContain('Subscribe test 2');
		}, 30_000);
	});

	describe('Admin operations', () => {
		it('admin can send and read messages (auto-permissions from group creation)', async () => {
			const { messageId } = await group.admin.client.messaging.sendMessage({
				signer: group.admin.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Admin message',
			});

			const msg = await group.admin.client.messaging.getMessage({
				signer: group.admin.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});

			expect(msg.text).toBe('Admin message');
		});
	});
});
