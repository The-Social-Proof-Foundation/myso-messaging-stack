// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { Transaction } from '@socialproof/myso/transactions';

import type { MySoMessagingStackClient } from './client.js';
import { MySoMessagingStackClientError } from './error.js';
import {
	createMessagingGatingClient,
	MessagingGatingClient,
	type WalletMessagingPolicy,
} from './gating.js';
import type { GroupRef } from './types.js';

export interface PaidMessagingClientOptions {
	messaging: MySoMessagingStackClient;
	gating?: MessagingGatingClient;
}

export interface SetPaidPolicyOptions {
	signer: Signer;
	enabled: boolean;
	minCost: bigint | null;
}

export interface OpenPaidDmOptions {
	signer: Signer;
	recipient: string;
	escrowAmount: bigint;
	/** Coin object ID to fund the escrow. When omitted, split from gas. */
	paymentCoinId?: string;
	/** Replay-protection key (max 256 bytes). Random 32 bytes when omitted. */
	dedupeKey?: Uint8Array | number[];
	/** Per-sender replay nonce (u128). Random when omitted. */
	nonce?: number | bigint;
	name?: string;
	uuid?: string;
	/** Skip off-chain gating check (default false). */
	skipGatingCheck?: boolean;
}

export interface OpenAgentPaidDmOptions extends OpenPaidDmOptions {
	platformId: string;
	memoryAccountId: string;
}

/**
 * Options for {@link PaidMessagingClient.buildOpenPaidDm} — the unsigned
 * transaction variant of {@link OpenPaidDmOptions}. Takes the sender address
 * instead of a signer; the caller owns signing (e.g. with its own gas
 * resolution strategy).
 */
export interface BuildOpenPaidDmOptions {
	/** Transaction sender (the group creator). */
	sender: string;
	recipient: string;
	escrowAmount: bigint;
	/** Coin object ID to fund the escrow. When omitted, split from gas. */
	paymentCoinId?: string;
	/** Replay-protection key (max 256 bytes). Random 32 bytes when omitted. */
	dedupeKey?: Uint8Array | number[];
	/** Per-sender replay nonce (u128). Random when omitted. */
	nonce?: number | bigint;
	name?: string;
	uuid?: string;
	/**
	 * Creator's MemoryAccount object ID. When omitted, resolved on-chain at
	 * build time (wallet-only senders fall back to the wallet group variant).
	 */
	creatorMemoryAccountId?: string;
}

/** Unsigned open-paid-DM transaction plus the ids derived from its UUID. */
export interface BuildOpenPaidDmResult {
	transaction: Transaction;
	uuid: string;
	groupId: string;
	messageLogId: string;
}

/**
 * Options for {@link PaidMessagingClient.buildPayDmEscrow} — the unsigned
 * transaction variant of {@link PayDmEscrowOptions}.
 */
export interface BuildPayDmEscrowOptions {
	groupRef: GroupRef;
	recipient: string;
	escrowAmount: bigint;
	/** Coin object ID to fund the escrow. When omitted, split from gas. */
	paymentCoinId?: string;
	/** Replay-protection key (max 256 bytes). Random 32 bytes when omitted. */
	dedupeKey?: Uint8Array | number[];
	/** Per-sender replay nonce (u128). Random when omitted. */
	nonce?: number | bigint;
}

/**
 * Options for paying the DM escrow in an **existing** group (e.g. after the
 * relayer rejected a first message with `PAYMENT_REQUIRED`).
 */
export interface PayDmEscrowOptions {
	signer: Signer;
	groupRef: GroupRef;
	recipient: string;
	escrowAmount: bigint;
	/** Coin object ID to fund the escrow. When omitted, split from gas. */
	paymentCoinId?: string;
	/** Replay-protection key (max 256 bytes). Random 32 bytes when omitted. */
	dedupeKey?: Uint8Array | number[];
	/** Per-sender replay nonce (u128). Random when omitted. */
	nonce?: number | bigint;
	/** Skip off-chain gating check (default false). */
	skipGatingCheck?: boolean;
}

