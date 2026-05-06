// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileStorageQuiltStoreResult } from '../../src/storage/file-storage-types.js';
import type { FileStorageUploadMetadata } from '../../src/storage/file-storage-http-storage-adapter.js';
import { FileStorageHttpStorageAdapter } from '../../src/storage/file-storage-http-storage-adapter.js';
import {
	FileStorageUploadError,
	FileStorageDownloadError,
	FileStorageResponseError,
} from '../../src/storage/file-storage-errors.js';
import { HttpTimeoutError } from '../../src/http/errors.js';

// ── Fixtures ────────────────────────────────────────────────────────

const PUBLISHER = 'https://publisher.test';
const AGGREGATOR = 'https://aggregator.test';
const EPOCHS = 5;

function makeEntries(names: string[]) {
	return names.map((name) => ({
		name,
		data: new TextEncoder().encode(`data-for-${name}`),
	}));
}

function makeNewlyCreatedResponse(identifiers: string[]): FileStorageQuiltStoreResult {
	return {
		blobStoreResult: {
			newlyCreated: {
				blobObject: {
					id: '0xblob123',
					registeredEpoch: 10,
					blobId: 'blobId-abc',
					size: 1024,
					encodingType: 'RS2',
					certifiedEpoch: null,
					storage: {
						id: '0xstorage456',
						startEpoch: 10,
						endEpoch: 15,
						storageSize: 2048,
					},
					deletable: true,
				},
				resourceOperation: { registerFromScratch: { encoded_length: 2048, epochs_ahead: 5 } },
				cost: 500,
			},
		},
		storedQuiltBlobs: identifiers.map((id, i) => ({
			identifier: id,
			quiltPatchId: `patch-${i}`,
		})),
	};
}

