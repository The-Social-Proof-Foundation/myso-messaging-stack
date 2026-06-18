// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HybridRelayerTransport } from '../../src/relayer/hybrid-transport.js';

const MOCK_RELAYER_URL = 'https://relayer.example.com';
const GROUP_ID = '0x' + 'ab'.repeat(32);

const WIRE_MESSAGE = {
	message_id: '550e8400-e29b-41d4-a716-446655440000',
	group_id: GROUP_ID,
	order: 1,
	encrypted_text: '010203',
	nonce: '000102030405060708090a0b',
	key_version: 2,
	sender_address: '0x' + 'cd'.repeat(32),
	created_at: 1700000000,
	updated_at: 1700000000,
	attachments: [],
	is_edited: false,
	is_deleted: false,
	sync_status: 'SYNC_PENDING',
	quilt_patch_id: null,
	signature: 'aa'.repeat(32),
	public_key: 'bb'.repeat(33),
};

class FailingWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSED = 3;

	constructor(_url: string) {
		queueMicrotask(() => {
			this.onerror?.(new Event('error'));
		});
	}

	readyState = FailingWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: (() => void) | null = null;

	close() {
		this.readyState = FailingWebSocket.CLOSED;
	}
}

const mockFetch = vi.fn<typeof fetch>();

describe('HybridRelayerTransport', () => {
	beforeEach(() => {
		mockFetch.mockClear();
		vi.stubGlobal('WebSocket', FailingWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('falls back to HTTP polling when WebSocket connection fails', async () => {
		const keypair = Ed25519Keypair.generate();
		const transport = new HybridRelayerTransport({
			relayerUrl: MOCK_RELAYER_URL,
			apiPrefix: '/v1',
			pollingIntervalMs: 10,
			fetch: mockFetch,
			WebSocket: FailingWebSocket as unknown as typeof WebSocket,
			wsMaxReconnectAttempts: 0,
		});

		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					messages: [WIRE_MESSAGE],
					hasNext: false,
				}),
				{ status: 200 },
			),
		);

		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ messages: [], hasNext: false }), { status: 200 }),
		);

		const controller = new AbortController();
		const messages = [];
		for await (const message of transport.subscribe({
			signer: keypair,
			groupId: GROUP_ID,
			signal: controller.signal,
		})) {
			messages.push(message.messageId);
			controller.abort();
		}

		expect(messages).toEqual([WIRE_MESSAGE.message_id]);
		expect(mockFetch).toHaveBeenCalled();
		const [url] = mockFetch.mock.calls[0]!;
		expect(String(url)).toContain('/v1/messages');
	});
});
