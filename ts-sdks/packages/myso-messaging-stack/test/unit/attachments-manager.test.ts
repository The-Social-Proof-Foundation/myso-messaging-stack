// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { SessionKey } from '@socialproof/mydata';
import type { MyDataCompatibleClient } from '@socialproof/mydata';
import { ClientCache, type ClientWithCoreApi } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentsManager } from '../../src/attachments/attachments-manager.js';
import type { AttachmentFile } from '../../src/attachments/types.js';
import { EnvelopeEncryption } from '../../src/encryption/envelope-encryption.js';
import { MySoMessagingStackClientError } from '../../src/error.js';
import type {
	StorageAdapter,
	StorageEntry,
	StorageUploadResult,
} from '../../src/storage/storage-adapter.js';
import { MySoMessagingStackDerive } from '../../src/derive.js';
import type { MySoMessagingStackView } from '../../src/view.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';
import {
	MOCK_PACKAGE_CONFIG,
	MOCK_PACKAGE_ID,
	MOCK_VERSION_ID,
} from './helpers/mock-package-config.js';

// === Constants ===

const mockMyDataMySoClient = {} as MyDataCompatibleClient;

// === Helpers ===

function createTestSessionKey(): SessionKey {
	const keypair = Ed25519Keypair.generate();
	return SessionKey.import(
		{
			address: keypair.getPublicKey().toMySoAddress(),
			packageId: '0x' + '00'.repeat(32),
			creationTimeMs: Date.now(),
			ttlMin: 30,
			sessionKey: keypair.getSecretKey(),
		},
		mockMyDataMySoClient,
	);
}

function createEnvelopeEncryption(): EnvelopeEncryption {
	const sessionKey = createTestSessionKey();
	return new EnvelopeEncryption({
		mydataClient: createMockMyDataClient(),
		mysoClient: { cache: new ClientCache() } as unknown as ClientWithCoreApi,
		view: { getCurrentKeyVersion: async () => 0n } as unknown as MySoMessagingStackView,
		derive: new MySoMessagingStackDerive({
			packageConfig: MOCK_PACKAGE_CONFIG,
		}),
		originalPackageId: MOCK_PACKAGE_ID,
		latestPackageId: MOCK_PACKAGE_ID,
		versionId: MOCK_VERSION_ID,
		encryption: {
			sessionKey: { getSessionKey: () => sessionKey },
		},
	});
}

/**
 * In-memory StorageAdapter that stores entries in a Map.
 * Upload assigns incrementing IDs ("id-0", "id-1", ...).
 */
function createMockStorageAdapter(): StorageAdapter & {
	store: Map<string, Uint8Array>;
	uploadCalls: StorageEntry[][];
} {
	let nextId = 0;
	const store = new Map<string, Uint8Array>();
	const uploadCalls: StorageEntry[][] = [];

	return {
		store,
		uploadCalls,
		upload: vi.fn(async (entries: StorageEntry[]): Promise<StorageUploadResult> => {
			uploadCalls.push(entries);
			const ids: string[] = [];
			for (const entry of entries) {
				const id = `id-${nextId++}`;
				store.set(id, entry.data);
				ids.push(id);
			}
			return { ids, metadata: { blobId: 'test-blob' } };
		}),
		download: vi.fn(async (id: string): Promise<Uint8Array> => {
			const data = store.get(id);
			if (!data) throw new Error(`Not found: ${id}`);
			return data;
		}),
	};
}

function makeFile(name: string, content: string, mimeType = 'text/plain'): AttachmentFile {
	return {
		fileName: name,
		mimeType,
		data: new TextEncoder().encode(content),
	};
}

function makeFileOfSize(name: string, sizeBytes: number): AttachmentFile {
	return {
		fileName: name,
		mimeType: 'application/octet-stream',
		data: new Uint8Array(sizeBytes),
	};
}

// === Tests ===

