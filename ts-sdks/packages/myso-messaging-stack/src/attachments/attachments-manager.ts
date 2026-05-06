// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { fromHex, toHex } from '@socialproof/myso/utils';

import type { EnvelopeEncryption } from '../encryption/envelope-encryption.js';
import { MySoMessagingStackClientError } from '../error.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { GroupRef } from '../types.js';
import type {
	Attachment,
	AttachmentFile,
	AttachmentHandle,
	AttachmentMetadata,
	AttachmentsConfig,
} from './types.js';

const DEFAULT_MAX_ATTACHMENTS = 10;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_TOTAL_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Orchestrates encrypting, uploading, downloading, and decrypting attachments.
 *
 * Upload flow:
 * 1. Validate file count and sizes.
 * 2. Encrypt each file individually via {@link EnvelopeEncryption}.
 * 3. Upload all encrypted files as a batch via {@link StorageAdapter}.
 * 4. Encrypt per-file metadata (fileName, mimeType, fileSize, extras).
 * 5. Return {@link Attachment}[] ready for the relayer.
 *
 * Resolve flow:
 * 1. Decrypt each attachment's metadata from the inline encrypted blob.
 * 2. Return {@link AttachmentHandle}[] with lazy `data()` closures that
 *    download and decrypt individual files on demand.
 */
export class AttachmentsManager<TApproveContext = void> {
	readonly #encryption: EnvelopeEncryption<TApproveContext>;
	readonly #storageAdapter: StorageAdapter;
	readonly #maxAttachments: number;
	readonly #maxFileSizeBytes: number;
	readonly #maxTotalFileSizeBytes: number;

	constructor(encryption: EnvelopeEncryption<TApproveContext>, config: AttachmentsConfig) {
		this.#encryption = encryption;
		this.#storageAdapter = config.storageAdapter;
		this.#maxAttachments = config.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
		this.#maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
		this.#maxTotalFileSizeBytes = config.maxTotalFileSizeBytes ?? DEFAULT_MAX_TOTAL_FILE_SIZE_BYTES;
	}

