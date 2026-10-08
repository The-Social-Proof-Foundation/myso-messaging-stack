// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MessageKind, PaymentAssetKind } from './relayer/types.js';

/**
 * Chat payments exist only in 1:1 DMs. The encrypted message body is a JSON payload; the
 * relayer only sees the cleartext {@link PaymentMetadata} (digest, status, counterpart).
 */

/** Asset reference carried inside the encrypted payload (display + settlement info). */
export interface PaymentAssetRef {
	kind: PaymentAssetKind;
	/** Native: coin type (e.g. MYSO). SPT: pool / token object id. */
	id: string;
	symbol: string;
	name?: string;
	/** Decimals used to render `amount` (base units). */
	decimals: number;
	iconUrl?: string;
}

/** Encrypted body of a `token_transfer` message. */
export interface TokenTransferPayload {
	v: 1;
	/** Amount in base units, as a decimal string (bigint-safe). */
	amount: string;
	asset: PaymentAssetRef;
	/** Recipient address (the DM counterpart). */
	to: string;
	note?: string;
}

/** Encrypted body of a `request_payment` message. */
export interface PaymentRequestPayload {
	v: 1;
	/** Requested amount in base units, as a decimal string. */
	amount: string;
	asset: PaymentAssetRef;
	description?: string;
}

export type PaymentPayload = TokenTransferPayload | PaymentRequestPayload;

/**
 * `to` is required on a token transfer and absent on a payment request, so it is
 * the discriminant for narrowing a stored body. Use these instead of testing for
 * the optional `note` / `description` fields, which may simply be undefined.
 */
export function isTokenTransferPayload(
	payload: PaymentPayload,
): payload is TokenTransferPayload {
	return 'to' in payload && typeof payload.to === 'string';
}

export function isPaymentRequestPayload(
	payload: PaymentPayload,
): payload is PaymentRequestPayload {
	return !isTokenTransferPayload(payload);
}

/** Optional free-text line for a payment body: a request's description or a transfer's note. */
export function paymentPayloadNote(payload: PaymentPayload): string | undefined {
	return isPaymentRequestPayload(payload) ? payload.description : payload.note;
}

function isAssetRef(raw: unknown): raw is PaymentAssetRef {
	if (!raw || typeof raw !== 'object') return false;
	const a = raw as Record<string, unknown>;
	return (
		(a.kind === 'native' || a.kind === 'spt') &&
		typeof a.id === 'string' &&
		typeof a.symbol === 'string' &&
		typeof a.decimals === 'number'
	);
}

function isBaseUnitAmount(raw: unknown): raw is string {
	return typeof raw === 'string' && /^[0-9]+$/.test(raw) && raw !== '0';
}

/** Serialize a transfer payload for encryption. Throws on invalid input. */
export function encodeTokenTransferPayload(payload: TokenTransferPayload): string {
	if (!isBaseUnitAmount(payload.amount)) {
		throw new Error('amount must be a positive base-unit integer string');
	}
	if (!isAssetRef(payload.asset)) throw new Error('asset is invalid');
	if (!payload.to) throw new Error('to is required');
	return JSON.stringify(payload);
}

/** Serialize a request payload for encryption. Throws on invalid input. */
export function encodePaymentRequestPayload(payload: PaymentRequestPayload): string {
	if (!isBaseUnitAmount(payload.amount)) {
		throw new Error('amount must be a positive base-unit integer string');
	}
	if (!isAssetRef(payload.asset)) throw new Error('asset is invalid');
	return JSON.stringify(payload);
}

/**
 * Parse a decrypted payment body. Returns `undefined` for non-payment kinds or malformed
 * payloads (callers fall back to a generic "payment" bubble).
 */
export function parsePaymentPayload(kind: MessageKind, text: string): PaymentPayload | undefined {
	if (kind !== 'token_transfer' && kind !== 'request_payment') return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const p = raw as Record<string, unknown>;
	if (p.v !== 1 || !isBaseUnitAmount(p.amount) || !isAssetRef(p.asset)) return undefined;
	if (kind === 'token_transfer') {
		if (typeof p.to !== 'string' || !p.to) return undefined;
		return {
			v: 1,
			amount: p.amount,
			asset: p.asset,
			to: p.to,
			note: typeof p.note === 'string' ? p.note : undefined,
		};
	}
	return {
		v: 1,
		amount: p.amount,
		asset: p.asset,
		description: typeof p.description === 'string' ? p.description : undefined,
	};
}
