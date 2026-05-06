// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock MyDataClient for unit tests.
 *
 * Only implements `encrypt()` and `decrypt()` — the two methods used by
 * DEKManager. The mock stores plaintext inside the BCS EncryptedObject's
 * ciphertext field so `decrypt()` can extract it without real threshold crypto.
 */

import type { MyDataClient } from '@socialproof/mydata';
import { EncryptedObject } from '@socialproof/mydata';

/**
 * Creates a mock MyDataClient that round-trips data through EncryptedObject BCS.
 *
 * - `encrypt()` serializes an EncryptedObject with the plaintext stored in the
 *   Aes256Gcm ciphertext blob.
 * - `decrypt()` parses the EncryptedObject and returns the ciphertext blob
 *   (which is the original plaintext).
 */
export function createMockMyDataClient(): MyDataClient {
	return {
		encrypt: async ({ packageId, id, data, threshold }) => {
			const encryptedObject = EncryptedObject.serialize({
				version: 0,
				packageId,
				id,
				services: [],
				threshold: threshold ?? 2,
				encryptedShares: {
					BonehFranklinBLS12381: {
						nonce: new Uint8Array(96),
						encryptedShares: [],
						encryptedRandomness: new Uint8Array(32),
					},
				},
				ciphertext: {
					Aes256Gcm: {
						blob: Array.from(data),
						aad: null,
					},
				},
			}).toBytes();

			return {
				encryptedObject,
				key: new Uint8Array(32),
			};
		},

		decrypt: async ({ data }) => {
			const parsed = EncryptedObject.parse(data);

			if (!('Aes256Gcm' in parsed.ciphertext)) {
				throw new Error('Mock MyDataClient only supports Aes256Gcm ciphertext');
			}

			return new Uint8Array(parsed.ciphertext.Aes256Gcm!.blob);
		},
	} as MyDataClient;
}

/**
 * Creates mock EncryptedObject bytes containing the given identity and plaintext.
 * Useful for tests that need pre-built encrypted DEK bytes.
 */
export function createMockEncryptedDekBytes(options: {
	packageId: string;
	identityHex: string;
	plaintext: Uint8Array;
}): Uint8Array {
	return EncryptedObject.serialize({
		version: 0,
		packageId: options.packageId,
		id: options.identityHex,
		services: [],
		threshold: 2,
		encryptedShares: {
			BonehFranklinBLS12381: {
				nonce: new Uint8Array(96),
				encryptedShares: [],
				encryptedRandomness: new Uint8Array(32),
			},
		},
		ciphertext: {
			Aes256Gcm: {
				blob: Array.from(options.plaintext),
				aad: null,
			},
		},
	}).toBytes();
}
