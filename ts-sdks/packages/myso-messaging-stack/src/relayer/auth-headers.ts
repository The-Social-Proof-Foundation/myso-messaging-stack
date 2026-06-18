// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { parseSerializedSignature } from '@socialproof/myso/cryptography';
import { toHex } from '@socialproof/myso/utils';

function extractRawSignature(serializedSignature: string): Uint8Array {
	const parsed = parseSerializedSignature(serializedSignature);
	if (!parsed.signature) {
		throw new Error(
			'Unsupported signature scheme: only keypair signatures (Ed25519, Secp256k1, Secp256r1) are supported',
		);
	}
	return parsed.signature;
}

function getPublicKeyHex(signer: Signer): string {
	return toHex(signer.getPublicKey().toMySoBytes());
}

export async function signAndCreateAuthHeaders(
	signer: Signer,
	messageBytes: Uint8Array,
): Promise<Record<string, string>> {
	const { signature } = await signer.signPersonalMessage(messageBytes);
	const rawSig = extractRawSignature(signature);
	return {
		'x-signature': toHex(rawSig),
		'x-public-key': getPublicKeyHex(signer),
	};
}

export async function createBodyAuth(
	signer: Signer,
	payload: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
	const timestamp = Math.floor(Date.now() / 1000);
	const body = {
		...payload,
		sender_address: signer.toMySoAddress(),
		timestamp,
	};
	const bodyStr = JSON.stringify(body);
	const bodyBytes = new TextEncoder().encode(bodyStr);
	const headers = await signAndCreateAuthHeaders(signer, bodyBytes);
	return { body, headers };
}

/** Header-based auth for GET/DELETE and WebSocket upgrade. */
export async function createHeaderAuth(
	signer: Signer,
	groupId: string,
): Promise<Record<string, string>> {
	const timestamp = Math.floor(Date.now() / 1000);
	const senderAddress = signer.toMySoAddress();
	const canonical = `${timestamp}:${senderAddress}:${groupId}`;
	const canonicalBytes = new TextEncoder().encode(canonical);
	const authHeaders = await signAndCreateAuthHeaders(signer, canonicalBytes);
	return {
		...authHeaders,
		'x-sender-address': senderAddress,
		'x-timestamp': timestamp.toString(),
		'x-group-id': groupId,
	};
}

export async function createWalletHeaderAuth(signer: Signer): Promise<Record<string, string>> {
	const timestamp = Math.floor(Date.now() / 1000);
	const senderAddress = signer.toMySoAddress();
	const canonical = `${timestamp}:${senderAddress}`;
	const canonicalBytes = new TextEncoder().encode(canonical);
	const authHeaders = await signAndCreateAuthHeaders(signer, canonicalBytes);
	return {
		...authHeaders,
		'x-sender-address': senderAddress,
		'x-timestamp': timestamp.toString(),
	};
}

/** Query-string auth for browser WebSocket connections (cannot set custom headers). */
export async function createWsAuthQuery(
	signer: Signer,
	groupId: string,
	afterOrder?: number,
): Promise<string> {
	const headers = await createHeaderAuth(signer, groupId);
	const params = new URLSearchParams({
		group_id: groupId,
		sender_address: headers['x-sender-address'],
		timestamp: headers['x-timestamp'],
		signature: headers['x-signature'],
		public_key: headers['x-public-key'],
	});
	if (afterOrder !== undefined) {
		params.set('after_order', String(afterOrder));
	}
	return params.toString();
}
