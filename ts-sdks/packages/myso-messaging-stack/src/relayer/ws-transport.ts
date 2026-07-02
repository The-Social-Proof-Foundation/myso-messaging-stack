// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { createWsAuthQuery } from './auth-headers.js';
import type { SubscribeParams } from './types.js';
import { RelayerTransportError } from './types.js';
import type { RelayerSubscriptionEvent } from './types.js';
import {
	fromWireMessage,
	fromWireReactionEvent,
	type WireMessageCreatedEvent,
	type WireReactionUpdatedEvent,
} from './wire.js';

/** Thrown when a WebSocket connection cannot be established or is lost. */
export class WsConnectionError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable = true) {
		super(message);
		this.name = 'WsConnectionError';
		this.retryable = retryable;
	}
}

export interface WSRelayerTransportConfig {
	relayerUrl: string;
	/**
	 * Prefix for the WebSocket path, e.g. `/v1` → `/v1/ws`.
	 * When omitted, uses `/v1/ws` (the relayer only exposes WS on v1).
	 */
	apiPrefix?: string;
	reconnectInitialMs?: number;
	reconnectMaxMs?: number;
	maxReconnectAttempts?: number;
	/** Injectable WebSocket constructor (for unit tests). */
	WebSocket?: typeof WebSocket;
}

const DEFAULT_RECONNECT_INITIAL_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 10_000;

function relayerUrlToWsBase(relayerUrl: string): string {
	const url = new URL(relayerUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.origin;
}

function resolveWsPath(apiPrefix: string): string {
	if (apiPrefix) {
		return `${apiPrefix}/ws`;
	}
	return '/v1/ws';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new DOMException('Aborted', 'AbortError'));
			},
			{ once: true },
		);
	});
}

/**
 * WebSocket transport for realtime `subscribe()` only.
 *
 * Parses `{ type: "message.created", message: WireMessageResponse }` and
 * `{ type: "reaction.updated", ... }` frames and yields domain events
 * directly — no HTTP refetch after delivery.
 */
export class WSRelayerTransport {
	readonly #relayerUrl: string;
	readonly #wsPath: string;
	readonly #reconnectInitialMs: number;
	readonly #reconnectMaxMs: number;
	readonly #maxReconnectAttempts: number;
	readonly #WebSocket: typeof WebSocket;
	#disconnected = false;

