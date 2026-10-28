// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { normalizeSharedPostAddress } from './verification.js';
import { MySoMessagingStackClientError } from './error.js';
import type { DecryptedMessage, GetMessagesOptions } from './messaging-types.js';
import type { FetchMessagesResult, RelayerMessage } from './relayer/types.js';

/** Strict room pages are deliberately smaller than the general chat timeline. */
export const ROOM_HISTORY_MAX_PAGE_SIZE = 50;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const MAX_PAGE_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

/** Requires an explicit normal MessagingReader grant; oversight adapters are separate. */
export type GetRoomMessagesOptions<TApproveContext = void> = GetMessagesOptions<TApproveContext>;

/** Signature verification attests ciphertext, group, kind and sender, not relayer chronology. */
export type RoomHistoryEntry = {
	messageId: string;
	order: number;
} & (
	| {
			status: 'verified_content';
			content: Pick<DecryptedMessage, 'text' | 'kind' | 'senderAddress'> & {
				attachmentIntegrity: DecryptedMessage['attachmentIntegrity'];
				attachmentCount: number;
				attachmentMetadataStatus: 'none' | 'verified' | 'unavailable';
				attachments: Array<{ fileName: string; mimeType: string; fileSize: number; storageId: string }>;
				attributionIntegrity: DecryptedMessage['attributionIntegrity'];
				isAgentMessage: boolean;
				attribution?: Pick<DecryptedMessage, 'principalOwner' | 'subAgentId' | 'identityClass'>;
			};
	  }
	| {
			status: 'unverified_content' | 'unavailable_content' | 'system_metadata' | 'deleted_metadata';
	  }
);

export interface RoomHistoryPage {
	groupId: string;
	entries: RoomHistoryEntry[];
	hasNext: boolean;
	/** Exclusive continuation based on raw rows, including unavailable/unverified rows. */
	nextCursor: { afterOrder: number; beforeOrder?: number } | { beforeOrder: number } | null;
	/** True only for a nonempty page where every row released verified text; not a completeness proof. */
	allContentVerified: boolean;
	/** IDs, orders, system/deletion state and pagination are relayer metadata, not signed evidence. */
	metadataSource: 'relayer_unverified';
}

function invalid(message: string): never {
	throw new MySoMessagingStackClientError(message);
}

export function validateRoomHistoryRequest(options: {
	afterOrder?: number;
	beforeOrder?: number;
	limit?: number;
}): number {
	const { afterOrder, beforeOrder } = options;
	for (const value of [afterOrder, beforeOrder]) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			invalid('Room history cursors must be nonnegative safe integers');
		}
	}
	if (afterOrder !== undefined && beforeOrder !== undefined && afterOrder >= beforeOrder) {
		invalid('Room history cursor window is empty or reversed');
	}
	const limit = options.limit ?? ROOM_HISTORY_MAX_PAGE_SIZE;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > ROOM_HISTORY_MAX_PAGE_SIZE) {
		invalid('Room history limit must be between 1 and 50');
	}
	return limit;
}

