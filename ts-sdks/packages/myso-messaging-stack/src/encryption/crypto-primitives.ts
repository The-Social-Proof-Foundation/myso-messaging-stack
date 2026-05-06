// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pluggable interface for symmetric crypto operations.
 *
 * The default {@link WebCryptoPrimitives} implementation uses the Web Crypto API
 * (`globalThis.crypto`), which is available in modern browsers and Node.js 20+.
 * Provide a custom implementation for environments without Web Crypto support.
 */
export interface CryptoPrimitives {
	/** Generate cryptographically random bytes of the given length. */
	generateRandomBytes(length: number): Uint8Array;

	/** Generate a cryptographically random UUID v4. */
	generateUUID(): string;

	/** Generate an AES-256-GCM key, returned as raw bytes. */
	generateAesKey(): Promise<Uint8Array>;

	/** AES-256-GCM encrypt. Returns ciphertext with 16-byte auth tag appended. */
	aesGcmEncrypt(
		key: Uint8Array,
		plaintext: Uint8Array,
		nonce: Uint8Array,
		aad?: Uint8Array,
	): Promise<Uint8Array>;

	/** AES-256-GCM decrypt. Throws on authentication failure. */
	aesGcmDecrypt(
		key: Uint8Array,
		ciphertext: Uint8Array,
		nonce: Uint8Array,
		aad?: Uint8Array,
	): Promise<Uint8Array>;
}

/** Default {@link CryptoPrimitives} backed by the Web Crypto API. */
export class WebCryptoPrimitives implements CryptoPrimitives {
	#crypto: Crypto;

	constructor() {
		if (typeof globalThis.crypto === 'undefined') {
			throw new Error(
				'Web Crypto API not available. Provide a custom CryptoPrimitives implementation.',
			);
		}
		this.#crypto = globalThis.crypto;
	}

	generateRandomBytes(length: number): Uint8Array {
		return this.#crypto.getRandomValues(new Uint8Array(length));
	}

	generateUUID(): string {
		return this.#crypto.randomUUID();
	}

	async generateAesKey(): Promise<Uint8Array> {
		const key = await this.#crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
			'encrypt',
			'decrypt',
		]);
		const raw = await this.#crypto.subtle.exportKey('raw', key);
		return new Uint8Array(raw);
	}

	async aesGcmEncrypt(
		key: Uint8Array,
		plaintext: Uint8Array,
		nonce: Uint8Array,
		aad?: Uint8Array,
	): Promise<Uint8Array> {
		const cryptoKey = await this.#crypto.subtle.importKey(
			'raw',
			key as Uint8Array<ArrayBuffer>,
			{ name: 'AES-GCM' },
			false,
			['encrypt'],
		);
		const params: AesGcmParams = {
			name: 'AES-GCM',
			iv: nonce as Uint8Array<ArrayBuffer>,
			tagLength: 128,
		};
		if (aad) params.additionalData = aad as Uint8Array<ArrayBuffer>;
		const ciphertext = await this.#crypto.subtle.encrypt(
			params,
			cryptoKey,
			plaintext as Uint8Array<ArrayBuffer>,
		);
		return new Uint8Array(ciphertext);
	}

	async aesGcmDecrypt(
		key: Uint8Array,
		ciphertext: Uint8Array,
		nonce: Uint8Array,
		aad?: Uint8Array,
	): Promise<Uint8Array> {
		const cryptoKey = await this.#crypto.subtle.importKey(
			'raw',
			key as Uint8Array<ArrayBuffer>,
			{ name: 'AES-GCM' },
			false,
			['decrypt'],
		);
		const params: AesGcmParams = {
			name: 'AES-GCM',
			iv: nonce as Uint8Array<ArrayBuffer>,
			tagLength: 128,
		};
		if (aad) params.additionalData = aad as Uint8Array<ArrayBuffer>;
		const plaintext = await this.#crypto.subtle.decrypt(
			params,
			cryptoKey,
			ciphertext as Uint8Array<ArrayBuffer>,
		);
		return new Uint8Array(plaintext);
	}
}

let defaultPrimitives: CryptoPrimitives | undefined;

/** Returns a lazily-initialized singleton {@link WebCryptoPrimitives}. */
export function getDefaultCryptoPrimitives(): CryptoPrimitives {
	defaultPrimitives ??= new WebCryptoPrimitives();
	return defaultPrimitives;
}
