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
	paymentCoinId: string;
	dedupeKey: Uint8Array | number[];
	nonce: number | bigint;
	name?: string;
	uuid?: string;
	/** Skip off-chain gating check (default false). */
	skipGatingCheck?: boolean;
}

export interface OpenAgentPaidDmOptions extends OpenPaidDmOptions {
	platformId: string;
	memoryAccountId: string;
}

export interface ReplyAndClaimSettledOptions {
	signer: Signer;
	groupRef: GroupRef;
	paidMsgSeq: number | bigint;
	charCount: number;
	dedupeKey: Uint8Array | number[];
	nonce: number | bigint;
	platformFeeRecipient: string;
	ecosystemFeeRecipient: string;
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

	constructor(options: PaidMessagingClientOptions) {
		this.#messaging = options.messaging;
		this.#gating = options.gating;
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
	async getOnChainPolicy(
		recipient: string,
	): Promise<{ enabled: boolean; minCost: bigint | null }> {
		return this.#messaging.view.requiresPaymentFromRecipient(recipient);
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

		const uuid = options.uuid ?? crypto.randomUUID();
		const name = options.name ?? 'Paid DM';
		const sender = options.signer.toMySoAddress();

		const tx = new Transaction();
		tx.add(
			this.#messaging.call.createAndShareGroup({
				sender,
				name,
				uuid,
				initialMembers: [options.recipient],
			}),
		);
		tx.add(
			this.#messaging.call.sendPaidMessageDigest({
				uuid,
				recipient: options.recipient,
				payment: options.paymentCoinId,
				escrowAmount: options.escrowAmount,
				dedupeKey: options.dedupeKey,
				nonce: options.nonce,
			}),
		);

		const { digest } = await this.#execute(tx, options.signer, 'open paid DM');
		const groupId = this.#messaging.derive.groupId({ uuid });
		const messageLogId = this.#messaging.derive.messageLogId({ uuid });
		return { digest, groupId, uuid, messageLogId };
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

		const tx = new Transaction();
		tx.add(
			this.#messaging.call.createAgentAndShareGroup({
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
				uuid,
				platformId: options.platformId,
				memoryAccountId: options.memoryAccountId,
				recipient: options.recipient,
				payment: options.paymentCoinId,
				escrowAmount: options.escrowAmount,
				dedupeKey: options.dedupeKey,
				nonce: options.nonce,
			}),
		);

		const { digest } = await this.#execute(tx, options.signer, 'open agent paid DM');
		const groupId = this.#messaging.derive.groupId({ uuid });
		const messageLogId = this.#messaging.derive.messageLogId({ uuid });
		return { digest, groupId, uuid, messageLogId };
	}

	async replyAndClaimSettled(
		options: ReplyAndClaimSettledOptions,
	): Promise<{ digest: string }> {
		const tx = new Transaction();
		tx.add(
			this.#messaging.call.replyToPaidMessageClaimSettled({
				...options.groupRef,
				paidMsgSeq: options.paidMsgSeq,
				charCount: options.charCount,
				dedupeKey: options.dedupeKey,
				nonce: options.nonce,
				platformFeeRecipient: options.platformFeeRecipient,
				ecosystemFeeRecipient: options.ecosystemFeeRecipient,
			}),
		);
		return this.#execute(tx, options.signer, 'reply and claim settled paid escrow');
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
