// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MyDataClient, SessionKey } from '@socialproof/mydata';
import { toHex } from '@socialproof/myso/utils';

import type { CryptoPrimitives } from './crypto-primitives.js';
import { getDefaultCryptoPrimitives } from './crypto-primitives.js';
import { DefaultMyDataPolicy, type MyDataPolicy } from './mydata-policy.js';

/** AES-256 key length in bytes. */
export const DEK_LENGTH = 32;

/** AES-GCM standard nonce length in bytes. */
export const NONCE_LENGTH = 12;

export interface DEKManagerConfig {
	mydataClient: MyDataClient;
	/** Only `packageId` is needed — identity bytes are always the standard format. */
	mydataPolicy: Pick<MyDataPolicy, 'packageId'>;
	cryptoPrimitives?: CryptoPrimitives;
	defaultThreshold?: number;
}

/** Result of generating a new DEK. */
export interface GeneratedDEK {
	/** The plaintext 32-byte data encryption key. */
	dek: Uint8Array;
	/** The MyData-encrypted DEK bytes (ready to store on-chain). */
	encryptedDek: Uint8Array;
	/** The identity bytes that were used for MyData encryption. */
	identityBytes: Uint8Array;
}

/**
 * Handles DEK generation and decryption via MyData threshold encryption.
 *
 * Identity bytes are always the standard format `[groupId][keyVersion]`
 * (via {@link DefaultMyDataPolicy.encodeIdentity}). Only `packageId` is taken
 * from the configured policy.
 *
 * This is an internal building block — use {@link EnvelopeEncryption} for the
 * top-level API.
 */
export class DEKManager {
	readonly #mydataClient: MyDataClient;
	readonly #mydataPolicy: Pick<MyDataPolicy, 'packageId'>;
	readonly #crypto: CryptoPrimitives;
	readonly #defaultThreshold: number;

	constructor(config: DEKManagerConfig) {
		this.#mydataClient = config.mydataClient;
		this.#mydataPolicy = config.mydataPolicy;
		this.#crypto = config.cryptoPrimitives ?? getDefaultCryptoPrimitives();
		this.#defaultThreshold = config.defaultThreshold ?? 2;
	}

	/** Generate an AES-256-GCM DEK and encrypt it with MyData. */
	async generateDEK(options: {
		groupId: string;
		keyVersion?: bigint;
		threshold?: number;
	}): Promise<GeneratedDEK> {
		const keyVersion = options.keyVersion ?? 0n;
		const identityBytes = DefaultMyDataPolicy.encodeIdentity(options.groupId, keyVersion);

		const dek = await this.#crypto.generateAesKey();

		const { encryptedObject } = await this.#mydataClient.encrypt({
			threshold: options.threshold ?? this.#defaultThreshold,
			packageId: this.#mydataPolicy.packageId,
			id: toHex(identityBytes),
			data: dek,
		});

		return { dek, encryptedDek: encryptedObject, identityBytes };
	}

	/** Decrypt a DEK from its MyData-encrypted bytes. */
	async decryptDEK(options: {
		encryptedDek: Uint8Array;
		sessionKey: SessionKey;
		txBytes: Uint8Array;
	}): Promise<Uint8Array> {
		return this.#mydataClient.decrypt({
			data: options.encryptedDek,
			sessionKey: options.sessionKey,
			txBytes: options.txBytes,
		});
	}
}
