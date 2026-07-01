// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { RelayerTransport } from '../relayer/transport.js';
import { RelayerTransportError } from '../relayer/types.js';
import { decryptReadState, encryptReadState } from './read-state-crypto.js';
import { createEmptyReadState, mergeReadState, type UserReadState } from './types.js';

export class ReadStateManager {
	readonly #transport: RelayerTransport;

	constructor(transport: RelayerTransport) {
		this.#transport = transport;
	}

	async getReadState(signer: Signer): Promise<UserReadState> {
		try {
			const wire = await this.#transport.getUserReadState({ signer });
			return decryptReadState(signer, wire.encryptedBlob);
		} catch (error) {
			if (error instanceof RelayerTransportError && error.status === 404) {
				return createEmptyReadState();
			}
			throw error;
		}
	}

	async updateReadState(options: {
		signer: Signer;
		groupId: string;
		readUpto: number;
		localState?: UserReadState;
	}): Promise<UserReadState> {
		const base = options.localState ?? (await this.getReadState(options.signer));
		const merged: UserReadState = {
			version: 1,
			updatedAt: Date.now(),
			groups: {
				...base.groups,
				[options.groupId]: {
					readUpto: Math.max(base.groups[options.groupId]?.readUpto ?? 0, options.readUpto),
					muted: base.groups[options.groupId]?.muted,
				},
			},
		};

		let remote: UserReadState | undefined;
		try {
			const wire = await this.#transport.getUserReadState({ signer: options.signer });
			remote = await decryptReadState(options.signer, wire.encryptedBlob);
		} catch {
			remote = undefined;
		}

		const finalState = remote ? mergeReadState(merged, remote) : merged;
		finalState.groups[options.groupId] = {
			readUpto: Math.max(finalState.groups[options.groupId]?.readUpto ?? 0, options.readUpto),
			muted: finalState.groups[options.groupId]?.muted,
		};
		finalState.updatedAt = Date.now();

		const encryptedBlob = await encryptReadState(options.signer, finalState);
		await this.#transport.putUserReadState({
			signer: options.signer,
			encryptedBlob,
			blobVersion: finalState.updatedAt,
		});
		return finalState;
	}

	async getUnreadCounts(options: {
		signer: Signer;
		groupIds: string[];
		readState?: UserReadState;
	}): Promise<Record<string, number>> {
		const readState = options.readState ?? (await this.getReadState(options.signer));
		const counts: Record<string, number> = {};

		for (const groupId of options.groupIds) {
			const readUpto = readState.groups[groupId]?.readUpto ?? 0;
			const { messages } = await this.#transport.fetchMessages({
				signer: options.signer,
				groupId,
				afterOrder: readUpto,
				limit: 500,
			});
			counts[groupId] = messages.filter((m) => !m.isDeleted).length;
		}

		return counts;
	}
}
