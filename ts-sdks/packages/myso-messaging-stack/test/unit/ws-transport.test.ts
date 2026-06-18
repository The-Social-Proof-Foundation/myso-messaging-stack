// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WSRelayerTransport } from '../../src/relayer/ws-transport.js';

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

type MockListener = (event: { data: string }) => void;

class MockWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSED = 3;

	static instances: MockWebSocket[] = [];

	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: MockListener | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = MockWebSocket.OPEN;
			this.onopen?.();
		});
	}

	emitMessage(data: string) {
		this.onmessage?.({ data });
	}

	close() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}
}

describe('WSRelayerTransport', () => {
	beforeEach(() => {
		MockWebSocket.instances = [];
		vi.stubGlobal('WebSocket', MockWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('parses message.created wire frames without HTTP refetch', async () => {
		const keypair = Ed25519Keypair.generate();
		const transport = new WSRelayerTransport({
			relayerUrl: MOCK_RELAYER_URL,
			apiPrefix: '/v1',
			WebSocket: MockWebSocket as unknown as typeof WebSocket,
			maxReconnectAttempts: 0,
		});

		const controller = new AbortController();
		const subscribePromise = (async () => {
			const messages = [];
			for await (const message of transport.subscribe({
				signer: keypair,
				groupId: GROUP_ID,
				signal: controller.signal,
			})) {
				messages.push(message);
				controller.abort();
			}
			return messages;
		})();

		await vi.waitFor(() => {
			expect(MockWebSocket.instances.length).toBe(1);
		});

		const socket = MockWebSocket.instances[0]!;
		expect(socket.url).toContain('wss://relayer.example.com/v1/ws?');
		expect(socket.url).toContain(`group_id=${encodeURIComponent(GROUP_ID)}`);

		socket.emitMessage(
			JSON.stringify({
				type: 'message.created',
				message: WIRE_MESSAGE,
			}),
		);

		const messages = await subscribePromise;
		expect(messages).toHaveLength(1);
		expect(messages[0]?.messageId).toBe(WIRE_MESSAGE.message_id);
		expect(messages[0]?.encryptedText).toEqual(new Uint8Array([1, 2, 3]));
	});
});
