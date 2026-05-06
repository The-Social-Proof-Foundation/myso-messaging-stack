// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * A single entry in a batch upload.
 *
 * The `name` serves as a logical identifier within the batch. For File Storage quilts,
 * it becomes the quilt patch identifier; for S3, it could map to an object key.
 */
export interface StorageEntry {
	/** Logical name for this entry within the upload batch. */
	name: string;
	/** Raw bytes to store (already encrypted by the time they reach here). */
	data: Uint8Array;
}

/**
 * Result of a batch upload operation.
 */
export interface StorageUploadResult {
	/** One ID per entry, in the same order as the input. Used for {@link StorageAdapter.download}. */
	ids: string[];
	/**
	 * Adapter-specific metadata from the upload operation.
	 *
	 * The {@link StorageAdapter} interface is agnostic about the shape of this field.
	 * Concrete adapters define their own metadata types. The consumer (e.g. AttachmentsManager)
	 * persists this opaque metadata for future use (e.g., on-chain deletion, epoch extension)
	 * without interpreting it.
	 *
	 * For File Storage quilts this is quilt-level metadata (one MySo Blob object for the entire
	 * quilt): `{ blobObjectId, blobId, startEpoch, endEpoch, cost, deletable }`.
	 * Per-patch identifiers are already captured in `ids`.
	 *
	 * For S3 this might contain bucket info, or a `Record<string, PerFileMetadata>`
	 * if per-file metadata is relevant.
	 */
	metadata?: unknown;
}

/**
 * Encryption-unaware storage abstraction.
 *
 * Implementations handle the mechanics of storing and retrieving opaque bytes.
 * Encryption/decryption is handled by the caller (e.g., AttachmentsManager)
 * before data reaches the adapter.
 */
export interface StorageAdapter {
	/**
	 * Upload one or more entries as a batch.
	 *
	 * Implementations may store them together (e.g., File Storage quilts — one HTTP call,
	 * one MySo Blob object) or individually (e.g., S3 putObject per entry). The caller
	 * doesn't know or care.
	 */
	upload(entries: StorageEntry[]): Promise<StorageUploadResult>;

	/** Download a single entry by its ID. */
	download(id: string): Promise<Uint8Array>;

	/**
	 * Delete entries by their IDs.
	 *
	 * Optional. Adapters that don't support deletion (e.g., File Storage via publisher HTTP
	 * API) should not implement this. When absent, the caller skips physical deletion —
	 * orphaned encrypted data expires naturally or becomes unreachable.
	 */
	delete?(ids: string[]): Promise<void>;
}
