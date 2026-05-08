/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: metadata
 *
 * Metadata associated with a messaging group. Stored as a dynamic field on the
 * `PermissionedGroup<Messaging>` object via the `GroupManager` actor.
 *
 * Immutable fields (set at creation, never changed):
 *
 * - `uuid`: Client-provided UUID
 * - `creator`: Address of the group creator
 *
 * Mutable fields (editable by `MetadataAdmin` holders):
 *
 * - `name`: Human-readable group name
 * - `data`: Key-value map for arbitrary extension data
 */

import {
	MoveTuple,
	MoveStruct,
	normalizeMoveArguments,
	type RawTransactionArgument,
} from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
import * as vec_map from './deps/myso/vec_map.js';
const $moduleName = '@local-pkg/myso-messaging-stack::metadata';
export const MetadataKey = new MoveTuple({
	name: `${$moduleName}::MetadataKey`,
	fields: [bcs.u64()],
});
export const Metadata = new MoveStruct({
	name: `${$moduleName}::Metadata`,
	fields: {
		name: bcs.string(),
		uuid: bcs.string(),
		creator: bcs.Address,
		data: vec_map.VecMap(bcs.string(), bcs.string()),
	},
});
export interface KeyOptions {
	package?: string;
	arguments?: [];
}
/** Returns the dynamic field key for the current schema version. */
export function key(options: KeyOptions = {}) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'metadata',
			function: 'key',
		});
}
export interface NameArguments {
	self: RawTransactionArgument<string>;
}
export interface NameOptions {
	package?: string;
	arguments: NameArguments | [self: RawTransactionArgument<string>];
}
export function name(options: NameOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'metadata',
			function: 'name',
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
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'metadata',
			function: 'uuid',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface CreatorArguments {
	self: RawTransactionArgument<string>;
}
export interface CreatorOptions {
	package?: string;
	arguments: CreatorArguments | [self: RawTransactionArgument<string>];
}
export function creator(options: CreatorOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'metadata',
			function: 'creator',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface DataArguments {
	self: RawTransactionArgument<string>;
}
export interface DataOptions {
	package?: string;
	arguments: DataArguments | [self: RawTransactionArgument<string>];
}
export function data(options: DataOptions) {
	const packageAddress = options.package ?? '@local-pkg/myso-messaging-stack';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'metadata',
			function: 'data',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
