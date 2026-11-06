// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

import type { Signer } from '@socialproof/myso/cryptography';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { MySoMessagingStackClient } from '../../src/client.js';
import {
	decodeContentEnvelope,
	encodeContentEnvelope,
	padme,
	relayerKindForEnvelope,
	type ContentEnvelope,
} from '../../src/content/envelope.js';
import { TimelineFold } from '../../src/content/timeline-fold.js';
import type { RelayerMessage, SendMessageParams } from '../../src/relayer/types.js';
import type { RelayerTransport } from '../../src/relayer/transport.js';
import type { MySoMessagingStackCompatibleClient } from '../../src/types.js';
import { signMessageContent } from '../../src/verification.js';
import { MOCK_PACKAGE_CONFIG } from './helpers/mock-package-config.js';

const vectors = JSON.parse(
	readFileSync(new URL('../vectors/content-envelope-v2.json', import.meta.url), 'utf8'),
) as {
	padme: { input: number; output: number }[];
	cases: { name: string; envelope: ContentEnvelope; plaintextHex: string }[];
};

const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

describe('content envelope v2', () => {
	it('matches padme vectors', () => {
		for (const v of vectors.padme) expect(padme(v.input)).toBe(v.output);
	});

	it('decodes every shared vector and re-encodes it identically', () => {
		for (const c of vectors.cases) {
			const plaintext = fromHex(c.plaintextHex);
			expect(decodeContentEnvelope(plaintext), c.name).toEqual(c.envelope);
			expect(Buffer.from(encodeContentEnvelope(c.envelope)).toString('hex'), c.name).toBe(c.plaintextHex);
		}
	});

	it('pads short messages to 256 bytes so length does not leak', () => {
		expect(encodeContentEnvelope({ t: 'text', text: 'a' }).length).toBe(256);
		expect(encodeContentEnvelope({ t: 'text', text: 'a'.repeat(200) }).length).toBe(256);
	});

	it('treats anything malformed as a v1 plaintext', () => {
		const good = encodeContentEnvelope({ t: 'text', text: 'hi' });
		expect(decodeContentEnvelope(new TextEncoder().encode('plain v1 text'))).toBeNull();
		const badVersion = good.slice();
		badVersion[0] = 0x03;
		expect(decodeContentEnvelope(badVersion)).toBeNull();
		const badPad = good.slice();
		badPad[good.length - 1] = 1;
		expect(decodeContentEnvelope(badPad)).toBeNull();
		expect(decodeContentEnvelope(good.slice(0, good.length - 1))).toBeNull();
		expect(decodeContentEnvelope(encodeContentEnvelope({ t: 'nope', text: '' } as never))).toBeNull();
	});

	it('hides inner types behind message / event row kinds', () => {
		expect(relayerKindForEnvelope({ t: 'text', text: '' })).toBe('message');
		expect(relayerKindForEnvelope({ t: 'poll', text: '' })).toBe('message');
		expect(relayerKindForEnvelope({ t: 'event', e: { type: 'delete', target: 'x' } })).toBe('event');
		expect(relayerKindForEnvelope({ t: 'post', text: '' })).toBe('post');
	});
});

