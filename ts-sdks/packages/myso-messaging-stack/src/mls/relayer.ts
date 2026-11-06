// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { fromHex, toHex } from '@socialproof/myso/utils';

import {
	createBodyAuth,
	createHeaderAuth,
	createWalletHeaderAuth,
	signAndCreateAuthHeaders,
} from '../relayer/auth-headers.js';
import type { RelayerTransport } from '../relayer/transport.js';
import { RelayerTransportError, type RelayerMessage } from '../relayer/types.js';
import { signMessageContent } from '../verification.js';
import type { MlsDeviceCertificate } from './types.js';

/** Relayer delivery-service calls the MLS session needs (E2EE-Protocol-MLS.md). */
export interface MlsRelayer {
	putKeyPackages(signer: Signer, deviceId: string, cert: MlsDeviceCertificate, kps: Uint8Array[]): Promise<void>;
	claimKeyPackages(signer: Signer, wallets: string[]): Promise<{ wallet: string; deviceId: string; keyPackage: Uint8Array }[]>;
	postWelcome(signer: Signer, groupId: string, recipients: { wallet: string; deviceId: string }[], welcome: Uint8Array): Promise<void>;
	takeWelcomes(signer: Signer, deviceId: string): Promise<{ groupId: string; welcome: Uint8Array }[]>;
	postGroupInfo(signer: Signer, groupId: string, info: Uint8Array): Promise<void>;
	getGroupInfo(signer: Signer, groupId: string): Promise<Uint8Array | null>;
	/** Signed `commit` row (commits and proposals). `false` = 409: another commit won the epoch. */
	postControlRow(signer: Signer, groupId: string, mls: Uint8Array): Promise<boolean>;
	fetchRows(signer: Signer, groupId: string, afterOrder: number, limit: number): Promise<{ messages: RelayerMessage[]; hasNext: boolean }>;
	deleteDevice(signer: Signer, deviceId: string): Promise<void>;
	/** Signed `event` row carrying an MLS application message that isn't a chat row (history). */
	postAppRow(signer: Signer, groupId: string, mls: Uint8Array): Promise<void>;
	// Self-group (`self:<wallet>`, this wallet's devices only; wallet-auth routes).
	getSelfGroupInfo(signer: Signer): Promise<Uint8Array | null>;
	putSelfGroupInfo(signer: Signer, info: Uint8Array): Promise<void>;
	/** `false` = 409 (stale self-group commit). */
	postSelfMessage(signer: Signer, body: Uint8Array): Promise<boolean>;
	fetchSelf(signer: Signer, after: number, limit: number): Promise<{ seq: number; body: Uint8Array }[]>;
	// Passkey message backup (M8; wallet-auth routes). Optional: sessions without them can't back up.
	putBackupSegment?(signer: Signer, keyId: string, body: Uint8Array): Promise<number>;
	listBackupSegments?(signer: Signer, keyId: string, after: number, limit: number): Promise<{ seq: number; body: Uint8Array }[]>;
	deleteBackup?(signer: Signer, keyId: string): Promise<void>;
}

/** HTTP implementation: `/v1/mls/*` via fetch, log rows via the existing relayer transport. */
export class HttpMlsRelayer implements MlsRelayer {
	readonly #url: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #transport: RelayerTransport;

