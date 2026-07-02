// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { Attachment } from '../attachments/types.js';
import type { HttpClientConfig } from '../http/types.js';
import type { RelayerTransport } from './transport.js';

export type SyncStatus =
	| 'SYNC_PENDING'
	| 'SYNCED'
	| 'UPDATE_PENDING'
	| 'UPDATED'
	| 'DELETE_PENDING'
	| 'DELETED';

/** A message returned by a {@link RelayerTransport} implementation. */
export interface RelayerMessage {
	messageId: string;
	groupId: string;
	order: number;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
	senderAddress: string;
	createdAt: number;
	updatedAt: number;
	attachments: Attachment[];
	isEdited: boolean;
	isDeleted: boolean;
	/** Only relevant when using a backend that syncs to File Storage. */
	syncStatus?: SyncStatus;
	/** Only present when the backend persists messages to File Storage. */
	quiltPatchId?: string | null;
	/** Hex-encoded per-message signature (64 bytes). */
	signature: string;
	/** Hex-encoded public key with scheme flag prefix. */
	publicKey: string;
	principalOwner?: string;
	subAgentId?: string;
	identityClass?: 0 | 1 | 2;
	isAgentMessage: boolean;
}

export interface SendMessageParams {
	signer: Signer;
	groupId: string;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
	attachments?: Attachment[];
	/** Hex-encoded per-message signature for sender verification. */
	messageSignature?: string;
	/** Agent attribution (required when sending as a sub-agent). */
	attribution?: {
		principalOwner: string;
		subAgentId: string;
		identityClass: 0 | 1 | 2;
	};
}

/** Supports cursor-based pagination via afterOrder/beforeOrder. */
export interface FetchMessagesParams {
	signer: Signer;
	groupId: string;
	afterOrder?: number;
	beforeOrder?: number;
	limit?: number;
}

export interface FetchMessageParams {
	signer: Signer;
	messageId: string;
	groupId: string;
}

export interface UpdateMessageParams {
	signer: Signer;
	messageId: string;
	groupId: string;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
	attachments?: Attachment[];
	/** Hex-encoded per-message signature for sender verification. */
	messageSignature?: string;
}

export interface DeleteMessageParams {
	signer: Signer;
	messageId: string;
	groupId: string;
}

export interface SubscribeParams {
	signer: Signer;
	groupId: string;
	/** Resume from this order (exclusive). Only messages with order > afterOrder are delivered. */
	afterOrder?: number;
	limit?: number;
	signal?: AbortSignal;
}

export interface SendMessageResult {
	messageId: string;
}

export interface FetchMessagesResult {
	messages: RelayerMessage[];
	hasNext: boolean;
}

/** One row from `GET /v1/groups/:group_id/reactions`. */
export interface RelayerReactionEntry {
	chainSeq: number;
	/** Canonical Unicode emoji string (NFC), e.g. `👍`, `❤️`, `👨‍👩‍👧‍👦`. */
	emoji: string;
	count: number;
	/** Wallet addresses of members who currently have this reaction set. */
	reactors: string[];
}

/**
 * Absolute-state reaction change (`reaction.updated` realtime event).
 * Carries the full count + reactor list so duplicate delivery is idempotent.
 */
export interface RelayerReactionEvent {
	groupId: string;
	chainSeq: number;
	/** Canonical Unicode emoji string (NFC). */
	emoji: string;
	count: number;
	reactors: string[];
}

/** Union of realtime events yielded by `subscribe()`. */
export type RelayerSubscriptionEvent =
	| { type: 'message.created'; message: RelayerMessage }
	| { type: 'reaction.updated'; reaction: RelayerReactionEvent };

export interface ListGroupReactionsParams {
	signer: Signer;
	groupId: string;
	/** When set, only reactions for this `chain_seq` index. */
	chainSeq?: number;
}

export interface PostGroupReactionParams {
	signer: Signer;
	groupId: string;
	chainSeq: number;
	/** Canonical Unicode emoji string (NFC) — see `emojiToStorage()`. */
	emoji: string;
	/** When false, removes the signer's reaction (idempotent on server). */
	add?: boolean;
}

export interface ListGroupPinsParams {
	signer: Signer;
	groupId: string;
}

export interface SetGroupPinParams {
	signer: Signer;
	groupId: string;
	chainSeq: number;
	pin?: boolean;
}

/** `GET /v1/groups/:group_id/receipts` for the authenticated member. */
export interface GroupReceiptState {
	deliveredUpto?: number;
	readUpto?: number;
}

export interface GetGroupReceiptsParams {
	signer: Signer;
	groupId: string;
}

export interface PostGroupReceiptsParams {
	signer: Signer;
	groupId: string;
	deliveredUpto?: number;
	readUpto?: number;
}

export interface UserReadStateWire {
	encryptedBlob: Uint8Array;
	blobVersion: number;
	updatedAt?: string;
}

