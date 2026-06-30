// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';

import {
	fromRelayerConversation,
	type AgentConversation,
} from './agent-discovery.js';
import { messagingPermissionTypes } from './constants.js';
import { MySoMessagingStackClientError } from './error.js';
import type { MySoMessagingStackClient } from './client.js';
import type {
	DecryptedMessage,
	GetMessageOptions,
	GetMessagesOptions,
	GetMessagesResult,
	SendMessageOptions,
} from './messaging-types.js';
import type { AttachmentFile } from './attachments/types.js';
import type { CreateAgentGroupCallOptions, GroupRef } from './types.js';
import type { MyDataPolicy } from './encryption/mydata-policy.js';
import {
	PrincipalMyDataOversightPolicy,
	type PrincipalOversightPolicyOptions,
} from './encryption/mydata-policy.js';

/** Sub-agent signing context for agent messaging PTBs and relayer attribution. */
export interface AgentSignerContext {
	agentSigner: Signer;
	subAgentId: string;
	principalOwner: string;
	identityClass: 0 | 1 | 2;
	memoryAccountId: string;
	platformId: string;
	crossPrincipalPeerMemoryAccountId?: string;
}

export type AgentMessagingPermission = keyof ReturnType<typeof messagingPermissionTypes>;

export interface AgentSendMessageOptions<TApproveContext = void> {
	groupRef: GroupRef;
	text?: string;
	files?: AttachmentFile[];
	mydataApproveContext?: TApproveContext extends void ? never : TApproveContext;
}

export interface AgentSendPaidMessageOptions {
	groupRef: GroupRef;
	recipient: string;
	paymentCoinId: string;
	escrowAmount: bigint;
	dedupeKey: Uint8Array | number[];
	nonce: number | bigint;
}

export interface CreateAgentGroupOptions extends CreateAgentGroupCallOptions {
	transaction?: Transaction;
}

export interface WaitForMembershipOptions {
	messaging: MySoMessagingStackClient<unknown>;
	groupId: string;
	memberAddress: string;
	permission: AgentMessagingPermission;
	intervalMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface CreateAgentGroupAndWaitOptions extends CreateAgentGroupOptions {
	waitForAgentSender?: boolean;
	waitForPrincipalReader?: boolean;
}

export interface AgentMessagingClient<TApproveContext = void> {
	createAndShareGroup(
		options: CreateAgentGroupOptions,
	): Promise<{ digest: string; groupId: string; encryptionHistoryId: string; uuid: string }>;
	createAgentGroupAndWait(
		options: CreateAgentGroupAndWaitOptions,
	): Promise<{ digest: string; groupId: string; encryptionHistoryId: string; uuid: string }>;
	sendMessage(
		options: AgentSendMessageOptions<TApproveContext>,
	): Promise<{ messageId: string }>;
	waitForMembership(
		options: Omit<WaitForMembershipOptions, 'messaging' | 'memberAddress'>,
	): Promise<void>;
	getMessages(
		options: Omit<GetMessagesOptions<TApproveContext>, 'signer'>,
	): Promise<GetMessagesResult>;
	getMessage(
		options: Omit<GetMessageOptions<TApproveContext>, 'signer'>,
	): Promise<DecryptedMessage>;
	sendPaidMessage(options: AgentSendPaidMessageOptions): Promise<{ digest: string }>;
}

export interface PrincipalMessagingClient<TApproveContext = void> {
	listAgentConversations(principalOwner?: string): Promise<AgentConversation[]>;
	getMessages(
		options: Omit<GetMessagesOptions<TApproveContext>, 'signer'>,
	): Promise<GetMessagesResult>;
	getMessage(
		options: Omit<GetMessageOptions<TApproveContext>, 'signer'>,
	): Promise<DecryptedMessage>;
}

export interface CreateAgentMessagingClientOptions<TApproveContext = void> {
	messaging: MySoMessagingStackClient<TApproveContext>;
	agent: AgentSignerContext;
}

export interface CreatePrincipalMessagingClientOptions<TApproveContext = void> {
	messaging: MySoMessagingStackClient<TApproveContext>;
	humanSigner: Signer;
	/**
	 * When set, use {@link createPrincipalOversightPolicy} on the base messaging client
	 * before constructing the principal client so the human can decrypt agent groups.
	 */
	oversight?: Omit<PrincipalOversightPolicyOptions, 'originalPackageId' | 'latestPackageId' | 'versionId'>;
}

/** Poll on-chain permission grants until present or timeout. */
export async function waitForMembership(options: WaitForMembershipOptions): Promise<void> {
	const {
		messaging,
		groupId,
		memberAddress,
		permission,
		intervalMs = 500,
		timeoutMs = 30_000,
		signal,
	} = options;
	const permissionType =
		messagingPermissionTypes(messaging.packageConfig.originalPackageId)[permission];
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new MySoMessagingStackClientError('waitForMembership aborted');
		}
		const allowed = await messaging.groups.view.hasPermission({
			groupId,
			member: memberAddress,
			permissionType,
		});
		if (allowed) return;
		await sleep(intervalMs, signal);
	}

	throw new MySoMessagingStackClientError(
		`Timed out waiting for ${permission} on group ${groupId} for ${memberAddress}`,
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new MySoMessagingStackClientError('waitForMembership aborted'));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new MySoMessagingStackClientError('waitForMembership aborted'));
			},
			{ once: true },
		);
	});
}

