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
	emojiCode: number;
	count: number;
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
	emojiCode: number;
	/** When false, decrements tally (never below zero on server). */
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
