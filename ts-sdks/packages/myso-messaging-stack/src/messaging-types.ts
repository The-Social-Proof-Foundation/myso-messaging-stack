// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { Attachment, AttachmentFile, AttachmentHandle } from './attachments/types.js';
import type { PaymentPayload, TokenTransferPayload, PaymentRequestPayload } from './payments.js';
import type {
	MessageKind,
	PaymentMetadata,
	PaymentRequestAction,
	RelayerReactionEvent,
	RelayerReceiptEvent,
	SyncStatus,
	SystemMessage,
} from './relayer/types.js';
import type { GroupRef } from './types.js';

export type {
	MessageKind,
	PaymentAssetKind,
	PaymentMetadata,
	PaymentRequestAction,
	PaymentRequestStatus,
	SystemEventType,
	SystemMessage,
	TokenTransferStatus,
} from './relayer/types.js';

// ── Conditional mydataApproveContext ────────────────────────────────

/**
 * Conditionally adds `mydataApproveContext` when `TApproveContext` is not `void`.
 * Mirrors the pattern in {@link EnvelopeEncryption}.
 */
export type WithApproveContext<TBase, TApproveContext> = TApproveContext extends void
	? TBase
	: TBase & { mydataApproveContext: TApproveContext };

// ── Public types ─────────────────────────────────────────────────

/** Cleartext agent attribution returned by the relayer for agent-sent messages. */
export interface MessageAttribution {
	principalOwner?: string;
	subAgentId?: string;
	identityClass?: 0 | 1 | 2;
}

/** A decrypted message returned by {@link MySoMessagingStackClient} methods. */
export interface DecryptedMessage extends MessageAttribution {
	messageId: string;
	groupId: string;
	order: number;
	/** Decrypted plaintext. Empty string for deleted, system, or attachment-only messages. */
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
	/** True when the relayer stored agent attribution metadata. */
	isAgentMessage: boolean;
	/** Defaults to `text` for legacy messages. */
	kind?: MessageKind;
	/** Present when `kind === 'system'`. Unknown `system.type` values are kept as strings. */
	system?: SystemMessage;
	/** Relayer-confirmed payment state for `token_transfer` / `request_payment` (1:1 DMs). */
	paymentMetadata?: PaymentMetadata;
	/** Decrypted payment body (amount, asset, note/description). Undefined if malformed. */
	payment?: PaymentPayload;
}

// ── Options types ────────────────────────────────────────────────

interface SendMessageOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	/** Message text. At least one of `text` or `files` must be provided. */
	text?: string;
	/** Files to attach. Requires attachments support to be configured. */
	files?: AttachmentFile[];
	/** Timeline kind (`text` default). Signed into the message canonical string. */
	kind?: 'text' | 'post' | 'request_payment' | 'poll' | 'token_transfer';
	/** Client idempotency key for safe retries. Required for `post`, `token_transfer`, `request_payment`. */
	idempotencyKey?: string;
	/** Cleartext payment fields (`token_transfer` requires `digest`). 1:1 DMs only. */
	paymentMetadata?: {
		digest?: string;
		assetKind: 'native' | 'spt';
		requestMessageId?: string;
		senderWallet?: string;
	};
	/** Cleartext on-chain post id when `kind === 'post'` (bound into signature). */
	sharedPostAddress?: string;
	/** Optional agent attribution for relayer POST body. */
	attribution?: MessageAttribution & {
		principalOwner: string;
		subAgentId: string;
		identityClass: 0 | 1 | 2;
	};
	/** Principal owner for principal-aware DM block checks (agent senders). */
	principalOwner?: string;
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

interface SendTokenTransferOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	/** Digest of the already-submitted on-chain transfer. */
	digest: string;
	payload: TokenTransferPayload;
	/** Payment request this transfer settles (the relayer links and settles it). */
	requestMessageId?: string;
	/** Funded wallet that signed the transfer, when it differs from the messaging key (web zkLogin). */
	senderWallet?: string;
}

/** Options for {@link MySoMessagingStackClient.sendTokenTransfer}. */
export type SendTokenTransferOptions<TApproveContext = void> = WithApproveContext<
	SendTokenTransferOptionsBase,
	TApproveContext
>;

interface SendPaymentRequestOptionsBase {
	signer: Signer;
	groupRef: GroupRef;
	payload: PaymentRequestPayload;
	/** Client request id; defaults to a random UUID. Sent as `request:<id>`. */
	requestId?: string;
}

/** Options for {@link MySoMessagingStackClient.sendPaymentRequest}. */
export type SendPaymentRequestOptions<TApproveContext = void> = WithApproveContext<
	SendPaymentRequestOptionsBase,
	TApproveContext
>;

/** Options for {@link MySoMessagingStackClient.respondToPaymentRequest}. No encryption involved. */
export interface RespondToPaymentRequestOptions {
	signer: Signer;
	groupRef: GroupRef;
	/** The `request_payment` message. */
	messageId: string;
	/** `reject` (payer) or `cancel` (requester). */
	action: PaymentRequestAction;
}

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

/**
 * Event yielded by {@link MySoMessagingStackClient.subscribe}: a decrypted
 * message, an absolute-state reaction update, ephemeral typing / presence,
 * or peer-visible delivery/read receipts.
 */
export type MessagingEvent =
	| { type: 'message'; message: DecryptedMessage }
	| { type: 'reaction'; reaction: RelayerReactionEvent }
	| {
			type: 'typing';
			typing: {
				member: string;
				typing: boolean;
				/** Unix seconds TTL for a start without a matching stop. */
				expiresAt?: number;
			};
	  }
	| { type: 'presence'; presence: { member: string; online: boolean } }
	| { type: 'receipt'; receipt: RelayerReceiptEvent };

// ── Reactions ────────────────────────────────────────────────────

/** Options for {@link MySoMessagingStackClient.listReactions}. */
export interface ListReactionsOptions {
	signer: Signer;
	groupRef: GroupRef;
	/** When set, only reactions for the message with this relayer `order`. */
	order?: number;
}

/** Options for {@link MySoMessagingStackClient.addReaction} / {@link MySoMessagingStackClient.removeReaction}. */
export interface ReactionOptions {
	signer: Signer;
	groupRef: GroupRef;
	/** The relayer-assigned `order` of the target message. */
	order: number;
	/** The reaction emoji. Canonicalized (NFC) by the client before sending. */
	emoji: string;
}

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
