/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Fee distribution for claimed paid-message escrow (`MYSO`).
 *
 * Fee BPS are read from [`messaging_config::MessagingConfig`].
 *
 * When `platform_fee_recipient` is [`NO_PLATFORM_FEE_RECIPIENT`] (`@0x0`), the
 * platform share is combined with the ecosystem share and sent to
 * `ecosystem_fee_recipient` (wallet paid DMs with no associated platform).
 *
 * Uses `transfer::public_transfer` to fee recipients. Credits to the live
 * `Platform` treasury balance require
 * `social_contracts::platform::add_to_treasury` (same-package); see
 * `ref_social_contract/sources/messaging_paid_fee_bridge.move` for a
 * foundation-side helper.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
import { type Transaction } from '@socialproof/myso/transactions';
const $moduleName = '@local-pkg/messaging::paid_escrow_settlement';
export const EscrowFeeTotals = new MoveStruct({
	name: `${$moduleName}::EscrowFeeTotals`,
	fields: {
		total_amount: bcs.u64(),
		platform_fee: bcs.u64(),
		treasury_fee: bcs.u64(),
		net_amount: bcs.u64(),
	},
});
export interface NoPlatformFeeRecipientOptions {
	package?: string;
	arguments?: [];
}
/**
 * Sentinel: pass as `platform_fee_recipient` when no platform is associated with
 * the paid DM.
 */
export function noPlatformFeeRecipient(options: NoPlatformFeeRecipientOptions = {}) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_escrow_settlement',
			function: 'no_platform_fee_recipient',
		});
}
export interface TotalAmountArguments {
	t: RawTransactionArgument<string>;
}
export interface TotalAmountOptions {
	package?: string;
	arguments: TotalAmountArguments | [t: RawTransactionArgument<string>];
}
export function totalAmount(options: TotalAmountOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['t'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_escrow_settlement',
			function: 'total_amount',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface PlatformFeeArguments {
	t: RawTransactionArgument<string>;
}
export interface PlatformFeeOptions {
	package?: string;
	arguments: PlatformFeeArguments | [t: RawTransactionArgument<string>];
}
export function platformFee(options: PlatformFeeOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['t'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_escrow_settlement',
			function: 'platform_fee',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface TreasuryFeeArguments {
	t: RawTransactionArgument<string>;
}
export interface TreasuryFeeOptions {
	package?: string;
	arguments: TreasuryFeeArguments | [t: RawTransactionArgument<string>];
}
export function treasuryFee(options: TreasuryFeeOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['t'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_escrow_settlement',
			function: 'treasury_fee',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface NetAmountArguments {
	t: RawTransactionArgument<string>;
}
export interface NetAmountOptions {
	package?: string;
	arguments: NetAmountArguments | [t: RawTransactionArgument<string>];
}
export function netAmount(options: NetAmountOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null] satisfies (string | null)[];
	const parameterNames = ['t'];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_escrow_settlement',
			function: 'net_amount',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
export interface DistributeEscrowToRecipientsArguments {
	config: RawTransactionArgument<string>;
	escrowCoin: RawTransactionArgument<string>;
	platformFeeRecipient: RawTransactionArgument<string>;
	ecosystemFeeRecipient: RawTransactionArgument<string>;
	primaryRecipient: RawTransactionArgument<string>;
}
export interface DistributeEscrowToRecipientsOptions {
	package?: string;
	arguments:
		| DistributeEscrowToRecipientsArguments
		| [
				config: RawTransactionArgument<string>,
				escrowCoin: RawTransactionArgument<string>,
				platformFeeRecipient: RawTransactionArgument<string>,
				ecosystemFeeRecipient: RawTransactionArgument<string>,
				primaryRecipient: RawTransactionArgument<string>,
		  ];
}
/**
 * Splits `escrow_coin` per paid-message BPS: platform, ecosystem, then
 * `primary_recipient`.
 */
export function distributeEscrowToRecipients(options: DistributeEscrowToRecipientsOptions) {
	const packageAddress = options.package ?? '@local-pkg/messaging';
	const argumentsTypes = [null, null, 'address', 'address', 'address'] satisfies (string | null)[];
	const parameterNames = [
		'config',
		'escrowCoin',
		'platformFeeRecipient',
		'ecosystemFeeRecipient',
		'primaryRecipient',
	];
	return (tx: Transaction) =>
		tx.moveCall({
			package: packageAddress,
			module: 'paid_escrow_settlement',
			function: 'distribute_escrow_to_recipients',
			arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
		});
}
