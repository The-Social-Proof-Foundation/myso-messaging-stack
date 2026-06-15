/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import {
	MoveTuple,
	MoveStruct,
	normalizeMoveArguments,
	type RawTransactionArgument,
} from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
const $moduleName = '@local-pkg/messaging::version';
export const VERSION = new MoveTuple({ name: `${$moduleName}::VERSION`, fields: [bcs.bool()] });
export const Version = new MoveStruct({
	name: `${$moduleName}::Version`,
	fields: {
		id: bcs.Address,
		version: bcs.u64(),
	},
});
export interface VersionArguments {
	self: RawTransactionArgument<string>;
}
export interface VersionOptions {
	package?: string;
	arguments: VersionArguments | [self: RawTransactionArgument<string>];
}
export function version(options: VersionOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['self'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'version',
			function: 'version',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface PackageVersionOptions {
	package?: string;
	arguments?: [];
}
export function packageVersion(options: PackageVersionOptions = {}) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'version',
			function: 'package_version',
		});
}
