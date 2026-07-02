// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { HttpClientConfig } from '../http/types.js';
import { DEFAULT_HTTP_TIMEOUT } from '../http/types.js';
import { HttpTimeoutError } from '../http/errors.js';
import { createWalletHeaderAuth } from './auth-headers.js';
import { RelayerTransportError } from './types.js';
import type {
	AckWorkflowItemParams,
	DismissWorkflowItemParams,
	ListWorkflowItemsParams,
	WorkflowBadgeParams,
	WorkflowItem,
} from './types.js';
import {
	fromWireWorkflowItem,
	type WireListWorkflowResponse,
	type WireWorkflowBadgeResponse,
	type WireWorkflowItem,
} from './wire.js';

export interface WorkflowClientConfig extends HttpClientConfig {
	relayerUrl: string;
	/** REST prefix, e.g. `/v1`. Default `/v1`. */
	apiPrefix?: string;
}

/**
 * Wallet-authenticated client for the workflow inbox REST surface.
 * Realtime updates arrive on the existing user-feed WebSocket transport.
 */
export class WorkflowClient {
	readonly #relayerUrl: string;
	readonly #apiPrefix: string;
	readonly #timeoutMs: number;

	constructor(config: WorkflowClientConfig) {
		this.#relayerUrl = config.relayerUrl.replace(/\/+$/, '');
		const rawPrefix = (config.apiPrefix ?? '/v1').trim();
		this.#apiPrefix =
			rawPrefix === ''
				? ''
				: (rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`).replace(/\/+$/, '');
		this.#timeoutMs = config.timeout ?? DEFAULT_HTTP_TIMEOUT;
	}

	async listItems(params: ListWorkflowItemsParams): Promise<WorkflowItem[]> {
		const headers = await createWalletHeaderAuth(params.signer);
		const query = new URLSearchParams();
		if (params.status) {
			query.set('status', params.status);
		}
		if (params.itemType) {
			query.set('type', params.itemType);
		}
		if (params.cursor) {
			query.set('cursor', params.cursor);
		}
		if (params.limit !== undefined) {
			query.set('limit', String(params.limit));
		}
		const suffix = query.size > 0 ? `?${query.toString()}` : '';
		const wire = await this.#request<WireListWorkflowResponse>(
			`${this.#apiPrefix}/workflow/items${suffix}`,
			{ method: 'GET', headers },
		);
		return wire.items.map(fromWireWorkflowItem);
	}

	async ackItem(params: AckWorkflowItemParams): Promise<WorkflowItem> {
		const headers = await createWalletHeaderAuth(params.signer);
		const wire = await this.#request<WireWorkflowItem>(
			`${this.#apiPrefix}/workflow/items/${params.itemId}/ack`,
			{ method: 'POST', headers },
		);
		return fromWireWorkflowItem(wire);
	}

	async dismissItem(params: DismissWorkflowItemParams): Promise<WorkflowItem> {
		const headers = await createWalletHeaderAuth(params.signer);
		const wire = await this.#request<WireWorkflowItem>(
			`${this.#apiPrefix}/workflow/items/${params.itemId}/dismiss`,
			{ method: 'POST', headers },
		);
		return fromWireWorkflowItem(wire);
	}

	async badge(params: WorkflowBadgeParams): Promise<number> {
		const headers = await createWalletHeaderAuth(params.signer);
		const wire = await this.#request<WireWorkflowBadgeResponse>(
			`${this.#apiPrefix}/workflow/badge`,
			{ method: 'GET', headers },
		);
		return wire.open_count;
	}

	async #request<T>(path: string, init: RequestInit): Promise<T> {
		const url = `${this.#relayerUrl}${path}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const response = await fetch(url, {
				...init,
				signal: controller.signal,
			});
			if (!response.ok) {
				let body: unknown;
				try {
					body = await response.json();
				} catch {
					body = undefined;
				}
				const code =
					body && typeof body === 'object' && 'code' in body
						? String((body as { code: unknown }).code)
						: undefined;
				const message =
					body && typeof body === 'object' && 'message' in body
						? String((body as { message: unknown }).message)
						: `HTTP ${response.status}`;
				throw new RelayerTransportError(message, response.status, code, body);
			}
			if (response.status === 204) {
				return undefined as T;
			}
			return (await response.json()) as T;
		} catch (error) {
			if (error instanceof RelayerTransportError) {
				throw error;
			}
			if (error instanceof Error && error.name === 'AbortError') {
				throw new HttpTimeoutError(url, this.#timeoutMs);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}
