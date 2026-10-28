// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { SessionKey, type MyDataCompatibleClient } from '@socialproof/mydata';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { Transaction } from '@socialproof/myso/transactions';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import { describe, expect, it } from 'vitest';
import {
	AgentMyDataReaderPolicy,
	DefaultMyDataPolicy,
} from '../../src/encryption/mydata-policy.js';
import { EnvelopeEncryption } from '../../src/encryption/envelope-encryption.js';
import { MySoMessagingStackDerive } from '../../src/derive.js';
import type { MySoMessagingStackView } from '../../src/view.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';
import { MOCK_PACKAGE_CONFIG } from './helpers/mock-package-config.js';

const options = {
	originalPackageId: MOCK_PACKAGE_CONFIG.originalPackageId,
	latestPackageId: MOCK_PACKAGE_CONFIG.latestPackageId,
	versionId: MOCK_PACKAGE_CONFIG.versionId,
	platformId: `0x${'21'.repeat(32)}`,
	memoryConfigId: MOCK_PACKAGE_CONFIG.memoryConfigId,
	memoryAccountId: `0x${'22'.repeat(32)}`,
	agentDerivedAddress: `0x${'23'.repeat(32)}`,
};

describe('native agent room reader policy source regressions', () => {
	it('pins the native account/config/platform/clock ABI instead of using the generic reader gate', () => {
		const policy = new AgentMyDataReaderPolicy(options);
		const group = `0x${'24'.repeat(32)}`;
		const tx = new Transaction();
		policy.mydataApproveThunk(DefaultMyDataPolicy.encodeIdentity(group, 7n), group, '0x25')(tx);
		const call = tx.getData().commands[0].MoveCall;
		expect(call?.function).toBe('mydata_approve_agent_reader');
		expect(call?.arguments).toHaveLength(8);
		const inputs = JSON.stringify(tx.getData().inputs);
		for (const objectId of [
			options.versionId,
			options.memoryConfigId,
			options.memoryAccountId,
			options.platformId,
		]) {
			expect(inputs).toContain(objectId);
		}
	});

	it('rejects a cross-room identity and a session from another agent or encryption package', () => {
		const policy = new AgentMyDataReaderPolicy(options);
		expect(() =>
			policy.mydataApproveThunk(
				DefaultMyDataPolicy.encodeIdentity(`0x${'01'.repeat(32)}`, 0n),
				'0x2',
				'0x3',
			),
		).toThrow('identity mismatch');
		expect(() =>
			policy.assertSessionIdentity({ address: '0x4', packageId: options.originalPackageId }),
		).toThrow();
		expect(() =>
			policy.assertSessionIdentity({ address: options.agentDerivedAddress, packageId: '0x4' }),
		).toThrow();
		expect(() =>
			policy.assertSessionIdentity({
				address: options.agentDerivedAddress,
				packageId: options.originalPackageId,
			}),
		).not.toThrow();
	});

	it('cannot use a generated cached DEK with a mismatched session', async () => {
		const key = Ed25519Keypair.generate();
		const session = SessionKey.import(
			{
				address: key.toMySoAddress(),
				packageId: options.originalPackageId,
				creationTimeMs: Date.now(),
				ttlMin: 30,
				sessionKey: key.getSecretKey(),
			},
			{} as MyDataCompatibleClient,
		);
		const encryption = new EnvelopeEncryption({
			mydataClient: createMockMyDataClient(),
			mysoClient: {} as ClientWithCoreApi,
			view: {} as MySoMessagingStackView,
			derive: new MySoMessagingStackDerive({ packageConfig: MOCK_PACKAGE_CONFIG }),
			originalPackageId: options.originalPackageId,
			latestPackageId: options.latestPackageId,
			versionId: options.versionId,
			encryption: {
				sessionKey: { getSessionKey: () => session },
				mydataPolicy: new AgentMyDataReaderPolicy(options),
			},
		});
		const { uuid } = await encryption.generateGroupDEK();
		await expect(
			encryption.encrypt({ uuid, keyVersion: 0n, data: new Uint8Array([1]) }),
		).rejects.toThrow('configured room agent');
	});
});
