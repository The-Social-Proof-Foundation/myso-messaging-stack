/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Per-wallet paid DM policy for the messaging package.
 *
 * Stored separately from social profiles: keyed by wallet address, sparse table
 * (only wallets that opt in have a row).
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
import * as table from './deps/myso/table.js';
const $moduleName = '@local-pkg/messaging::paid_messaging_policy';
export const PaidMessagingPolicy = new MoveStruct({
	name: `${$moduleName}::PaidMessagingPolicy`,
	fields: {
		enabled: bcs.bool(),
		min_cost: bcs.option(bcs.u64()),
	},
});
export const PaidMessagingRegistry = new MoveStruct({
	name: `${$moduleName}::PaidMessagingRegistry`,
	fields: {
		id: bcs.Address,
		policies: table.Table,
	},
});
export const PaidMessagingPolicyUpdated = new MoveStruct({
	name: `${$moduleName}::PaidMessagingPolicyUpdated`,
	fields: {
		wallet: bcs.Address,
		enabled: bcs.bool(),
		min_cost: bcs.option(bcs.u64()),
	},
});
export interface SetPaidMessagingPolicyArguments {
	registry: RawTransactionArgument<string>;
	enabled: RawTransactionArgument<boolean>;
	minCost: RawTransactionArgument<number | bigint | null>;
}
export interface SetPaidMessagingPolicyOptions {
	package?: string;
	arguments:
		| SetPaidMessagingPolicyArguments
		| [
				registry: RawTransactionArgument<string>,
				enabled: RawTransactionArgument<boolean>,
				minCost: RawTransactionArgument<number | bigint | null>,
		  ];
}
/**
 * Sets paid DM policy for the transaction sender's wallet.
 *
 * When `enabled` is true, `min_cost` must be set (enforced on stranger 1:1 paid
 * opens).
 */
export function setPaidMessagingPolicy(options: SetPaidMessagingPolicyOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, 'bool', '0x1::option::Option<u64>'] satisfies (string | null)[];
	const parameterNames = ['registry', 'enabled', 'minCost'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_messaging_policy',
			function: 'set_paid_messaging_policy',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface RequiresPaymentFromArguments {
	registry: RawTransactionArgument<string>;
	recipient: RawTransactionArgument<string>;
}
export interface RequiresPaymentFromOptions {
	package?: string;
	arguments:
		| RequiresPaymentFromArguments
		| [registry: RawTransactionArgument<string>, recipient: RawTransactionArgument<string>];
}
/** Returns `Some(min_cost)` when the recipient requires paid stranger DMs. */
export function requiresPaymentFrom(options: RequiresPaymentFromOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, 'address'] satisfies (string | null)[];
	const parameterNames = ['registry', 'recipient'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_messaging_policy',
			function: 'requires_payment_from',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
