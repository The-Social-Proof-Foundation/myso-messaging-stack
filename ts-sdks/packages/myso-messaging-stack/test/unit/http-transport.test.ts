// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { toHex } from '@socialproof/myso/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Attachment } from '../../src/attachments/types.js';
import { HTTPRelayerTransport } from '../../src/relayer/http-transport.js';
import { RelayerTransportError } from '../../src/relayer/types.js';

const MOCK_RELAYER_URL = 'https://relayer.example.com';

// Sample wire message from the relayer (snake_case, as returned by the HTTP API)
const WIRE_MESSAGE = {
	message_id: '550e8400-e29b-41d4-a716-446655440000',
	group_id: '0x' + 'ab'.repeat(32),
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
};

// Shared mock fetch — injected via config, not globalThis
const mockFetch = vi.fn<typeof fetch>();

// Default signer used when the test doesn't need a specific keypair.
const defaultKeypair = Ed25519Keypair.generate();

function createTransport() {
	return new HTTPRelayerTransport({
		relayerUrl: MOCK_RELAYER_URL,
		fetch: mockFetch,
	});
}

describe('HTTPRelayerTransport', () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// sendMessage

	describe('sendMessage', () => {
		it('sends POST /messages with correct body and auth headers', async () => {
			const keypair = Ed25519Keypair.generate();
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ message_id: 'test-uuid' }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' },
				}),
			);

			const result = await transport.sendMessage({
				signer: keypair,
				groupId: '0x' + 'ab'.repeat(32),
				encryptedText: new Uint8Array([1, 2, 3]),
				nonce: new Uint8Array(12),
				keyVersion: 2n,
			});

			expect(result.messageId).toBe('test-uuid');

			expect(mockFetch).toHaveBeenCalledOnce();
			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe(`${MOCK_RELAYER_URL}/messages`);
			expect(init?.method).toBe('POST');

			const body = JSON.parse(init?.body as string);
			expect(body.group_id).toBe('0x' + 'ab'.repeat(32));
			expect(body.encrypted_text).toBe('010203');
			expect(body.nonce).toBe('000000000000000000000000');
			expect(body.key_version).toBe(2);
			expect(body.sender_address).toBe(keypair.toMySoAddress());
			expect(body.timestamp).toBeTypeOf('number');

			const headers = init?.headers as Record<string, string>;
			expect(headers['x-signature']).toBeTypeOf('string');
			expect(headers['x-public-key']).toBeTypeOf('string');
			expect(headers['Content-Type']).toBe('application/json');
		});

		it('includes attachments when provided', async () => {
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ message_id: 'test-uuid' }), { status: 201 }),
			);

			const attachments: Attachment[] = [
				{ storageId: 'patch-1', nonce: 'aabb', encryptedMetadata: 'ccdd', metadataNonce: 'eeff' },
				{ storageId: 'patch-2', nonce: '1122', encryptedMetadata: '3344', metadataNonce: '5566' },
			];

			await transport.sendMessage({
				signer: defaultKeypair,
				groupId: '0x' + 'ab'.repeat(32),
				encryptedText: new Uint8Array([1]),
				nonce: new Uint8Array(12),
				keyVersion: 0n,
				attachments,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.attachments).toEqual([
				{
					storage_id: 'patch-1',
					nonce: 'aabb',
					encrypted_metadata: 'ccdd',
					metadata_nonce: 'eeff',
				},
				{
					storage_id: 'patch-2',
					nonce: '1122',
					encrypted_metadata: '3344',
					metadata_nonce: '5566',
				},
			]);
		});
	});

	// fetchMessages

	describe('fetchMessages', () => {
		it('sends GET /messages with query params and header auth', async () => {
			const keypair = Ed25519Keypair.generate();
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ messages: [WIRE_MESSAGE], hasNext: false }), { status: 200 }),
			);

			const groupId = '0x' + 'ab'.repeat(32);
			const result = await transport.fetchMessages({
				signer: keypair,
				groupId,
				afterOrder: 5,
				limit: 10,
			});

			expect(result.messages).toHaveLength(1);
			expect(result.hasNext).toBe(false);

			const msg = result.messages[0];
			expect(msg.messageId).toBe(WIRE_MESSAGE.message_id);
			expect(msg.groupId).toBe(WIRE_MESSAGE.group_id);
			expect(msg.encryptedText).toBeInstanceOf(Uint8Array);
			expect(msg.nonce).toBeInstanceOf(Uint8Array);
			expect(msg.keyVersion).toBe(2n); // bigint
			expect(msg.syncStatus).toBe('SYNC_PENDING');

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain('group_id=');
			expect(url).toContain('after_order=5');
			expect(url).toContain('limit=10');

			const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
			expect(headers['x-signature']).toBeTypeOf('string');
			expect(headers['x-public-key']).toBeTypeOf('string');
			expect(headers['x-sender-address']).toBe(keypair.toMySoAddress());
			expect(headers['x-timestamp']).toBeTypeOf('string');
			expect(headers['x-group-id']).toBe(groupId);
		});
	});

	// fetchMessage

	describe('fetchMessage', () => {
		it('fetches a single message by ID', async () => {
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(WIRE_MESSAGE), { status: 200 }));

			const msg = await transport.fetchMessage({
				signer: defaultKeypair,
				messageId: WIRE_MESSAGE.message_id,
				groupId: WIRE_MESSAGE.group_id,
			});

			expect(msg.messageId).toBe(WIRE_MESSAGE.message_id);
			expect(msg.order).toBe(1);
			expect(msg.keyVersion).toBe(2n);

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain('message_id=');
		});
	});

	// updateMessage

	describe('updateMessage', () => {
		it('sends PUT /messages with body auth', async () => {
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

			await transport.updateMessage({
				signer: defaultKeypair,
				messageId: 'test-uuid',
				groupId: '0x' + 'ab'.repeat(32),
				encryptedText: new Uint8Array([4, 5, 6]),
				nonce: new Uint8Array(12),
				keyVersion: 1n,
			});

			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe(`${MOCK_RELAYER_URL}/messages`);
			expect(init?.method).toBe('PUT');

			const body = JSON.parse(init?.body as string);
			expect(body.message_id).toBe('test-uuid');
			expect(body.encrypted_text).toBe('040506');
			expect(body.key_version).toBe(1);
		});
	});

	// deleteMessage

	describe('deleteMessage', () => {
		it('sends DELETE /messages/:id with header auth', async () => {
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

			await transport.deleteMessage({
				signer: defaultKeypair,
				messageId: 'test-uuid',
				groupId: '0x' + 'ab'.repeat(32),
			});

			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe(`${MOCK_RELAYER_URL}/messages/test-uuid`);
			expect(init?.method).toBe('DELETE');

			const headers = init?.headers as Record<string, string>;
			expect(headers['x-signature']).toBeTypeOf('string');
			expect(headers['x-group-id']).toBe('0x' + 'ab'.repeat(32));
		});
	});

	// Error handling

	describe('error handling', () => {
		it('throws RelayerTransportError on API error (400)', async () => {
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'Invalid hex in nonce' }), { status: 400 }),
			);

			await expect(
				transport.sendMessage({
					signer: defaultKeypair,
					groupId: '0x' + 'ab'.repeat(32),
					encryptedText: new Uint8Array([1]),
					nonce: new Uint8Array(12),
					keyVersion: 0n,
				}),
			).rejects.toThrow(RelayerTransportError);

			try {
				mockFetch.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: 'Invalid hex in nonce' }), { status: 400 }),
				);
				await transport.sendMessage({
					signer: defaultKeypair,
					groupId: '0x' + 'ab'.repeat(32),
					encryptedText: new Uint8Array([1]),
					nonce: new Uint8Array(12),
					keyVersion: 0n,
				});
			} catch (e) {
				expect(e).toBeInstanceOf(RelayerTransportError);
				const err = e as RelayerTransportError;
				expect(err.status).toBe(400);
				expect(err.message).toBe('Invalid hex in nonce');
				expect(err.code).toBeUndefined();
			}
		});

		it('throws RelayerTransportError with code on auth error (403)', async () => {
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'Not a group member', code: 'NOT_GROUP_MEMBER' }), {
					status: 403,
				}),
			);

			try {
				await transport.fetchMessages({
					signer: defaultKeypair,
					groupId: '0x' + 'ab'.repeat(32),
				});
			} catch (e) {
				expect(e).toBeInstanceOf(RelayerTransportError);
				const err = e as RelayerTransportError;
				expect(err.status).toBe(403);
				expect(err.code).toBe('NOT_GROUP_MEMBER');
			}
		});

		it('throws after disconnect', async () => {
			const transport = createTransport();
			transport.disconnect();

			await expect(
				transport.fetchMessages({ signer: defaultKeypair, groupId: '0x' + 'ab'.repeat(32) }),
			).rejects.toThrow('Transport is disconnected');
		});
	});

	// subscribe

	/** Routes fetchMessages polls through `onMessagesPoll`; reactions listings return []. */
	function mockPolling(onMessagesPoll: (poll: number) => Response) {
		let poll = 0;
		mockFetch.mockImplementation(async (input) => {
			if (String(input).includes('/reactions')) {
				return new Response(JSON.stringify([]), { status: 200 });
			}
			poll += 1;
			return onMessagesPoll(poll);
		});
	}

	describe('subscribe', () => {
		it('yields message events from polling and stops on abort', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				pollingIntervalMs: 10,
				fetch: mockFetch,
			});

			const controller = new AbortController();

			mockPolling((poll) => {
				if (poll === 1) {
					return new Response(
						JSON.stringify({
							messages: [
								{ ...WIRE_MESSAGE, order: 1 },
								{ ...WIRE_MESSAGE, order: 2, message_id: 'msg-2' },
							],
							hasNext: false,
						}),
						{ status: 200 },
					);
				}
				if (poll === 2) {
					return new Response(
						JSON.stringify({
							messages: [{ ...WIRE_MESSAGE, order: 3, message_id: 'msg-3' }],
							hasNext: false,
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ messages: [], hasNext: false }), { status: 200 });
			});

			const received: string[] = [];
			for await (const event of transport.subscribe({
				signer: defaultKeypair,
				groupId: WIRE_MESSAGE.group_id,
				signal: controller.signal,
			})) {
				if (event.type !== 'message.created') continue;
				received.push(event.message.messageId);
				if (received.length === 3) {
					controller.abort();
				}
			}

			expect(received).toEqual([WIRE_MESSAGE.message_id, 'msg-2', 'msg-3']);
		});

		it('throws on 4xx client errors instead of retrying', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				pollingIntervalMs: 10,
				fetch: mockFetch,
			});

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'Not a group member', code: 'NOT_GROUP_MEMBER' }), {
					status: 403,
				}),
			);

			const received: string[] = [];
			await expect(async () => {
				for await (const event of transport.subscribe({
					signer: defaultKeypair,
					groupId: WIRE_MESSAGE.group_id,
				})) {
					if (event.type === 'message.created') {
						received.push(event.message.messageId);
					}
				}
			}).rejects.toThrow(RelayerTransportError);

			expect(received).toEqual([]);
		});

		it('retries on 5xx server errors', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				pollingIntervalMs: 10,
				fetch: mockFetch,
			});

			const controller = new AbortController();

			mockPolling((poll) => {
				// First poll: 500 server error (should retry)
				if (poll === 1) {
					return new Response(JSON.stringify({ error: 'Internal server error' }), {
						status: 500,
					});
				}
				// Second poll: success with a message, then abort
				if (poll === 2) {
					return new Response(
						JSON.stringify({ messages: [{ ...WIRE_MESSAGE, order: 1 }], hasNext: false }),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ messages: [], hasNext: false }), { status: 200 });
			});

			const received: string[] = [];
			for await (const event of transport.subscribe({
				signer: defaultKeypair,
				groupId: WIRE_MESSAGE.group_id,
				signal: controller.signal,
			})) {
				if (event.type !== 'message.created') continue;
				received.push(event.message.messageId);
				controller.abort();
			}

			expect(received).toEqual([WIRE_MESSAGE.message_id]);
			// Should have retried after the 500 (message polls only; abort precedes reactions)
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		it('stops on disconnect', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				pollingIntervalMs: 10,
				fetch: mockFetch,
			});

			mockPolling(
				() =>
					new Response(JSON.stringify({ messages: [], hasNext: false }), { status: 200 }),
			);

			setTimeout(() => transport.disconnect(), 50);

			const received: string[] = [];
			for await (const event of transport.subscribe({
				signer: defaultKeypair,
				groupId: WIRE_MESSAGE.group_id,
			})) {
				if (event.type === 'message.created') {
					received.push(event.message.messageId);
				}
			}

			expect(received).toEqual([]);
		});
	});

	// Signing correctness

	describe('signing', () => {
		it('produces valid X-Public-Key header matching signer', async () => {
			const keypair = Ed25519Keypair.generate();
			const transport = createTransport();

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ message_id: 'test' }), { status: 201 }),
			);

			await transport.sendMessage({
				signer: keypair,
				groupId: '0x' + 'ab'.repeat(32),
				encryptedText: new Uint8Array([1]),
				nonce: new Uint8Array(12),
				keyVersion: 0n,
			});

			const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
			const publicKeyHex = headers['x-public-key'];

			const expectedHex = toHex(keypair.getPublicKey().toMySoBytes());
			expect(publicKeyHex).toBe(expectedHex);

			expect(headers['x-signature']).toHaveLength(128);
		});
	});

	// URL handling

	describe('URL handling', () => {
		it('strips trailing slashes from relayer URL', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: 'https://relayer.example.com///',
				fetch: mockFetch,
			});

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ message_id: 'test' }), { status: 201 }),
			);

			await transport.sendMessage({
				signer: defaultKeypair,
				groupId: '0x' + 'ab'.repeat(32),
				encryptedText: new Uint8Array([1]),
				nonce: new Uint8Array(12),
				keyVersion: 0n,
			});

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toBe('https://relayer.example.com/messages');
		});
	});

	describe('group reactions', () => {
		it('GET /v1/groups/:id/reactions with header auth and chain_seq query', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			const keypair = Ed25519Keypair.generate();
			const groupId = '0x' + 'ab'.repeat(32);
			mockFetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify([{ chain_seq: 1, emoji: '👍', count: 3, reactors: ['0xa', '0xb'] }]),
					{ status: 200 },
				),
			);

			const rows = await transport.listGroupReactions({
				signer: keypair,
				groupId,
				chainSeq: 1,
			});

			expect(rows).toEqual([{ chainSeq: 1, emoji: '👍', count: 3, reactors: ['0xa', '0xb'] }]);
			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toBe(`${MOCK_RELAYER_URL}/v1/groups/${groupId}/reactions?chain_seq=1`);
		});

		it('subscribe polls messages and diffs reaction snapshots into events', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				pollingIntervalMs: 1,
				fetch: mockFetch,
			});
			const controller = new AbortController();

			let messagesCall = 0;
			let reactionsCall = 0;
			mockFetch.mockImplementation(async (input) => {
				const url = String(input);
				if (url.includes('/reactions')) {
					reactionsCall += 1;
					// Poll 1: baseline (no events). Poll 2: reaction added. Poll 3: removed.
					if (reactionsCall === 1) {
						return new Response(JSON.stringify([]), { status: 200 });
					}
					if (reactionsCall === 2) {
						return new Response(
							JSON.stringify([{ chain_seq: 1, emoji: '👍', count: 1, reactors: ['0xa'] }]),
							{ status: 200 },
						);
					}
					return new Response(JSON.stringify([]), { status: 200 });
				}
				messagesCall += 1;
				if (messagesCall === 1) {
					return new Response(JSON.stringify({ messages: [WIRE_MESSAGE], hasNext: false }), {
						status: 200,
					});
				}
				return new Response(JSON.stringify({ messages: [], hasNext: false }), { status: 200 });
			});

			const events: string[] = [];
			for await (const event of transport.subscribe({
				signer: defaultKeypair,
				groupId: WIRE_MESSAGE.group_id,
				signal: controller.signal,
			})) {
				if (event.type === 'message.created') {
					events.push(`message:${event.message.messageId}`);
				} else {
					events.push(
						`reaction:${event.reaction.chainSeq}:${event.reaction.emoji}:${event.reaction.count}:${event.reaction.reactors.join('|')}`,
					);
				}
				if (events.length === 3) controller.abort();
			}

			expect(events).toEqual([
				`message:${WIRE_MESSAGE.message_id}`,
				'reaction:1:👍:1:0xa',
				'reaction:1:👍:0:',
			]);
		});

		it('defaults reactors to an empty array for legacy responses', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify([{ chain_seq: 1, emoji: '👍', count: 3 }]), { status: 200 }),
			);

			const rows = await transport.listGroupReactions({
				signer: defaultKeypair,
				groupId: '0x' + 'ab'.repeat(32),
			});

			expect(rows).toEqual([{ chainSeq: 1, emoji: '👍', count: 3, reactors: [] }]);
		});

		it('POST /v1/groups/:id/reactions with body auth', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

			await transport.postGroupReaction({
				signer: defaultKeypair,
				groupId: '0x' + 'ab'.repeat(32),
				chainSeq: 2,
				emoji: '👍',
				add: false,
			});

			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe(`${MOCK_RELAYER_URL}/v1/groups/0x${'ab'.repeat(32)}/reactions`);
			expect(init?.method).toBe('POST');
			const body = JSON.parse(init?.body as string);
			expect(body.chain_seq).toBe(2);
			expect(body.emoji).toBe('👍');
			expect(body.add).toBe(false);
			expect(body.group_id).toBe('0x' + 'ab'.repeat(32));
		});
	});

	describe('group pins', () => {
		it('GET /v1/groups/:id/pins', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([1, 3, 5]), { status: 200 }));

			const pins = await transport.listGroupPins({
				signer: defaultKeypair,
				groupId: '0x' + 'cd'.repeat(32),
			});

			expect(pins).toEqual([1, 3, 5]);
		});

		it('POST /v1/groups/:id/pins', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

			await transport.setGroupPin({
				signer: defaultKeypair,
				groupId: '0x' + 'ef'.repeat(32),
				chainSeq: 9,
				pin: true,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.chain_seq).toBe(9);
			expect(body.pin).toBe(true);
		});
	});

	describe('group receipts', () => {
		it('GET /v1/groups/:id/receipts', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ delivered_upto: 10, read_upto: 8 }), { status: 200 }),
			);

			const state = await transport.getGroupReceipts({
				signer: defaultKeypair,
				groupId: '0x' + '12'.repeat(32),
			});

			expect(state.deliveredUpto).toBe(10);
			expect(state.readUpto).toBe(8);
		});

		it('POST /v1/groups/:id/receipts', async () => {
			const transport = new HTTPRelayerTransport({
				relayerUrl: MOCK_RELAYER_URL,
				apiPrefix: '/v1',
				fetch: mockFetch,
			});
			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

			await transport.postGroupReceipts({
				signer: defaultKeypair,
				groupId: '0x' + '34'.repeat(32),
				deliveredUpto: 12,
				readUpto: 7,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.delivered_upto).toBe(12);
			expect(body.read_upto).toBe(7);
		});
	});
});
