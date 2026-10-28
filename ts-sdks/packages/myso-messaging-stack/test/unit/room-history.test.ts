// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';
import { MySoMessagingStackClient } from '../../src/client.js';
import type { MySoMessagingStackCompatibleClient } from '../../src/types.js';
import type { RelayerMessage } from '../../src/relayer/types.js';
import type { RelayerTransport } from '../../src/relayer/transport.js';
import { signMessageContent } from '../../src/verification.js';
import { validateRoomHistoryPage, validateRoomHistoryRequest } from '../../src/room-history.js';
import { MOCK_PACKAGE_CONFIG } from './helpers/mock-package-config.js';

const groupId = `0x${'ab'.repeat(32)}`;
const groupRef = { groupId, encryptionHistoryId: `0x${'cd'.repeat(32)}` };

function raw(order: number, overrides: Partial<RelayerMessage> = {}): RelayerMessage {
	return {
		messageId: `message-${order}`,
		groupId,
		order,
		encryptedText: new Uint8Array([1, 2, 3]),
		nonce: new Uint8Array(12),
		keyVersion: 0n,
		senderAddress: `0x${'ef'.repeat(32)}`,
		createdAt: 1,
		updatedAt: 1,
		attachments: [],
		isEdited: false,
		isDeleted: false,
		signature: '',
		publicKey: '',
		isAgentMessage: false,
		...overrides,
	};
}

function fixture(rows: RelayerMessage[], hasNext = true) {
	const hasPermission = vi.fn().mockResolvedValue(true);
	const fetchMessages = vi.fn().mockResolvedValue({ messages: rows, hasNext });
	const client = new MySoMessagingStackClient({
		client: {
			groups: { view: { hasPermission }, bcs: { PermissionedGroup: { name: 'Group' } }, call: {} },
			mydata: {},
		} as unknown as MySoMessagingStackCompatibleClient<string, string>,
		groupsName: 'groups',
		mydataName: 'mydata',
		packageConfig: MOCK_PACKAGE_CONFIG,
		encryption: {
			sessionKey: {
				getSessionKey: () => {
					throw new Error('unexpected key request');
				},
			},
		},
		relayer: { transport: { fetchMessages } as unknown as RelayerTransport },
	});
	const decrypt = vi
		.spyOn(client.encryption, 'decrypt')
		.mockResolvedValue(new TextEncoder().encode('private room text'));
	const clearCache = vi.spyOn(client.encryption, 'clearCache');
	const signer = { toMySoAddress: () => `0x${'01'.repeat(32)}` } as Signer;
	return { client, hasPermission, fetchMessages, decrypt, clearCache, signer };
}

