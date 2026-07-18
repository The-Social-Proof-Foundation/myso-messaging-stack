// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import { HttpTimeoutError } from '../http/errors.js';
import { DEFAULT_HTTP_TIMEOUT, type HttpClientConfig } from '../http/types.js';
import { createHeaderAuth } from '../relayer/auth-headers.js';
import type { FetchMessagesResult, RelayerMessage } from '../relayer/types.js';
import { fromFileStorageMessage } from './file-storage-message.js';
import type { RecoverMessagesParams, RecoveryTransport } from './transport.js';
import type { FileStorageMessageWire } from './types.js';

export interface RelayerArchiveRecoveryConfig extends HttpClientConfig {
	/** Relayer base URL (same host as live messaging). */
	relayerUrl: string;
	/** Platform namespace (must match relayer `ARCHIVE_NAMESPACE`). */
	namespace: string;
	/** Signer for wallet auth headers on archive GET. */
	signer: Signer;
	/**
	 * API prefix for archive routes.
	 * @default '/v1'
	 */
	apiPrefix?: string;
}

interface ArchiveMessagesResponse {
	groupId: string;
	hasNext: boolean;
	messages: FileStorageMessageWire[];
}

/**
 * Recovery transport that reads archived messages from the relayer's
 * in-process R2 archive (`GET /v1/archive/groups/:groupId/messages`).
 *
 * Wire format matches File Storage patches, so {@link fromFileStorageMessage}
 * is reused for conversion.
 */
export class RelayerArchiveRecoveryTransport implements RecoveryTransport {
	readonly #relayerUrl: string;
	readonly #namespace: string;
	readonly #signer: Signer;
	readonly #apiPrefix: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeout: number;
	readonly #onError?: (error: Error) => void;

	constructor(config: RelayerArchiveRecoveryConfig) {
		this.#relayerUrl = config.relayerUrl.replace(/\/+$/, '');
		this.#namespace = config.namespace;
		this.#signer = config.signer;
		this.#apiPrefix = (config.apiPrefix ?? '/v1').replace(/\/+$/, '');
		this.#fetch = config.fetch ?? globalThis.fetch;
		this.#timeout = config.timeout ?? DEFAULT_HTTP_TIMEOUT;
		this.#onError = config.onError;
	}

	async recoverMessages(params: RecoverMessagesParams): Promise<FetchMessagesResult> {
		const queryParams = new URLSearchParams();
		queryParams.set('namespace', this.#namespace);
		if (params.limit !== undefined) {
			queryParams.set('limit', params.limit.toString());
		}
		if (params.afterOrder !== undefined) {
			queryParams.set('after_order', params.afterOrder.toString());
		}
		if (params.beforeOrder !== undefined) {
			queryParams.set('before_order', params.beforeOrder.toString());
		}

		const url = `${this.#relayerUrl}${this.#apiPrefix}/archive/groups/${encodeURIComponent(params.groupId)}/messages?${queryParams}`;
		const authHeaders = await createHeaderAuth(this.#signer, params.groupId);

		const response = await this.#request<ArchiveMessagesResponse>(url, authHeaders);
		const active = (response.messages ?? []).filter(
			(m) => m.sync_status !== 'DELETED' && m.sync_status !== 'DELETE_PENDING',
		);

		const messages: RelayerMessage[] = active.map((wire) => fromFileStorageMessage(wire));
		messages.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

		return {
			messages,
			hasNext: response.hasNext ?? false,
		};
	}

	async #request<T>(url: string, headers: Record<string, string>): Promise<T> {
		try {
			const res = await this.#fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(this.#timeout),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`Relayer archive returned ${res.status}: ${text}`);
			}
			return (await res.json()) as T;
		} catch (err) {
			if (err instanceof Error && err.name === 'TimeoutError') {
				const timeoutErr = new HttpTimeoutError(url, this.#timeout);
				this.#onError?.(timeoutErr);
				throw timeoutErr;
			}
			const wrapped =
				err instanceof Error ? err : new Error('Relayer archive request failed', { cause: err });
			this.#onError?.(wrapped);
			throw wrapped;
		}
	}
}

/** @deprecated Use {@link RelayerArchiveRecoveryConfig}. */
export type CloudflareRecoveryConfig = RelayerArchiveRecoveryConfig;