describe('TimelineFold', () => {
	const alice = '0x' + 'aa'.repeat(32);
	const bob = '0x' + 'bb'.repeat(32);
	const msg = (id: string, order: number, sender = alice) => ({
		messageId: id,
		order,
		senderAddress: sender,
		senderVerified: true,
	});

	it('latest reaction op per (target, emoji, member) wins, in order', () => {
		const fold = new TimelineFold();
		fold.ingest(msg('m1', 1));
		fold.ingest({ ...msg('e3', 3, bob), event: { type: 'reaction', target: 'm1', emoji: '👍', add: false } });
		fold.ingest({ ...msg('e2', 2, bob), event: { type: 'reaction', target: 'm1', emoji: '👍', add: true } });
		expect(fold.reactionsFor('m1')).toEqual([]);
		fold.ingest({ ...msg('e4', 4, alice), event: { type: 'reaction', target: 'm1', emoji: '👍', add: true } });
		expect(fold.reactionsFor('m1')).toEqual([{ emoji: '👍', members: [alice] }]);
		expect(fold.hasReacted('m1', '👍', alice)).toBe(true);
	});

	it('holds events until their target is ingested', () => {
		const fold = new TimelineFold();
		fold.ingest({ ...msg('e2', 2, bob), event: { type: 'reaction', target: 'm1', emoji: '❤️', add: true } });
		expect(fold.reactionsFor('m1')).toEqual([]);
		const changed = fold.ingest(msg('m1', 1));
		expect([...changed]).toEqual(['m1']);
		expect(fold.reactionsFor('m1')).toEqual([{ emoji: '❤️', members: [bob] }]);
	});

	it('ignores events that predate their target, unverified events, and replays', () => {
		const fold = new TimelineFold();
		fold.ingest(msg('m1', 5));
		fold.ingest({ ...msg('e1', 4, bob), event: { type: 'reaction', target: 'm1', emoji: '👍', add: true } });
		fold.ingest({
			...msg('e6', 6, bob),
			senderVerified: false,
			event: { type: 'reaction', target: 'm1', emoji: '👍', add: true },
		});
		expect(fold.reactionsFor('m1')).toEqual([]);
		const e7 = { ...msg('e7', 7, bob), event: { type: 'reaction' as const, target: 'm1', emoji: '👍', add: true } };
		fold.ingest(e7);
		expect(fold.ingest(e7).size).toBe(0);
	});

	it('only the author can edit or delete', () => {
		const fold = new TimelineFold();
		fold.ingest(msg('m1', 1, alice));
		fold.ingest({ ...msg('e2', 2, bob), event: { type: 'edit', target: 'm1', text: 'hijack' } });
		fold.ingest({ ...msg('e3', 3, bob), event: { type: 'delete', target: 'm1' } });
		expect(fold.editFor('m1')).toBeUndefined();
		expect(fold.isDeleted('m1')).toBe(false);
		fold.ingest({ ...msg('e5', 5, alice), event: { type: 'edit', target: 'm1', text: 'second' } });
		fold.ingest({ ...msg('e4', 4, alice), event: { type: 'edit', target: 'm1', text: 'first' } });
		expect(fold.editFor('m1')?.text).toBe('second');
		fold.ingest({ ...msg('e6', 6, alice), event: { type: 'delete', target: 'm1' } });
		expect(fold.isDeleted('m1')).toBe(true);
	});

	it('tracks pins and poll votes', () => {
		const fold = new TimelineFold();
		fold.ingest(msg('m1', 1));
		fold.ingest(msg('m2', 2));
		fold.ingest({ ...msg('p1', 3, bob), event: { type: 'pin', target: 'm2', pinned: true } });
		fold.ingest({ ...msg('p2', 4, bob), event: { type: 'pin', target: 'm1', pinned: true } });
		fold.ingest({ ...msg('p3', 5, alice), event: { type: 'pin', target: 'm2', pinned: false } });
		expect(fold.pinnedTargets()).toEqual(['m1']);
		fold.ingest({ ...msg('v1', 6, bob), event: { type: 'poll_vote', target: 'm1', options: [0] } });
		fold.ingest({ ...msg('v2', 7, bob), event: { type: 'poll_vote', target: 'm1', options: [2] } });
		expect(fold.votesFor('m1').get(bob)).toEqual([2]);
	});
});

