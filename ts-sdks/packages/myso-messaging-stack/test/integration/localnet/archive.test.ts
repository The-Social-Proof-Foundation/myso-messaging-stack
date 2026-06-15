// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';

import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('archive', () => {
	let adminClient: MySoMessagingStackTestClient;
	let adminKeypair: Ed25519Keypair;
	let messagingPackageId: string;
	let faucetUrl: string;

	let clientConfig: {
		mysoClientUrl: string;
		packageConfig: ReturnType<typeof inject<'genesisConfig'>>;
	};

	beforeAll(() => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');
		const adminAccount = inject('adminAccount');
		const faucetPort = inject('faucetPort');

		messagingPackageId = genesisConfig.messaging.originalPackageId;
		faucetUrl = `http://localhost:${faucetPort}`;
		adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		clientConfig = { mysoClientUrl, packageConfig: genesisConfig };

		adminClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			packageConfig: clientConfig.packageConfig,
			keypair: adminKeypair,
		});
	});

	it('should archive a group successfully (PermissionsAdmin)', async () => {
		const uuid = crypto.randomUUID();

		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Archive Test Group',
		});

		const groupId = adminClient.messaging.derive.groupId({ uuid });

		const { digest } = await adminClient.messaging.archiveGroup({
			signer: adminKeypair,
			groupId,
		});

		expect(digest).toBeDefined();
		expect(digest).toMatch(/^[A-Za-z0-9+/=]+$/);
	});

	it('should still allow members to decrypt historical messages after archive', async () => {
		const uuid = crypto.randomUUID();

		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Archive Decrypt Test',
		});

		const groupId = adminClient.messaging.derive.groupId({ uuid });
		const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({ uuid });

		// Encrypt a message before archiving
		const message = 'historical message';
		const envelope = await adminClient.messaging.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			keyVersion: 0n,
			data: new TextEncoder().encode(message),
		});

		// Archive the group
		await adminClient.messaging.archiveGroup({
			signer: adminKeypair,
			groupId,
		});

		// Members should still be able to decrypt historical messages
		const decrypted = await adminClient.messaging.encryption.decrypt({
			groupId,
			encryptionHistoryId,
			envelope,
		});
		expect(new TextDecoder().decode(decrypted)).toBe(message);
	});

	it('should deny key rotation after archive (group is paused)', async () => {
		const uuid = crypto.randomUUID();

		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Archive Rotate Test',
		});

		const groupId = adminClient.messaging.derive.groupId({ uuid });

		await adminClient.messaging.archiveGroup({
			signer: adminKeypair,
			groupId,
		});

		await expect(
			adminClient.messaging.rotateEncryptionKey({
				signer: adminKeypair,
				uuid,
			}),
		).rejects.toThrow();
	});

	it('should deny archive without PermissionsAdmin', async () => {
		const uuid = crypto.randomUUID();

		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Archive Perm Test',
		});

		const groupId = adminClient.messaging.derive.groupId({ uuid });

		// Fund a member and grant only MessagingReader (not PermissionsAdmin)
		const member = await createFundedAccount({ faucetUrl });
		const memberClient = createMySoMessagingStackClient({
			...clientConfig,
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			keypair: member.keypair,
		});

		await adminClient.groups.grantPermission({
			signer: adminKeypair,
			groupId,
			member: member.address,
			permissionType: messagingPermissionTypes(messagingPackageId).MessagingReader,
		});

		await expect(
			memberClient.messaging.archiveGroup({
				signer: member.keypair,
				groupId,
			}),
		).rejects.toThrow();
	});
});