async function signed(
	order: number,
	overrides: Partial<RelayerMessage> = {},
): Promise<RelayerMessage> {
	const key = Ed25519Keypair.generate();
	const row = raw(order, { senderAddress: key.toMySoAddress(), ...overrides });
	// Relayer public keys use hex flag+key, not the SDK's base64 public-key form.
	row.publicKey = Array.from(key.getPublicKey().toMySoBytes(), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	row.signature = await signMessageContent(key, row);
	return row;
}

describe('strict room history source regressions', () => {
	it('rejects wrong rooms, duplicate identities, non-advancing and unsafe cursors before decryption', () => {
		for (const rows of [
			[raw(1, { groupId: '0x2' })],
			[raw(1), raw(2, { messageId: 'message-1' })],
			[raw(2), raw(1)],
			[raw(Number.MAX_SAFE_INTEGER + 1)],
		])
			expect(() =>
				validateRoomHistoryPage({ messages: rows, hasNext: true }, groupId, {}),
			).toThrow();
		expect(() => validateRoomHistoryPage({ messages: [], hasNext: true }, groupId, {})).toThrow();
		expect(() => validateRoomHistoryRequest({ afterOrder: 8, beforeOrder: 8 })).toThrow();
		expect(() => validateRoomHistoryRequest({ limit: 51 })).toThrow();
	});

	it('preserves both bounds when continuing a finite forward window', () => {
		expect(
			validateRoomHistoryPage({ messages: [raw(7), raw(8)], hasNext: true }, groupId, {
				afterOrder: 6,
				beforeOrder: 12,
			}),
		).toEqual({ afterOrder: 8, beforeOrder: 12 });
	});

	it('enforces per-message and aggregate ciphertext bounds', () => {
		expect(() =>
			validateRoomHistoryPage(
				{ messages: [raw(1, { encryptedText: new Uint8Array(1024 * 1024 + 1) })], hasNext: false },
				groupId,
				{},
			),
		).toThrow();
		const messages = Array.from({ length: 5 }, (_, i) =>
			raw(i + 1, { encryptedText: new Uint8Array(1024 * 1024) }),
		);
		expect(() => validateRoomHistoryPage({ messages, hasNext: false }, groupId, {})).toThrow();
	});

	it('does not request messages or keys without current reader permission', async () => {
		const f = fixture([raw(1)]);
		f.hasPermission.mockResolvedValue(false);
		await expect(f.client.getRoomMessages({ signer: f.signer, groupRef })).rejects.toThrow(
			'reader permission',
		);
		expect(f.fetchMessages).not.toHaveBeenCalled();
		expect(f.decrypt).not.toHaveBeenCalled();
		expect(f.clearCache).toHaveBeenCalledWith(groupId);
	});

	it('keeps unverified rows and cursor progress without decrypting them', async () => {
		const f = fixture([raw(7), raw(8)]);
		const page = await f.client.getRoomMessages({ signer: f.signer, groupRef, afterOrder: 6 });
		expect(page.entries.map((entry) => entry.status)).toEqual([
			'unverified_content',
			'unverified_content',
		]);
		expect(page.nextCursor).toEqual({ afterOrder: 8 });
		expect(page.allContentVerified).toBe(false);
		expect(f.decrypt).not.toHaveBeenCalled();
	});

	it('rejects ciphertext tampering before requesting a key', async () => {
		const row = await signed(1);
		row.encryptedText[0] ^= 1;
		const f = fixture([row]);
		const page = await f.client.getRoomMessages({ signer: f.signer, groupRef });
		expect(page.entries[0].status).toBe('unverified_content');
		expect(f.decrypt).not.toHaveBeenCalled();
	});

	it('returns verified text with explicit unavailable rows and no unsigned attribution/attachment claims', async () => {
		const f = fixture([
			await signed(7, { principalOwner: '0x123', subAgentId: '0x456' }),
			await signed(8),
		]);
		f.decrypt.mockRejectedValueOnce(new Error('provider secret should not leave this call'));
		const page = await f.client.getRoomMessages({ signer: f.signer, groupRef });
		expect(page.entries[0]).toEqual({
			messageId: 'message-7',
			order: 7,
			status: 'unavailable_content',
		});
		expect(page.entries[1]).toMatchObject({
			status: 'verified_content',
			content: { text: 'private room text' },
		});
		expect(page.entries[1]).not.toHaveProperty('principalOwner');
		expect(page.entries[1]).not.toHaveProperty('attachments');
		expect(page.nextCursor).toEqual({ beforeOrder: 7 });
		expect(JSON.stringify(page)).not.toContain('provider secret');
	});

	it('discards the whole page if permission is removed during decryption', async () => {
		const f = fixture([await signed(1)]);
		f.hasPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(f.client.getRoomMessages({ signer: f.signer, groupRef })).rejects.toThrow(
			'reader permission',
		);
		expect(f.decrypt).toHaveBeenCalledOnce();
		expect(f.clearCache).toHaveBeenCalledWith(groupId);
	});

	it('does not mistake system/deletion metadata for verified plaintext', async () => {
		const f = fixture([raw(1, { kind: 'system' }), raw(2, { isDeleted: true })], false);
		const page = await f.client.getRoomMessages({ signer: f.signer, groupRef });
		expect(page.entries.map((entry) => entry.status)).toEqual([
			'system_metadata',
			'deleted_metadata',
		]);
		expect(page.allContentVerified).toBe(false);
		expect(f.decrypt).not.toHaveBeenCalled();
	});
});
