// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { SessionKey } from '@socialproof/mydata';
import { SessionKey as SessionKeyClass } from '@socialproof/mydata';
import type { MyDataCompatibleClient } from '@socialproof/mydata';
import { mysoGroups } from '@socialproof/myso-groups';
import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { Transaction } from '@socialproof/myso/transactions';
import { describe, expect, it } from 'vitest';

import { mysoMessagingStack } from '../../src/client.js';
import { createPaidMessagingClient, PAID_MSG_NO_PLATFORM_FEE_RECIPIENT } from '../../src/paid-messaging.js';
import type { MySoMessagingStackEncryptionOptions } from '../../src/types.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';
import {
  MOCK_ECOSYSTEM_TREASURY_ID,
  MOCK_PACKAGE_CONFIG,
  MOCK_PACKAGE_ID,
} from './helpers/mock-package-config.js';

const MOCK_PERMISSIONED_GROUPS_PACKAGE_ID = '0x' + 'ff'.repeat(32);
const MOCK_WITNESS_TYPE = `${MOCK_PERMISSIONED_GROUPS_PACKAGE_ID}::messaging::Messaging`;
const RECIPIENT = '0x' + 'cd'.repeat(32);
const SENDER = '0x' + 'ee'.repeat(32);
// Short-circuits the build-time on-chain MemoryAccount lookup (no RPC in unit tests).
const CREATOR_MEMORY_ACCOUNT = '0x' + 'aa'.repeat(32);

const mockMyDataMySoClient = {} as MyDataCompatibleClient;

function createMockSessionKey(): SessionKey {
	const keypair = Ed25519Keypair.generate();
	return SessionKeyClass.import(
		{
			address: keypair.getPublicKey().toMySoAddress(),
			packageId: '0x' + '00'.repeat(32),
			creationTimeMs: Date.now(),
			ttlMin: 30,
			sessionKey: keypair.getSecretKey(),
		},
		mockMyDataMySoClient,
	);
}

function createMockEncryptionOptions(): MySoMessagingStackEncryptionOptions {
	const sessionKey = createMockSessionKey();
	return {
		sessionKey: { getSessionKey: () => sessionKey },
	};
}

function createMessagingClient() {
	const mysoClient = new MySoJsonRpcClient({ url: 'http://127.0.0.1:9000', network: 'localnet' });
	return mysoClient
		.$extend(
			mysoGroups({
				witnessType: MOCK_WITNESS_TYPE,
				packageConfig: {
					originalPackageId: MOCK_PERMISSIONED_GROUPS_PACKAGE_ID,
					latestPackageId: MOCK_PERMISSIONED_GROUPS_PACKAGE_ID,
				},
			}),
			{ name: 'mydata' as const, register: () => createMockMyDataClient() },
		)
		.$extend(
			mysoMessagingStack({
				packageConfig: MOCK_PACKAGE_CONFIG,
				encryption: createMockEncryptionOptions(),
				relayer: { relayerUrl: 'http://localhost:3000' },
			}),
		);
}

interface ArgumentLike {
	$kind?: string;
	NestedResult?: unknown;
	Input?: unknown;
}

interface CommandLike {
	$kind?: string;
	MoveCall?: {
		package?: string;
		module?: string;
		function?: string;
		arguments?: ArgumentLike[];
	};
	SplitCoins?: unknown;
	$Intent?: { name?: string };
}

function commandsOf(transaction: Transaction): CommandLike[] {
	return transaction.getData().commands as CommandLike[];
}

function findMoveCall(
	transaction: Transaction,
	fn: string,
): CommandLike['MoveCall'] | undefined {
	return commandsOf(transaction).find((cmd) => cmd.MoveCall?.function === fn)?.MoveCall;
}

function objectInputId(transaction: Transaction, arg: ArgumentLike | undefined): string | undefined {
	if (arg?.$kind !== 'Input' || typeof arg.Input !== 'number') {
		return undefined;
	}
	const serialized = JSON.stringify(transaction.getData().inputs[arg.Input] ?? null);
	const match = serialized.match(/0x[a-f0-9]{64}/i);
	return match?.[0];
}

