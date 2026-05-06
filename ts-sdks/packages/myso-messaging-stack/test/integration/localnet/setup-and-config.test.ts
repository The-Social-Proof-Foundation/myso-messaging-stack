// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

import { createMySoClient, createMySoMessagingStackClient } from '../../helpers/index.js';

describe('messaging-groups: Setup & Configuration', () => {
	it('should have published both packages', () => {
		const publishedPackages = inject('publishedPackages');
		expect(publishedPackages['permissioned-groups']).toBeDefined();
		expect(publishedPackages['permissioned-groups'].packageId).toBeDefined();
		expect(publishedPackages['messaging']).toBeDefined();
		expect(publishedPackages['messaging'].packageId).toBeDefined();
	});

	it('should have found the MessagingNamespace', () => {
		const namespaceId = inject('messagingNamespaceId');
		expect(namespaceId).toBeDefined();
		expect(namespaceId).toMatch(/^0x[a-f0-9]+$/);
	});

	it('should have found the Version shared object', () => {
		const versionId = inject('messagingVersionId');
		expect(versionId).toBeDefined();
		expect(versionId).toMatch(/^0x[a-f0-9]+$/);
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
		const publishedPackages = inject('publishedPackages');
		const namespaceId = inject('messagingNamespaceId');
		const versionId = inject('messagingVersionId');

		const client = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network: 'localnet',
			permissionedGroupsPackageId: publishedPackages['permissioned-groups'].packageId,
			messagingPackageId: publishedPackages['messaging'].packageId,
			namespaceId: namespaceId!,
			versionId: versionId!,
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
		const publishedPackages = inject('publishedPackages');
		const namespaceId = inject('messagingNamespaceId');
		const versionId = inject('messagingVersionId');
		const messagingPackageId = publishedPackages['messaging'].packageId;

		const client = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network: 'localnet',
			permissionedGroupsPackageId: publishedPackages['permissioned-groups'].packageId,
			messagingPackageId,
			namespaceId: namespaceId!,
			versionId: versionId!,
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