function randomDedupeKey(): Uint8Array {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** Random u128 nonce — per-sender collision odds are negligible. */
function randomNonce(): bigint {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let value = 0n;
	for (const byte of bytes) {
		value = (value << 8n) | BigInt(byte);
	}
	return value;
}

/** Resolves the escrow funding source: explicit coin or a split from gas. */
function resolvePayment(
	tx: Transaction,
	options: { paymentCoinId?: string; escrowAmount: bigint },
) {
	if (options.paymentCoinId) {
		return options.paymentCoinId;
	}
	const [payment] = tx.splitCoins(tx.gas, [options.escrowAmount]);
	return payment;
}

/** @deprecated Use {@link MySoMessagingStackView.getMessagingConfig} for the live on-chain value. */
export const PAID_DM_MIN_REPLY_CHARS = 6;

/**
 * Pass as `platformFeeRecipient` when no platform is associated with the paid DM.
 * On-chain, both fee slices (500 bps total) route to the ecosystem treasury address.
 */
export const PAID_MSG_NO_PLATFORM_FEE_RECIPIENT = '0x0';

export interface ReplyAndClaimSettledOptions {
	signer: Signer;
	groupRef: GroupRef;
	paidMsgSeq: number | bigint;
	charCount: number;
	dedupeKey: Uint8Array | number[];
	nonce: number | bigint;
	platformFeeRecipient: string;
}

export interface BuildReplyAndClaimSettledOptions {
	groupRef: GroupRef;
	paidMsgSeq: number | bigint;
	charCount: number;
	dedupeKey?: Uint8Array | number[];
	nonce?: number | bigint;
	platformFeeRecipient: string;
}

export interface RefundPaidEscrowOptions {
	signer: Signer;
	groupRef: GroupRef;
	paidMsgSeq: number | bigint;
}

/**
 * High-level paid stranger DM helpers wrapping on-chain escrow + optional off-chain gating.
 */
export class PaidMessagingClient {
	readonly #messaging: MySoMessagingStackClient;
	readonly #gating?: MessagingGatingClient;
	#minReplyCharsCache: number | null = null;

	constructor(options: PaidMessagingClientOptions) {
		this.#messaging = options.messaging;
		this.#gating = options.gating;
	}

	/** Minimum reply characters required to claim paid-DM escrow (from on-chain config). */
	async minReplyChars(): Promise<number> {
		if (this.#minReplyCharsCache !== null) {
			return this.#minReplyCharsCache;
		}
		const config = await this.#messaging.view.getMessagingConfig();
		this.#minReplyCharsCache = config.minReplyChars;
		return config.minReplyChars;
	}

	async setPolicy(options: SetPaidPolicyOptions): Promise<{ digest: string }> {
		const tx = new Transaction();
		tx.add(
			this.#messaging.call.setPaidMessagingPolicy({
				enabled: options.enabled,
				minCost: options.minCost,
			}),
		);
		return this.#execute(tx, options.signer, 'set paid messaging policy');
	}

	/** Off-chain policy from myso-social-server (indexed PaidMessagingRegistry). */
	async getPolicy(recipient: string): Promise<WalletMessagingPolicy | null> {
		if (!this.#gating) {
			throw new MySoMessagingStackClientError(
				'PaidMessagingClient.getPolicy requires a MessagingGatingClient',
			);
		}
		return this.#gating.getWalletMessagingPolicy(recipient);
	}

	/** On-chain policy via `requires_payment_from` dev-inspect. */
	async getOnChainPolicy(recipient: string): Promise<{ enabled: boolean; minCost: bigint | null }> {
		return this.#messaging.view.requiresPaymentFromRecipient(recipient);
	}

	/**
	 * Builds the unsigned open-paid-DM transaction as one PTB:
	 * `messaging::create_group` (or the wallet variant) returning the
	 * `(group, encryptionHistory, messageLog)` values, then
	 * `messaging::send_paid_message_digest` borrowing those results, then
	 * `transfer::public_share_object` on all three — sharing must come last.
	 *
	 * The group/log must be passed as same-transaction results, never by their
	 * derived ids: the objects do not exist on-chain until this transaction
	 * executes, so id-based object inputs fail resolution with
	 * "input objects invalid".
	 *
	 * The escrow is funded from `paymentCoinId` or a gas split. Use this
	 * builder when the caller owns signing — e.g. to pre-resolve gas payment
	 * against live RPC.
	 */
	buildOpenPaidDm(options: BuildOpenPaidDmOptions): BuildOpenPaidDmResult {
		const uuid = options.uuid ?? crypto.randomUUID();
		const name = options.name ?? 'Paid DM';

		const transaction = new Transaction();
		const created = transaction.add(
			this.#messaging.call.createGroup({
				sender: options.sender,
				name,
				uuid,
				initialMembers: [options.recipient],
				...(options.creatorMemoryAccountId && {
					creatorMemoryAccountId: options.creatorMemoryAccountId,
				}),
			}),
		);
		transaction.add(
			this.#messaging.call.sendPaidMessageDigest({
				group: created[0],
				messageLog: created[2],
				recipient: options.recipient,
				payment: resolvePayment(transaction, options),
				escrowAmount: options.escrowAmount,
				dedupeKey: options.dedupeKey ?? randomDedupeKey(),
				nonce: options.nonce ?? randomNonce(),
			}),
		);
		transaction.add(
			this.#messaging.call.shareGroup({
				group: created[0],
				encryptionHistory: created[1],
				messageLog: created[2],
			}),
		);

		return {
			transaction,
			uuid,
			groupId: this.#messaging.derive.groupId({ uuid }),
			messageLogId: this.#messaging.derive.messageLogId({ uuid }),
		};
	}

	async openPaidDm(options: OpenPaidDmOptions): Promise<{
		digest: string;
		groupId: string;
		uuid: string;
		messageLogId: string;
	}> {
		if (!options.skipGatingCheck && this.#gating) {
			await this.#gating.assertPaidOpenAllowed({
				recipient: options.recipient,
				escrowAmount: options.escrowAmount,
			});
		}

		const { transaction, uuid, groupId, messageLogId } = this.buildOpenPaidDm({
			sender: options.signer.toMySoAddress(),
			recipient: options.recipient,
			escrowAmount: options.escrowAmount,
			paymentCoinId: options.paymentCoinId,
			dedupeKey: options.dedupeKey,
			nonce: options.nonce,
			name: options.name,
			uuid: options.uuid,
		});

		const { digest } = await this.#execute(transaction, options.signer, 'open paid DM');
		return { digest, groupId, uuid, messageLogId };
	}

	/**
	 * Pay the DM escrow in an existing group — the recovery path after the
	 * relayer rejects a first message with `PAYMENT_REQUIRED` (e.g. the group
	 * was created without payment, or a follow was later removed).
	 *
	 * Runs the same on-chain checks as `openPaidDm` (`send_paid_message_digest`):
	 * DM metadata, first paid send, not-following, recipient minimum. After the
	 * transaction lands and the relayer indexes `PaidMessageSent`, retry the send.
	 */
	/**
	 * Builds the unsigned pay-escrow transaction for an existing group
	 * (`messaging::send_paid_message_digest`). See {@link buildOpenPaidDm}
	 * for when to prefer builders over the signing methods.
	 */
	buildPayDmEscrow(options: BuildPayDmEscrowOptions): { transaction: Transaction } {
		const transaction = new Transaction();
		transaction.add(
			this.#messaging.call.sendPaidMessageDigest({
				...options.groupRef,
				recipient: options.recipient,
				payment: resolvePayment(transaction, options),
				escrowAmount: options.escrowAmount,
				dedupeKey: options.dedupeKey ?? randomDedupeKey(),
				nonce: options.nonce ?? randomNonce(),
			}),
		);
		return { transaction };
	}

	async payDmEscrow(options: PayDmEscrowOptions): Promise<{ digest: string }> {
		if (!options.skipGatingCheck && this.#gating) {
			await this.#gating.assertPaidOpenAllowed({
				recipient: options.recipient,
				escrowAmount: options.escrowAmount,
			});
		}

		const { transaction } = this.buildPayDmEscrow({
			groupRef: options.groupRef,
			recipient: options.recipient,
			escrowAmount: options.escrowAmount,
			paymentCoinId: options.paymentCoinId,
			dedupeKey: options.dedupeKey,
			nonce: options.nonce,
		});
		return this.#execute(transaction, options.signer, 'pay DM escrow');
	}

	async openAgentPaidDm(
		options: OpenAgentPaidDmOptions,
	): Promise<{ digest: string; groupId: string; uuid: string; messageLogId: string }> {
		if (!options.skipGatingCheck && this.#gating) {
			await this.#gating.assertPaidOpenAllowed({
				recipient: options.recipient,
				escrowAmount: options.escrowAmount,
			});
		}

		const uuid = options.uuid ?? crypto.randomUUID();
		const name = options.name ?? 'Agent paid DM';

		// Same-PTB composition as buildOpenPaidDm: create (values) -> paid
		// digest borrowing the results -> share last. The derived group/log ids
		// do not exist yet, so they cannot be object inputs.
		const tx = new Transaction();
		const created = tx.add(
			this.#messaging.call.createAgentGroup({
				name,
				uuid,
				initialMembers: [options.recipient],
				platformId: options.platformId,
				creatorMemoryAccountId: options.memoryAccountId,
				crossPrincipalPeerMemoryAccountId: options.memoryAccountId,
			}),
		);
		tx.add(
			this.#messaging.call.sendAgentPaidMessageDigest({
				group: created[0],
				messageLog: created[2],
				platformId: options.platformId,
				memoryAccountId: options.memoryAccountId,
				recipient: options.recipient,
				payment: resolvePayment(tx, options),
				escrowAmount: options.escrowAmount,
				dedupeKey: options.dedupeKey ?? randomDedupeKey(),
				nonce: options.nonce ?? randomNonce(),
			}),
		);
		tx.add(
			this.#messaging.call.shareGroup({
				group: created[0],
				encryptionHistory: created[1],
				messageLog: created[2],
			}),
		);

		const { digest } = await this.#execute(tx, options.signer, 'open agent paid DM');
		const groupId = this.#messaging.derive.groupId({ uuid });
		const messageLogId = this.#messaging.derive.messageLogId({ uuid });
		return { digest, groupId, uuid, messageLogId };
	}

	buildReplyAndClaimSettled(options: BuildReplyAndClaimSettledOptions): {
		transaction: Transaction;
	} {
		const transaction = new Transaction();
		transaction.add(
			this.#messaging.call.replyToPaidMessageClaimSettled({
				...options.groupRef,
				paidMsgSeq: options.paidMsgSeq,
				charCount: options.charCount,
				dedupeKey: options.dedupeKey ?? randomDedupeKey(),
				nonce: options.nonce ?? randomNonce(),
				platformFeeRecipient: options.platformFeeRecipient,
			}),
		);
		return { transaction };
	}

	async replyAndClaimSettled(options: ReplyAndClaimSettledOptions): Promise<{ digest: string }> {
		const { transaction } = this.buildReplyAndClaimSettled({
			groupRef: options.groupRef,
			paidMsgSeq: options.paidMsgSeq,
			charCount: options.charCount,
			dedupeKey: options.dedupeKey,
			nonce: options.nonce,
			platformFeeRecipient: options.platformFeeRecipient,
		});
		return this.#execute(transaction, options.signer, 'reply and claim settled paid escrow');
	}

	async refundEscrow(options: RefundPaidEscrowOptions): Promise<{ digest: string }> {
		const tx = new Transaction();
		tx.add(
			this.#messaging.call.refundPaidEscrow({
				...options.groupRef,
				paidMsgSeq: options.paidMsgSeq,
			}),
		);
		return this.#execute(tx, options.signer, 'refund paid escrow');
	}

	async #execute(
		transaction: Transaction,
		signer: Signer,
		label: string,
	): Promise<{ digest: string }> {
		const client = this.#messaging.mysoClient;
		transaction.setSenderIfNotSet(signer.toMySoAddress());
		const result = await signer.signAndExecuteTransaction({
			transaction,
			client,
		});
		const tx = result.Transaction ?? result.FailedTransaction;
		if (!tx?.status.success) {
			throw new MySoMessagingStackClientError(
				`Failed to ${label}: ${tx?.status.error ?? 'unknown error'}`,
			);
		}
		await client.core.waitForTransaction({ result });
		return { digest: tx.digest };
	}
}

export function createPaidMessagingClient(options: PaidMessagingClientOptions) {
	return new PaidMessagingClient(options);
}

export function createPaidMessagingClientWithGating(options: {
	messaging: MySoMessagingStackClient;
	socialServerUrl: string;
	fetch?: typeof fetch;
}) {
	return new PaidMessagingClient({
		messaging: options.messaging,
		gating: createMessagingGatingClient({
			socialServerUrl: options.socialServerUrl,
			fetch: options.fetch,
		}),
	});
}

export type { WalletMessagingPolicy };
