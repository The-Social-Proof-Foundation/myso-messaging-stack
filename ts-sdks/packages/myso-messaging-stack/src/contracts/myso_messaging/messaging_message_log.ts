// Hand-written bindings for `messaging::` paid-escrow entry points only.
// Kept separate from generated `messaging.ts` to avoid clobbering codegen.

import { normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import type { Transaction } from '@socialproof/myso/transactions';

const CLOCK = '0x2::clock::Clock' as const;

export interface SendPaidMessageDigestBaseArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	recipient: RawTransactionArgument<string>;
	payment: RawTransactionArgument<string>;
	escrowAmount: RawTransactionArgument<number | bigint>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
}

export interface SendPaidMessageDigestOptions {
	package?: string;
	arguments: SendPaidMessageDigestBaseArguments;
}

export function sendPaidMessageDigest(options: SendPaidMessageDigestOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const a = options.arguments;
	const argumentsTypes = [
		null,
		null,
		null,
		'address',
		null,
		'u64',
		'vector<u8>',
		'u128',
		CLOCK,
	] as const;
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'send_paid_message_digest',
			arguments: normalizeMoveArguments(
				[
					a.version,
					a.group,
					a.log,
					a.recipient,
					a.payment,
					a.escrowAmount,
					a.dedupeKey,
					a.nonce,
				],
				argumentsTypes,
			),
		});
}

export interface ReplyToPaidMessageClaimCoinArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	paidMsgSeq: RawTransactionArgument<number | bigint>;
	charCount: RawTransactionArgument<number>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
}

export interface ReplyToPaidMessageClaimCoinOptions {
	package?: string;
	arguments: ReplyToPaidMessageClaimCoinArguments;
}

export function replyToPaidMessageClaimCoin(options: ReplyToPaidMessageClaimCoinOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const a = options.arguments;
	const argumentsTypes = [null, null, null, 'u64', 'u32', 'vector<u8>', 'u128', CLOCK] as const;
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'reply_to_paid_message_claim_coin',
			arguments: normalizeMoveArguments(
				[
					a.version,
					a.group,
					a.log,
					a.paidMsgSeq,
					a.charCount,
					a.dedupeKey,
					a.nonce,
				],
				argumentsTypes,
			),
		});
}

export interface ReplyToPaidMessageClaimSettledArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	paidMsgSeq: RawTransactionArgument<number | bigint>;
	charCount: RawTransactionArgument<number>;
	dedupeKey: RawTransactionArgument<number[]>;
	nonce: RawTransactionArgument<number | bigint>;
	platformFeeRecipient: RawTransactionArgument<string>;
	ecosystemFeeRecipient: RawTransactionArgument<string>;
}

export interface ReplyToPaidMessageClaimSettledOptions {
	package?: string;
	arguments: ReplyToPaidMessageClaimSettledArguments;
}

export function replyToPaidMessageClaimSettled(options: ReplyToPaidMessageClaimSettledOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const a = options.arguments;
	const argumentsTypes = [
		null,
		null,
		null,
		'u64',
		'u32',
		'vector<u8>',
		'u128',
		CLOCK,
		'address',
		'address',
	] as const;
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'reply_to_paid_message_claim_settled',
			arguments: normalizeMoveArguments(
				[
					a.version,
					a.group,
					a.log,
					a.paidMsgSeq,
					a.charCount,
					a.dedupeKey,
					a.nonce,
					CLOCK,
					a.platformFeeRecipient,
					a.ecosystemFeeRecipient,
				],
				argumentsTypes,
			),
		});
}

export interface RefundPaidEscrowArguments {
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	log: RawTransactionArgument<string>;
	paidMsgSeq: RawTransactionArgument<number | bigint>;
}

export interface RefundPaidEscrowOptions {
	package?: string;
	arguments: RefundPaidEscrowArguments;
}

export function refundPaidEscrow(options: RefundPaidEscrowOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const a = options.arguments;
	const argumentsTypes = [null, null, null, 'u64', CLOCK] as const;
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging',
			function: 'refund_paid_escrow',
			arguments: normalizeMoveArguments(
				[a.version, a.group, a.log, a.paidMsgSeq],
				argumentsTypes,
			),
		});
}
