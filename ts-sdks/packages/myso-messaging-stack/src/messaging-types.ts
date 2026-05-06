// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { Attachment, AttachmentFile, AttachmentHandle } from './attachments/types.js';
import type { SyncStatus } from './relayer/types.js';
import type { GroupRef } from './types.js';

// ── Conditional mydataApproveContext ────────────────────────────────

/**
 * Conditionally adds `mydataApproveContext` when `TApproveContext` is not `void`.
 * Mirrors the pattern in {@link EnvelopeEncryption}.
 */
export type WithApproveContext<TBase, TApproveContext> = TApproveContext extends void
	? TBase
	: TBase & { mydataApproveContext: TApproveContext };

// ── Public types ─────────────────────────────────────────────────

/** A decrypted message returned by {@link MySoMessagingStackClient} methods. */
export interface DecryptedMessage {
	messageId: string;
	groupId: string;
	order: number;
	/** Decrypted plaintext. Empty string for deleted or attachment-only messages. */
	text: string;
	senderAddress: string;
	createdAt: number;
	updatedAt: number;
	isEdited: boolean;
	isDeleted: boolean;
	/** Only present when the backend syncs to File Storage. */
	syncStatus?: SyncStatus;
	/** Resolved attachment handles with lazy data download. Empty when no attachments or not configured. */
	attachments: AttachmentHandle[];
	/** Whether the per-message sender signature was verified successfully. */
	senderVerified: boolean;
}

// ── Options types ────────────────────────────────────────────────

interface SendMessageOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	/** Message text. At least one of `text` or `files` must be provided. */
	text?: string;
	/** Files to attach. Requires attachments support to be configured. */
	files?: AttachmentFile[];
}

/** Options for {@link MySoMessagingStackClient.sendMessage}. */
export type SendMessageOptions<TApproveContext = void> = WithApproveContext<
	SendMessageOptionsBase,
	TApproveContext
>;

interface GetMessageOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	messageId: string;
}

/** Options for {@link MySoMessagingStackClient.getMessage}. */
export type GetMessageOptions<TApproveContext = void> = WithApproveContext<
	GetMessageOptionsBase,
	TApproveContext
>;

interface GetMessagesOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	afterOrder?: number;
	beforeOrder?: number;
	limit?: number;
}

/** Options for {@link MySoMessagingStackClient.getMessages}. */
export type GetMessagesOptions<TApproveContext = void> = WithApproveContext<
	GetMessagesOptionsBase,
	TApproveContext
>;

/** Result of {@link MySoMessagingStackClient.getMessages}. */
export interface GetMessagesResult {
	messages: DecryptedMessage[];
	hasNext: boolean;
}

/**
 * Describes how attachments should change during an edit.
 *
 * The SDK computes the final attachment list as:
 * `current.filter(a => !remove.includes(a.storageId)) + upload(new)`
 *
 * Storage entries for removed attachments are deleted best-effort when
 * the storage adapter supports it.
 */
export interface EditAttachments {
	/** The current attachments on the message (from {@link DecryptedMessage}). */
	current: Attachment[];
	/** Storage IDs of attachments to remove. */
	remove?: string[];
	/** New files to encrypt and upload. */
	new?: AttachmentFile[];
}

interface EditMessageOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	messageId: string;
	/** New message text. */
	text: string;
	/** Attachment changes. Omit to leave attachments unchanged. */
	attachments?: EditAttachments;
}

/** Options for {@link MySoMessagingStackClient.editMessage}. */
export type EditMessageOptions<TApproveContext = void> = WithApproveContext<
	EditMessageOptionsBase,
	TApproveContext
>;

/** Options for {@link MySoMessagingStackClient.deleteMessage}. No encryption involved. */
export interface DeleteMessageOptions {
	signer: Signer;
	groupRef: GroupRef;
	messageId: string;
}

interface SubscribeOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	afterOrder?: number;
	signal?: AbortSignal;
}

/** Options for {@link MySoMessagingStackClient.subscribe}. */
export type SubscribeOptions<TApproveContext = void> = WithApproveContext<
	SubscribeOptionsBase,
	TApproveContext
>;

// ── Recovery ─────────────────────────────────────────────────────

interface RecoverMessagesOptionsBase {
	groupRef: GroupRef;
	afterOrder?: number;
	beforeOrder?: number;
	limit?: number;
}

/** Options for {@link MySoMessagingStackClient.recoverMessages}. */
export type RecoverMessagesOptions<TApproveContext = void> = WithApproveContext<
	RecoverMessagesOptionsBase,
	TApproveContext
>;
