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
			const events = [];
			for await (const event of transport.subscribe({
				signer: keypair,
				groupId: GROUP_ID,
				signal: controller.signal,
			})) {
				events.push(event);
				controller.abort();
			}
			return events;
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

		const events = await subscribePromise;
		expect(events).toHaveLength(1);
		const event = events[0]!;
		if (event.type !== 'message.created') throw new Error('expected message event');
		expect(event.message.messageId).toBe(WIRE_MESSAGE.message_id);
		expect(event.message.encryptedText).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('yields both message.created and reaction.updated frames', async () => {
		const keypair = Ed25519Keypair.generate();
		const transport = new WSRelayerTransport({
			relayerUrl: MOCK_RELAYER_URL,
			apiPrefix: '/v1',
			WebSocket: MockWebSocket as unknown as typeof WebSocket,
			maxReconnectAttempts: 0,
		});

		const controller = new AbortController();
		const subscribePromise = (async () => {
			const events = [];
			for await (const event of transport.subscribe({
				signer: keypair,
				groupId: GROUP_ID,
				signal: controller.signal,
			})) {
				events.push(event);
				if (events.length === 2) controller.abort();
			}
			return events;
		})();

		await vi.waitFor(() => {
			expect(MockWebSocket.instances.length).toBe(1);
		});

		const socket = MockWebSocket.instances[0]!;
		socket.emitMessage(JSON.stringify({ type: 'message.created', message: WIRE_MESSAGE }));
		socket.emitMessage(
			JSON.stringify({
				type: 'reaction.updated',
				group_id: GROUP_ID,
				chain_seq: 1,
				emoji: '👨‍👩‍👧‍👦',
				count: 2,
				reactors: ['0xa', '0xb'],
			}),
		);

		const events = await subscribePromise;
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			type: 'message.created',
			message: { messageId: WIRE_MESSAGE.message_id },
		});
		expect(events[1]).toEqual({
			type: 'reaction.updated',
			reaction: {
				groupId: GROUP_ID,
				chainSeq: 1,
				emoji: '👨‍👩‍👧‍👦',
				count: 2,
				reactors: ['0xa', '0xb'],
			},
		});
	});

	it('yields typing start/stop and presence frames on the group feed', async () => {
		const keypair = Ed25519Keypair.generate();
		const transport = new WSRelayerTransport({
			relayerUrl: MOCK_RELAYER_URL,
			apiPrefix: '/v1',
			WebSocket: MockWebSocket as unknown as typeof WebSocket,
			maxReconnectAttempts: 0,
		});

		const controller = new AbortController();
		const subscribePromise = (async () => {
			const events = [];
			for await (const event of transport.subscribe({
				signer: keypair,
				groupId: GROUP_ID,
				signal: controller.signal,
			})) {
				events.push(event);
				if (events.length === 3) controller.abort();
			}
			return events;
		})();

		await vi.waitFor(() => {
			expect(MockWebSocket.instances.length).toBe(1);
		});

		const socket = MockWebSocket.instances[0]!;
		socket.emitMessage(
			JSON.stringify({
				type: 'typing.start',
				group_id: GROUP_ID,
				member: '0xa',
				expires_at: 1_700_000_005,
			}),
		);
		socket.emitMessage(
			JSON.stringify({ type: 'typing.stop', group_id: GROUP_ID, member: '0xa' }),
		);
		socket.emitMessage(
			JSON.stringify({
				type: 'presence.updated',
				group_id: GROUP_ID,
				member: '0xb',
				online: true,
			}),
		);

		const events = await subscribePromise;
		expect(events).toEqual([
			{
				type: 'typing.start',
				typing: { groupId: GROUP_ID, member: '0xa', expiresAt: 1_700_000_005 },
			},
			{
				type: 'typing.stop',
				typing: { groupId: GROUP_ID, member: '0xa', expiresAt: undefined },
			},
			{
				type: 'presence.updated',
				presence: { groupId: GROUP_ID, member: '0xb', online: true },
			},
		]);
	});

	it('subscribeUserEvents connects to /v1/users/ws and yields user feed frames', async () => {
		const keypair = Ed25519Keypair.generate();
		const transport = new WSRelayerTransport({
			relayerUrl: MOCK_RELAYER_URL,
			apiPrefix: '/v1',
			WebSocket: MockWebSocket as unknown as typeof WebSocket,
			maxReconnectAttempts: 0,
		});

		const controller = new AbortController();
		const subscribePromise = (async () => {
			const events = [];
			for await (const event of transport.subscribeUserEvents({
				signer: keypair,
				signal: controller.signal,
			})) {
				events.push(event);
				if (events.length === 4) controller.abort();
			}
			return events;
		})();

		await vi.waitFor(() => {
			expect(MockWebSocket.instances.length).toBe(1);
		});

		const socket = MockWebSocket.instances[0]!;
		expect(socket.url).toContain('wss://relayer.example.com/v1/users/ws?');
		expect(socket.url).toContain(
			`sender_address=${encodeURIComponent(keypair.toMySoAddress())}`,
		);
		expect(socket.url).not.toContain('group_id=');

		socket.emitMessage(
			JSON.stringify({ type: 'group.activity', group_id: '0xg', latest_order: 12 }),
		);
		socket.emitMessage(
			JSON.stringify({ type: 'read_state.updated', wallet: '0xme', blob_version: 3 }),
		);
		socket.emitMessage(
			JSON.stringify({ type: 'group.discovered', group_id: '0xnew', reason: 'invited' }),
		);
		socket.emitMessage(JSON.stringify({ type: 'group.hidden', group_id: '0xold' }));

		const events = await subscribePromise;
		expect(events).toEqual([
			{ type: 'group.activity', groupId: '0xg', latestOrder: 12 },
			{ type: 'read_state.updated', blobVersion: 3 },
			{ type: 'group.discovered', groupId: '0xnew', reason: 'invited' },
			{ type: 'group.hidden', groupId: '0xold' },
		]);
	});
});
