// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal types matching the File Storage publisher/aggregator HTTP API responses.
 *
 * These follow the `publisher_openapi.yaml` schemas (`QuiltStoreResult`,
 * `BlobStoreResult`, `StoredQuiltPatch`, `Blob`) and are intentionally
 * **not** exported from the package — consumers interact only with the
 * adapter-agnostic `StorageAdapter` interface.
 */

// ── Blob-level types ────────────────────────────────────────────────

export interface FileStorageStorageResource {
	id: string;
	startEpoch: number;
	endEpoch: number;
	storageSize: number;
}

/** MySo object for a stored blob. */
export interface FileStorageBlob {
	id: string;
	registeredEpoch: number;
	blobId: string;
	size: number;
	encodingType: string;
	certifiedEpoch: number | null;
	storage: FileStorageStorageResource;
	deletable: boolean;
}

// ── BlobStoreResult variants ────────────────────────────────────────

export interface FileStorageNewlyCreated {
	blobObject: FileStorageBlob;
	resourceOperation: unknown;
	cost: number;
	sharedBlobObject?: string | null;
}

export interface FileStorageAlreadyCertified {
	blobId: string;
	endEpoch: number;
	event?: { txDigest: string; eventSeq: string };
	object?: string;
}

/**
 * Discriminated union returned by `PUT /v1/quilts` and `PUT /v1/blobs`.
 *
 * We only handle `newlyCreated` and `alreadyCertified` — `markedInvalid`
 * and `error` variants are surfaced as generic errors.
 */
export type FileStorageBlobStoreResult =
	| { newlyCreated: FileStorageNewlyCreated; alreadyCertified?: never }
	| { alreadyCertified: FileStorageAlreadyCertified; newlyCreated?: never };

// ── Quilt-level types ───────────────────────────────────────────────

export interface FileStorageStoredQuiltPatch {
	identifier: string;
	quiltPatchId: string;
	range?: [number, number] | null;
}

/** Top-level response from `PUT /v1/quilts`. */
export interface FileStorageQuiltStoreResult {
	blobStoreResult: FileStorageBlobStoreResult;
	storedQuiltBlobs: FileStorageStoredQuiltPatch[];
}
