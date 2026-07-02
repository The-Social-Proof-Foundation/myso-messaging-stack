// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { decodeMySoPrivateKey } from '@socialproof/myso/cryptography';

import type { CryptoPrimitives } from '../encryption/crypto-primitives.js';
import { getDefaultCryptoPrimitives } from '../encryption/crypto-primitives.js';
import type { UserReadState } from './types.js';

const READ_STATE_INFO = new TextEncoder().encode('myso-messaging-read-state-v1');

function getSignerSeed(signer: Signer): Uint8Array {
	if ('getSecretKey' in signer && typeof signer.getSecretKey === 'function') {
		const secret = (signer as { getSecretKey(): string | Uint8Array }).getSecretKey();
		// Keypair signers return the Bech32 `mysoprivkey...` string — decode to
		// the raw 32-byte seed for HKDF. (Passing the string to Web Crypto was
		// a silent-failure bug: every read-state write threw at encrypt time.)
		if (typeof secret === 'string') {
			return decodeMySoPrivateKey(secret).secretKey;
		}
		return secret;
	}
	throw new Error('Read state encryption requires a keypair signer with getSecretKey()');
}

async function deriveReadStateKey(signer: Signer): Promise<Uint8Array> {
	const seed = getSignerSeed(signer);
	if (typeof globalThis.crypto?.subtle?.importKey !== 'function') {
		throw new Error('Web Crypto HKDF is required for read-state encryption');
	}
	const baseKey = await globalThis.crypto.subtle.importKey(
		'raw',
		seed as Uint8Array<ArrayBuffer>,
		'HKDF',
		false,
		['deriveBits'],
	);
	const bits = await globalThis.crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: READ_STATE_INFO,
		},
		baseKey,
		256,
	);
	return new Uint8Array(bits);
}

export async function encryptReadState(
	signer: Signer,
	state: UserReadState,
	cryptoPrimitives: CryptoPrimitives = getDefaultCryptoPrimitives(),
): Promise<Uint8Array> {
	const key = await deriveReadStateKey(signer);
	const nonce = cryptoPrimitives.generateRandomBytes(12);
	const plaintext = new TextEncoder().encode(JSON.stringify(state));
	const ciphertext = await cryptoPrimitives.aesGcmEncrypt(key, plaintext, nonce);
	const blob = new Uint8Array(nonce.length + ciphertext.length);
	blob.set(nonce, 0);
	blob.set(ciphertext, nonce.length);
	return blob;
}

export async function decryptReadState(
	signer: Signer,
	blob: Uint8Array,
	cryptoPrimitives: CryptoPrimitives = getDefaultCryptoPrimitives(),
): Promise<UserReadState> {
	const key = await deriveReadStateKey(signer);
	const nonce = blob.slice(0, 12);
	const ciphertext = blob.slice(12);
	const plaintext = await cryptoPrimitives.aesGcmDecrypt(key, ciphertext, nonce);
	return JSON.parse(new TextDecoder().decode(plaintext)) as UserReadState;
}
