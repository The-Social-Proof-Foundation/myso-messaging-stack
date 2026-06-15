// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// In your project, replace these imports with:
//   import { ... } from '@socialproof/myso-messaging-stack';
import type { RecoverMessagesParams, RecoveryTransport } from '../../src/recovery/transport.js';
import type { FetchMessagesResult, RelayerMessage } from '../../src/relayer/types.js';
import { DEFAULT_HTTP_TIMEOUT } from '../../src/http/types.js';
import { HttpTimeoutError } from '../../src/http/errors.js';
import { fromFileStorageMessage } from '../../src/recovery/file-storage-message.js';
import type { FileStorageMessageWire } from '../../src/recovery/types.js';
import type {
	AggregatorPatchInfo,
	IndexerPatch,
	IndexerPatchesResponse,
	FileStorageRecoveryConfig,
} from './types.js';

export class FileStorageRecoveryTransport implements RecoveryTransport {
	readonly #indexerUrl: string;
	readonly #aggregatorUrl: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeout: number;
	readonly #onError?: (error: Error) => void;

	constructor(config: FileStorageRecoveryConfig) {
		this.#indexerUrl = config.indexerUrl.replace(/\/+$/, '');
		this.#aggregatorUrl = config.aggregatorUrl.replace(/\/+$/, '');
		this.#fetch = config.fetch ?? globalThis.fetch;
		this.#timeout = config.timeout ?? DEFAULT_HTTP_TIMEOUT;
		this.#onError = config.onError;
	}

	async recoverMessages(params: RecoverMessagesParams): Promise<FetchMessagesResult> {
		// Build indexer URL with pagination
		const queryParams = new URLSearchParams();
		if (params.limit !== undefined) {
			queryParams.set('limit', params.limit.toString());
		}
		if (params.afterOrder !== undefined) {
			queryParams.set('after_order', params.afterOrder.toString());
		}
		if (params.beforeOrder !== undefined) {
			queryParams.set('before_order', params.beforeOrder.toString());
		}

		const queryString = queryParams.toString();
		const url = `${this.#indexerUrl}/v1/groups/${params.groupId}/patches${queryString ? `?${queryString}` : ''}`;

		const indexerResponse = await this.#request<IndexerPatchesResponse>(url);

		if (indexerResponse.patches.length === 0) {
			return { messages: [], hasNext: indexerResponse.hasMore };
		}

		// Filter out deleted patches
		const activePatches = indexerResponse.patches.filter(
			(p) => p.syncStatus !== 'DELETED' && p.syncStatus !== 'DELETE_PENDING',
		);

		if (activePatches.length === 0) {
			return { messages: [], hasNext: indexerResponse.hasMore };
		}

		// Group by blobId so we only list each quilt once
		const patchesByBlob = new Map<string, IndexerPatch[]>();
		for (const patch of activePatches) {
			const existing = patchesByBlob.get(patch.blobId);
			if (existing) {
				existing.push(patch);
			} else {
				patchesByBlob.set(patch.blobId, [patch]);
			}
		}

		// For each blob, list patches via aggregator then fetch content
		const messages: RelayerMessage[] = [];

		for (const [blobId, patches] of patchesByBlob) {
			try {
				const patchListUrl = `${this.#aggregatorUrl}/v1/quilts/${blobId}/patches`;
				const allBlobPatches = await this.#request<AggregatorPatchInfo[]>(patchListUrl);

				const identifierToPatchId = new Map<string, string>();
				for (const bp of allBlobPatches) {
					identifierToPatchId.set(bp.identifier, bp.patch_id);
				}

				for (const patch of patches) {
					const patchId = identifierToPatchId.get(patch.identifier);
					if (!patchId) {
						this.#onError?.(
							new Error(`No patch ID found for ${patch.identifier} in blob ${blobId}`),
						);
						continue;
					}

					try {
						const patchUrl = `${this.#aggregatorUrl}/v1/blobs/by-quilt-patch-id/${patchId}`;
						const patchResponse = await this.#fetch(patchUrl, {
							signal: AbortSignal.timeout(this.#timeout),
						});

						if (!patchResponse.ok) {
							throw new Error(`Aggregator returned ${patchResponse.status} for patch ${patchId}`);
						}

						const text = await patchResponse.text();
						const wire = JSON.parse(text) as FileStorageMessageWire;
						messages.push(fromFileStorageMessage(wire));
					} catch (err) {
						this.#onError?.(
							new Error(`Failed to read patch ${patchId} from blob ${blobId}`, { cause: err }),
						);
					}
				}
			} catch (err) {
				this.#onError?.(
					new Error(`Failed to read blob ${blobId} from FileStorage`, { cause: err }),
				);
			}
		}

		messages.sort((a, b) => a.order - b.order);
		return { messages, hasNext: indexerResponse.hasMore };
	}

	async #request<T>(url: string): Promise<T> {
		const timeoutSignal = AbortSignal.timeout(this.#timeout);

		try {
			const response = await this.#fetch(url, { signal: timeoutSignal });

			if (!response.ok) {
				const body = await response.text().catch(() => '');
				const error = new Error(
					`Request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
				);
				this.#onError?.(error);
				throw error;
			}

			return (await response.json()) as T;
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
}