/** Validate the whole raw page before any decryption or plaintext release. */
export function validateRoomHistoryPage(
	result: FetchMessagesResult,
	groupId: string,
	options: { afterOrder?: number; beforeOrder?: number; limit?: number },
): RoomHistoryPage['nextCursor'] {
	const limit = validateRoomHistoryRequest(options);
	const expectedGroup = normalizeSharedPostAddress(groupId);
	if (
		!expectedGroup ||
		!Array.isArray(result.messages) ||
		result.messages.length > limit ||
		typeof result.hasNext !== 'boolean'
	)
		invalid('Invalid room history page');
	const ids = new Set<string>();
	let lastOrder = -1;
	let bytes = 0;
	for (const raw of result.messages) {
		if (
			normalizeSharedPostAddress(raw.groupId) !== expectedGroup ||
			typeof raw.messageId !== 'string' ||
			!raw.messageId ||
			raw.messageId.length > 128 ||
			ids.has(raw.messageId) ||
			!Number.isSafeInteger(raw.order) ||
			raw.order <= lastOrder ||
			raw.order < 0 ||
			(options.afterOrder !== undefined && raw.order <= options.afterOrder) ||
			(options.beforeOrder !== undefined && raw.order >= options.beforeOrder)
		) {
			invalid('Room history contains a wrong-room, duplicate or invalid cursor row');
		}
		if (
			!(raw.encryptedText instanceof Uint8Array) ||
			raw.encryptedText.byteLength > MAX_CIPHERTEXT_BYTES
		) {
			invalid('Room history ciphertext exceeds the supported size');
		}
		if (
			raw.kind !== 'system' &&
			!raw.isDeleted &&
			(!(raw.nonce instanceof Uint8Array) ||
				raw.nonce.byteLength !== 12 ||
				typeof raw.keyVersion !== 'bigint' ||
				raw.keyVersion < 0n ||
				raw.keyVersion > (1n << 64n) - 1n ||
				!normalizeSharedPostAddress(raw.senderAddress) ||
				typeof raw.signature !== 'string' ||
				raw.signature.length > 1024 ||
				typeof raw.publicKey !== 'string' ||
				raw.publicKey.length > 512)
		)
			invalid('Room history contains invalid cryptographic fields');
		if (!Array.isArray(raw.attachments) || raw.attachments.length > 10) {
			invalid('Room history contains too many or malformed attachment references');
		}
		for (const attachment of raw.attachments) {
			const storageId = attachment?.storageId;
			const match = typeof storageId === 'string'
				? /^r2room:\/\/(0x)?([0-9a-fA-F]{1,64})\/([0-9a-f-]{36})$/i.exec(storageId)
				: null;
			if (
				!match ||
				normalizeSharedPostAddress(`${match[1] ?? ''}${match[2]}`) !== expectedGroup ||
				typeof attachment.nonce !== 'string' || !/^(?:[0-9a-fA-F]{2}){12}$/.test(attachment.nonce) ||
				typeof attachment.metadataNonce !== 'string' || !/^(?:[0-9a-fA-F]{2}){12}$/.test(attachment.metadataNonce) ||
				typeof attachment.encryptedMetadata !== 'string' || !/^(?:[0-9a-fA-F]{2}){1,131072}$/.test(attachment.encryptedMetadata)
			) invalid('Room history contains a malformed or wrong-room attachment reference');
		}
		bytes += raw.encryptedText.byteLength;
		if (bytes > MAX_PAGE_CIPHERTEXT_BYTES) invalid('Room history page exceeds the supported size');
		ids.add(raw.messageId);
		lastOrder = raw.order;
	}
	if (!result.hasNext) return null;
	if (!result.messages.length) invalid('Room history has a non-advancing empty page');
	// The native relayer returns an ascending newest window without afterOrder,
	// and an ascending oldest window when afterOrder is supplied.
	return options.afterOrder === undefined
		? { beforeOrder: result.messages[0].order }
		: {
				afterOrder: lastOrder,
				...(options.beforeOrder === undefined ? {} : { beforeOrder: options.beforeOrder }),
			};
}

/** Only text/ciphertext facts verified by the signature are exposed as content. */
export function verifiedRoomEntry(
	raw: RelayerMessage,
	message: DecryptedMessage,
): RoomHistoryEntry {
	if (
		!message.senderVerified ||
		message.groupId !== raw.groupId ||
		message.messageId !== raw.messageId ||
		message.order !== raw.order ||
		message.isDeleted ||
		message.kind === 'system'
	)
		invalid('Room plaintext does not match the verified row');
	return {
		messageId: raw.messageId,
		order: raw.order,
		status: 'verified_content',
		content: {
			text: message.text,
			kind: message.kind,
			senderAddress: message.senderAddress,
			attachmentIntegrity: message.attachmentIntegrity,
			attachmentCount: raw.attachments.length,
			attachmentMetadataStatus: raw.attachments.length === 0
				? 'none'
				: message.attachmentIntegrity === 'verified' && message.attachments.length === raw.attachments.length
					? 'verified'
					: 'unavailable',
			attachments: message.attachmentIntegrity === 'verified' && message.attachments.length === raw.attachments.length
				? message.attachments.map(({ fileName, mimeType, fileSize, wire }) => ({ fileName, mimeType, fileSize, storageId: wire.storageId }))
				: [],
			attributionIntegrity: message.attributionIntegrity,
			isAgentMessage: message.isAgentMessage,
			...(message.attributionIntegrity === 'verified'
				? { attribution: {
						...(message.principalOwner ? { principalOwner: message.principalOwner } : {}),
						...(message.subAgentId ? { subAgentId: message.subAgentId } : {}),
						...(message.identityClass === undefined ? {} : { identityClass: message.identityClass }),
					} }
				: {}),
		},
	};
}
