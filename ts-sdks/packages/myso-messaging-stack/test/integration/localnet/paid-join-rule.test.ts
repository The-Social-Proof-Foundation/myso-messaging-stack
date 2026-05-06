// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { requestMySoFromFaucetV2 } from '@socialproof/myso/faucet';
import { Transaction } from '@socialproof/myso/transactions';
import {
	createMySoMessagingStackClient,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

// ─── Client Extension for PaidJoinRule ───────────────────────────────────────

/**
 * Example client extension that wraps the `example_app::paid_join_rule` Move module.
 *
 * This demonstrates the recommended pattern for third-party contracts:
 * build a thin TypeScript extension and compose it via `$extend`.
 */
function paidJoinRuleExtension({
	exampleAppPackageId,
	namespaceId,
	versionId,
}: {
	exampleAppPackageId: string;
	namespaceId: string;
	versionId: string;
}) {
	const TOKEN_TYPE = '0x2::myso::MYSO';

	return {
		name: 'paidJoinRule' as const,
		register: (client: MySoMessagingStackTestClient) => ({
			/**
			 * Creates a token-gated messaging group in a single transaction.
			 *
			 * Calls `example_app::paid_join_rule::create_token_gated_group` which:
			 * 1. Creates the group via `messaging::create_group`
			 * 2. Creates a `PaidJoinRule<MYSO>` actor with the specified fee
			 * 3. Grants `ExtensionPermissionsAdmin` to the rule
			 * 4. Grants `FundsManager` to the caller
			 * 5. Shares everything
			 */
			async createTokenGatedGroup(options: {
				signer: Ed25519Keypair;
				name: string;
				uuid: string;
				fee: bigint;
			}) {
				// Generate encrypted DEK for the group's initial encryption key
				const { uuid, encryptedDek } = await client.messaging.encryption.generateGroupDEK(
					options.uuid,
				);

				const tx = new Transaction();
				tx.moveCall({
					package: exampleAppPackageId,
					module: 'paid_join_rule',
					function: 'create_token_gated_group',
					typeArguments: [TOKEN_TYPE],
					arguments: [
						tx.object(versionId),
						tx.object(namespaceId),
						tx.object(client.messaging.derive.groupManagerId()),
						tx.pure.string(options.name),
						tx.pure.string(uuid),
						tx.pure.vector('u8', Array.from(encryptedDek)),
						tx.pure.u64(options.fee),
					],
				});

				const result = await client.core.signAndExecuteTransaction({
					transaction: tx,
					signer: options.signer,
					include: { effects: true, objectTypes: true },
				});

				const txResult = result.Transaction ?? result.FailedTransaction;
				if (!txResult?.status.success) {
					throw new Error(
						`Failed to create token-gated group: ${JSON.stringify(txResult?.status)}`,
					);
				}

				await client.core.waitForTransaction({ result });

				// Find the created PaidJoinRule object
				const createdRule = txResult.effects!.changedObjects.find((obj) => {
					const objType = txResult.objectTypes?.[obj.objectId];
					return obj.idOperation === 'Created' && objType?.includes('PaidJoinRule');
				});

				if (!createdRule) {
					throw new Error('PaidJoinRule not found in transaction effects');
				}

				const groupId = client.messaging.derive.groupId({ uuid });
				const encryptionHistoryId = client.messaging.derive.encryptionHistoryId({ uuid });

				return { ruleId: createdRule.objectId, groupId, encryptionHistoryId, uuid };
			},

			/**
			 * Joins a group by paying the required fee via the PaidJoinRule actor.
			 * The transaction sender is granted MessagingReader permission.
			 */
			async join(options: {
				signer: Ed25519Keypair;
				ruleId: string;
				groupId: string;
				fee: bigint;
			}) {
				const tx = new Transaction();
				const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(options.fee)]);

				tx.moveCall({
					package: exampleAppPackageId,
					module: 'paid_join_rule',
					function: 'join',
					typeArguments: [TOKEN_TYPE],
					arguments: [tx.object(options.ruleId), tx.object(options.groupId), coin],
				});

				// Merge remainder back into gas (join takes &mut Coin, so the coin survives)
				tx.mergeCoins(tx.gas, [coin]);

				const result = await client.core.signAndExecuteTransaction({
					transaction: tx,
					signer: options.signer,
					include: { effects: true },
				});

				const txResult = result.Transaction ?? result.FailedTransaction;
				if (!txResult?.status.success) {
					throw new Error(`Failed to join group: ${JSON.stringify(txResult?.status)}`);
				}

				await client.core.waitForTransaction({ result });
			},

			/**
			 * Withdraws all accumulated fees from the PaidJoinRule.
			 * Requires the caller to have FundsManager permission on the group.
			 */
			async withdrawAll(options: { signer: Ed25519Keypair; ruleId: string; groupId: string }) {
				const tx = new Transaction();
				tx.moveCall({
					package: exampleAppPackageId,
					module: 'paid_join_rule',
					function: 'withdraw_all_entry',
					typeArguments: [TOKEN_TYPE],
					arguments: [tx.object(options.ruleId), tx.object(options.groupId)],
				});

				const result = await client.core.signAndExecuteTransaction({
					transaction: tx,
					signer: options.signer,
					include: { effects: true },
				});

				const txResult = result.Transaction ?? result.FailedTransaction;
				if (!txResult?.status.success) {
					throw new Error(`Failed to withdraw: ${JSON.stringify(txResult?.status)}`);
				}

				await client.core.waitForTransaction({ result });
			},
		}),
	};
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PaidJoinRule — Payment-Gated Group Membership via Actor Object', () => {
	let adminKeypair: Ed25519Keypair;
	let faucetUrl: string;
	let exampleAppPackageId: string;

	let groupId: string;
	let encryptionHistoryId: string;
	let ruleId: string;

	const JOIN_FEE = 1_000_000n; // 0.001 MYSO

	// Extended client with PaidJoinRule operations — showcasing $extend composition
	let extendedClient: ReturnType<typeof createExtendedClient>;

	let clientConfig: {
		mysoClientUrl: string;
		permissionedGroupsPackageId: string;
		messagingPackageId: string;
		namespaceId: string;
		versionId: string;
	};

	function createExtendedClient(keypair: Ed25519Keypair) {
		const baseClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			...clientConfig,
			keypair,
		});

		return baseClient.$extend(
			paidJoinRuleExtension({
				exampleAppPackageId,
				namespaceId: clientConfig.namespaceId,
				versionId: clientConfig.versionId,
			}),
		);
	}

	beforeAll(async () => {
		const mysoClientUrl = inject('mysoClientUrl');
		const publishedPackages = inject('publishedPackages');
		const namespaceId = inject('messagingNamespaceId');
		const versionId = inject('messagingVersionId');
		const adminAccount = inject('adminAccount');
		const faucetPort = inject('faucetPort');

		exampleAppPackageId = publishedPackages['example-app'].packageId;
		faucetUrl = `http://localhost:${faucetPort}`;
		adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		clientConfig = {
			mysoClientUrl,
			permissionedGroupsPackageId: publishedPackages['permissioned-groups'].packageId,
			messagingPackageId: publishedPackages['messaging'].packageId,
			namespaceId: namespaceId!,
			versionId: versionId!,
		};

		// Create admin client extended with PaidJoinRule
		extendedClient = createExtendedClient(adminKeypair);

		// Create a token-gated group — single atomic transaction
		const result = await extendedClient.paidJoinRule.createTokenGatedGroup({
			signer: adminKeypair,
			name: 'Paid Join Group',
			uuid: crypto.randomUUID(),
			fee: JOIN_FEE,
		});

		groupId = result.groupId;
		encryptionHistoryId = result.encryptionHistoryId;
		ruleId = result.ruleId;
	});

	it('should allow a user to self-serve join by paying the fee', async () => {
		const joinerKeypair = await fundNewKeypair(faucetUrl);
		const joinerAddress = joinerKeypair.getPublicKey().toMySoAddress();

		// Verify the user is NOT a member yet
		const { members: membersBefore } = await extendedClient.groups.view.getMembers({ groupId });
		const isMemberBefore = membersBefore.some((m) => m.address === joinerAddress);
		expect(isMemberBefore).toBe(false);

		// Join via the PaidJoinRule — user pays JOIN_FEE and gets MessagingReader
		await extendedClient.paidJoinRule.join({
			signer: joinerKeypair,
			ruleId,
			groupId,
			fee: JOIN_FEE,
		});

		// Verify the user IS now a member with MessagingReader permission
		const { members: membersAfter } = await extendedClient.groups.view.getMembers({ groupId });
		const joinerMembership = membersAfter.find((m) => m.address === joinerAddress);
		expect(joinerMembership).toBeDefined();

		// On-chain TypeName stores addresses without the '0x' prefix
		const pkgIdNoPrefix = clientConfig.messagingPackageId.replace(/^0x/, '');
		expect(joinerMembership!.permissions).toContain(`${pkgIdNoPrefix}::messaging::MessagingReader`);
	});

	it('should reject a user who provides insufficient payment', async () => {
		const joinerKeypair = await fundNewKeypair(faucetUrl);

		const tx = new Transaction();
		const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(JOIN_FEE - 1n)]);

		tx.moveCall({
			package: exampleAppPackageId,
			module: 'paid_join_rule',
			function: 'join',
			typeArguments: ['0x2::myso::MYSO'],
			arguments: [tx.object(ruleId), tx.object(groupId), coin],
		});

		// Merge remainder back into gas (join takes &mut Coin)
		tx.mergeCoins(tx.gas, [coin]);

		// The transaction aborts during simulation with EInsufficientPayment
		await expect(
			extendedClient.core.signAndExecuteTransaction({
				transaction: tx,
				signer: joinerKeypair,
				include: { effects: true },
			}),
		).rejects.toThrow();
	});

	it('should allow multiple users to join and accumulate fees', async () => {
		const joiner1 = await fundNewKeypair(faucetUrl);
		const joiner2 = await fundNewKeypair(faucetUrl);

		await extendedClient.paidJoinRule.join({ signer: joiner1, ruleId, groupId, fee: JOIN_FEE });
		await extendedClient.paidJoinRule.join({ signer: joiner2, ruleId, groupId, fee: JOIN_FEE });

		const { members } = await extendedClient.groups.view.getMembers({ groupId });
		expect(members.find((m) => m.address === joiner1.getPublicKey().toMySoAddress())).toBeDefined();
		expect(members.find((m) => m.address === joiner2.getPublicKey().toMySoAddress())).toBeDefined();
	});

	it('should allow FundsManager to withdraw accumulated fees', async () => {
		// Admin has FundsManager permission — withdraw all accumulated fees
		await extendedClient.paidJoinRule.withdrawAll({
			signer: adminKeypair,
			ruleId,
			groupId,
		});
	});

	it('should deny withdrawal from a non-FundsManager member', async () => {
		// First, have a new user join so there are funds to withdraw
		const joinerKeypair = await fundNewKeypair(faucetUrl);
		await extendedClient.paidJoinRule.join({
			signer: joinerKeypair,
			ruleId,
			groupId,
			fee: JOIN_FEE,
		});

		// The joiner (MessagingReader, not FundsManager) tries to withdraw
		const tx = new Transaction();
		tx.moveCall({
			package: exampleAppPackageId,
			module: 'paid_join_rule',
			function: 'withdraw_all_entry',
			typeArguments: ['0x2::myso::MYSO'],
			arguments: [tx.object(ruleId), tx.object(groupId)],
		});

		// The transaction aborts during simulation with ENotPermitted
		await expect(
			extendedClient.core.signAndExecuteTransaction({
				transaction: tx,
				signer: joinerKeypair,
				include: { effects: true },
			}),
		).rejects.toThrow();
	});

	it('should allow the joined user to encrypt and decrypt messages', async () => {
		const joinerKeypair = await fundNewKeypair(faucetUrl);

		// Join via paid rule
		await extendedClient.paidJoinRule.join({
			signer: joinerKeypair,
			ruleId,
			groupId,
			fee: JOIN_FEE,
		});

		// Create a separate client for the joiner
		const joinerClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			...clientConfig,
			keypair: joinerKeypair,
		});

		// Encrypt a message
		const message = 'Hello from a paid member!';
		const data = new TextEncoder().encode(message);

		const envelope = await joinerClient.messaging.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			keyVersion: 0n,
			data,
		});

		expect(envelope.ciphertext).toBeInstanceOf(Uint8Array);

		// Decrypt
		const decrypted = await joinerClient.messaging.encryption.decrypt({
			groupId,
			encryptionHistoryId,
			envelope,
		});

		expect(new TextDecoder().decode(decrypted)).toBe(message);
	});
});