export function createAgentMessagingClient<TApproveContext = void>(
	options: CreateAgentMessagingClientOptions<TApproveContext>,
): AgentMessagingClient<TApproveContext> {
	const { messaging, agent } = options;
	const crossPrincipalPeerMemoryAccountId =
		agent.crossPrincipalPeerMemoryAccountId ?? agent.memoryAccountId;

	return {
		async createAndShareGroup(callOptions) {
			const uuid = callOptions.uuid ?? crypto.randomUUID();
			const { digest } = await messaging.createAgentAndShareGroup({
				signer: agent.agentSigner,
				...callOptions,
				uuid,
				platformId: callOptions.platformId ?? agent.platformId,
				creatorMemoryAccountId:
					callOptions.creatorMemoryAccountId ?? agent.memoryAccountId,
				crossPrincipalPeerMemoryAccountId:
					callOptions.crossPrincipalPeerMemoryAccountId ??
					crossPrincipalPeerMemoryAccountId,
			});
			const groupId = messaging.derive.groupId({ uuid });
			const encryptionHistoryId = messaging.derive.encryptionHistoryId({ uuid });
			return { digest, groupId, encryptionHistoryId, uuid };
		},

		async createAgentGroupAndWait(callOptions) {
			const {
				waitForAgentSender = true,
				waitForPrincipalReader = true,
				...rest
			} = callOptions;
			const result = await this.createAndShareGroup(rest);
			if (waitForAgentSender) {
				await waitForMembership({
					messaging,
					groupId: result.groupId,
					memberAddress: agent.agentSigner.toMySoAddress(),
					permission: 'MessagingSender',
				});
			}
			if (waitForPrincipalReader) {
				await waitForMembership({
					messaging,
					groupId: result.groupId,
					memberAddress: agent.principalOwner,
					permission: 'MessagingReader',
				});
			}
			return result;
		},

		waitForMembership(opts) {
			return waitForMembership({
				messaging,
				...opts,
				memberAddress: agent.agentSigner.toMySoAddress(),
			});
		},

		sendMessage(opts) {
			const sendOptions = {
				...opts,
				signer: agent.agentSigner,
				principalOwner: agent.principalOwner,
				attribution: {
					principalOwner: agent.principalOwner,
					subAgentId: agent.subAgentId,
					identityClass: agent.identityClass,
				},
			} as SendMessageOptions<TApproveContext>;
			return messaging.sendMessage(sendOptions);
		},

		getMessages(opts) {
			return messaging.getMessages({
				...opts,
				signer: agent.agentSigner,
			} as GetMessagesOptions<TApproveContext>);
		},

		getMessage(opts) {
			return messaging.getMessage({
				...opts,
				signer: agent.agentSigner,
			} as GetMessageOptions<TApproveContext>);
		},

		async sendPaidMessage(opts) {
			const { Transaction } = await import('@socialproof/myso/transactions');
			const tx = new Transaction();
			tx.add(
				messaging.call.sendAgentPaidMessageDigest({
					...opts.groupRef,
					platformId: agent.platformId,
					memoryAccountId: agent.memoryAccountId,
					recipient: opts.recipient,
					payment: opts.paymentCoinId,
					escrowAmount: opts.escrowAmount,
					dedupeKey: opts.dedupeKey,
					nonce: opts.nonce,
				}),
			);
			const client = messaging.mysoClient;
			tx.setSenderIfNotSet(agent.agentSigner.toMySoAddress());
			const result = await agent.agentSigner.signAndExecuteTransaction({
				transaction: tx,
				client,
			});
			const executed = result.Transaction ?? result.FailedTransaction;
			if (!executed?.status.success) {
				throw new MySoMessagingStackClientError(
					`sendPaidMessage failed: ${executed?.status.error ?? 'unknown error'}`,
				);
			}
			await client.core.waitForTransaction({ result });
			return { digest: executed.digest };
		},
	};
}

export function createPrincipalMessagingClient<TApproveContext = void>(
	options: CreatePrincipalMessagingClientOptions<TApproveContext>,
): PrincipalMessagingClient<TApproveContext> {
	const { messaging, humanSigner } = options;

	return {
		async listAgentConversations(principalOwner) {
			const owner = principalOwner ?? humanSigner.toMySoAddress();
			if (owner !== humanSigner.toMySoAddress()) {
				throw new MySoMessagingStackClientError(
					'listAgentConversations principalOwner must match humanSigner address',
				);
			}
			const rows = await messaging.transport.listAgentConversations({
				signer: humanSigner,
			});
			return rows.map(fromRelayerConversation);
		},

		getMessages(opts) {
			return messaging.getMessages({
				...opts,
				signer: humanSigner,
			} as GetMessagesOptions<TApproveContext>);
		},

		getMessage(opts) {
			return messaging.getMessage({
				...opts,
				signer: humanSigner,
			} as GetMessageOptions<TApproveContext>);
		},
	};
}

export type { AgentConversation };

/** Build a principal oversight MyData policy for decrypting agent-associated groups. */
export function createPrincipalOversightPolicy(
	messaging: MySoMessagingStackClient,
	options: Omit<PrincipalOversightPolicyOptions, 'originalPackageId' | 'latestPackageId' | 'versionId'>,
): PrincipalMyDataOversightPolicy {
	return new PrincipalMyDataOversightPolicy({
		originalPackageId: messaging.packageConfig.originalPackageId,
		latestPackageId: messaging.packageConfig.latestPackageId,
		versionId: messaging.packageConfig.versionId,
		...options,
	});
}

export type { PrincipalOversightPolicyOptions, MyDataPolicy };