	/**
	 * Encrypt and upload a batch of files, returning structured attachments
	 * ready to be sent with a message via the relayer.
	 *
	 * Each returned {@link Attachment} contains the storage ID for the encrypted
	 * file data, plus encrypted metadata (fileName, mimeType, fileSize, extras).
	 * The caller passes these directly to `SendMessageParams.attachments`.
	 */
	async upload(
		files: AttachmentFile[],
		groupRef: GroupRef,
		encryptOptions?: Omit<EncryptCallOptions<TApproveContext>, 'data'>,
	): Promise<Attachment[]> {
		this.#validateFiles(files);

		// 1. Encrypt each file individually.
		const encryptedEntries: {
			data: Uint8Array;
			nonce: Uint8Array;
		}[] = [];
		for (const file of files) {
			const envelope = await this.#encryption.encrypt({
				...groupRef,
				...encryptOptions,
				data: file.data,
			} as Parameters<EnvelopeEncryption<TApproveContext>['encrypt']>[0]);
			encryptedEntries.push({
				data: envelope.ciphertext,
				nonce: envelope.nonce,
			});
		}

		// 2. Upload all encrypted files as a batch.
		const uploadResult = await this.#storageAdapter.upload(
			encryptedEntries.map((e, i) => ({ name: files[i].fileName, data: e.data })),
		);

		// 3. Encrypt per-file metadata and build Attachment[].
		const attachments: Attachment[] = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const metadata: AttachmentMetadata = {
				fileName: file.fileName,
				mimeType: file.mimeType,
				fileSize: file.data.byteLength,
				...(file.extras || uploadResult.metadata
					? {
							extras: {
								...(uploadResult.metadata as Record<string, unknown> | undefined),
								...file.extras,
							},
						}
					: {}),
			};

			const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
			const metadataEnvelope = await this.#encryption.encrypt({
				...groupRef,
				...encryptOptions,
				data: metadataBytes,
			} as Parameters<EnvelopeEncryption<TApproveContext>['encrypt']>[0]);

			attachments.push({
				storageId: uploadResult.ids[i],
				nonce: toHex(encryptedEntries[i].nonce),
				encryptedMetadata: toHex(metadataEnvelope.ciphertext),
				metadataNonce: toHex(metadataEnvelope.nonce),
			});
		}

		return attachments;
	}

	/**
	 * Decrypt attachment metadata and return lazy handles for each file.
	 *
	 * Takes the {@link Attachment}[] from a `RelayerMessage.attachments` and
	 * decrypts each one's metadata. The `keyVersion` comes from the parent
	 * message and applies to all attachments.
	 *
	 * Each {@link AttachmentHandle.data} call triggers a fresh download+decrypt —
	 * no caching is done at the attachment level.
	 */
	async resolve(
		attachments: Attachment[],
		groupRef: GroupRef,
		keyVersion: bigint,
		decryptOptions?: Omit<DecryptCallOptions<TApproveContext>, 'envelope'>,
	): Promise<AttachmentHandle[]> {
		const handles: AttachmentHandle[] = [];

		for (const attachment of attachments) {
			// Decrypt the metadata blob.
			const metadataBytes = await this.#encryption.decrypt({
				...groupRef,
				...decryptOptions,
				envelope: {
					ciphertext: fromHex(attachment.encryptedMetadata),
					nonce: fromHex(attachment.metadataNonce),
					keyVersion,
				},
			} as Parameters<EnvelopeEncryption<TApproveContext>['decrypt']>[0]);

			const metadata: AttachmentMetadata = JSON.parse(new TextDecoder().decode(metadataBytes));

			handles.push({
				fileName: metadata.fileName,
				mimeType: metadata.mimeType,
				fileSize: metadata.fileSize,
				extras: metadata.extras,
				wire: attachment,
				data: async () => {
					const encrypted = await this.#storageAdapter.download(attachment.storageId);
					return this.#encryption.decrypt({
						...groupRef,
						...decryptOptions,
						envelope: {
							ciphertext: encrypted,
							nonce: fromHex(attachment.nonce),
							keyVersion,
						},
					} as Parameters<EnvelopeEncryption<TApproveContext>['decrypt']>[0]);
				},
			});
		}

		return handles;
	}

	/**
	 * Best-effort deletion of stored attachment data.
	 *
	 * Delegates to {@link StorageAdapter.delete} when the adapter supports it.
	 * Silently does nothing when the adapter has no `delete` method.
	 * Errors are swallowed — callers should not fail on cleanup issues.
	 */
	async deleteStorageEntries(storageIds: string[]): Promise<void> {
		if (storageIds.length === 0 || !this.#storageAdapter.delete) return;
		try {
			await this.#storageAdapter.delete(storageIds);
		} catch {
			// Best-effort: orphaned encrypted data expires naturally.
		}
	}

	// === Private: Validation ===

	#validateFiles(files: AttachmentFile[]): void {
		if (files.length === 0) {
			throw new MySoMessagingStackClientError('At least one file is required');
		}

		if (files.length > this.#maxAttachments) {
			throw new MySoMessagingStackClientError(
				`Too many files: ${files.length} exceeds maximum of ${this.#maxAttachments}`,
			);
		}

		let totalSize = 0;
		for (const file of files) {
			if (file.data.byteLength > this.#maxFileSizeBytes) {
				throw new MySoMessagingStackClientError(
					`File "${file.fileName}" is ${file.data.byteLength} bytes, exceeding the ${this.#maxFileSizeBytes} byte limit`,
				);
			}
			totalSize += file.data.byteLength;
		}

		if (totalSize > this.#maxTotalFileSizeBytes) {
			throw new MySoMessagingStackClientError(
				`Total file size ${totalSize} bytes exceeds the ${this.#maxTotalFileSizeBytes} byte limit`,
			);
		}
	}
}

// === Internal helper types ===

/** Extract encrypt options shape, minus `data` which we provide. */
type EncryptCallOptions<TApproveContext> = Parameters<
	EnvelopeEncryption<TApproveContext>['encrypt']
>[0];

/** Extract decrypt options shape, minus `envelope` which we provide. */
type DecryptCallOptions<TApproveContext> = Parameters<
	EnvelopeEncryption<TApproveContext>['decrypt']
>[0];