describe('client content envelope v2', () => {
	const groupId = `0x${'ab'.repeat(32)}`;
	const groupRef = { groupId, encryptionHistoryId: `0x${'cd'.repeat(32)}` };

	function fixture(flag: string | null, rows: RelayerMessage[] = []) {
		const sent: SendMessageParams[] = [];
		const transport = {
			sendMessage: vi.fn(async (p: SendMessageParams) => {
				sent.push(p);
				return { messageId: 'new-id' };
			}),
			postGroupReaction: vi.fn(async () => {}),
			fetchMessages: vi.fn(async () => ({ messages: rows, hasNext: false })),
		};
		const client = new MySoMessagingStackClient({
			client: {
				groups: { view: { hasPermission: async () => true }, bcs: { PermissionedGroup: { name: 'G' } }, call: {} },
				mydata: {},
			} as unknown as MySoMessagingStackCompatibleClient<string, string>,
			groupsName: 'groups',
			mydataName: 'mydata',
			packageConfig: MOCK_PACKAGE_CONFIG,
			encryption: { sessionKey: { getSessionKey: () => { throw new Error('no key'); } } },
			relayer: { transport: transport as unknown as RelayerTransport },
		});
		vi.spyOn(client.view, 'groupsMetadata').mockResolvedValue({
			[groupId]: { data: { contents: flag ? [{ key: 'e2ee', value: flag }] : [] } },
		} as never);
		vi.spyOn(client.view, 'getCurrentKeyVersion').mockResolvedValue(0n);
		// Identity "encryption" so tests can read the envelope the client produced.
		vi.spyOn(client.encryption, 'encrypt').mockImplementation(async (o) => ({
			ciphertext: o.data,
			nonce: new Uint8Array(12),
			keyVersion: 0n,
		}));
		vi.spyOn(client.encryption, 'decrypt').mockImplementation(async (o) => o.envelope.ciphertext);
		return { client, transport, sent };
	}

	it('v2 group: reactions are encrypted events pushed only to the author', async () => {
		const { client, transport, sent } = fixture('v2');
		const signer = Ed25519Keypair.generate();
		const author = '0x' + '99'.repeat(32);
		await client.addReaction({
			signer,
			groupRef,
			order: 4,
			emoji: '👍',
			messageId: 'target-1',
			targetSenderAddress: author,
		});
		expect(transport.postGroupReaction).not.toHaveBeenCalled();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.kind).toBe('event');
		expect(sent[0]!.notifyWallets).toEqual([author]);
		expect(decodeContentEnvelope(sent[0]!.encryptedText)).toEqual({
			t: 'event',
			e: { type: 'reaction', target: 'target-1', emoji: '👍', add: true },
		});
	});

	it('v1 group: reactions keep using the legacy endpoint', async () => {
		const { client, transport, sent } = fixture(null);
		await client.addReaction({ signer: Ed25519Keypair.generate(), groupRef, order: 4, emoji: '👍' });
		expect(transport.postGroupReaction).toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it('v2 group: text messages hide their type and carry no relayer attachments', async () => {
		const { client, sent } = fixture('v2');
		await client.sendMessage({ signer: Ed25519Keypair.generate(), groupRef, text: 'secret' } as never);
		expect(sent[0]!.kind).toBe('message');
		expect(sent[0]!.attachments).toBeUndefined();
		expect(sent[0]!.encryptedText.length).toBe(256);
		expect(decodeContentEnvelope(sent[0]!.encryptedText)).toEqual({ t: 'text', text: 'secret' });
	});

	async function signedRow(
		order: number,
		kind: RelayerMessage['kind'],
		envelope: ContentEnvelope,
		key = Ed25519Keypair.generate(),
	): Promise<RelayerMessage> {
		const row: RelayerMessage = {
			messageId: `m${order}`,
			groupId,
			order,
			encryptedText: encodeContentEnvelope(envelope),
			nonce: new Uint8Array(12),
			keyVersion: 0n,
			senderAddress: key.toMySoAddress(),
			createdAt: order,
			updatedAt: order,
			attachments: [],
			isEdited: false,
			isDeleted: false,
			signature: '',
			publicKey: Buffer.from(key.getPublicKey().toMySoBytes()).toString('hex'),
			isAgentMessage: false,
			kind,
		};
		row.signature = await signMessageContent(key as Signer, row);
		return row;
	}

	it('decrypts v2 rows into inner kinds and verified events', async () => {
		const rows = [
			await signedRow(1, 'message', { t: 'poll', text: 'lunch?' }),
			await signedRow(2, 'event', { t: 'event', e: { type: 'reaction', target: 'm1', emoji: '🍕', add: true } }),
			// Row kind disagrees with the signed envelope: rendered empty, never as an event.
			await signedRow(3, 'message', { t: 'event', e: { type: 'delete', target: 'm1' } }),
		];
		const { client } = fixture('v2', rows);
		const { messages } = await client.getMessages({
			signer: Ed25519Keypair.generate(),
			groupRef,
		} as never);
		const [poll, reaction, mismatch] = messages;
		expect(poll).toMatchObject({ kind: 'poll', text: 'lunch?', contentVersion: 2, senderVerified: true });
		expect(reaction).toMatchObject({ kind: 'event', contentVersion: 2 });
		expect(reaction!.event).toEqual({ type: 'reaction', target: 'm1', emoji: '🍕', add: true });
		expect(mismatch).toMatchObject({ kind: 'text', text: '' });
		expect(mismatch!.event).toBeUndefined();
	});
});
