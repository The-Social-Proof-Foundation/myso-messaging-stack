// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { StorageAdapter, StorageEntry, StorageUploadResult } from './storage-adapter.js';
import type { FileStorageBlob, FileStorageQuiltStoreResult, FileStorageStoredQuiltPatch } from './file-storage-types.js';
import type { HttpClientConfig } from '../http/types.js';

import { DEFAULT_HTTP_TIMEOUT } from '../http/types.js';
import { HttpTimeoutError } from '../http/errors.js';
import { FileStorageUploadError, FileStorageDownloadError, FileStorageResponseError } from './file-storage-errors.js';

// ── Public config / metadata types ──────────────────────────────────

export interface FileStorageHttpStorageAdapterConfig extends HttpClientConfig {
	/** Base URL of the File Storage publisher (e.g. `https://publisher.file-storage-testnet.mysocial.network`). */
	publisherUrl: string;
	/** Base URL of the File Storage aggregator (e.g. `https://aggregator.file-storage-testnet.mysocial.network`). */
	aggregatorUrl: string;
	/** Number of epochs (ahead of the current one) for which to store data. */
	epochs: number;
}

/**
 * Metadata extracted from a successful quilt upload.
 *
 * Persisted opaquely in `StorageUploadResult.metadata` so consumers can
 * perform future on-chain operations (deletion, epoch extension) without
 * knowing File Storage internals.
 */
export interface FileStorageUploadMetadata {
	blobObjectId: string;
	blobId: string;
	startEpoch: number;
	endEpoch: number;
	cost: number;
	deletable: boolean;
}

// ── Adapter implementation ──────────────────────────────────────────

/**
 * {@link StorageAdapter} backed by the File Storage HTTP publisher + aggregator.
 *
 * - **Upload**: `PUT /v1/quilts?epochs=N` with `multipart/form-data`.
 * - **Download**: `GET /v1/blobs/by-quilt-patch-id/{id}`.
 * - **Delete**: not supported (publisher HTTP API has no deletion endpoint).
 */
export class FileStorageHttpStorageAdapter implements StorageAdapter {
	readonly #publisherUrl: string;
	readonly #aggregatorUrl: string;
	readonly #epochs: number;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeout: number;
	readonly #onError?: (error: Error) => void;

	constructor(config: FileStorageHttpStorageAdapterConfig) {
		this.#publisherUrl = config.publisherUrl.replace(/\/+$/, '');
		this.#aggregatorUrl = config.aggregatorUrl.replace(/\/+$/, '');
		this.#epochs = config.epochs;
		this.#fetch = config.fetch ?? globalThis.fetch;
		this.#timeout = config.timeout ?? DEFAULT_HTTP_TIMEOUT;
		this.#onError = config.onError;
	}

	// ── upload ─────────────────────────────────────────────────────

	async upload(entries: StorageEntry[]): Promise<StorageUploadResult> {
		const formData = new FormData();

		for (const entry of entries) {
			formData.append(entry.name, new Blob([new Uint8Array(entry.data)]));
		}

		const url = `${this.#publisherUrl}/v1/quilts?epochs=${this.#epochs}`;
		const response = await this.#request(url, { method: 'PUT', body: formData });

		if (!response.ok) {
			const body = await response.text();
			const error = new FileStorageUploadError(response.status, body);
			this.#onError?.(error);
			throw error;
		}

		const result: FileStorageQuiltStoreResult = await response.json();

		return {
			ids: this.#extractPatchIds(result.storedQuiltBlobs, entries),
			metadata: this.#extractMetadata(result),
		};
	}

	// ── download ───────────────────────────────────────────────────

	async download(id: string): Promise<Uint8Array> {
		const url = `${this.#aggregatorUrl}/v1/blobs/by-quilt-patch-id/${id}`;
		const response = await this.#request(url);

		if (!response.ok) {
			const body = await response.text();
			const error = new FileStorageDownloadError(response.status, body);
			this.#onError?.(error);
			throw error;
		}

		return new Uint8Array(await response.arrayBuffer());
	}

	// ── internal request helper ────────────────────────────────────

	async #request(url: string, init?: RequestInit): Promise<Response> {
		const timeoutSignal = AbortSignal.timeout(this.#timeout);

		try {
			return await this.#fetch(url, {
				...init,
				signal: init?.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal,
			});
		} catch (error) {
			if (error instanceof Error && error.name === 'TimeoutError') {
				const timeoutError = new HttpTimeoutError(url, this.#timeout);
				this.#onError?.(timeoutError);
				throw timeoutError;
			}
			if (error instanceof Error) {
				this.#onError?.(error);
			}
			throw error;
		}
	}

	// ── helpers ────────────────────────────────────────────────────

	/**
	 * Return quilt-patch IDs in the same order as `entries`.
	 *
	 * The publisher response contains patches keyed by `identifier` (the
	 * form-field name we used during upload). We build a lookup map so the
	 * returned `ids[]` array is positionally aligned with the input.
	 */
	#extractPatchIds(patches: FileStorageStoredQuiltPatch[], entries: StorageEntry[]): string[] {
		const byIdentifier = new Map(patches.map((p) => [p.identifier, p.quiltPatchId]));

		return entries.map((entry) => {
			const patchId = byIdentifier.get(entry.name);
			if (!patchId) {
				throw new FileStorageResponseError(
					`File Storage response missing quilt patch for identifier "${entry.name}"`,
				);
			}
			return patchId;
		});
	}

	/** Extract blob-level metadata from the `blobStoreResult`. */
	#extractMetadata(result: FileStorageQuiltStoreResult): FileStorageUploadMetadata {
		const { blobStoreResult } = result;

		if (blobStoreResult.newlyCreated) {
			const blob: FileStorageBlob = blobStoreResult.newlyCreated.blobObject;
			return {
				blobObjectId: blob.id,
				blobId: blob.blobId,
				startEpoch: blob.storage.startEpoch,
				endEpoch: blob.storage.endEpoch,
				cost: blobStoreResult.newlyCreated.cost,
				deletable: blob.deletable,
			};
		}

		if (blobStoreResult.alreadyCertified) {
			const cert = blobStoreResult.alreadyCertified;
			return {
				blobObjectId: cert.object ?? '',
				blobId: cert.blobId,
				startEpoch: 0,
				endEpoch: cert.endEpoch,
				cost: 0,
				deletable: false,
			};
		}

		throw new FileStorageResponseError(
			'Unexpected File Storage blobStoreResult — neither newlyCreated nor alreadyCertified',
		);
	}
}
