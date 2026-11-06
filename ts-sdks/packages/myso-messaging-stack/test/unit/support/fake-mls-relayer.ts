// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { MlsRelayer } from '../../../src/mls/relayer.js';
import type { MlsDeviceCertificate, MlsWasmModule } from '../../../src/mls/types.js';
import type { RelayerMessage } from '../../../src/relayer/types.js';

/** In-memory relayer: ordered log per group, one commit per epoch (like the real one). */
export class FakeRelayer implements MlsRelayer {
	rows = new Map<string, RelayerMessage[]>();
	epochs = new Map<string, number>();
	kps: { wallet: string; deviceId: string; keyPackage: Uint8Array; claimed: boolean }[] = [];
	welcomes: { groupId: string; wallet: string; deviceId: string; welcome: Uint8Array }[] = [];
	infos = new Map<string, Uint8Array>();
	#order = 0;

	constructor(private readonly mls: MlsWasmModule) {}

	append(groupId: string, sender: string, kind: RelayerMessage['kind'], bytes: Uint8Array) {
		const list = this.rows.get(groupId) ?? [];
		const order = ++this.#order;
		list.push({
			messageId: `r${order}`, groupId, order, encryptedText: bytes, nonce: new Uint8Array(12),
			keyVersion: 0n, senderAddress: sender, createdAt: order, updatedAt: order, attachments: [],
			isEdited: false, isDeleted: false, signature: '', publicKey: '', isAgentMessage: false, kind,
		});
		this.rows.set(groupId, list);
	}
	async putKeyPackages(signer: Signer, deviceId: string, _c: MlsDeviceCertificate, kps: Uint8Array[]) {
		for (const k of kps) this.kps.push({ wallet: signer.toMySoAddress().toLowerCase(), deviceId, keyPackage: k, claimed: false });
	}
	async claimKeyPackages(_s: Signer, wallets: string[]) {
		const seen = new Set<string>();
		const out = [];
		for (const k of this.kps) {
			const id = `${k.wallet}|${k.deviceId}`;
			if (k.claimed || !wallets.includes(k.wallet) || seen.has(id)) continue;
			k.claimed = true;
			seen.add(id);
			out.push({ wallet: k.wallet, deviceId: k.deviceId, keyPackage: k.keyPackage });
		}
		return out;
	}
	async postWelcome(_s: Signer, groupId: string, recipients: { wallet: string; deviceId: string }[], welcome: Uint8Array) {
		for (const r of recipients) this.welcomes.push({ groupId, ...r, welcome });
	}
	async takeWelcomes(signer: Signer, deviceId: string) {
		const wallet = signer.toMySoAddress().toLowerCase();
		const mine = this.welcomes.filter((w) => w.wallet === wallet && w.deviceId === deviceId);
		this.welcomes = this.welcomes.filter((w) => !mine.includes(w));
		return mine.map((w) => ({ groupId: w.groupId, welcome: w.welcome }));
	}
	async postGroupInfo(_s: Signer, groupId: string, info: Uint8Array) {
		this.infos.set(groupId, info);
	}
	async getGroupInfo(_s: Signer, groupId: string) {
		return this.infos.get(groupId) ?? null;
	}
	/** Next control row is accepted, then the call fails anyway (a timeout after the write). */
	failAfterAccept = false;
	async postControlRow(signer: Signer, groupId: string, bytes: Uint8Array) {
		const info = JSON.parse(this.mls.mlsInspect(bytes)) as { kind: string; epoch: number };
		if (info.kind === 'commit') {
			const current = this.epochs.get(groupId) ?? 0;
			if (Number(info.epoch) !== current) return false;
			this.epochs.set(groupId, current + 1);
		}
		this.append(groupId, signer.toMySoAddress().toLowerCase(), 'commit', bytes);
		if (this.failAfterAccept) {
			this.failAfterAccept = false;
			throw new Error('network timeout');
		}
		return true;
	}
	fetchFailures = 0;
	async fetchRows(_s: Signer, groupId: string, afterOrder: number, limit: number) {
		if (this.fetchFailures > 0) {
			this.fetchFailures--;
			throw new Error('network down');
		}
		const rows = (this.rows.get(groupId) ?? []).filter((r) => r.order > afterOrder);
		return { messages: rows.slice(0, limit), hasNext: rows.length > limit };
	}
	selfLogs = new Map<string, { seq: number; body: Uint8Array }[]>();
	selfInfos = new Map<string, Uint8Array>();
	async postAppRow(signer: Signer, groupId: string, mls: Uint8Array) {
		this.append(groupId, signer.toMySoAddress().toLowerCase(), 'event', mls);
	}
	async getSelfGroupInfo(signer: Signer) {
		return this.selfInfos.get(signer.toMySoAddress().toLowerCase()) ?? null;
	}
	async putSelfGroupInfo(signer: Signer, info: Uint8Array) {
		this.selfInfos.set(signer.toMySoAddress().toLowerCase(), info);
	}
	async postSelfMessage(signer: Signer, body: Uint8Array) {
		const wallet = signer.toMySoAddress().toLowerCase();
		const self = `self:${wallet}`;
		const info = JSON.parse(this.mls.mlsInspect(body)) as { kind: string; epoch: number };
		if (info.kind === 'commit') {
			const current = this.epochs.get(self) ?? 0;
			if (Number(info.epoch) !== current) return false;
			this.epochs.set(self, current + 1);
		}
		const log = this.selfLogs.get(wallet) ?? [];
		log.push({ seq: log.length + 1, body });
		this.selfLogs.set(wallet, log);
		return true;
	}
	async fetchSelf(signer: Signer, after: number, limit: number) {
		return (this.selfLogs.get(signer.toMySoAddress().toLowerCase()) ?? []).filter((i) => i.seq > after).slice(0, limit);
	}
	backup: { wallet: string; keyId: string; seq: number; body: Uint8Array }[] = [];
	async putBackupSegment(signer: Signer, keyId: string, body: Uint8Array) {
		const seq = this.backup.length + 1;
		this.backup.push({ wallet: signer.toMySoAddress().toLowerCase(), keyId, seq, body });
		return seq;
	}
	async listBackupSegments(signer: Signer, keyId: string, after: number, limit: number) {
		const wallet = signer.toMySoAddress().toLowerCase();
		return this.backup.filter((b) => b.wallet === wallet && b.keyId === keyId && b.seq > after).slice(0, limit);
	}
	async deleteBackup(signer: Signer, keyId: string) {
		const wallet = signer.toMySoAddress().toLowerCase();
		this.backup = this.backup.filter((b) => !(b.wallet === wallet && b.keyId === keyId));
	}
	async deleteDevice(signer: Signer, deviceId: string) {
		const wallet = signer.toMySoAddress().toLowerCase();
		this.kps = this.kps.filter((k) => !(k.wallet === wallet && k.deviceId === deviceId && !k.claimed));
	}
}