export interface GetUserReadStateParams {
	signer: Signer;
}

export interface PutUserReadStateParams {
	signer: Signer;
	encryptedBlob: Uint8Array;
	blobVersion: number;
}

export interface PostPushTokenParams {
	signer: Signer;
	platform: 'ios';
	token: string;
	environment: 'sandbox' | 'production';
}

export interface DeletePushTokenParams {
	signer: Signer;
	token: string;
}

export interface PostPresenceParams {
	signer: Signer;
	active?: boolean;
}

/** Agent-associated messaging group from relayer discovery. */
export interface RelayerAgentConversation {
	groupId: string;
	creatorActor: string;
	creatorPrincipal: string;
	creatorSubAgentId?: string | null;
	creatorIdentityClass?: number | null;
	organizationId?: string | null;
	groupName?: string | null;
	groupUuid?: string | null;
	createdAt: number;
}

export interface ListAgentConversationsParams {
	signer: Signer;
	limit?: number;
}

export interface ListGroupsForAgentParams {
	signer: Signer;
	derivedAddress: string;
	limit?: number;
}

/** Params for `GET /v1/messaging/dm-gate` (wallet auth; sender = signer address). */
export interface CheckDmGateParams {
	signer: Signer;
	/** Recipient wallet address. */
	recipient: string;
	/**
	 * Group scope for first-outbound-message and escrow checks.
	 * Omit for pre-create checks (before the DM group exists).
	 */
	groupId?: string;
}

/**
 * Extensible gate denial reason. The relayer may add values (e.g. `RATE_LIMITED`)
 * without a breaking SDK change.
 */
export type DmGateReason = 'BLOCKED' | 'PAYMENT_REQUIRED' | (string & {});

/**
 * Advisory DM-gate decision from the relayer. `POST /messages` remains the
 * authoritative enforcement point — treat this as UX guidance only.
 */
export interface DmGateResult {
	allowed: boolean;
	reason: DmGateReason | null;
	blocked: boolean;
	/** Sender follows the recipient (payment never required for followers). */
	following: boolean;
	/** An on-chain escrow from the sender to the recipient is already indexed. */
	paid: boolean;
	/** No prior outbound message from the signer in this group. */
	firstOutbound: boolean;
	/**
	 * The peer already escrowed MYSO to the signer in this group — replying is
	 * free and claims the escrow on-chain. Combined with `firstOutbound`, this
	 * drives "reply to claim" UX.
	 */
	peerPaid: boolean;
	/** Latest peer escrow amount in MIST, when `peerPaid` is true. */
	peerEscrowAmount: bigint | null;
	/** Recipient's minimum escrow in MIST, when payment applies. */
	minCost: bigint | null;
	recipient: string;
}

/**
 * Structured error from a transport implementation.
 * Uses HTTP-style status codes for error discrimination (e.g. 401, 404, 405).
 */
export class RelayerTransportError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = 'RelayerTransportError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The relayer rejected a first DM message with `402 PAYMENT_REQUIRED`: the
 * recipient has paid messaging enabled and no on-chain escrow from the sender
 * is indexed yet. Pay via `PaidMessagingClient` (`openPaidDm` for new DMs,
 * `payDmEscrow` for existing groups), then retry the send.
 */
export class PaymentRequiredError extends RelayerTransportError {
	/** Recipient's minimum escrow in MYSO base units (null when unknown). */
	readonly minCost: bigint | null;
	/** Recipient wallet that requires payment (null when unknown). */
	readonly paymentRecipient: string | null;

	constructor(message: string, options?: { minCost?: bigint | null; recipient?: string | null }) {
		super(message, 402, 'PAYMENT_REQUIRED');
		this.name = 'PaymentRequiredError';
		this.minCost = options?.minCost ?? null;
		this.paymentRecipient = options?.recipient ?? null;
	}
}

/**
 * Provide `relayerUrl` for the built-in HTTP transport,
 * or supply a custom `transport` instance for any other backend.
 */
export type RelayerConfig = RelayerHTTPConfig | RelayerCustomTransportConfig;

export interface RelayerHTTPConfig extends HttpClientConfig {
	relayerUrl: string;
	pollingIntervalMs?: number;
	/**
	 * Realtime delivery mode for `subscribe()`.
	 * - `hybrid` (default): WebSocket with HTTP polling fallback
	 * - `ws`: WebSocket only (no HTTP polling fallback)
	 * - `poll`: HTTP polling only
	 */
	realtime?: 'ws' | 'poll' | 'hybrid';
	/**
	 * Prefix for REST paths, e.g. `/v1` so message CRUD uses `/v1/messages`.
	 * Default `''` uses legacy `/messages`.
	 */
	apiPrefix?: string;
	transport?: never;
}

interface RelayerCustomTransportConfig {
	transport: RelayerTransport;
	relayerUrl?: never;
}
