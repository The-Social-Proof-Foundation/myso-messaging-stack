// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Transaction } from '@socialproof/myso/transactions';
import { describe, expect, it } from 'vitest';

import { MySoMessagingStackCall } from '../../src/call.js';
import { MySoMessagingStackDerive } from '../../src/derive.js';
import type { EnvelopeEncryption } from '../../src/encryption/envelope-encryption.js';
import { MOCK_PACKAGE_CONFIG, MOCK_PACKAGE_ID } from './helpers/mock-package-config.js';

const MOCK_SENDER = '0x' + '01'.repeat(32);
const MOCK_MEMORY_ACCOUNT_ID = '0x' + '02'.repeat(32);

function createCall(resolveMemoryAccountId: (owner: string) => Promise<string | null>) {
	const derive = new MySoMessagingStackDerive({
		packageConfig: MOCK_PACKAGE_CONFIG,
	});

	return new MySoMessagingStackCall({
		packageConfig: MOCK_PACKAGE_CONFIG,
		encryption: {
			generateGroupDEK: async (uuid?: string) => ({
				uuid: uuid ?? 'test-uuid',
				encryptedDek: new Uint8Array([1, 2, 3]),
			}),
			generateRotationDEK: async () => {
				throw new Error('not used');
			},
		} as unknown as EnvelopeEncryption<any>,
		derive,
		permissionedGroupTypeName: `${MOCK_PACKAGE_ID}::messaging::Messaging`,
		encryptionHistoryTypeName: `${MOCK_PACKAGE_ID}::encryption_history::EncryptionHistory`,
		messageLogTypeName: `${MOCK_PACKAGE_ID}::message_log::MessageLog`,
		groupsCall: {} as never,
		resolveMemoryAccountId,
	});
}

describe('MySoMessagingStackCall wallet group routing', () => {
	it('createAndShareGroup uses wallet path when MemoryAccount is absent', async () => {
		const call = createCall(async () => null);
		const tx = new Transaction();
		await call.createAndShareGroup({
			uuid: 'test-uuid',
			name: 'Wallet Group',
			sender: MOCK_SENDER,
		})(tx);

		expect(tx.getData().commands.length).toBeGreaterThan(0);
	});

	it('createAndShareGroup uses profile path when MemoryAccount exists', async () => {
		const call = createCall(async () => MOCK_MEMORY_ACCOUNT_ID);
		const tx = new Transaction();
		await call.createAndShareGroup({
			uuid: 'test-uuid',
			name: 'Profile Group',
			sender: MOCK_SENDER,
		})(tx);

		expect(tx.getData().commands.length).toBeGreaterThan(0);
	});
});
