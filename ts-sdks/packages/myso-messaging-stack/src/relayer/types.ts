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
	transport?: never;
}

interface RelayerCustomTransportConfig {
	transport: RelayerTransport;
	relayerUrl?: never;
}
