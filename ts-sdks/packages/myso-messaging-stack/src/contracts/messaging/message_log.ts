/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Per-group **paid message escrow** only (`MYSO`). Free messaging, digests,
 * reactions, pins, and receipts live off-chain (relayer / clients).
 *
 * Authorization is enforced in `messaging`; this module holds escrow state and
 * invariants.
 */

import {
	MoveTuple,
	MoveStruct,
	normalizeMoveArguments,
	type RawTransactionArgument,
} from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
import * as balance from './deps/myso/balance.js';
import * as table from './deps/myso/table.js';
const $moduleName = '@local-pkg/messaging::message_log';
export const MessageLogTag = new MoveTuple({
	name: `${$moduleName}::MessageLogTag`,
	fields: [bcs.string()],
});
export const PaidMessageEscrow = new MoveStruct({
	name: `${$moduleName}::PaidMessageEscrow`,
	fields: {
		payer: bcs.Address,
		recipient: bcs.Address,
		amount: bcs.u64(),
		escrowed_balance: balance.Balance,
		created_at_ms: bcs.u64(),
		claimed: bcs.bool(),
	},
});
export const MessageLog = new MoveStruct({
	name: `${$moduleName}::MessageLog`,
	fields: {
		id: bcs.Address,
		group_id: bcs.Address,
		uuid: bcs.string(),
		/** Monotonic id for each paid send (`seq` indexes `paid_msg_escrow`). */
		next_seq: bcs.u64(),
		used_dedupe: table.Table,
		nonces: table.Table,
		paid_msg_escrow: table.Table,
	},
});
export const MessageLogCreated = new MoveStruct({
	name: `${$moduleName}::MessageLogCreated`,
	fields: {
		message_log_id: bcs.Address,
		group_id: bcs.Address,
		uuid: bcs.string(),
	},
});
export const PaidMessageSent = new MoveStruct({
	name: `${$moduleName}::PaidMessageSent`,
	fields: {
		group_id: bcs.Address,
		seq: bcs.u64(),
		payer: bcs.Address,
		recipient: bcs.Address,
		amount: bcs.u64(),
		created_at_ms: bcs.u64(),
	},
});
export const PaidMessageReplied = new MoveStruct({
	name: `${$moduleName}::PaidMessageReplied`,
	fields: {
		group_id: bcs.Address,
		paid_msg_seq: bcs.u64(),
		recipient: bcs.Address,
		reply_char_count: bcs.u32(),
	},
});
export const PaymentClaimed = new MoveStruct({
	name: `${$moduleName}::PaymentClaimed`,
	fields: {
		group_id: bcs.Address,
		seq: bcs.u64(),
		recipient: bcs.Address,
		amount: bcs.u64(),
		claimed_at_ms: bcs.u64(),
	},
});
export const PaymentClaimedSettled = new MoveStruct({
	name: `${$moduleName}::PaymentClaimedSettled`,
	fields: {
		group_id: bcs.Address,
		seq: bcs.u64(),
		recipient: bcs.Address,
		total_amount: bcs.u64(),
		platform_fee: bcs.u64(),
		treasury_fee: bcs.u64(),
		net_amount: bcs.u64(),
		platform_fee_recipient: bcs.Address,
		ecosystem_fee_recipient: bcs.Address,
		claimed_at_ms: bcs.u64(),
	},
});
export const PaymentRefunded = new MoveStruct({
	name: `${$moduleName}::PaymentRefunded`,
	fields: {
		group_id: bcs.Address,
		seq: bcs.u64(),
		payer: bcs.Address,
		amount: bcs.u64(),
		refunded_at_ms: bcs.u64(),
	},
});
export interface GroupIdArguments {
	self: RawTransactionArgument<string>;
}
export interface GroupIdOptions {
	package?: string;
	arguments: GroupIdArguments | [self: RawTransactionArgument<string>];
}
export function groupId(options: GroupIdOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'message_log',
			function: 'group_id',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface UuidArguments {
	self: RawTransactionArgument<string>;
}
export interface UuidOptions {
	package?: string;
	arguments: UuidArguments | [self: RawTransactionArgument<string>];
}
export function uuid(options: UuidOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'message_log',
			function: 'uuid',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface NextSeqArguments {
	self: RawTransactionArgument<string>;
}
export interface NextSeqOptions {
	package?: string;
	arguments: NextSeqArguments | [self: RawTransactionArgument<string>];
}
export function nextSeq(options: NextSeqOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'message_log',
			function: 'next_seq',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
