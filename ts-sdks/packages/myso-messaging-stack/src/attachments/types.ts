// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { StorageAdapter } from '../storage/storage-adapter.js';

// === Configuration ===

/** Configuration for the {@link AttachmentsManager}. */
export interface AttachmentsConfig {
	/** Storage adapter for uploading/downloading encrypted bytes. */
	storageAdapter: StorageAdapter;
	/** Maximum number of files per upload (default: 10). */
	maxAttachments?: number;
	/** Maximum size per individual file in bytes (default: 10 MB). */
	maxFileSizeBytes?: number;
	/** Maximum total size of all files in bytes (default: 50 MB). */
	maxTotalFileSizeBytes?: number;
}

// === Input Types ===

/** A file to be encrypted and uploaded as an attachment. */
export interface AttachmentFile {
	/** Display name (e.g., "photo.jpg"). */
	fileName: string;
	/** MIME type (e.g., "image/jpeg"). */
	mimeType: string;
	/** Raw file bytes. */
	data: Uint8Array;
	/** Optional extra data to include in the encrypted metadata. */
	extras?: Record<string, unknown>;
}

// === Attachment Metadata (encrypted per-file, stored on the relayer) ===

/** Metadata about an attachment, encrypted and stored on the relayer. */
export interface AttachmentMetadata {
	/** Original file name. */
	fileName: string;
	/** MIME type. */
	mimeType: string;
	/** Original file size in bytes (before encryption). */
	fileSize: number;
	/** Adapter-specific or user-provided extra data (e.g. File Storage blobObjectId). */
	extras?: Record<string, unknown>;
}

// === Wire Type ===

/**
 * A structured attachment as it travels on the wire and through the SDK.
 *
 * Returned by {@link AttachmentsManager.upload}, passed to the relayer via
 * `SendMessageParams.attachments`, and received back on `RelayerMessage.attachments`.
 */
export interface Attachment {
	/** Storage ID for downloading the encrypted data (e.g. quilt-patch-id). */
	storageId: string;
	/** Hex-encoded 12-byte AES-GCM nonce used to encrypt the file data. */
	nonce: string;
	/** Hex-encoded encrypted metadata blob (fileName, mimeType, fileSize, extras). */
	encryptedMetadata: string;
	/** Hex-encoded 12-byte AES-GCM nonce used to encrypt the metadata. */
	metadataNonce: string;
}

// === User-facing Handle ===

/** A resolved attachment with lazy download+decrypt. */
export interface AttachmentHandle {
	/** Original file name. */
	fileName: string;
	/** MIME type. */
	mimeType: string;
	/** Original file size in bytes (before encryption). */
	fileSize: number;
	/** Extra data from the encrypted metadata (adapter-specific or user-provided). */
	extras?: Record<string, unknown>;
	/** The on-the-wire {@link Attachment} this handle was resolved from. Useful for edits. */
	wire: Attachment;
	/** Download and decrypt the attachment data on demand. */
	data(): Promise<Uint8Array>;
}
