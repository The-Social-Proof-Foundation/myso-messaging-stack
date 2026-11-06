// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { fromHex, toHex } from '@socialproof/myso/utils';

import {
	buildAttachmentAad,
	type AttachmentAadRole,
	type EnvelopeEncryption,
} from '../encryption/envelope-encryption.js';
import { EncryptionAccessDeniedError, MySoMessagingStackClientError } from '../error.js';
import type { EnvelopeAttachment } from '../content/envelope.js';
import { getDefaultCryptoPrimitives } from '../encryption/crypto-primitives.js';
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
 * Context an attachment ciphertext is bound to (attachment AAD v1). Must be the parent
 * message's key version and sender, or the receiver's reconstruction will not match.
 */
/** AAD for content-envelope-v2 file bytes (each file has its own random key). */
const FILE_V2_AAD = new TextEncoder().encode('myso-file-v2');

export interface AttachmentAadBinding {
	groupId: string;
	keyVersion: bigint;
	senderAddress: string;
}

/**
 * Orchestrates encrypting, uploading, downloading, and decrypting attachments.
 *
 * When an {@link AttachmentAadBinding} is given, file bytes and metadata are sealed with
 * attachment AAD v1 (see `buildAttachmentAad`). Resolve tries v1 first and falls back to
 * legacy no-AAD ciphertexts; whichever mode the metadata opens under is the only mode
 * used for the file bytes, so a re-posted blob can't decrypt under someone else's message.
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
		binding?: AttachmentAadBinding,
	): Promise<Attachment[]> {
		this.#validateFiles(files);
		const aadFor = (role: AttachmentAadRole) =>
			binding ? buildAttachmentAad({ ...binding, role }) : undefined;
		// Bound ciphertexts must be sealed under the same key version the AAD names.
		const versionOption = binding ? { keyVersion: binding.keyVersion } : {};

		// 1. Encrypt each file individually.
		const encryptedEntries: {
			data: Uint8Array;
			nonce: Uint8Array;
		}[] = [];
		for (const file of files) {
			const envelope = await this.#encryption.encrypt({
				...groupRef,
				...encryptOptions,
				...versionOption,
				data: file.data,
				aad: aadFor('data'),
			} as Parameters<EnvelopeEncryption<TApproveContext>['encrypt']>[0]);
			encryptedEntries.push({
				data: envelope.ciphertext,
				nonce: envelope.nonce,
			});
		}

		// 2. Upload all encrypted files as a batch.
		const uploadResult = await this.#storageAdapter.upload(
			encryptedEntries.map((e, i) => ({ name: files[i].fileName, data: e.data })),
			{ groupRef },
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
				...versionOption,
				data: metadataBytes,
				aad: aadFor('meta'),
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
		binding?: { groupId: string; senderAddress: string },
	): Promise<AttachmentHandle[]> {
		const handles: AttachmentHandle[] = [];
		const aadFor = (role: AttachmentAadRole) =>
			binding ? buildAttachmentAad({ ...binding, keyVersion, role }) : undefined;

		for (const attachment of attachments) {
			const metaEnvelope = {
				ciphertext: fromHex(attachment.encryptedMetadata),
				nonce: fromHex(attachment.metadataNonce),
				keyVersion,
			};
			const decryptMeta = (aad: Uint8Array | undefined) =>
				this.#encryption.decrypt({
					...groupRef,
					...decryptOptions,
					envelope: { ...metaEnvelope, aad },
				} as Parameters<EnvelopeEncryption<TApproveContext>['decrypt']>[0]);

			let metadataBytes: Uint8Array;
			let aadBound = false;
			const metaAad = aadFor('meta');
			if (metaAad) {
				try {
					metadataBytes = await decryptMeta(metaAad);
					aadBound = true;
				} catch (error) {
					// Access errors are not an AAD mismatch; retrying without AAD can't help.
					if (error instanceof EncryptionAccessDeniedError) throw error;
					metadataBytes = await decryptMeta(undefined);
				}
			} else {
				metadataBytes = await decryptMeta(undefined);
			}

			const metadata: AttachmentMetadata = JSON.parse(new TextDecoder().decode(metadataBytes));
			const dataAad = aadBound ? aadFor('data') : undefined;

			handles.push({
				fileName: metadata.fileName,
				mimeType: metadata.mimeType,
				fileSize: metadata.fileSize,
				extras: metadata.extras,
				wire: attachment,
				aadBound,
				data: async () => {
					const encrypted = await this.#storageAdapter.download(attachment.storageId);
					return this.#encryption.decrypt({
						...groupRef,
						...decryptOptions,
						envelope: {
							ciphertext: encrypted,
							nonce: fromHex(attachment.nonce),
							keyVersion,
							aad: dataAad,
						},
					} as Parameters<EnvelopeEncryption<TApproveContext>['decrypt']>[0]);
				},
			});
		}

		return handles;
	}

	/**
	 * Content envelope v2 upload: each file gets a fresh random AES-256-GCM key; the key and
	 * nonce travel only inside the (encrypted) envelope, never in a relayer column.
	 */
	async uploadV2(files: AttachmentFile[], groupRef: GroupRef): Promise<EnvelopeAttachment[]> {
		this.#validateFiles(files);
		const crypto = getDefaultCryptoPrimitives();
		const sealed: { key: Uint8Array; nonce: Uint8Array; data: Uint8Array }[] = [];
		for (const file of files) {
			const key = crypto.generateRandomBytes(32);
			const nonce = crypto.generateRandomBytes(12);
			const data = await crypto.aesGcmEncrypt(key, file.data, nonce, FILE_V2_AAD);
			sealed.push({ key, nonce, data });
		}
		const uploadResult = await this.#storageAdapter.upload(
			// Opaque names: the storage backend must not learn file names.
			sealed.map((e, i) => ({ name: `f${i}`, data: e.data })),
			{ groupRef },
		);
		return files.map((file, i) => ({
			id: uploadResult.ids[i]!,
			k: toHex(sealed[i]!.key),
			n: toHex(sealed[i]!.nonce),
			name: file.fileName,
			mime: file.mimeType,
			size: file.data.byteLength,
		}));
	}

	/** Lazy handles for v2 envelope attachments (integrity follows the envelope's signature). */
	resolveV2(refs: EnvelopeAttachment[]): AttachmentHandle[] {
		const crypto = getDefaultCryptoPrimitives();
		return refs.map((ref) => ({
			fileName: ref.name,
			mimeType: ref.mime,
			fileSize: ref.size,
			extras: {
				...(ref.poster ? { poster: ref.poster } : {}),
				...(ref.dur !== undefined ? { durationMs: ref.dur } : {}),
				...(ref.w !== undefined ? { width: ref.w } : {}),
				...(ref.h !== undefined ? { height: ref.h } : {}),
			},
			wire: { storageId: ref.id, nonce: ref.n, encryptedMetadata: '', metadataNonce: '' },
			aadBound: true,
			data: async () => {
				const encrypted = await this.#storageAdapter.download(ref.id);
				return crypto.aesGcmDecrypt(fromHex(ref.k), encrypted, fromHex(ref.n), FILE_V2_AAD);
			},
		}));
	}

	/** Download + decrypt a v2 poster (or any `{id, k, n}` blob reference). */
	async downloadV2Blob(ref: { id: string; k: string; n: string }): Promise<Uint8Array> {
		const encrypted = await this.#storageAdapter.download(ref.id);
		return getDefaultCryptoPrimitives().aesGcmDecrypt(
			fromHex(ref.k),
			encrypted,
			fromHex(ref.n),
			FILE_V2_AAD,
		);
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
