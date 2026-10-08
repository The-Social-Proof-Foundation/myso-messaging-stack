// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
	encodePaymentRequestPayload,
	encodeTokenTransferPayload,
	parsePaymentPayload,
	type PaymentAssetRef,
} from '../../src/payments.js';
import { fromWireMessage, parsePaymentMetadata, type WireMessageResponse } from '../../src/relayer/wire.js';

const MYSO: PaymentAssetRef = { kind: 'native', id: '0x2::myso::MYSO', symbol: 'MYSO', decimals: 9 };

describe('payment payloads', () => {
	it('round-trips a token transfer payload', () => {
		const text = encodeTokenTransferPayload({
			v: 1,
			amount: '1500000000',
			asset: MYSO,
			to: '0xdef',
			note: 'lunch',
		});
		expect(parsePaymentPayload('token_transfer', text)).toEqual({
			v: 1,
			amount: '1500000000',
			asset: MYSO,
			to: '0xdef',
			note: 'lunch',
		});
	});

	it('round-trips a payment request payload', () => {
		const text = encodePaymentRequestPayload({
			v: 1,
			amount: '42',
			asset: MYSO,
			description: 'split dinner',
		});
		expect(parsePaymentPayload('request_payment', text)).toEqual({
			v: 1,
			amount: '42',
			asset: MYSO,
			description: 'split dinner',
		});
	});

	it('rejects invalid amounts on encode and ignores them on parse', () => {
		for (const amount of ['0', '-1', '1.5', '', 'abc']) {
			expect(() => encodePaymentRequestPayload({ v: 1, amount, asset: MYSO })).toThrow();
			expect(
				parsePaymentPayload('request_payment', JSON.stringify({ v: 1, amount, asset: MYSO })),
			).toBeUndefined();
		}
	});

	it('returns undefined for non-payment kinds and malformed JSON', () => {
		expect(parsePaymentPayload('text', '{"v":1}')).toBeUndefined();
		expect(parsePaymentPayload('token_transfer', 'not json')).toBeUndefined();
		expect(parsePaymentPayload('token_transfer', JSON.stringify({ v: 1, amount: '1', asset: MYSO }))).toBeUndefined();
	});
});

describe('payment metadata wire parsing', () => {
	it('parses token_transfer metadata', () => {
		expect(
			parsePaymentMetadata('token_transfer', {
				digest: '5Hs8kmZjK9v7E2f1cQ3tYpLwNx4RbUaVd6GhTeJ8CqMn',
				asset_kind: 'spt',
				status: 'failed',
				to: '0xdef',
				reason: 'chain_failed',
				request_message_id: 'req-1',
			}),
		).toEqual({
			type: 'token_transfer',
			digest: '5Hs8kmZjK9v7E2f1cQ3tYpLwNx4RbUaVd6GhTeJ8CqMn',
			assetKind: 'spt',
			status: 'failed',
			to: '0xdef',
			requestMessageId: 'req-1',
			reason: 'chain_failed',
		});
	});

	it('parses request_payment metadata including settlement link', () => {
		expect(
			parsePaymentMetadata('request_payment', {
				asset_kind: 'native',
				payer: '0xdef',
				status: 'paid',
				fulfilling_message_id: 'msg-2',
				fulfilled_digest: 'abc',
			}),
		).toEqual({
			type: 'request_payment',
			assetKind: 'native',
			payer: '0xdef',
			status: 'paid',
			fulfillingMessageId: 'msg-2',
			fulfilledDigest: 'abc',
		});
	});

	it('rejects unknown statuses and missing fields', () => {
		expect(
			parsePaymentMetadata('request_payment', { asset_kind: 'native', payer: '0x1', status: 'weird' }),
		).toBeUndefined();
		expect(parsePaymentMetadata('token_transfer', { asset_kind: 'native' })).toBeUndefined();
		expect(parsePaymentMetadata('text', { asset_kind: 'native' })).toBeUndefined();
	});

	it('fromWireMessage exposes the kind and payment metadata', () => {
		const wire = {
			message_id: 'm1',
			group_id: '0xg',
			order: 1,
			encrypted_text: '',
			nonce: '',
			key_version: 0,
			sender_address: '0xabc',
			created_at: 1,
			updated_at: 1,
			attachments: [],
			is_edited: false,
			is_deleted: false,
			sync_status: 'SYNC_PENDING',
			quilt_patch_id: null,
			signature: '',
			public_key: '',
			kind: 'token_transfer',
			metadata: {
				digest: '5Hs8kmZjK9v7E2f1cQ3tYpLwNx4RbUaVd6GhTeJ8CqMn',
				asset_kind: 'native',
				status: 'pending',
				to: '0xdef',
			},
		} as WireMessageResponse;
		const msg = fromWireMessage(wire);
		expect(msg.kind).toBe('token_transfer');
		expect(msg.paymentMetadata).toMatchObject({ type: 'token_transfer', status: 'pending' });
	});
});
