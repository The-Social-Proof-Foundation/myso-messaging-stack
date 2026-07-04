/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: mydata_policies
 *
 * Default `mydata_approve` functions for MyData encryption access control. Called
 * by MyData key servers (via dry-run) to authorize decryption.
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
	const packageAddress = options.package ?? '@local-pkg/messaging';
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
export interface MydataApproveReaderArguments {
	id: RawTransactionArgument<number[]>;
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	encryptionHistory: RawTransactionArgument<string>;
}
export interface MydataApproveReaderOptions {
	package?: string;
	arguments:
		| MydataApproveReaderArguments
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
export function mydataApproveReader(options: MydataApproveReaderOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
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
export interface MydataApproveReaderWithOversightArguments {
	id: RawTransactionArgument<number[]>;
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	encryptionHistory: RawTransactionArgument<string>;
	memoryAccount: RawTransactionArgument<string>;
	agentDerivedAddress: RawTransactionArgument<string>;
}
export interface MydataApproveReaderWithOversightOptions {
	package?: string;
	arguments:
		| MydataApproveReaderWithOversightArguments
		| [
				id: RawTransactionArgument<number[]>,
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				encryptionHistory: RawTransactionArgument<string>,
				memoryAccount: RawTransactionArgument<string>,
				agentDerivedAddress: RawTransactionArgument<string>,
		  ];
}
/**
 * Principal oversight fallback: allows the human owner to decrypt when they hold
 * no direct `MessagingReader` but a registered sub-agent on the same
 * [`MemoryAccount`] does.
 */
export function mydataApproveReaderWithOversight(options: MydataApproveReaderWithOversightOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = ['vector<u8>', null, null, null, null, 'address'] satisfies (
		| string
		| null
	)[];
	const parameterNames = [
		'id',
		'version',
		'group',
		'encryptionHistory',
		'memoryAccount',
		'agentDerivedAddress',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'mydata_policies',
			function: 'mydata_approve_reader_with_oversight',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface MydataApproveAgentReaderArguments {
	id: RawTransactionArgument<number[]>;
	version: RawTransactionArgument<string>;
	group: RawTransactionArgument<string>;
	encryptionHistory: RawTransactionArgument<string>;
	platform: RawTransactionArgument<string>;
	memoryConfig: RawTransactionArgument<string>;
	memoryAccount: RawTransactionArgument<string>;
}
export interface MydataApproveAgentReaderOptions {
	package?: string;
	arguments:
		| MydataApproveAgentReaderArguments
		| [
				id: RawTransactionArgument<number[]>,
				version: RawTransactionArgument<string>,
				group: RawTransactionArgument<string>,
				encryptionHistory: RawTransactionArgument<string>,
				platform: RawTransactionArgument<string>,
				memoryConfig: RawTransactionArgument<string>,
				memoryAccount: RawTransactionArgument<string>,
		  ];
}
/**
 * Sub-agent MyData reader approval via `CAP_MESSAGE_READ` on the
 * [`MemoryAccount`].
 */
export function mydataApproveAgentReader(options: MydataApproveAgentReaderOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [
		'vector<u8>',
		null,
		null,
		null,
		null,
		null,
		null,
		'0x2::clock::Clock',
	] satisfies (string | null)[];
	const parameterNames = [
		'id',
		'version',
		'group',
		'encryptionHistory',
		'platform',
		'memoryConfig',
		'memoryAccount',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'mydata_policies',
			function: 'mydata_approve_agent_reader',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
