// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { GENESIS_PACKAGE_IDS } from '../../../src/genesis.js';

import { createMySoClient, createMySoMessagingStackClient } from '../../helpers/index.js';

describe('messaging-groups: Setup & Configuration', () => {
	it('should resolve genesis messaging namespace', () => {
		const namespaceId = inject('messagingNamespaceId');
		expect(namespaceId).toBeDefined();
		expect(namespaceId).toMatch(/^0x[a-f0-9]+$/);
	});

	it('should resolve genesis Version shared object', () => {
		const versionId = inject('messagingVersionId');
		expect(versionId).toBeDefined();
		expect(versionId).toMatch(/^0x[a-f0-9]+$/);
	});

	it('should expose genesis package IDs in resolved config', () => {
		const genesisConfig = inject('genesisConfig');
		expect(genesisConfig.messaging.originalPackageId).toBe(GENESIS_PACKAGE_IDS.messaging);
		expect(genesisConfig.permissionedGroups.originalPackageId).toBe(GENESIS_PACKAGE_IDS.framework);
		expect(genesisConfig.messaging.blockListRegistryId).toMatch(/^0x[a-f0-9]+$/);
		expect(genesisConfig.messaging.socialGraphId).toMatch(/^0x[a-f0-9]+$/);
	});

	it('should have a working myso client', async () => {
		const mysoClientUrl = inject('mysoClientUrl');
		const adminAccount = inject('adminAccount');

		const mysoClient = createMySoClient({ url: mysoClientUrl, network: 'localnet' });
		const { balance } = await mysoClient.core.getBalance({
			owner: adminAccount.address,
		});

		expect(BigInt(balance.balance)).toBeGreaterThan(0n);
	});

	it('should extend MySoClient with PermissionedGroups, MyData, and MessagingGroups', () => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');

		const client = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network: 'localnet',
			packageConfig: genesisConfig,
			keypair: new Ed25519Keypair(),
		});

		expect(client.groups).toBeDefined();
		expect(client.groups.call).toBeDefined();
		expect(client.groups.tx).toBeDefined();
		expect(client.groups.bcs).toBeDefined();

		expect(client.mydata).toBeDefined();

		expect(client.messaging).toBeDefined();
		expect(client.messaging.call).toBeDefined();
		expect(client.messaging.tx).toBeDefined();
		expect(client.messaging.view).toBeDefined();
		expect(client.messaging.bcs).toBeDefined();
	});

	it('should have BCS types with correct package-scoped names', () => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');
		const messagingPackageId = genesisConfig.messaging.originalPackageId;

		const client = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network: 'localnet',
			packageConfig: genesisConfig,
			keypair: new Ed25519Keypair(),
		});

		expect(client.messaging.bcs.Messaging.name).toBe(`${messagingPackageId}::messaging::Messaging`);
		expect(client.messaging.bcs.MessagingNamespace.name).toBe(
			`${messagingPackageId}::messaging::MessagingNamespace`,
		);
		expect(client.messaging.bcs.MessagingSender.name).toBe(
			`${messagingPackageId}::messaging::MessagingSender`,
		);
		expect(client.messaging.bcs.MessagingReader.name).toBe(
			`${messagingPackageId}::messaging::MessagingReader`,
		);
		expect(client.messaging.bcs.EncryptionHistory.name).toBe(
			`${messagingPackageId}::encryption_history::EncryptionHistory`,
		);
		expect(client.messaging.bcs.EncryptionKeyRotator.name).toBe(
			`${messagingPackageId}::encryption_history::EncryptionKeyRotator`,
		);
	});
});
