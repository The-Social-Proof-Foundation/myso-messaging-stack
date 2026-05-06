// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for encryption round-trip.
// The SDK handles encryption/decryption transparently, so these tests verify:
// 1. Messages sent via sendMessage are encrypted and decrypted correctly
// 2. Multiple messages maintain independent encryption
// 3. Large messages are handled
// 4. Non-members cannot decrypt messages (403 on fetch)

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { RelayerTransportError } from '@socialproof/myso-messaging-stack';

import { setupTestGroup, type GroupSetupResult } from './helpers/setup-group.js';

describe('Encryption Round-Trip', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const publishedPackages = inject('publishedPackages');
	const adminAccount = inject('adminAccount');
	const messagingNamespaceId = inject('messagingNamespaceId');
	const messagingVersionId = inject('messagingVersionId');
	const mydataServerConfigs = inject('mydataServerConfigs');

	let group: GroupSetupResult;

	beforeAll(async () => {
		const adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		group = await setupTestGroup({
			mysoClientUrl,
			network,
			permissionedGroupsPackageId: publishedPackages['permissioned-groups'].packageId,
			messagingPackageId: publishedPackages['messaging'].packageId,
			namespaceId: messagingNamespaceId,
			versionId: messagingVersionId,
			adminKeypair,
			relayerUrl,
			mydata:
				mydataServerConfigs.length > 0
					? { serverConfigs: mydataServerConfigs, verifyKeyServers: false }
					: undefined,
		});
	}, 180_000);

	describe('Encrypted Message Flow', () => {
		it('should encrypt and decrypt a message correctly', async () => {
			const plaintext = 'Hello, encrypted world! 🔐';

			const { messageId } = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: plaintext,
			});

			const msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});

			expect(msg.text).toBe(plaintext);
		});

		it('should handle multiple messages with independent encryption', async () => {
			const messages = [
				'First encrypted message',
				'Second encrypted message',
				'Third encrypted message',
			];

			const messageIds: string[] = [];
			for (const text of messages) {
				const { messageId } = await group.member.client.messaging.sendMessage({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					text,
				});
				messageIds.push(messageId);
			}

			// Verify each message decrypts to its original plaintext
			for (let i = 0; i < messages.length; i++) {
				const msg = await group.member.client.messaging.getMessage({
					signer: group.member.keypair,
					groupRef: { uuid: group.uuid },
					messageId: messageIds[i],
				});
				expect(msg.text).toBe(messages[i]);
			}
		});

		it('should handle special characters and unicode', async () => {
			const plaintext = '特殊文字テスト 🎉 <script>alert("xss")</script> "quotes" & symbols';

			const { messageId } = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: plaintext,
			});

			const msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});

			expect(msg.text).toBe(plaintext);
		});

		it('non-member cannot read messages (403)', async () => {
			await expect(
				group.nonMember.client.messaging.getMessages({
					signer: group.nonMember.keypair,
					groupRef: { uuid: group.uuid },
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});

	describe('Large Message Handling', () => {
		it('should encrypt and decrypt a 10KB message', async () => {
			const largeText = 'A'.repeat(10 * 1024);

			const { messageId } = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: largeText,
			});

			const msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});

			expect(msg.text).toBe(largeText);
			expect(msg.text.length).toBe(10 * 1024);
		});
	});

	describe('Edit Preserves Encryption', () => {
		it('should re-encrypt correctly after edit', async () => {
			const original = 'Original encrypted text';
			const updated = 'Updated encrypted text';

			const { messageId } = await group.member.client.messaging.sendMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				text: original,
			});

			// Verify original
			let msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});
			expect(msg.text).toBe(original);

			// Edit
			await group.member.client.messaging.editMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
				text: updated,
			});

			// Verify updated
			msg = await group.member.client.messaging.getMessage({
				signer: group.member.keypair,
				groupRef: { uuid: group.uuid },
				messageId,
			});
			expect(msg.text).toBe(updated);
			expect(msg.isEdited).toBe(true);
		});
	});
});