	constructor(options: { relayerUrl: string; transport: RelayerTransport; fetch?: typeof globalThis.fetch }) {
		this.#url = options.relayerUrl.replace(/\/$/, '');
		this.#transport = options.transport;
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	async #call<T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
		const response = await this.#fetch(`${this.#url}${path}`, {
			method,
			headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new RelayerTransportError(`${method} ${path} failed (${response.status}): ${text}`, response.status);
		}
		return (await response.json()) as T;
	}

	async #signedPost<T>(signer: Signer, path: string, payload: Record<string, unknown>, method = 'POST'): Promise<T> {
		const { body, headers } = await createBodyAuth(signer, payload);
		return this.#call<T>(method, path, headers, body);
	}

	async putKeyPackages(signer: Signer, deviceId: string, cert: MlsDeviceCertificate, kps: Uint8Array[]) {
		await this.#signedPost(signer, '/v1/mls/key-packages', {
			device_id: deviceId,
			certificate: cert,
			key_packages: kps.map((k) => toHex(k)),
		});
	}

	async claimKeyPackages(signer: Signer, wallets: string[]) {
		const res = await this.#signedPost<{ items: { wallet: string; device_id: string; key_package: string }[] }>(
			signer,
			'/v1/mls/key-packages/claim',
			{ wallets },
		);
		return res.items.map((i) => ({ wallet: i.wallet, deviceId: i.device_id, keyPackage: fromHex(i.key_package) }));
	}

	async postWelcome(signer: Signer, groupId: string, recipients: { wallet: string; deviceId: string }[], welcome: Uint8Array) {
		await this.#signedPost(signer, `/v1/groups/${groupId}/mls/welcomes`, {
			group_id: groupId,
			recipients: recipients.map((r) => ({ wallet: r.wallet, device_id: r.deviceId })),
			welcome: toHex(welcome),
		});
	}

	async takeWelcomes(signer: Signer, deviceId: string) {
		const headers = await createWalletHeaderAuth(signer);
		const res = await this.#call<{ items: { group_id: string; welcome: string }[] }>(
			'GET',
			`/v1/mls/welcomes?device_id=${encodeURIComponent(deviceId)}`,
			headers,
		);
		return res.items.map((i) => ({ groupId: i.group_id, welcome: fromHex(i.welcome) }));
	}

	async postGroupInfo(signer: Signer, groupId: string, info: Uint8Array) {
		await this.#signedPost(signer, `/v1/groups/${groupId}/mls/group-info`, {
			group_id: groupId,
			group_info: toHex(info),
		});
	}

	async getGroupInfo(signer: Signer, groupId: string) {
		const headers = await createHeaderAuth(signer, groupId);
		try {
			const res = await this.#call<{ group_info: string }>('GET', `/v1/groups/${groupId}/mls/group-info`, headers);
			return fromHex(res.group_info);
		} catch (error) {
			if (error instanceof RelayerTransportError && error.status === 404) return null;
			throw error;
		}
	}

	async postControlRow(signer: Signer, groupId: string, mls: Uint8Array) {
		const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
		const messageSignature = await signMessageContent(signer, {
			groupId,
			kind: 'commit',
			encryptedText: mls,
			nonce,
			keyVersion: 0n,
		});
		try {
			await this.#transport.sendMessage({
				signer,
				groupId,
				encryptedText: mls,
				nonce,
				keyVersion: 0n,
				kind: 'commit',
				messageSignature,
			});
			return true;
		} catch (error) {
			if (error instanceof RelayerTransportError && error.status === 409) return false;
			throw error;
		}
	}

	async postAppRow(signer: Signer, groupId: string, mls: Uint8Array) {
		const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
		const messageSignature = await signMessageContent(signer, {
			groupId,
			kind: 'event',
			encryptedText: mls,
			nonce,
			keyVersion: 0n,
		});
		await this.#transport.sendMessage({
			signer,
			groupId,
			encryptedText: mls,
			nonce,
			keyVersion: 0n,
			kind: 'event',
			messageSignature,
		});
	}

	async getSelfGroupInfo(signer: Signer) {
		const headers = await createWalletHeaderAuth(signer);
		try {
			const res = await this.#call<{ group_info: string }>('GET', '/v1/mls/self/group-info', headers);
			return fromHex(res.group_info);
		} catch (error) {
			if (error instanceof RelayerTransportError && error.status === 404) return null;
			throw error;
		}
	}

	async putSelfGroupInfo(signer: Signer, info: Uint8Array) {
		await this.#signedPost(signer, '/v1/mls/self/group-info', { group_info: toHex(info) }, 'PUT');
	}

	async postSelfMessage(signer: Signer, body: Uint8Array) {
		try {
			await this.#signedPost(signer, '/v1/mls/self/messages', { body: toHex(body) });
			return true;
		} catch (error) {
			if (error instanceof RelayerTransportError && error.status === 409) return false;
			throw error;
		}
	}

	async fetchSelf(signer: Signer, after: number, limit: number) {
		const headers = await createWalletHeaderAuth(signer);
		const res = await this.#call<{ items: { seq: number; body: string }[] }>(
			'GET',
			`/v1/mls/self/messages?after=${after}&limit=${limit}`,
			headers,
		);
		return res.items.map((i) => ({ seq: i.seq, body: fromHex(i.body) }));
	}

	async putBackupSegment(signer: Signer, keyId: string, body: Uint8Array) {
		const res = await this.#signedPost<{ seq: number }>(signer, '/v1/mls/backup/segments', {
			key_id: keyId,
			body: toHex(body),
		});
		return res.seq;
	}

	async listBackupSegments(signer: Signer, keyId: string, after: number, limit: number) {
		const headers = await createWalletHeaderAuth(signer);
		const res = await this.#call<{ items: { seq: number; body: string }[] }>(
			'GET',
			`/v1/mls/backup/segments?key_id=${encodeURIComponent(keyId)}&after=${after}&limit=${limit}`,
			headers,
		);
		return res.items.map((i) => ({ seq: i.seq, body: fromHex(i.body) }));
	}

	async deleteBackup(signer: Signer, keyId: string) {
		const timestamp = Math.floor(Date.now() / 1000);
		const sender = signer.toMySoAddress().toLowerCase();
		const canonical = new TextEncoder().encode(`${timestamp}:${sender}:${keyId}`);
		const auth = await signAndCreateAuthHeaders(signer, canonical);
		await this.#call('DELETE', `/v1/mls/backup/${encodeURIComponent(keyId)}`, {
			...auth,
			'x-sender-address': sender,
			'x-timestamp': String(timestamp),
		});
	}

	async fetchRows(signer: Signer, groupId: string, afterOrder: number, limit: number) {
		return this.#transport.fetchMessages({ signer, groupId, afterOrder, limit });
	}

	async deleteDevice(signer: Signer, deviceId: string) {
		const timestamp = Math.floor(Date.now() / 1000);
		const sender = signer.toMySoAddress().toLowerCase();
		// Wallet DELETEs sign the last path segment (binds the device id).
		const canonical = new TextEncoder().encode(`${timestamp}:${sender}:${deviceId}`);
		const auth = await signAndCreateAuthHeaders(signer, canonical);
		await this.#call('DELETE', `/v1/mls/devices/${encodeURIComponent(deviceId)}`, {
			...auth,
			'x-sender-address': sender,
			'x-timestamp': String(timestamp),
		});
	}
}
