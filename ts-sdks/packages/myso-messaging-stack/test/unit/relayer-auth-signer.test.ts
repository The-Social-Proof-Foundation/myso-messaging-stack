// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { fromBase64, toHex } from '@socialproof/myso/utils';
import { describe, expect, it, vi } from 'vitest';

import {
	createHeaderAuth,
	signAndCreateAuthHeaders,
	ZKLOGIN_PUBLIC_KEY_HEX,
} from '../../src/relayer/auth-headers.js';
import {
	withRelayerAuthSigner,
	zkLoginRelayerSigner,
} from '../../src/relayer/relayer-auth-signer.js';
import type { RelayerTransport } from '../../src/relayer/transport.js';

/** Real serialized zkLogin signature (MySoKit fixture); only its shape matters here. */
const ZK_SIGNATURE = 'BQNNMTE3MDE4NjY4MTI3MDQ1MTcyMTM5MTQ2MTI3OTg2NzQ3NDg2NTc3NTU1NjY1ODY1OTc0MzQ4MTA5NDEyNDA0ODMzNDY3NjkzNjkyNjdNMTQxMjA0Mzg5OTgwNjM2OTIyOTczODYyNDk3NTQyMzA5NzI3MTUxNTM4NzY1Mzc1MzAxNjg4ODM5ODE1MTM1ODQ1ODYxNzIxOTU4NDEBMQMCTDE4Njc0NTQ1MDE2MDI1ODM4NDg4NTI3ODc3ODI3NjE5OTY1NjAxNzAxMTgyNDkyOTk1MDcwMTQ5OTkyMzA4ODY4NTI1NTY5OTgyNzNNMTQ0NjY0MTk2OTg2NzkxMTYzMTM0NzUyMTA2NTQ1NjI5NDkxMjgzNDk1OTcxMDE3NjkyNTY5NTkwMTAwMDMxODg4ODYwOTEwODAzMTACTTExMDcyOTU0NTYyOTI0NTg4NDk2MTQ4NjMyNDc0MDc4NDMyNDA2NjMzMjg4OTQ4MjU2NzE4ODA5NzE0ODYxOTg2MTE5MzAzNTI5NzYwTTE5NzkwNTE2MDEwNzg0OTM1MTAwMTUwNjE0OTg5MDk3OTA4MjMzODk5NzE4NjQ1NTM2MTMwNzI3NzczNzEzNDA3NjExMTYxMzY4MDQ2AgExATADTTEwNDIzMjg5MDUxODUzMDMzOTE1MzgwODEwNTE2MTMwMjA1NzQ3MTgyODY3NTk2NDU3MTM5OTk5MTc2NzE0NDc2NDE1MTQ4Mzc2MzUwTTIxNzg1NzE5Njk1ODQ4MDEzOTA4MDYxNDkyOTg5NzY1Nzc3Nzg4MTQyMjU1ODk3OTg2MzAwMjQxNTYxMjgwMTk2NzQ1MTc0OTM0NDU3ATExeUpwYzNNaU9pSm9kSFJ3Y3pvdkwyRmpZMjkxYm5SekxtZHZiMmRzWlM1amIyMGlMQwFmZXlKaGJHY2lPaUpTVXpJMU5pSXNJbXRwWkNJNkltSTVZV00yTURGa01UTXhabVEwWm1aa05UVTJabVl3TXpKaFlXSXhPRGc0T0RCalpHVXpZamtpTENKMGVYQWlPaUpLVjFRaWZRTTEzMzIyODk3OTMwMTYzMjE4NTMyMjY2NDMwNDA5NTEwMzk0MzE2OTg1Mjc0NzY5MTI1NjY3MjkwNjAwMzIxNTY0MjU5NDY2NTExNzExrgAAAAAAAABhAEp+O5GEAF/5tKNDdWBObNf/1uIrbOJmE+xpnlBD2Vikqhbd0zLrQ2NJyquYXp4KrvWUOl7Hso+OK0eiV97ffwucM8VdtG2hjf/RUGNO5JNUH+D/gHtE9sHe6ZEnxwZL7g==';
const ZK_ADDRESS = '0x' + '6b'.repeat(32);

function zkSigner(ephemeral = new Ed25519Keypair()) {
	const signPersonalMessage = vi.fn(async () => ZK_SIGNATURE);
	return {
		ephemeral,
		signPersonalMessage,
		signer: zkLoginRelayerSigner(ephemeral, { address: ZK_ADDRESS, signPersonalMessage }),
	};
}

describe('zkLoginRelayerSigner', () => {
	it('authenticates as the zkLogin address and forwards everything else', async () => {
		const { ephemeral, signer, signPersonalMessage } = zkSigner();
		expect(signer.toMySoAddress()).toBe(ZK_ADDRESS);
		expect(signer.getPublicKey().toMySoAddress()).toBe(ephemeral.toMySoAddress());

		const bytes = new TextEncoder().encode('1700000000:' + ZK_ADDRESS);
		const signed = await signer.signPersonalMessage(bytes);
		expect(signed.signature).toBe(ZK_SIGNATURE);
		expect(signPersonalMessage).toHaveBeenCalledWith(bytes);
	});
});

describe('relayer auth headers', () => {
	it('send a zkLogin signature whole with the 05 marker', async () => {
		const { signer } = zkSigner();
		const headers = await signAndCreateAuthHeaders(signer, new Uint8Array([1, 2, 3]));
		expect(headers['x-public-key']).toBe(ZKLOGIN_PUBLIC_KEY_HEX);
		expect(headers['x-signature']).toBe(toHex(fromBase64(ZK_SIGNATURE)));
	});

	it('use the zkLogin address as the sender', async () => {
		const { signer } = zkSigner();
		const headers = await createHeaderAuth(signer, '0xABC');
		expect(headers['x-sender-address']).toBe(ZK_ADDRESS);
		expect(headers['x-group-id']).toBe('0xabc');
		expect(headers['x-public-key']).toBe('05');
	});

	it('keep plain keypair signatures unchanged', async () => {
		const keypair = new Ed25519Keypair();
		const headers = await signAndCreateAuthHeaders(keypair, new Uint8Array([1, 2, 3]));
		expect(headers['x-public-key']).toBe(toHex(keypair.getPublicKey().toMySoBytes()));
		expect(headers['x-public-key'].startsWith('00')).toBe(true);
		expect(headers['x-signature']).toHaveLength(128);
	});
});

describe('withRelayerAuthSigner', () => {
	it('maps the signer of every call and leaves other arguments alone', async () => {
		const original = new Ed25519Keypair();
		const mapped = new Ed25519Keypair();
		const sendMessage = vi.fn(async (_params: unknown) => ({ messageId: 'm1' }));
		const subscribe = vi.fn((_params: unknown) => ({ [Symbol.asyncIterator]: () => ({}) }));
		const transport = withRelayerAuthSigner(
			{ sendMessage, subscribe } as unknown as RelayerTransport,
			(signer) => (signer === original ? mapped : signer),
		);

		await transport.sendMessage({ signer: original, groupId: '0x1' } as never);
		expect(sendMessage.mock.calls[0]![0]).toMatchObject({ signer: mapped, groupId: '0x1' });

		// Iterables come back synchronously, untouched.
		const iterable = transport.subscribe({ signer: original, groupId: '0x1' } as never);
		expect(typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
		expect(subscribe.mock.calls[0]![0]).toMatchObject({ signer: mapped });
	});
});
