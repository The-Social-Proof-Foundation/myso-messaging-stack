// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { requestMySoFromFaucetV2 } from '@socialproof/myso/faucet';
import { Transaction } from '@socialproof/myso/transactions';
import { messagingPermissionTypes, type MyDataPolicy } from '@socialproof/myso-messaging-stack';

import {
	createMySoMessagingStackClient,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Context required by the custom mydata_approve in example_app::custom_mydata_policy. */
interface SubscriptionApproveContext {
	serviceId: string;
	subscriptionId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fundNewKeypair(faucetUrl: string): Promise<Ed25519Keypair> {
	const keypair = new Ed25519Keypair();
	await requestMySoFromFaucetV2({
		host: faucetUrl,
		recipient: keypair.getPublicKey().toMySoAddress(),
	});
	return keypair;
}

/**
 * Creates a custom MyDataPolicy that calls example_app::custom_mydata_policy::mydata_approve.
 * The mydata_approve validates:
 * 1. Standard identity bytes (via messaging::mydata_policies::validate_identity)
 * 2. Subscription ownership and expiry (custom check_policy)
 */
function createSubscriptionMyDataPolicy(
	exampleAppPackageId: string,
): MyDataPolicy<SubscriptionApproveContext> {
	return {
		packageId: exampleAppPackageId,
		mydataApproveThunk(idBytes, groupId, encHistId, context) {
			return (tx) =>
				tx.moveCall({
					package: exampleAppPackageId,
					module: 'custom_mydata_policy',
					function: 'mydata_approve',
					typeArguments: ['0x2::myso::MYSO'],
					arguments: [
						tx.pure.vector('u8', Array.from(idBytes)),
						tx.object(context.subscriptionId),
						tx.object(context.serviceId),
						tx.object(groupId),
						tx.object(encHistId),
						tx.object('0x6'), // Clock
					],
				});
		},
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// Skipped until example_app is published on localnet (genesis migration pending).
const EXAMPLE_APP_PLACEHOLDER_PACKAGE_ID = '0x' + '00'.repeat(32);

describe.skip('Custom MyDataPolicy — Subscription-Gated Encryption', () => {
	// Default-policy admin client (for group creation and management)
	let defaultAdminClient: MySoMessagingStackTestClient;
	let adminKeypair: Ed25519Keypair;
	let faucetUrl: string;

	let exampleAppPackageId: string;
	let groupId: string;
	let encryptionHistoryId: string;
	let serviceId: string;

	let clientConfig: {
		mysoClientUrl: string;
		packageConfig: ReturnType<typeof inject<'genesisConfig'>>;
	};

	beforeAll(async () => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');
		const adminAccount = inject('adminAccount');
		const faucetPort = inject('faucetPort');

		exampleAppPackageId = EXAMPLE_APP_PLACEHOLDER_PACKAGE_ID;
		faucetUrl = `http://localhost:${faucetPort}`;
		adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		clientConfig = {
			mysoClientUrl,
			packageConfig: genesisConfig,
		};

		// 1. Create a default-policy admin client (for group management)
		defaultAdminClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			packageConfig: clientConfig.packageConfig,
			keypair: adminKeypair,
		});

		// 2. Create a messaging group
		const uuid = crypto.randomUUID();
		await defaultAdminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			name: 'Custom MyData Policy Group',
			uuid,
		});

		groupId = defaultAdminClient.messaging.derive.groupId({ uuid });
		encryptionHistoryId = defaultAdminClient.messaging.derive.encryptionHistoryId({ uuid });

		// 3. Create Service<MYSO> linked to this group (creates + shares in one call)
		const createServiceTx = new Transaction();
		createServiceTx.moveCall({
			package: exampleAppPackageId,
			module: 'custom_mydata_policy',
			function: 'create_service_and_share',
			typeArguments: ['0x2::myso::MYSO'],
			arguments: [
				createServiceTx.pure.id(groupId),
				createServiceTx.pure.u64(1000), // fee: 1000 MIST
				createServiceTx.pure.u64(3_600_000), // ttl: 1 hour
			],
		});

		const createServiceResult = await defaultAdminClient.core.signAndExecuteTransaction({
			transaction: createServiceTx,
			signer: adminKeypair,
			include: { effects: true, objectTypes: true },
		});

		const createServiceTxResult =
			createServiceResult.Transaction ?? createServiceResult.FailedTransaction;
		if (!createServiceTxResult?.status.success) {
			throw new Error(`Failed to create service: ${JSON.stringify(createServiceTxResult?.status)}`);
		}

		await defaultAdminClient.core.waitForTransaction({ result: createServiceResult });

		// Find the created Service object
		const createdService = createServiceTxResult.effects!.changedObjects.find((obj) => {
			const objType = createServiceTxResult.objectTypes?.[obj.objectId];
			return obj.idOperation === 'Created' && objType?.includes('Service');
		});

		if (!createdService) {
			throw new Error('Service not found in transaction effects');
		}

		serviceId = createdService.objectId;
	});

	it('should encrypt and decrypt with custom mydata_approve', async () => {
		// Fund a subscriber and grant them MessagingReader permission
		const subscriberKeypair = await fundNewKeypair(faucetUrl);
		const subscriberAddress = subscriberKeypair.getPublicKey().toMySoAddress();

		await defaultAdminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: subscriberAddress,
			permissionTypes: Object.values(
				messagingPermissionTypes(clientConfig.packageConfig.messaging.originalPackageId),
			),
		});

		// Subscribe using entry function (creates + transfers to sender in one call)
		const subscribeTx = new Transaction();
		const [coin] = subscribeTx.splitCoins(subscribeTx.gas, [1000]);
		subscribeTx.moveCall({
			package: exampleAppPackageId,
			module: 'custom_mydata_policy',
			function: 'subscribe_entry',
			typeArguments: ['0x2::myso::MYSO'],
			arguments: [
				subscribeTx.object(serviceId),
				coin,
				subscribeTx.object('0x6'), // Clock
			],
		});

		const subscribeResult = await defaultAdminClient.core.signAndExecuteTransaction({
			transaction: subscribeTx,
			signer: subscriberKeypair,
			include: { effects: true, objectTypes: true },
		});

		const subscribeTxResult = subscribeResult.Transaction ?? subscribeResult.FailedTransaction;
		if (!subscribeTxResult?.status.success) {
			throw new Error(`Failed to subscribe: ${JSON.stringify(subscribeTxResult?.status)}`);
		}

		await defaultAdminClient.core.waitForTransaction({ result: subscribeResult });

		// Find the created Subscription object
		const createdSubscription = subscribeTxResult.effects!.changedObjects.find((obj) => {
			const objType = subscribeTxResult.objectTypes?.[obj.objectId];
			return obj.idOperation === 'Created' && objType?.includes('Subscription');
		});

		if (!createdSubscription) {
			throw new Error('Subscription not found in transaction effects');
		}

		const subscriptionId = createdSubscription.objectId;

		// Create custom mydata policy
		const mydataPolicy = createSubscriptionMyDataPolicy(exampleAppPackageId);

		// Create subscriber client with custom mydata policy
		const subscriberClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			packageConfig: clientConfig.packageConfig,
			keypair: subscriberKeypair,
			mydataPolicy,
		});

		const approveContext: SubscriptionApproveContext = { serviceId, subscriptionId };

		// Encrypt
		const message = 'Subscription-gated secret message';
		const data = new TextEncoder().encode(message);

		const envelope = await subscriberClient.messaging.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			keyVersion: 0n,
			data,
			mydataApproveContext: approveContext,
		});

		expect(envelope.ciphertext).toBeInstanceOf(Uint8Array);
		expect(envelope.keyVersion).toBe(0n);

		// Decrypt
		const decrypted = await subscriberClient.messaging.encryption.decrypt({
			groupId,
			encryptionHistoryId,
			envelope,
			mydataApproveContext: approveContext,
		});

		expect(new TextDecoder().decode(decrypted)).toBe(message);
	});

	it('should deny a non-subscriber member', async () => {
		// Fund an outsider and grant them MessagingReader but NO subscription
		const outsiderKeypair = await fundNewKeypair(faucetUrl);
		const outsiderAddress = outsiderKeypair.getPublicKey().toMySoAddress();

		await defaultAdminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: outsiderAddress,
			permissionTypes: Object.values(
				messagingPermissionTypes(clientConfig.packageConfig.messaging.originalPackageId),
			),
		});

		const mydataPolicy = createSubscriptionMyDataPolicy(exampleAppPackageId);

		const outsiderClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			packageConfig: clientConfig.packageConfig,
			keypair: outsiderKeypair,
			mydataPolicy,
		});

		// The outsider has no subscription — use a fake subscription ID
		// The mydata_approve dry-run should fail because the object doesn't exist / isn't owned
		await expect(
			outsiderClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode('should fail'),
				mydataApproveContext: {
					serviceId,
					subscriptionId: '0x0000000000000000000000000000000000000000000000000000000000000000',
				},
			}),
		).rejects.toThrow();
	});

	it('should deny a non-member subscriber', async () => {
		// Fund an outsider — do NOT grant MessagingReader
		const outsiderKeypair = await fundNewKeypair(faucetUrl);

		// Subscribe using entry function (they can subscribe even without being a member)
		const subscribeTx = new Transaction();
		const [coin] = subscribeTx.splitCoins(subscribeTx.gas, [1000]);
		subscribeTx.moveCall({
			package: exampleAppPackageId,
			module: 'custom_mydata_policy',
			function: 'subscribe_entry',
			typeArguments: ['0x2::myso::MYSO'],
			arguments: [
				subscribeTx.object(serviceId),
				coin,
				subscribeTx.object('0x6'), // Clock
			],
		});

		const subscribeResult = await defaultAdminClient.core.signAndExecuteTransaction({
			transaction: subscribeTx,
			signer: outsiderKeypair,
			include: { effects: true, objectTypes: true },
		});

		const subscribeTxResult = subscribeResult.Transaction ?? subscribeResult.FailedTransaction;
		if (!subscribeTxResult?.status.success) {
			throw new Error(`Failed to subscribe outsider: ${JSON.stringify(subscribeTxResult?.status)}`);
		}

		await defaultAdminClient.core.waitForTransaction({ result: subscribeResult });

		const createdSubscription = subscribeTxResult.effects!.changedObjects.find((obj) => {
			const objType = subscribeTxResult.objectTypes?.[obj.objectId];
			return obj.idOperation === 'Created' && objType?.includes('Subscription');
		});

		if (!createdSubscription) {
			throw new Error('Subscription not found in transaction effects');
		}

		const subscriptionId = createdSubscription.objectId;

		const mydataPolicy = createSubscriptionMyDataPolicy(exampleAppPackageId);

		const outsiderClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			packageConfig: clientConfig.packageConfig,
			keypair: outsiderKeypair,
			mydataPolicy,
		});

		// Has subscription but is NOT a member — mydata_approve should reject
		await expect(
			outsiderClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode('should fail'),
				mydataApproveContext: { serviceId, subscriptionId },
			}),
		).rejects.toThrow(/mydata_approve/);
	});
});
