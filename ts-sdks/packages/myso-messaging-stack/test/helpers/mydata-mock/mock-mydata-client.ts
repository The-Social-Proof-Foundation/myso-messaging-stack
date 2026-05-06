// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Enhanced mock MyDataClient for integration tests.
 *
 * Extends the unit-test mock pattern (storing plaintext DEK inside the
 * EncryptedObject BCS ciphertext field) with **mydata_approve dry-run validation**
 * on decrypt. This validates:
 *
 * - On-chain access control (`mydata_approve_reader` checks MessagingReader permission)
 * - Identity bytes encoding correctness
 * - Key version existence in EncryptionHistory
 *
 * **Accepted tradeoff:** We trust `@socialproof/mydata` for BLS12381/Shamir/ElGamal
 * crypto correctness (covered by their own tests). Integration with real MyData
 * key servers is validated via testnet tests separately.
 */

import type { MyDataClient } from '@socialproof/mydata';
import { EncryptedObject } from '@socialproof/mydata';
import { Transaction } from '@socialproof/myso/transactions';

import type { MockMyDataClientOptions } from './types.js';

/**
 * Creates an enhanced mock MyDataClient that:
 * - `encrypt()`: Stores plaintext DEK in a valid EncryptedObject BCS structure
 * - `decrypt()`: Dry-runs the mydata_approve transaction on localnet to validate
 *   access control, then returns the plaintext DEK from BCS
 */
export function createMockMyDataClient(options: MockMyDataClientOptions): MyDataClient {
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

		decrypt: async ({ data, sessionKey, txBytes }) => {
			// 1. Parse the EncryptedObject to extract plaintext
			const parsed = EncryptedObject.parse(data);

			if (!('Aes256Gcm' in parsed.ciphertext)) {
				throw new Error('Mock MyDataClient only supports Aes256Gcm ciphertext');
			}

			// 2. Dry-run the mydata_approve transaction to validate access control.
			//    txBytes are TransactionKind bytes (built with onlyTransactionKind: true).
			//    We reconstruct a full transaction for simulation.
			const tx = Transaction.fromKind(txBytes);
			const senderAddress = sessionKey.getAddress();
			tx.setSender(senderAddress);

			const result = await options.mysoClient.core.simulateTransaction({
				transaction: tx,
			});

			// Check if simulation succeeded
			if (result.$kind === 'FailedTransaction') {
				const error = result.FailedTransaction?.status?.error;
				const message = error?.message ?? JSON.stringify(error) ?? 'unknown error';
				throw new Error(`mydata_approve dry-run failed: ${message}`);
			}

			// 3. Access granted — return the plaintext DEK
			return new Uint8Array(parsed.ciphertext.Aes256Gcm!.blob);
		},
	} as MyDataClient;
}
