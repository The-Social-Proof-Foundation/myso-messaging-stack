// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for File Storage sync lifecycle.
// Tests the message sync flow: SYNC_PENDING → SYNCED → UPDATED → DELETED
//
// Prerequisites for testnet:
//   - Relayer running with short sync interval:
//     FILE_STORAGE_SYNC_INTERVAL_SECS=5
//     FILE_STORAGE_SYNC_MESSAGE_THRESHOLD=1
//   - File Storage testnet (publisher + aggregator)
//
// On localnet: File Storage is not available, so these tests verify only the
// syncStatus field transitions through the relayer's in-memory storage.
// The actual File Storage blob verification is skipped on localnet.

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import type { DecryptedMessage } from '@socialproof/myso-messaging-stack';

import { setupTestGroup, type GroupSetupResult } from './helpers/setup-group.js';

async function pollUntilSyncStatus(
	group: GroupSetupResult,
	messageId: string,
	targetStatus: string,
	timeoutMs = 60_000,
	intervalMs = 2_000,
): Promise<DecryptedMessage> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const msg = await group.member.client.messaging.getMessage({
			signer: group.member.keypair,
			groupRef: { uuid: group.uuid },
			messageId,
		});

		if (msg.syncStatus === targetStatus) {
			return msg;
		}

		await new Promise((r) => setTimeout(r, intervalMs));
	}

	throw new Error(`Timed out waiting for syncStatus=${targetStatus} on message ${messageId}`);
}

describe('File Storage Sync Lifecycle', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const genesisConfig = inject('genesisConfig');
	const adminAccount = inject('adminAccount');
	const mydataServerConfigs = inject('mydataServerConfigs');

	let group: GroupSetupResult;

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

	describe('Create and Sync', () => {
		let messageId: string;

		it('should create a message with SYNC_PENDING status', async () => {
			const result = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'File Storage sync test message',
			});
			messageId = result.messageId;

			// Immediately after creation, syncStatus should be SYNC_PENDING
			const msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});
			expect(msg.syncStatus).toBe('SYNC_PENDING');
		});

		it('should transition to SYNCED', async () => {
			const synced = await pollUntilSyncStatus(group, messageId, 'SYNCED');
			expect(synced.syncStatus).toBe('SYNCED');
		}, 90_000);
	});

	describe('Edit and Re-sync', () => {
		let messageId: string;

		it('should create and sync a message first', async () => {
			const result = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Before edit',
			});
			messageId = result.messageId;

			await pollUntilSyncStatus(group, messageId, 'SYNCED');
		}, 90_000);

		it('should transition to UPDATED after edit and re-sync', async () => {
			await group.member.client.messaging.editMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
				text: 'After edit - new content',
			});

			const updated = await pollUntilSyncStatus(group, messageId, 'UPDATED');

			expect(updated.syncStatus).toBe('UPDATED');
			expect(updated.text).toBe('After edit - new content');
		}, 90_000);
	});

	describe('Delete and Tombstone Sync', () => {
		let messageId: string;

		it('should create and sync a message first', async () => {
			const result = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Message to be deleted',
			});
			messageId = result.messageId;

			await pollUntilSyncStatus(group, messageId, 'SYNCED');
		}, 90_000);

		it('should transition to DELETED after soft-delete and sync', async () => {
			await group.member.client.messaging.deleteMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});

			const deleted = await pollUntilSyncStatus(group, messageId, 'DELETED');

			expect(deleted.syncStatus).toBe('DELETED');
			expect(deleted.isDeleted).toBe(true);
		}, 90_000);
	});

	describe('Subscribe During Sync', () => {
		it('receives messages via subscribe while sync is in progress', async () => {
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
					if (received.length >= 3) {
						controller.abort();
					}
				}
			})();

			await new Promise((r) => setTimeout(r, 200));

			// Send messages — these will initially be SYNC_PENDING
			await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Subscribe sync test 1',
			});
			await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Subscribe sync test 2',
			});
			await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: 'Subscribe sync test 3',
			});

			await subscribePromise;

			expect(received).toHaveLength(3);
			expect(received).toContain('Subscribe sync test 1');
			expect(received).toContain('Subscribe sync test 2');
			expect(received).toContain('Subscribe sync test 3');
		}, 30_000);
	});
});