function makeAlreadyCertifiedResponse(identifiers: string[]): FileStorageQuiltStoreResult {
	return {
		blobStoreResult: {
			alreadyCertified: {
				blobId: 'blobId-existing',
				endEpoch: 20,
				event: { txDigest: 'digest123', eventSeq: '0' },
				object: '0xobject789',
			},
		},
		storedQuiltBlobs: identifiers.map((id, i) => ({
			identifier: id,
			quiltPatchId: `patch-${i}`,
		})),
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function textResponse(body: string, status: number): Response {
	return new Response(body, { status });
}

function binaryResponse(data: Uint8Array): Response {
	return new Response(new Uint8Array(data).buffer, {
		status: 200,
		headers: { 'Content-Type': 'application/octet-stream' },
	});
}

// ── Tests ───────────────────────────────────────────────────────────

describe('FileStorageHttpStorageAdapter', () => {
	let mockFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
	let adapter: FileStorageHttpStorageAdapter;

	beforeEach(() => {
		mockFetch = vi.fn<typeof globalThis.fetch>();
		adapter = new FileStorageHttpStorageAdapter({
			publisherUrl: PUBLISHER,
			aggregatorUrl: AGGREGATOR,
			epochs: EPOCHS,
			fetch: mockFetch,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── upload ─────────────────────────────────────────────────────

	describe('upload', () => {
		it('should PUT multipart/form-data to /v1/quilts with correct epochs', async () => {
			const entries = makeEntries(['file-a', 'file-b']);
			mockFetch.mockResolvedValueOnce(jsonResponse(makeNewlyCreatedResponse(['file-a', 'file-b'])));

			await adapter.upload(entries);

			expect(mockFetch).toHaveBeenCalledOnce();
			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${PUBLISHER}/v1/quilts?epochs=${EPOCHS}`);
			expect(init.method).toBe('PUT');
			expect(init.body).toBeInstanceOf(FormData);

			const formData = init.body as FormData;
			expect(formData.get('file-a')).toBeInstanceOf(Blob);
			expect(formData.get('file-b')).toBeInstanceOf(Blob);
		});

		it('should return patch IDs in the same order as input entries', async () => {
			const entries = makeEntries(['second', 'first']);
			// Response patches in different order than entries
			const response = makeNewlyCreatedResponse(['first', 'second']);
			response.storedQuiltBlobs = [
				{ identifier: 'first', quiltPatchId: 'patch-first' },
				{ identifier: 'second', quiltPatchId: 'patch-second' },
			];
			mockFetch.mockResolvedValueOnce(jsonResponse(response));

			const result = await adapter.upload(entries);

			// IDs must match entry order, not response order
			expect(result.ids).toEqual(['patch-second', 'patch-first']);
		});

		it('should extract FileStorageUploadMetadata from newlyCreated response', async () => {
			const entries = makeEntries(['a']);
			mockFetch.mockResolvedValueOnce(jsonResponse(makeNewlyCreatedResponse(['a'])));

			const result = await adapter.upload(entries);
			const metadata = result.metadata as FileStorageUploadMetadata;

			expect(metadata).toEqual({
				blobObjectId: '0xblob123',
				blobId: 'blobId-abc',
				startEpoch: 10,
				endEpoch: 15,
				cost: 500,
				deletable: true,
			});
		});

		it('should extract FileStorageUploadMetadata from alreadyCertified response', async () => {
			const entries = makeEntries(['a']);
			mockFetch.mockResolvedValueOnce(jsonResponse(makeAlreadyCertifiedResponse(['a'])));

			const result = await adapter.upload(entries);
			const metadata = result.metadata as FileStorageUploadMetadata;

			expect(metadata).toEqual({
				blobObjectId: '0xobject789',
				blobId: 'blobId-existing',
				startEpoch: 0,
				endEpoch: 20,
				cost: 0,
				deletable: false,
			});
		});

		it('should throw FileStorageUploadError on non-2xx response', async () => {
			mockFetch.mockResolvedValueOnce(textResponse('storage quota exceeded', 413));

			const promise = adapter.upload(makeEntries(['a']));
			await expect(promise).rejects.toThrow(FileStorageUploadError);
			await expect(promise).rejects.toThrow(/413/);
		});

		it('should throw FileStorageResponseError when a patch identifier is missing', async () => {
			const response = makeNewlyCreatedResponse(['wrong-name']);
			mockFetch.mockResolvedValueOnce(jsonResponse(response));

			await expect(adapter.upload(makeEntries(['expected-name']))).rejects.toThrow(
				FileStorageResponseError,
			);
		});

		it('should throw FileStorageResponseError for unexpected blobStoreResult', async () => {
			const response = {
				blobStoreResult: { markedInvalid: { blob_id: 'x', event: {} } },
				storedQuiltBlobs: [{ identifier: 'a', quiltPatchId: 'p' }],
			};
			mockFetch.mockResolvedValueOnce(jsonResponse(response));

			await expect(adapter.upload(makeEntries(['a']))).rejects.toThrow(FileStorageResponseError);
		});
	});

	// ── download ───────────────────────────────────────────────────

	describe('download', () => {
		it('should GET /v1/blobs/by-quilt-patch-id/{id} and return Uint8Array', async () => {
			const payload = new TextEncoder().encode('hello file storage');
			mockFetch.mockResolvedValueOnce(binaryResponse(payload));

			const result = await adapter.download('patch-123');

			expect(mockFetch).toHaveBeenCalledOnce();
			const [url] = mockFetch.mock.calls[0];
			expect(url).toBe(`${AGGREGATOR}/v1/blobs/by-quilt-patch-id/patch-123`);
			expect(result).toEqual(payload);
		});

		it('should throw FileStorageDownloadError on 404', async () => {
			mockFetch.mockResolvedValueOnce(textResponse('not found', 404));

			const promise = adapter.download('bad-id');
			await expect(promise).rejects.toThrow(FileStorageDownloadError);
			await expect(promise).rejects.toThrow(/404/);
		});

		it('should throw FileStorageDownloadError on 500', async () => {
			mockFetch.mockResolvedValueOnce(textResponse('internal error', 500));

			await expect(adapter.download('some-id')).rejects.toThrow(FileStorageDownloadError);
		});
	});

	// ── HttpClientConfig ──────────────────────────────────────────

	describe('HttpClientConfig', () => {
		it('should strip trailing slashes from URLs', async () => {
			const a = new FileStorageHttpStorageAdapter({
				publisherUrl: 'https://pub.test///',
				aggregatorUrl: 'https://agg.test/',
				epochs: 1,
				fetch: mockFetch,
			});

			mockFetch.mockResolvedValueOnce(jsonResponse(makeNewlyCreatedResponse(['x'])));
			await a.upload(makeEntries(['x']));

			const [url] = mockFetch.mock.calls[0];
			expect(url).toBe('https://pub.test/v1/quilts?epochs=1');
		});

		it('should call onError callback before throwing on upload failure', async () => {
			const onError = vi.fn();
			const a = new FileStorageHttpStorageAdapter({
				publisherUrl: PUBLISHER,
				aggregatorUrl: AGGREGATOR,
				epochs: EPOCHS,
				fetch: mockFetch,
				onError,
			});

			mockFetch.mockResolvedValueOnce(textResponse('bad', 500));

			await expect(a.upload(makeEntries(['a']))).rejects.toThrow(FileStorageUploadError);
			expect(onError).toHaveBeenCalledOnce();
			expect(onError.mock.calls[0][0]).toBeInstanceOf(FileStorageUploadError);
		});

		it('should call onError callback before throwing on download failure', async () => {
			const onError = vi.fn();
			const a = new FileStorageHttpStorageAdapter({
				publisherUrl: PUBLISHER,
				aggregatorUrl: AGGREGATOR,
				epochs: EPOCHS,
				fetch: mockFetch,
				onError,
			});

			mockFetch.mockResolvedValueOnce(textResponse('not found', 404));

			await expect(a.download('x')).rejects.toThrow(FileStorageDownloadError);
			expect(onError).toHaveBeenCalledOnce();
			expect(onError.mock.calls[0][0]).toBeInstanceOf(FileStorageDownloadError);
		});

		it('should throw HttpTimeoutError and call onError when request times out', async () => {
			const onError = vi.fn();
			const a = new FileStorageHttpStorageAdapter({
				publisherUrl: PUBLISHER,
				aggregatorUrl: AGGREGATOR,
				epochs: EPOCHS,
				fetch: () => {
					throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
				},
				onError,
			});

			await expect(a.download('x')).rejects.toThrow(HttpTimeoutError);
			expect(onError).toHaveBeenCalledOnce();
			expect(onError.mock.calls[0][0]).toBeInstanceOf(HttpTimeoutError);
		});

		it('should call onError for non-timeout fetch errors', async () => {
			const onError = vi.fn();
			const networkError = new TypeError('Failed to fetch');
			const a = new FileStorageHttpStorageAdapter({
				publisherUrl: PUBLISHER,
				aggregatorUrl: AGGREGATOR,
				epochs: EPOCHS,
				fetch: () => {
					throw networkError;
				},
				onError,
			});

			await expect(a.download('x')).rejects.toThrow(TypeError);
			expect(onError).toHaveBeenCalledWith(networkError);
		});
	});
});
