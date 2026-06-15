/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * On-chain registry mapping **canonical group handles** to
 * `PermissionedGroup<Messaging>` object IDs.
 *
 * This is intentionally separate from any **profile** `UsernameRegistry` (user
 * usernames): the same string may exist as both a user username and a group
 * handle; clients use separate lookup APIs (`lookup_profile_by_username` vs
 * `lookup_group_by_handle`).
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
import * as table from './deps/myso/table.js';
const $moduleName = '@local-pkg/messaging::group_handle_registry';
export const GroupHandleRegistry = new MoveStruct({
	name: `${$moduleName}::GroupHandleRegistry`,
	fields: {
		id: bcs.Address,
		handle_to_group: table.Table,
		group_to_handle: table.Table,
	},
});
export interface LookupGroupByHandleArguments {
	registry: RawTransactionArgument<string>;
	handle: RawTransactionArgument<string>;
}
export interface LookupGroupByHandleOptions {
	package?: string;
	arguments:
		| LookupGroupByHandleArguments
		| [registry: RawTransactionArgument<string>, handle: RawTransactionArgument<string>];
}
/**
 * Returns the group object ID for a handle, if registered. No version gate — safe
 * for off-chain indexing.
 */
export function lookupGroupByHandle(options: LookupGroupByHandleOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, '0x1::string::String'] satisfies (string | null)[];
	const parameterNames = ['registry', 'handle'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'group_handle_registry',
			function: 'lookup_group_by_handle',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
