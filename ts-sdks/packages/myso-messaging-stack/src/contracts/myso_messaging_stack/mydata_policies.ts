/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: mydata_policies
 *
 * Default `mydata_approve` functions for MyData encryption access control. Called by
 * MyData key servers (via dry-run) to authorize decryption.
 *
 * ## Identity Bytes Format
 *
 * Identity bytes: `[group_id (32 bytes)][key_version (8 bytes LE u64)]` Total: 40
 * bytes
 *
 * - `group_id`: The PermissionedGroup<Messaging> object ID
 * - `key_version`: The encryption key version (supports key rotation)
 *
 * ## Custom Policies
 *
 * Apps can implement custom `mydata_approve` with different logic:
 *
 * - Subscription-based, time-limited, NFT-gated access, etc.
 * - Must be in the same package used during `mydata.encrypt`.
 */

import { type Transaction } from '@socialproof/myso/transactions';
import { normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
export interface ValidateIdentityArguments {
	group: RawTransactionArgument<string>;
	encryptionHistory: RawTransactionArgument<string>;
	id: RawTransactionArgument<number[]>;
}
export interface ValidateIdentityOptions {
	package?: string;
	arguments:
		| ValidateIdentityArguments
		| [
				group: RawTransactionArgument<string>,
				encryptionHistory: RawTransactionArgument<string>,
				id: RawTransactionArgument<number[]>,
		  ];
}
/**
 * Validates identity bytes format and extracts components.
 *
 * Expected format: `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
 *
 * Custom `mydata_approve` functions in external packages should call this to reuse
 * the standard identity validation logic instead of duplicating it.
 *
 * # Parameters
 *
 * - `group`: Reference to the PermissionedGroup<Messaging>
 * - `encryption_history`: Reference to the EncryptionHistory
 * - `id`: The MyData identity bytes to validate
 *
 * # Aborts
 *
 * - `EEncryptionHistoryMismatch`: if encryption_history doesn't belong to this
 *   group
 * - `EInvalidIdentity`: if length != 40 or group_id doesn't match
 * - `EInvalidKeyVersion`: if key_version > current_key_version
 */
export function validateIdentity(options: ValidateIdentityOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null, null, 'vector<u8>'] satisfies (string | null)[];
	const parameterNames = ['group', 'encryptionHistory', 'id'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'mydata_policies',
			function: 'validate_identity',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface MyDataApproveReaderArguments {
	id: RawTransactionArgument<number[]>;
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	encryptionHistory: RawTransactionArgument<string>;
}
export interface MyDataApproveReaderOptions {
	package?: string;
	arguments:
		| MyDataApproveReaderArguments
		| [
				id: RawTransactionArgument<number[]>,
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				encryptionHistory: RawTransactionArgument<string>,
		  ];
}
/**
 * Default mydata_approve that checks `MessagingReader` permission.
 *
 * # Parameters
 *
 * - `id`: MyData identity bytes
 *   `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
 * - `group`: Reference to the PermissionedGroup<Messaging>
 * - `encryption_history`: Reference to the EncryptionHistory
 * - `ctx`: Transaction context
 *
 * # Aborts
 *
 * - `EEncryptionHistoryMismatch`: if encryption_history doesn't belong to this
 *   group
 * - `EInvalidIdentity`: if identity bytes are malformed or group_id doesn't match
 * - `EInvalidKeyVersion`: if key_version doesn't exist
 * - `ENotPermitted`: if caller doesn't have `MessagingReader` permission
 */
export function mydataApproveReader(options: MyDataApproveReaderOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = ['vector<u8>', null, null, null] satisfies (string | null)[];
	const parameterNames = ['id', 'version', 'group', 'encryptionHistory'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'mydata_policies',
			function: 'mydata_approve_reader',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
