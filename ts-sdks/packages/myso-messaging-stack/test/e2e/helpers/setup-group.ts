// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MyDataClient, MyDataClientOptions } from '@socialproof/mydata';
import type { MySoClientTypes } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import type { ResolvedGenesisMessagingConfig } from '@socialproof/myso-messaging-stack';
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';
import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
	type AccountFunding,
} from '../../helpers/index.js';

export interface GroupSetupConfig {
	mysoClientUrl: string;
	network?: MySoClientTypes.Network;
	packageConfig: ResolvedGenesisMessagingConfig;
	faucetUrl?: string;
	adminKeypair: Ed25519Keypair;
	relayerUrl?: string;
	mydata?: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>;
	relayerSyncDelayMs?: number;
}

export interface GroupUser {
	keypair: Ed25519Keypair;
	client: MySoMessagingStackTestClient;
}

export interface GroupSetupResult {
	uuid: string;
	groupId: string;
	admin: GroupUser;
	member: GroupUser;
	nonMember: GroupUser;
}

export async function setupTestGroup(config: GroupSetupConfig): Promise<GroupSetupResult> {
	const network = config.network ?? 'localnet';

	function buildClient(keypair: Ed25519Keypair) {
		return createMySoMessagingStackClient({
			url: config.mysoClientUrl,
			network,
			packageConfig: config.packageConfig,
			keypair,
			relayer: config.relayerUrl ? { relayerUrl: config.relayerUrl } : undefined,
			mydata: config.mydata,
		});
	}

	const adminClient = buildClient(config.adminKeypair);

	const uuid = crypto.randomUUID();
	await adminClient.messaging.createAndShareGroup({
		signer: config.adminKeypair,
		uuid,
		name: 'E2E Test Group',
	});

	const groupId = adminClient.messaging.derive.groupId({ uuid });

	const funding: AccountFunding = config.faucetUrl
		? { faucetUrl: config.faucetUrl }
		: { client: adminClient, signer: config.adminKeypair };
	const member = await createFundedAccount(funding);
	const memberKeypair = member.keypair;

	const messagingPerms = messagingPermissionTypes(config.packageConfig.messaging.originalPackageId);
	await adminClient.groups.grantPermissions({
		signer: config.adminKeypair,
		groupId,
		member: member.address,
		permissionTypes: Object.values(messagingPerms),
	});

	const nonMemberKeypair = new Ed25519Keypair();

	const syncDelay = config.relayerSyncDelayMs ?? 12_000;
	console.log(`Waiting ${syncDelay / 1000}s for relayer to sync on-chain permissions...`);
	await new Promise((resolve) => setTimeout(resolve, syncDelay));

	return {
		uuid,
		groupId,
		admin: { keypair: config.adminKeypair, client: adminClient },
		member: { keypair: memberKeypair, client: buildClient(memberKeypair) },
		nonMember: { keypair: nonMemberKeypair, client: buildClient(nonMemberKeypair) },
	};
}
