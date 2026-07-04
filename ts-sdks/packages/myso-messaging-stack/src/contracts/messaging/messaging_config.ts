/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/** Global configuration for paid messaging (fees, reply rules, dedupe limits). */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
const $moduleName = '@local-pkg/messaging::messaging_config';
export const MessagingAdminCap = new MoveStruct({
	name: `${$moduleName}::MessagingAdminCap`,
	fields: {
		id: bcs.Address,
	},
});
export const MessagingConfig = new MoveStruct({
	name: `${$moduleName}::MessagingConfig`,
	fields: {
		id: bcs.Address,
		paid_msg_platform_fee_bps: bcs.u64(),
		paid_msg_treasury_fee_bps: bcs.u64(),
		payment_expiration_ms: bcs.u64(),
		min_reply_chars: bcs.u32(),
		max_dedupe_key_bytes: bcs.u64(),
	},
});
export const MessagingConfigUpdatedEvent = new MoveStruct({
	name: `${$moduleName}::MessagingConfigUpdatedEvent`,
	fields: {
		updated_by: bcs.Address,
		timestamp: bcs.u64(),
		paid_msg_platform_fee_bps: bcs.u64(),
		paid_msg_treasury_fee_bps: bcs.u64(),
		payment_expiration_ms: bcs.u64(),
		min_reply_chars: bcs.u32(),
		max_dedupe_key_bytes: bcs.u64(),
	},
});
export interface UpdateMessagingConfigArguments {
	Admin: RawTransactionArgument<string>;
	config: RawTransactionArgument<string>;
	paidMsgPlatformFeeBps: RawTransactionArgument<number | bigint>;
	paidMsgTreasuryFeeBps: RawTransactionArgument<number | bigint>;
	paymentExpirationMs: RawTransactionArgument<number | bigint>;
	minReplyChars: RawTransactionArgument<number>;
	maxDedupeKeyBytes: RawTransactionArgument<number | bigint>;
}
export interface UpdateMessagingConfigOptions {
	package?: string;
	arguments:
		| UpdateMessagingConfigArguments
		| [
				Admin: RawTransactionArgument<string>,
				config: RawTransactionArgument<string>,
				paidMsgPlatformFeeBps: RawTransactionArgument<number | bigint>,
				paidMsgTreasuryFeeBps: RawTransactionArgument<number | bigint>,
				paymentExpirationMs: RawTransactionArgument<number | bigint>,
				minReplyChars: RawTransactionArgument<number>,
				maxDedupeKeyBytes: RawTransactionArgument<number | bigint>,
		  ];
}
export function updateMessagingConfig(options: UpdateMessagingConfigOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		null,
		null,
		'u64',
		'u64',
		'u64',
		'u32',
		'u64',
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'Admin',
		'config',
		'paidMsgPlatformFeeBps',
		'paidMsgTreasuryFeeBps',
		'paymentExpirationMs',
		'minReplyChars',
		'maxDedupeKeyBytes',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging_config',
			function: 'update_messaging_config',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface PaidMsgPlatformFeeBpsArguments {
	config: RawTransactionArgument<string>;
}
export interface PaidMsgPlatformFeeBpsOptions {
	package?: string;
	arguments: PaidMsgPlatformFeeBpsArguments | [config: RawTransactionArgument<string>];
}
export function paidMsgPlatformFeeBps(options: PaidMsgPlatformFeeBpsOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['config'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging_config',
			function: 'paid_msg_platform_fee_bps',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface PaidMsgTreasuryFeeBpsArguments {
	config: RawTransactionArgument<string>;
}
export interface PaidMsgTreasuryFeeBpsOptions {
	package?: string;
	arguments: PaidMsgTreasuryFeeBpsArguments | [config: RawTransactionArgument<string>];
}
export function paidMsgTreasuryFeeBps(options: PaidMsgTreasuryFeeBpsOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['config'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging_config',
			function: 'paid_msg_treasury_fee_bps',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface PaymentExpirationMsArguments {
	config: RawTransactionArgument<string>;
}
export interface PaymentExpirationMsOptions {
	package?: string;
	arguments: PaymentExpirationMsArguments | [config: RawTransactionArgument<string>];
}
export function paymentExpirationMs(options: PaymentExpirationMsOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['config'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging_config',
			function: 'payment_expiration_ms',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface MinReplyCharsArguments {
	config: RawTransactionArgument<string>;
}
export interface MinReplyCharsOptions {
	package?: string;
	arguments: MinReplyCharsArguments | [config: RawTransactionArgument<string>];
}
export function minReplyChars(options: MinReplyCharsOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['config'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging_config',
			function: 'min_reply_chars',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface MaxDedupeKeyBytesArguments {
	config: RawTransactionArgument<string>;
}
export interface MaxDedupeKeyBytesOptions {
	package?: string;
	arguments: MaxDedupeKeyBytesArguments | [config: RawTransactionArgument<string>];
}
export function maxDedupeKeyBytes(options: MaxDedupeKeyBytesOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['config'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'messaging_config',
			function: 'max_dedupe_key_bytes',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