describe('AttachmentsManager', () => {
	describe('validation', () => {
		it('should reject empty files array', async () => {
			const encryption = createEnvelopeEncryption();
			await encryption.generateGroupDEK();
			const manager = new AttachmentsManager(encryption, {
				storageAdapter: createMockStorageAdapter(),
			});

			await expect(manager.upload([], { uuid: 'test' })).rejects.toThrow(
				MySoMessagingStackClientError,
			);
			await expect(manager.upload([], { uuid: 'test' })).rejects.toThrow(
				'At least one file is required',
			);
		});

		it('should reject too many files', async () => {
			const encryption = createEnvelopeEncryption();
			await encryption.generateGroupDEK();
			const manager = new AttachmentsManager(encryption, {
				storageAdapter: createMockStorageAdapter(),
				maxAttachments: 2,
			});

			const files = [makeFile('a.txt', 'a'), makeFile('b.txt', 'b'), makeFile('c.txt', 'c')];

			await expect(manager.upload(files, { uuid: 'test' })).rejects.toThrow(
				'Too many files: 3 exceeds maximum of 2',
			);
		});

		it('should reject individual file exceeding size limit', async () => {
			const encryption = createEnvelopeEncryption();
			await encryption.generateGroupDEK();
			const manager = new AttachmentsManager(encryption, {
				storageAdapter: createMockStorageAdapter(),
				maxFileSizeBytes: 100,
			});

			const files = [makeFileOfSize('big.bin', 101)];

			await expect(manager.upload(files, { uuid: 'test' })).rejects.toThrow(
				/big\.bin.*101 bytes.*100 byte limit/,
			);
		});

		it('should reject total file size exceeding limit', async () => {
			const encryption = createEnvelopeEncryption();
			await encryption.generateGroupDEK();
			const manager = new AttachmentsManager(encryption, {
				storageAdapter: createMockStorageAdapter(),
				maxFileSizeBytes: 100,
				maxTotalFileSizeBytes: 150,
			});

			const files = [makeFileOfSize('a.bin', 80), makeFileOfSize('b.bin', 80)];

			await expect(manager.upload(files, { uuid: 'test' })).rejects.toThrow(
				/Total file size 160 bytes exceeds the 150 byte limit/,
			);
		});
	});

	describe('upload', () => {
		it('should encrypt each file and return structured Attachment[] (no manifest)', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files = [
				makeFile('hello.txt', 'hello world'),
				makeFile('photo.jpg', 'fake-image-data', 'image/jpeg'),
			];

			const attachments = await manager.upload(files, { uuid });

			// Should have uploaded only the file data batch — no manifest
			expect(storage.uploadCalls).toHaveLength(1);

			// File batch should contain 2 entries
			const fileEntries = storage.uploadCalls[0];
			expect(fileEntries).toHaveLength(2);
			expect(fileEntries[0].name).toBe('hello.txt');
			expect(fileEntries[1].name).toBe('photo.jpg');
			// Encrypted data should differ from plaintext
			expect(fileEntries[0].data).not.toEqual(files[0].data);

			// Result should be Attachment[]
			expect(attachments).toHaveLength(2);
			for (const attachment of attachments) {
				expect(attachment.storageId).toBeDefined();
				expect(attachment.nonce).toBeDefined();
				expect(attachment.encryptedMetadata).toBeDefined();
				expect(attachment.metadataNonce).toBeDefined();
			}
		});

		it('should work with a single file', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const attachments = await manager.upload([makeFile('only.txt', 'content')], { uuid });

			expect(storage.uploadCalls).toHaveLength(1);
			expect(storage.uploadCalls[0]).toHaveLength(1);
			expect(attachments).toHaveLength(1);
			expect(attachments[0].storageId).toBe('id-0');
		});

		it('should work at max file count', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, {
				storageAdapter: storage,
				maxAttachments: 3,
			});

			const files = [makeFile('a.txt', 'a'), makeFile('b.txt', 'b'), makeFile('c.txt', 'c')];

			const attachments = await manager.upload(files, { uuid });

			expect(storage.uploadCalls[0]).toHaveLength(3);
			expect(attachments).toHaveLength(3);
		});

		it('should produce encrypted metadata (not plaintext)', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const attachments = await manager.upload(
				[makeFile('secret.txt', 'top-secret', 'text/plain')],
				{ uuid },
			);

			// encryptedMetadata should not contain plaintext metadata
			const metadataHex = attachments[0].encryptedMetadata;
			expect(metadataHex).not.toContain('secret.txt');
			expect(metadataHex).not.toContain('text/plain');
		});

		it('should include storage adapter metadata in extras', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const attachments = await manager.upload([makeFile('test.txt', 'data')], { uuid });
			const handles = await manager.resolve(attachments, { uuid }, 0n);

			// The mock adapter returns { blobId: 'test-blob' } as metadata
			expect(handles[0].extras).toEqual(expect.objectContaining({ blobId: 'test-blob' }));
		});

		it('should merge user-provided extras with adapter metadata', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files: AttachmentFile[] = [
				{
					fileName: 'test.txt',
					mimeType: 'text/plain',
					data: new TextEncoder().encode('data'),
					extras: { customField: 'user-value' },
				},
			];

			const attachments = await manager.upload(files, { uuid });
			const handles = await manager.resolve(attachments, { uuid }, 0n);

			// User extras should override/merge with adapter metadata
			expect(handles[0].extras).toEqual(
				expect.objectContaining({
					blobId: 'test-blob', // from adapter
					customField: 'user-value', // from user
				}),
			);
		});
	});

	describe('resolve', () => {
		it('should decrypt metadata and return lazy handles', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files = [
				makeFile('doc.txt', 'document content'),
				makeFile('img.png', 'png-bytes', 'image/png'),
			];

			const attachments = await manager.upload(files, { uuid });
			const handles = await manager.resolve(attachments, { uuid }, 0n);

			expect(handles).toHaveLength(2);

			expect(handles[0].fileName).toBe('doc.txt');
			expect(handles[0].mimeType).toBe('text/plain');
			expect(handles[0].fileSize).toBe(new TextEncoder().encode('document content').byteLength);

			expect(handles[1].fileName).toBe('img.png');
			expect(handles[1].mimeType).toBe('image/png');
		});

		it('should lazily download and decrypt each attachment via data()', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files = [makeFile('hello.txt', 'hello'), makeFile('world.txt', 'world')];

			const attachments = await manager.upload(files, { uuid });

			// Reset download mock to track resolve calls separately
			(storage.download as ReturnType<typeof vi.fn>).mockClear();

			const handles = await manager.resolve(attachments, { uuid }, 0n);

			// No downloads yet — metadata was decrypted from inline blobs
			expect(storage.download).toHaveBeenCalledTimes(0);

			// Download first file
			const data0 = await handles[0].data();
			expect(new TextDecoder().decode(data0)).toBe('hello');
			expect(storage.download).toHaveBeenCalledTimes(1);

			// Download second file
			const data1 = await handles[1].data();
			expect(new TextDecoder().decode(data1)).toBe('world');
			expect(storage.download).toHaveBeenCalledTimes(2);
		});

		it('should trigger a fresh download on each data() call (no caching)', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const attachments = await manager.upload([makeFile('f.txt', 'content')], { uuid });

			(storage.download as ReturnType<typeof vi.fn>).mockClear();

			const handles = await manager.resolve(attachments, { uuid }, 0n);
			// No downloads yet
			expect(storage.download).toHaveBeenCalledTimes(0);

			await handles[0].data();
			expect(storage.download).toHaveBeenCalledTimes(1);

			await handles[0].data();
			expect(storage.download).toHaveBeenCalledTimes(2);
		});
	});

	describe('roundtrip', () => {
		it('should upload and resolve files with matching plaintext', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files = [
				makeFile('readme.md', '# Hello World', 'text/markdown'),
				makeFile('data.json', '{"key":"value"}', 'application/json'),
				makeFile('empty.txt', ''),
			];

			const attachments = await manager.upload(files, { uuid });
			const handles = await manager.resolve(attachments, { uuid }, 0n);

			expect(handles).toHaveLength(3);

			for (let i = 0; i < files.length; i++) {
				const handle = handles[i];
				expect(handle.fileName).toBe(files[i].fileName);
				expect(handle.mimeType).toBe(files[i].mimeType);
				expect(handle.fileSize).toBe(files[i].data.byteLength);

				const decrypted = await handle.data();
				expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(files[i].data));
			}
		});

		it('should roundtrip with explicit groupId and encryptionHistoryId', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const derive = new MySoMessagingStackDerive({
				packageConfig: MOCK_PACKAGE_CONFIG,
			});
			const groupId = derive.groupId({ uuid });
			const encryptionHistoryId = derive.encryptionHistoryId({ uuid });

			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files = [makeFile('test.txt', 'explicit ids')];

			const attachments = await manager.upload(files, { groupId, encryptionHistoryId });
			const handles = await manager.resolve(attachments, { groupId, encryptionHistoryId }, 0n);

			const decrypted = await handles[0].data();
			expect(new TextDecoder().decode(decrypted)).toBe('explicit ids');
		});

		it('should roundtrip binary data', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 127]);
			const files: AttachmentFile[] = [
				{ fileName: 'binary.bin', mimeType: 'application/octet-stream', data: binaryData },
			];

			const attachments = await manager.upload(files, { uuid });
			const handles = await manager.resolve(attachments, { uuid }, 0n);

			const decrypted = await handles[0].data();
			expect(Array.from(decrypted)).toEqual(Array.from(binaryData));
		});

		it('should roundtrip extras through metadata', async () => {
			const encryption = createEnvelopeEncryption();
			const { uuid } = await encryption.generateGroupDEK();
			const storage = createMockStorageAdapter();
			const manager = new AttachmentsManager(encryption, { storageAdapter: storage });

			const files: AttachmentFile[] = [
				{
					fileName: 'with-extras.txt',
					mimeType: 'text/plain',
					data: new TextEncoder().encode('data'),
					extras: { customTag: 'important' },
				},
			];

			const attachments = await manager.upload(files, { uuid });
			const handles = await manager.resolve(attachments, { uuid }, 0n);

			expect(handles[0].extras).toEqual(expect.objectContaining({ customTag: 'important' }));
		});
	});
});
