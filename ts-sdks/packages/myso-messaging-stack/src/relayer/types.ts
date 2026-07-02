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

/** Ephemeral typing indicator on the group feed. */
export interface RelayerTypingEvent {
	groupId: string;
	member: string;
	/**
	 * Unix seconds after which a `typing.start` should be discarded if no
	 * `typing.stop` arrived — the TTL is the recovery mechanism.
	 */
	expiresAt?: number;
}

/** Wallet-scoped presence on the group feed (one online state per wallet). */
export interface RelayerPresenceEvent {
	groupId: string;
	member: string;
	online: boolean;
}

/** Union of realtime events yielded by `subscribe()`. */
export type RelayerSubscriptionEvent =
	| { type: 'message.created'; message: RelayerMessage }
	| { type: 'reaction.updated'; reaction: RelayerReactionEvent }
	| { type: 'typing.start'; typing: RelayerTypingEvent }
	| { type: 'typing.stop'; typing: RelayerTypingEvent }
	| { type: 'presence.updated'; presence: RelayerPresenceEvent };

/**
 * Wallet-scoped events from the user feed (`/v1/users/ws`). Metadata only —
 * the WebSocket is a notification mechanism; REST stays the source of truth.
 */
export type RelayerUserEvent =
	| {
			/** A message landed in one of your groups. */
			type: 'group.activity';
			groupId: string;
			latestOrder: number;
	  }
	| {
			/** Your read-state blob changed (another device/tab). */
			type: 'read_state.updated';
			blobVersion: number;
	  }
	| {
			/** A conversation appeared — re-fetch canonical group state over REST. */
			type: 'group.discovered';
			groupId: string;
			reason: 'created' | 'invited' | 'joined';
	  }
	| {
			/** A conversation should leave the sidebar. */
			type: 'group.hidden';
			groupId: string;
	  };

export interface SubscribeUserEventsParams {
	signer: Signer;
	signal?: AbortSignal;
	/**
	 * Group ids used by the HTTP polling fallback to synthesize
	 * `group.activity` events by diffing batch unread counts. Ignored by the
	 * WebSocket path (the relayer filters by membership server-side).
	 */
	groupIds?: string[];
}

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
	/**
	 * Legacy client-proposed version — ignored by relayers that assign
	 * versions server-side. Kept for backward compatibility.
	 */
	blobVersion: number;
	/**
	 * Compare-and-set: the write only succeeds when this matches the stored
	 * version; on mismatch the transport throws {@link ReadStateConflictError}.
	 * Omit for legacy last-writer-wins behavior.
	 */
	expectedVersion?: number;
}

/** Result of a successful read-state PUT (server-assigned version). */
export interface PutUserReadStateResult {
	/** Monotonic server-assigned version of the stored blob. */
	blobVersion: number;
}

/** One request item for the batch unread-counts endpoint. */
export interface UnreadCountItem {
	groupId: string;
	/** The client's read watermark (relayer `order`, exclusive). */
	afterOrder: number;
}

export interface FetchUnreadCountsParams {
	signer: Signer;
	items: UnreadCountItem[];
}

/** Per-group activity from `POST /v1/users/unread-counts`. */
export interface GroupUnreadCount {
	groupId: string;
	/** Highest assigned order in the group (includes soft-deleted rows). */
	latestOrder: number;
	/** Exact count of non-deleted messages after the watermark. */
	unreadCount: number;
}

export interface SendTypingParams {
	signer: Signer;
	groupId: string;
	/** `true` broadcasts `typing.start`; `false` broadcasts `typing.stop`. */
	typing: boolean;
}

export interface GetGroupPresenceParams {
	signer: Signer;
	groupId: string;
}

/** One member row from `GET /v1/groups/:group_id/presence`. */
export interface GroupPresenceEntry {
	member: string;
	/** RFC3339 last-seen timestamp, when known. */
	lastSeen?: string;
	online: boolean;
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
	/** Parsed JSON error body, when the response carried one. */
	readonly body?: unknown;

	constructor(message: string, status: number, code?: string, body?: unknown) {
		super(message);
		this.name = 'RelayerTransportError';
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

/**
 * The read-state blob was modified by another client between your GET and PUT
 * (`409 READ_STATE_CONFLICT`). Carries the server's current record so callers
 * can merge and retry without another GET.
 */
export class ReadStateConflictError extends RelayerTransportError {
	/** The record currently stored on the relayer. */
	readonly current: UserReadStateWire;

	constructor(message: string, current: UserReadStateWire) {
		super(message, 409, 'READ_STATE_CONFLICT');
		this.name = 'ReadStateConflictError';
		this.current = current;
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
