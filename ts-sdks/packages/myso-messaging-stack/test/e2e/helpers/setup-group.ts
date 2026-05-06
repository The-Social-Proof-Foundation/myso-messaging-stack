// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MyDataClient, MyDataClientOptions } from '@socialproof/mydata';
import type { MySoClientTypes } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';
import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
	type AccountFunding,
} from '../../helpers/index.js';

export interface GroupSetupConfig {
	mysoClientUrl: string;
	/** Network to use. Default: 'localnet'. */
	network?: MySoClientTypes.Network;
	permissionedGroupsPackageId: string;
	messagingPackageId: string;
	namespaceId: string;
	versionId: string;
	/** Faucet URL for funding accounts (localnet). When omitted, funds via admin wallet transfer. */
	faucetUrl?: string;
	adminKeypair: Ed25519Keypair;
	/** Relayer URL. When provided, clients are created with real HTTP transport. */
	relayerUrl?: string;
	/**
	 * MyData configuration override. When provided, uses a real MyDataClient
	 * (e.g. for testnet with real key servers). When omitted, a mock MyDataClient is used.
	 */
	mydata?: MyDataClient | Omit<MyDataClientOptions, 'mysoClient'>;
	/** How long to wait for the relayer to sync on-chain events (ms). Default: 12000 */
	relayerSyncDelayMs?: number;
}

export interface GroupUser {
	keypair: Ed25519Keypair;
	client: MySoMessagingStackTestClient;
}

export interface GroupSetupResult {
	/** UUID used to create the group. Use as `groupRef: { uuid }` with the SDK client. */
	uuid: string;
	/** Derived on-chain group ID. */
	groupId: string;
	admin: GroupUser;
	member: GroupUser;
	nonMember: GroupUser;
}

/**
 * Creates a new on-chain messaging group, grants full permissions to a member keypair,
 * and waits for the relayer to sync.
 *
 * Supports both localnet (mock mydata, testcontainers) and testnet (real mydata, real infra)
 * via the `network`, `mydata`, and `relayerUrl` options.
 */
export async function setupTestGroup(config: GroupSetupConfig): Promise<GroupSetupResult> {
	const network = config.network ?? 'localnet';

	function buildClient(keypair: Ed25519Keypair) {
		return createMySoMessagingStackClient({
			url: config.mysoClientUrl,
			network,
			permissionedGroupsPackageId: config.permissionedGroupsPackageId,
			messagingPackageId: config.messagingPackageId,
			namespaceId: config.namespaceId,
			versionId: config.versionId,
			keypair,
			relayer: config.relayerUrl ? { relayerUrl: config.relayerUrl } : undefined,
			mydata: config.mydata,
		});
	}

	const adminClient = buildClient(config.adminKeypair);

	// Create the messaging group
	const uuid = crypto.randomUUID();
	await adminClient.messaging.createAndShareGroup({
		signer: config.adminKeypair,
		uuid,
		name: 'E2E Test Group',
	});

	const groupId = adminClient.messaging.derive.groupId({ uuid });

	// Fund a member and grant all messaging permissions
	const funding: AccountFunding = config.faucetUrl
		? { faucetUrl: config.faucetUrl }
		: { client: adminClient, signer: config.adminKeypair };
	const member = await createFundedAccount(funding);
	const memberKeypair = member.keypair;

	const messagingPerms = messagingPermissionTypes(config.messagingPackageId);
	await adminClient.groups.grantPermissions({
		signer: config.adminKeypair,
		groupId,
		member: member.address,
		permissionTypes: Object.values(messagingPerms),
	});

	// Create a non-member keypair (not funded, not granted permissions)
	const nonMemberKeypair = new Ed25519Keypair();

	// Wait for the relayer to pick up on-chain events
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