describe('PaidMessagingClient builders', () => {
	const client = createMessagingClient();
	const paid = createPaidMessagingClient({ messaging: client.messaging });

	it('buildPayDmEscrow targets messaging::send_paid_message_digest with a gas-split escrow', () => {
		const { transaction } = paid.buildPayDmEscrow({
			groupRef: { uuid: 'test-uuid' },
			recipient: RECIPIENT,
			escrowAmount: 10_000_000_000n,
		});

		expect(transaction).toBeInstanceOf(Transaction);

		const moveCall = findMoveCall(transaction, 'send_paid_message_digest');
		expect(moveCall).toBeDefined();
		expect(moveCall?.module).toBe('messaging');
		expect(moveCall?.package).toBe(MOCK_PACKAGE_ID);

		// Escrow funded by splitting from gas when no paymentCoinId is given.
		expect(commandsOf(transaction).some((cmd) => cmd.SplitCoins)).toBe(true);
	});

	it('buildPayDmEscrow skips the gas split when paymentCoinId is provided', () => {
		const { transaction } = paid.buildPayDmEscrow({
			groupRef: { uuid: 'test-uuid' },
			recipient: RECIPIENT,
			escrowAmount: 10_000_000_000n,
			paymentCoinId: '0x' + '77'.repeat(32),
		});

		expect(findMoveCall(transaction, 'send_paid_message_digest')).toBeDefined();
		expect(commandsOf(transaction).some((cmd) => cmd.SplitCoins)).toBe(false);
	});

	it('buildOpenPaidDm returns derive-consistent ids and a create -> escrow -> share PTB', () => {
		const uuid = 'open-paid-dm-uuid';
		const { transaction, uuid: outUuid, groupId, messageLogId } = paid.buildOpenPaidDm({
			sender: SENDER,
			recipient: RECIPIENT,
			escrowAmount: 10_000_000_000n,
			name: 'Paid DM',
			uuid,
			creatorMemoryAccountId: CREATOR_MEMORY_ACCOUNT,
		});

		expect(outUuid).toBe(uuid);
		expect(groupId).toBe(client.messaging.derive.groupId({ uuid }));
		expect(messageLogId).toBe(client.messaging.derive.messageLogId({ uuid }));

		// Group creation is an async thunk (DEK generation + memory-account
		// routing resolve at build time); the escrow MoveCall is added eagerly.
		const commands = commandsOf(transaction);
		expect(
			commands.some((cmd) => cmd.$Intent?.name === 'AsyncTransactionThunk'),
		).toBe(true);

		const escrowCall = findMoveCall(transaction, 'send_paid_message_digest');
		expect(escrowCall).toBeDefined();

		// The group/log must be same-transaction results (NestedResult), never
		// object inputs: the derived ids do not exist on-chain until this
		// transaction executes ("input objects invalid" otherwise).
		// send_paid_message_digest args: [version, group, log, ...].
		const groupArg = escrowCall?.arguments?.[1];
		const logArg = escrowCall?.arguments?.[2];
		expect(groupArg?.$kind).toBe('NestedResult');
		expect(logArg?.$kind).toBe('NestedResult');

		// The create thunk placeholder precedes the escrow call, preserving
		// on-chain ordering (group must exist before the paid send).
		const thunkIndex = commands.findIndex(
			(cmd) => cmd.$Intent?.name === 'AsyncTransactionThunk',
		);
		const escrowIndex = commands.findIndex(
			(cmd) => cmd.MoveCall?.function === 'send_paid_message_digest',
		);
		expect(thunkIndex).toBeGreaterThanOrEqual(0);
		expect(thunkIndex).toBeLessThan(escrowIndex);

		// The created values are shared last (after the paid-send borrow):
		// three transfer::public_share_object calls following the escrow call.
		const shareIndexes = commands
			.map((cmd, idx) =>
				cmd.MoveCall?.module === 'transfer' &&
				cmd.MoveCall.function === 'public_share_object'
					? idx
					: -1,
			)
			.filter((idx) => idx >= 0);
		expect(shareIndexes).toHaveLength(3);
		for (const idx of shareIndexes) {
			expect(idx).toBeGreaterThan(escrowIndex);
		}
	});

	it('buildOpenPaidDm generates a UUID when omitted', () => {
		const first = paid.buildOpenPaidDm({
			sender: SENDER,
			recipient: RECIPIENT,
			escrowAmount: 1n,
			creatorMemoryAccountId: CREATOR_MEMORY_ACCOUNT,
		});
		const second = paid.buildOpenPaidDm({
			sender: SENDER,
			recipient: RECIPIENT,
			escrowAmount: 1n,
			creatorMemoryAccountId: CREATOR_MEMORY_ACCOUNT,
		});

		expect(first.uuid).toBeTruthy();
		expect(second.uuid).toBeTruthy();
		expect(first.uuid).not.toBe(second.uuid);
		expect(first.groupId).not.toBe(second.groupId);
	});

	it('buildReplyAndClaimSettled targets reply_to_paid_message_claim_settled with ecosystem treasury object', () => {
		const { transaction } = paid.buildReplyAndClaimSettled({
			groupRef: { uuid: 'claim-uuid' },
			paidMsgSeq: 0n,
			charCount: 12,
			platformFeeRecipient: PAID_MSG_NO_PLATFORM_FEE_RECIPIENT,
		});

		const moveCall = findMoveCall(transaction, 'reply_to_paid_message_claim_settled');
		expect(moveCall).toBeDefined();
		expect(moveCall?.module).toBe('messaging');
		expect(moveCall?.package).toBe(MOCK_PACKAGE_ID);

		const args = moveCall?.arguments ?? [];
		const platformArg = args[args.length - 2];
		const ecosystemTreasuryArg = args[args.length - 1];
		expect(platformArg?.$kind).toBe('Input');
		expect(ecosystemTreasuryArg?.$kind).toBe('Input');
		expect(objectInputId(transaction, ecosystemTreasuryArg)).toBe(MOCK_ECOSYSTEM_TREASURY_ID);
	});
});
