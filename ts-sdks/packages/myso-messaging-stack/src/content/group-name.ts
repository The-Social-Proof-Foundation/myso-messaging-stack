// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypted group names (E2EE M2).
 *
 * On-chain `Metadata.name` is public, so v2 groups store `enc:v1:<keyVersion>:<base64(nonce||ct||tag)>`
 * instead: the name is UTF-8, zero-padded to {@link GROUP_NAME_PADDED_BYTES} (every name has the same
 * ciphertext length), sealed with the group DEK at `keyVersion` and AAD `myso-group-name-v1:<groupId>`.
 * The result is at most 128 bytes, the on-chain limit. Must match iOS `MessagingGroupName`.
 */

export const GROUP_NAME_PREFIX = 'enc:v1:';
/** Max plaintext bytes; names are padded to exactly this length. */
export const GROUP_NAME_PADDED_BYTES = 59;

export function isEncryptedGroupName(name: string): boolean {
	return name.startsWith(GROUP_NAME_PREFIX);
}

export function groupNameAad(groupId: string): Uint8Array {
	return new TextEncoder().encode(`myso-group-name-v1:${groupId.toLowerCase()}`);
}

/** UTF-8 encode and zero-pad; throws when the name doesn't fit. */
export function padGroupName(name: string): Uint8Array {
	const bytes = new TextEncoder().encode(name.normalize('NFC'));
	if (bytes.length > GROUP_NAME_PADDED_BYTES) {
		throw new Error(`Group name is ${bytes.length} bytes; encrypted names allow ${GROUP_NAME_PADDED_BYTES}`);
	}
	const out = new Uint8Array(GROUP_NAME_PADDED_BYTES);
	out.set(bytes);
	return out;
}

export function unpadGroupName(padded: Uint8Array): string {
	let end = padded.length;
	while (end > 0 && padded[end - 1] === 0) end--;
	return new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(0, end));
}

export function formatEncryptedGroupName(keyVersion: bigint, nonce: Uint8Array, ciphertext: Uint8Array): string {
	const sealed = new Uint8Array(nonce.length + ciphertext.length);
	sealed.set(nonce);
	sealed.set(ciphertext, nonce.length);
	return `${GROUP_NAME_PREFIX}${keyVersion}:${toBase64(sealed)}`;
}

export function parseEncryptedGroupName(
	name: string,
): { keyVersion: bigint; nonce: Uint8Array; ciphertext: Uint8Array } | null {
	if (!isEncryptedGroupName(name)) return null;
	const rest = name.slice(GROUP_NAME_PREFIX.length);
	const sep = rest.indexOf(':');
	if (sep <= 0) return null;
	const version = rest.slice(0, sep);
	if (!/^\d+$/.test(version)) return null;
	let sealed: Uint8Array;
	try {
		sealed = fromBase64(rest.slice(sep + 1));
	} catch {
		return null;
	}
	if (sealed.length !== 12 + GROUP_NAME_PADDED_BYTES + 16) return null;
	return { keyVersion: BigInt(version), nonce: sealed.subarray(0, 12), ciphertext: sealed.subarray(12) };
}

function toBase64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function fromBase64(text: string): Uint8Array {
	const s = atob(text);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}
