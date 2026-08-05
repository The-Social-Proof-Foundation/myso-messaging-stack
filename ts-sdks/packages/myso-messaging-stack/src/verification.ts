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
 * Relayer `normalize_shared_post_address`: lowercase `0x` + left-pad to 64 hex.
 * Returns `null` when the value is not a valid on-chain object id.
 */
export function normalizeSharedPostAddress(raw?: string | null): string | null {
	const trimmed = (raw ?? '').trim().toLowerCase();
	if (!trimmed.startsWith('0x')) return null;
	const hex = trimmed.slice(2);
	if (!hex || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) return null;
	return `0x${hex.padStart(64, '0')}`;
}

/**
 * Build the canonical message bytes that are signed per-message.
 *
 * Default: `"{groupId}:{kind}:{hex(encryptedText)}:{hex(nonce)}:{keyVersion}"`
 * `kind === 'post'`:
 * `"{groupId}:post:{sharedPostAddress}:{idempotencyKey}:{hex(encryptedText)}:{hex(nonce)}:{keyVersion}"`
 *
 * `groupId` is lowercased. Post addresses are padded like the relayer verify path.
 */
export function buildCanonicalMessage(params: {
	groupId: string;
	kind?: string;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
	sharedPostAddress?: string;
	idempotencyKey?: string;
}): Uint8Array {
	const kind = params.kind ?? 'text';
	const groupId = params.groupId.toLowerCase();
	let canonical: string;
	if (kind === 'post') {
		const post =
			normalizeSharedPostAddress(params.sharedPostAddress) ??
			(params.sharedPostAddress ?? '').trim().toLowerCase();
		const idem = (params.idempotencyKey ?? '').trim();
		canonical = `${groupId}:${kind}:${post}:${idem}:${toHex(params.encryptedText)}:${toHex(params.nonce)}:${params.keyVersion}`;
	} else {
		canonical = `${groupId}:${kind}:${toHex(params.encryptedText)}:${toHex(params.nonce)}:${params.keyVersion}`;
	}
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
		kind?: string;
		encryptedText: Uint8Array;
		nonce: Uint8Array;
		keyVersion: bigint;
		sharedPostAddress?: string;
		idempotencyKey?: string;
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
	kind?: string;
	encryptedText: Uint8Array;
	nonce: Uint8Array;
	keyVersion: bigint;
	senderAddress: string;
	/** Hex-encoded 64-byte raw signature. */
	signature: string;
	/** Hex-encoded public key with scheme flag prefix (as returned by the relayer). */
	publicKey: string;
	sharedPostAddress?: string;
	idempotencyKey?: string;
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
