// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content envelope v2 (CEv2). See docs/myso-messaging-stack/E2EE-Protocol-v2.md.
 *
 * `plaintext = 0x02 || u32_be(N) || json[N] || 0x00 * pad`, total length
 * `max(256, padme(5 + N))`. Must match iOS `MessagingContentEnvelope` byte-for-byte.
 */

export const CONTENT_ENVELOPE_VERSION = 0x02;
export const CONTENT_ENVELOPE_MIN_LENGTH = 256;
const HEADER_LENGTH = 5;

/** Attachment reference carried inside the envelope (replaces the relayer `attachments[]` column). */
export interface EnvelopeAttachment {
	/** Storage id of the encrypted file bytes. */
	id: string;
	/** Hex 32-byte random AES-256-GCM key for this file. */
	k: string;
	/** Hex 12-byte nonce. */
	n: string;
	name: string;
	mime: string;
	size: number;
	poster?: { id: string; k: string; n: string };
	dur?: number;
	w?: number;
	h?: number;
}

export type EnvelopeMessageType = 'text' | 'poll' | 'post' | 'token_transfer' | 'request_payment';

export type MessageEvent =
	| { type: 'reaction'; target: string; emoji: string; add: boolean }
	| { type: 'edit'; target: string; text: string; att?: EnvelopeAttachment[] }
	| { type: 'delete'; target: string }
	| { type: 'pin'; target: string; pinned: boolean }
	| { type: 'poll_vote'; target: string; options: number[] };

export type ContentEnvelope =
	| { t: EnvelopeMessageType; text: string; att?: EnvelopeAttachment[] }
	| { t: 'event'; e: MessageEvent };

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
	'text',
	'poll',
	'post',
	'token_transfer',
	'request_payment',
]);
const EVENT_TYPES: ReadonlySet<string> = new Set(['reaction', 'edit', 'delete', 'pin', 'poll_vote']);

/** Padmé: rounds `length` up so the padded size leaks O(log log L) bits with ≤ 12% overhead. */
export function padme(length: number): number {
	if (length <= 1) return length;
	const e = Math.floor(Math.log2(length));
	const s = Math.floor(Math.log2(e)) + 1;
	const lastBits = e - s;
	const mask = 2 ** lastBits - 1;
	// Plain arithmetic (not bitwise) so lengths past 2^31 stay correct.
	return Math.ceil(length / (mask + 1)) * (mask + 1);
}

/** Padded plaintext length for a JSON body of `jsonLength` bytes. */
export function paddedEnvelopeLength(jsonLength: number): number {
	return Math.max(CONTENT_ENVELOPE_MIN_LENGTH, padme(HEADER_LENGTH + jsonLength));
}

export function encodeContentEnvelope(envelope: ContentEnvelope): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(envelope));
	const out = new Uint8Array(paddedEnvelopeLength(json.length));
	out[0] = CONTENT_ENVELOPE_VERSION;
	new DataView(out.buffer).setUint32(1, json.length, false);
	out.set(json, HEADER_LENGTH);
	return out;
}

/**
 * Decode a CEv2 plaintext. Returns `null` for anything that is not a well-formed v2 envelope,
 * which callers treat as a v1 plaintext.
 */
export function decodeContentEnvelope(plaintext: Uint8Array): ContentEnvelope | null {
	if (plaintext.length < HEADER_LENGTH || plaintext[0] !== CONTENT_ENVELOPE_VERSION) return null;
	const jsonLength = new DataView(
		plaintext.buffer,
		plaintext.byteOffset,
		plaintext.byteLength,
	).getUint32(1, false);
	if (HEADER_LENGTH + jsonLength > plaintext.length) return null;
	if (plaintext.length !== paddedEnvelopeLength(jsonLength)) return null;
	for (let i = HEADER_LENGTH + jsonLength; i < plaintext.length; i++) {
		if (plaintext[i] !== 0) return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(
				plaintext.subarray(HEADER_LENGTH, HEADER_LENGTH + jsonLength),
			),
		);
	} catch {
		return null;
	}
	return validateEnvelope(parsed);
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function validateAttachments(raw: unknown): EnvelopeAttachment[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: EnvelopeAttachment[] = [];
	for (const a of raw) {
		if (!a || typeof a !== 'object') continue;
		const r = a as Record<string, unknown>;
		if (!isString(r.id) || !isString(r.k) || !isString(r.n)) continue;
		if (!/^[0-9a-f]{64}$/i.test(r.k) || !/^[0-9a-f]{24}$/i.test(r.n)) continue;
		const item: EnvelopeAttachment = {
			id: r.id,
			k: r.k.toLowerCase(),
			n: r.n.toLowerCase(),
			name: isString(r.name) ? r.name : 'file',
			mime: isString(r.mime) ? r.mime : 'application/octet-stream',
			size: typeof r.size === 'number' ? r.size : 0,
		};
		const p = r.poster as Record<string, unknown> | undefined;
		if (
			p &&
			isString(p.id) &&
			isString(p.k) &&
			isString(p.n) &&
			/^[0-9a-f]{64}$/i.test(p.k) &&
			/^[0-9a-f]{24}$/i.test(p.n)
		) {
			item.poster = { id: p.id, k: p.k.toLowerCase(), n: p.n.toLowerCase() };
		}
		if (typeof r.dur === 'number') item.dur = r.dur;
		if (typeof r.w === 'number') item.w = r.w;
		if (typeof r.h === 'number') item.h = r.h;
		out.push(item);
	}
	return out;
}

function validateEvent(raw: unknown): MessageEvent | null {
	if (!raw || typeof raw !== 'object') return null;
	const e = raw as Record<string, unknown>;
	if (!isString(e.type) || !EVENT_TYPES.has(e.type) || !isString(e.target)) return null;
	switch (e.type) {
		case 'reaction':
			if (!isString(e.emoji) || typeof e.add !== 'boolean') return null;
			return { type: 'reaction', target: e.target, emoji: e.emoji.normalize('NFC'), add: e.add };
		case 'edit': {
			if (!isString(e.text)) return null;
			const att = validateAttachments(e.att);
			return { type: 'edit', target: e.target, text: e.text, ...(att ? { att } : {}) };
		}
		case 'delete':
			return { type: 'delete', target: e.target };
		case 'pin':
			if (typeof e.pinned !== 'boolean') return null;
			return { type: 'pin', target: e.target, pinned: e.pinned };
		case 'poll_vote':
			if (!Array.isArray(e.options) || !e.options.every((o) => Number.isInteger(o))) return null;
			return { type: 'poll_vote', target: e.target, options: e.options as number[] };
	}
	return null;
}

function validateEnvelope(raw: unknown): ContentEnvelope | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (r.t === 'event') {
		const e = validateEvent(r.e);
		return e ? { t: 'event', e } : null;
	}
	if (!isString(r.t) || !MESSAGE_TYPES.has(r.t)) return null;
	const att = validateAttachments(r.att);
	return {
		t: r.t as EnvelopeMessageType,
		text: isString(r.text) ? r.text : '',
		...(att && att.length > 0 ? { att } : {}),
	};
}

/** Relayer row kind for an envelope: inner types are hidden behind `message` / `event`. */
export function relayerKindForEnvelope(
	envelope: ContentEnvelope,
): 'message' | 'event' | 'post' | 'token_transfer' | 'request_payment' {
	switch (envelope.t) {
		case 'event':
			return 'event';
		case 'post':
		case 'token_transfer':
		case 'request_payment':
			return envelope.t;
		default:
			return 'message';
	}
}