	constructor(config: WSRelayerTransportConfig) {
		this.#relayerUrl = config.relayerUrl.replace(/\/+$/, '');
		const rawPrefix = (config.apiPrefix ?? '').trim();
		const apiPrefix =
			rawPrefix === ''
				? ''
				: (rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`).replace(/\/+$/, '');
		this.#wsPath = resolveWsPath(apiPrefix);
		this.#reconnectInitialMs = config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
		this.#reconnectMaxMs = config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
		this.#maxReconnectAttempts = config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
		this.#WebSocket = config.WebSocket ?? globalThis.WebSocket;
	}

	async *subscribe(params: SubscribeParams): AsyncIterable<RelayerSubscriptionEvent> {
		let lastOrder = params.afterOrder;
		let reconnectAttempt = 0;

		while (!this.#disconnected && !params.signal?.aborted) {
			try {
				for await (const event of this.#connectAndStream(params, lastOrder)) {
					if (this.#disconnected || params.signal?.aborted) return;
					yield event;
					if (event.type === 'message.created') {
						lastOrder = event.message.order;
					}
					reconnectAttempt = 0;
				}
				return;
			} catch (error) {
				if (this.#disconnected || params.signal?.aborted) return;
				if (error instanceof RelayerTransportError && error.status >= 400 && error.status < 500) {
					throw error;
				}
				if (error instanceof WsConnectionError && !error.retryable) {
					throw error;
				}
				if (error instanceof DOMException && error.name === 'AbortError') {
					return;
				}

				reconnectAttempt += 1;
				if (reconnectAttempt > this.#maxReconnectAttempts) {
					throw error instanceof Error
						? error
						: new WsConnectionError('WebSocket subscribe failed');
				}

				const backoff = Math.min(
					this.#reconnectInitialMs * 2 ** (reconnectAttempt - 1),
					this.#reconnectMaxMs,
				);
				await delay(backoff, params.signal);
			}
		}
	}

	async *#connectAndStream(
		params: SubscribeParams,
		afterOrder: number | undefined,
	): AsyncIterable<RelayerSubscriptionEvent> {
		const query = await createWsAuthQuery(params.signer, params.groupId, afterOrder);
		const wsUrl = `${relayerUrlToWsBase(this.#relayerUrl)}${this.#wsPath}?${query}`;

		const socket = new this.#WebSocket(wsUrl);
		const messageQueue: RelayerSubscriptionEvent[] = [];
		let resolveNext: ((value: RelayerSubscriptionEvent | typeof STREAM_END) => void) | undefined;
		let streamEnded = false;
		const STREAM_END = Symbol('stream_end');

		const pushEvent = (event: RelayerSubscriptionEvent) => {
			if (resolveNext) {
				resolveNext(event);
				resolveNext = undefined;
			} else {
				messageQueue.push(event);
			}
		};

		const waitForOpen = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new WsConnectionError('WebSocket connect timed out'));
			}, CONNECT_TIMEOUT_MS);

			const onAbort = () => {
				clearTimeout(timer);
				socket.close();
				reject(new DOMException('Aborted', 'AbortError'));
			};
			params.signal?.addEventListener('abort', onAbort, { once: true });

			socket.onopen = () => {
				clearTimeout(timer);
				params.signal?.removeEventListener('abort', onAbort);
				resolve();
			};

			socket.onerror = () => {
				clearTimeout(timer);
				params.signal?.removeEventListener('abort', onAbort);
				reject(new WsConnectionError('WebSocket connection failed'));
			};
		});

		socket.onmessage = (event) => {
			try {
				const data = typeof event.data === 'string' ? event.data : String(event.data);
				const frame = JSON.parse(data) as
					| WireMessageCreatedEvent
					| WireReactionUpdatedEvent
					| { type?: string };
				if (frame.type === 'message.created' && 'message' in frame) {
					const message = fromWireMessage(frame.message);
					if (afterOrder !== undefined && message.order <= afterOrder) {
						return;
					}
					pushEvent({ type: 'message.created', message });
				} else if (frame.type === 'reaction.updated' && 'chain_seq' in frame) {
					pushEvent({ type: 'reaction.updated', reaction: fromWireReactionEvent(frame) });
				}
			} catch {
				// Ignore malformed frames; server should only send valid JSON events.
			}
		};

		socket.onclose = () => {
			if (!streamEnded) {
				if (resolveNext) {
					resolveNext(STREAM_END);
					resolveNext = undefined;
				}
				streamEnded = true;
			}
		};

		try {
			await waitForOpen;

			while (!this.#disconnected && !params.signal?.aborted && !streamEnded) {
				if (messageQueue.length > 0) {
					yield messageQueue.shift()!;
					continue;
				}

				const next = await new Promise<RelayerSubscriptionEvent | typeof STREAM_END>((resolve) => {
					if (messageQueue.length > 0) {
						resolve(messageQueue.shift()!);
						return;
					}
					if (streamEnded) {
						resolve(STREAM_END);
						return;
					}
					resolveNext = resolve;
				});

				if (next === STREAM_END) {
					throw new WsConnectionError('WebSocket closed');
				}
				yield next;
			}
		} finally {
			const openState = this.#WebSocket.OPEN ?? 1;
			const connectingState = this.#WebSocket.CONNECTING ?? 0;
			if (socket.readyState === openState || socket.readyState === connectingState) {
				socket.close();
			}
		}
	}

	disconnect(): void {
		this.#disconnected = true;
	}
}
