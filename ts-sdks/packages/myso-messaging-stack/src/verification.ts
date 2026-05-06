// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import {
	parseSerializedSignature,
	SIGNATURE_FLAG_TO_SCHEME,
	toSerializedSignature,
} from '@socialproof/myso/cryptography';
import { fromHex, toHex } from '@socialproof/myso/utils';
import { publicKeyFromMySoBytes, verifyPersonalMessageSignature } from '@socialproof/myso/verify';

// ── Canonical message ────────────────────────────────────────────

/**
 * Build the canonical message bytes that are signed per-message.
 *
 * Format: `"{groupId}:{hex(encryptedText)}:{hex(nonce)}:{keyVersion}"`
 *
 * This matches the relayer's `verify_message_signature` canonical string.
 */
export function buildCanonicalMessage(params: {
	groupId: string;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
}): Uint8Array {
	const canonical = `${params.groupId}:${toHex(params.encryptedText)}:${toHex(params.nonce)}:${params.keyVersion}`;
	return new TextEncoder().encode(canonical);
}

// ── Signing ──────────────────────────────────────────────────────

/**
 * Sign the per-message canonical content.
 * Returns the raw 64-byte signature as a hex string.
 */
export async function signMessageContent(
	signer: Signer,
	params: {
		groupId: string;
		encryptedText: Uint8Array;
		nonce: Uint8Array;
		keyVersion: bigint;
	},
): Promise<string> {
	const canonicalBytes = buildCanonicalMessage(params);
	const { signature } = await signer.signPersonalMessage(canonicalBytes);
	const parsed = parseSerializedSignature(signature);
	if (!parsed.signature) {
		throw new Error(
			'Unsupported signature scheme: only keypair signatures (Ed25519, Secp256k1, Secp256r1) are supported',
		);
	}
	return toHex(parsed.signature);
}

// ── Verification ─────────────────────────────────────────────────

export interface VerifyMessageSenderParams {
	groupId: string;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
	senderAddress: string;
	/** Hex-encoded 64-byte raw signature. */
	signature: string;
	/** Hex-encoded public key with scheme flag prefix (as returned by the relayer). */
	publicKey: string;
}

/**
 * Verify that a message was signed by the claimed sender.
 *
 * Reconstructs the canonical message from the ciphertext fields,
 * rebuilds the serialized signature from the stored raw components,
 * then verifies using `verifyPersonalMessageSignature`.
 *
 * @returns `true` if the signature is valid and the derived address matches `senderAddress`.
 */
export async function verifyMessageSender(params: VerifyMessageSenderParams): Promise<boolean> {
	try {
		const canonicalBytes = buildCanonicalMessage(params);

		// Reconstruct the serialized signature from raw components.
		const rawSig = fromHex(params.signature);
		const pubKeyBytes = fromHex(params.publicKey);

		// First byte is the scheme flag.
		const flag = pubKeyBytes[0] as keyof typeof SIGNATURE_FLAG_TO_SCHEME;
		const signatureScheme = SIGNATURE_FLAG_TO_SCHEME[flag];
		if (!signatureScheme) return false;

		const publicKey = publicKeyFromMySoBytes(pubKeyBytes);

		const serializedSignature = toSerializedSignature({
			signatureScheme,
			signature: rawSig,
			publicKey,
		});

		// Verify the signature and check the derived address matches.
		const verifiedKey = await verifyPersonalMessageSignature(canonicalBytes, serializedSignature);
		return verifiedKey.toMySoAddress() === params.senderAddress;
	} catch {
		return false;
	}
}
