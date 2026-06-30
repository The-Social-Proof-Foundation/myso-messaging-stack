// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Attachment } from '../attachments/types.js';
import type { RelayerMessage, SyncStatus } from '../relayer/types.js';
import type { FileStorageAttachmentWire, FileStorageMessageWire } from './types.js';

/** Convert a number[] (Rust serde_json Vec<u8>) to a hex string. */
function bytesToHex(bytes: number[]): string {
	return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Convert a raw File Storage attachment to the SDK's {@link Attachment} format. */
function mapAttachment(wire: FileStorageAttachmentWire): Attachment {
	return {
		storageId: wire.storage_id,
		nonce: bytesToHex(wire.nonce),
		encryptedMetadata: bytesToHex(wire.encrypted_metadata),
		metadataNonce: bytesToHex(wire.metadata_nonce),
	};
}

/**
 * Convert a raw File Storage message to the SDK's {@link RelayerMessage} format.
 *
 * Handles: number[] → Uint8Array/hex, ISO 8601 → unix seconds,
 * Rust field names → SDK names, derives isEdited/isDeleted.
 */
export function fromFileStorageMessage(wire: FileStorageMessageWire): RelayerMessage {
	const createdAt = Math.floor(new Date(wire.created_at).getTime() / 1000);
	const updatedAt = Math.floor(new Date(wire.updated_at).getTime() / 1000);
	const isEdited = wire.created_at !== wire.updated_at;
	const isDeleted = wire.sync_status === 'DELETE_PENDING' || wire.sync_status === 'DELETED';
	const hasAttribution =
		wire.principal_owner != null || wire.sub_agent_id != null || wire.identity_class != null;

	return {
		messageId: wire.id,
		groupId: wire.group_id,
		order: wire.order ?? 0,
		encryptedText: new Uint8Array(wire.encrypted_msg),
		nonce: new Uint8Array(wire.nonce),
		keyVersion: BigInt(wire.key_version),
		senderAddress: wire.sender_wallet_addr,
		createdAt,
		updatedAt,
		attachments: wire.attachments.map(mapAttachment),
		isEdited,
		isDeleted,
		syncStatus: wire.sync_status as SyncStatus,
		quiltPatchId: wire.quilt_patch_id,
		signature: wire.signature ?? '',
		publicKey: wire.public_key ?? '',
		principalOwner: wire.principal_owner ?? undefined,
		subAgentId: wire.sub_agent_id ?? undefined,
		identityClass:
			wire.identity_class === 0 || wire.identity_class === 1 || wire.identity_class === 2
				? wire.identity_class
				: undefined,
		isAgentMessage: hasAttribution,
	};
}
