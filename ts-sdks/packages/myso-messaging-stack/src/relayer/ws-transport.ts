// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { createUserWsAuthQuery, createWsAuthQuery } from './auth-headers.js';
import type { SubscribeParams, SubscribeUserEventsParams } from './types.js';
import { RelayerTransportError } from './types.js';
import type { RelayerSubscriptionEvent, RelayerUserEvent } from './types.js';
import {
	fromWireMessage,
	fromWirePresenceEvent,
	fromWireReactionEvent,
	fromWireTypingEvent,
	fromWireUserFeedEvent,
	type WireMessageCreatedEvent,
	type WirePresenceEvent,
	type WireReactionUpdatedEvent,
	type WireTypingEvent,
	type WireUserFeedEvent,
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

function resolveUserWsPath(apiPrefix: string): string {
	if (apiPrefix) {
		return `${apiPrefix}/users/ws`;
	}
	return '/v1/users/ws';
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

/** Parses a group-feed frame into a domain event, or null to skip it. */
function parseGroupFrame(
	data: string,
	afterOrder: number | undefined,
): RelayerSubscriptionEvent | null {
	const frame = JSON.parse(data) as
		| WireMessageCreatedEvent
		| WireReactionUpdatedEvent
		| WireTypingEvent
		| WirePresenceEvent
		| { type?: string };
	if (frame.type === 'message.created' && 'message' in frame) {
		const message = fromWireMessage(frame.message);
		if (afterOrder !== undefined && message.order <= afterOrder) {
			return null;
		}
		return { type: 'message.created', message };
	}
	if (frame.type === 'reaction.updated' && 'chain_seq' in frame) {
		return { type: 'reaction.updated', reaction: fromWireReactionEvent(frame) };
	}
	if ((frame.type === 'typing.start' || frame.type === 'typing.stop') && 'member' in frame) {
		return { type: frame.type, typing: fromWireTypingEvent(frame as WireTypingEvent) };
	}
	if (frame.type === 'presence.updated' && 'member' in frame) {
		return { type: 'presence.updated', presence: fromWirePresenceEvent(frame) };
	}
	return null;
}

/** Parses a user-feed frame into a domain event, or null to skip it. */
function parseUserFrame(data: string): RelayerUserEvent | null {
	const frame = JSON.parse(data) as WireUserFeedEvent | { type?: string };
	if (!frame.type) {
		return null;
	}
	return fromWireUserFeedEvent(frame as WireUserFeedEvent);
}

/**
 * WebSocket transport for the realtime streams:
 * - `subscribe()` — per-group feed (`/v1/ws`): messages, reactions, typing, presence
 * - `subscribeUserEvents()` — wallet feed (`/v1/users/ws`): activity, read-state, discovery
 *
 * Frames are parsed into domain events directly — no HTTP refetch after delivery.
 */
export class WSRelayerTransport {
	readonly #relayerUrl: string;
	readonly #wsPath: string;
	readonly #userWsPath: string;
	readonly #reconnectInitialMs: number;
	readonly #reconnectMaxMs: number;
	readonly #maxReconnectAttempts: number;
	readonly #WebSocket: typeof WebSocket;
	#disconnected = false;
	/** Live sockets — closed immediately on {@link disconnect} so presence goes offline. */
	readonly #openSockets = new Set<WebSocket>();

	constructor(config: WSRelayerTransportConfig) {
		this.#relayerUrl = config.relayerUrl.replace(/\/+$/, '');
		const rawPrefix = (config.apiPrefix ?? '').trim();
		const apiPrefix =
			rawPrefix === ''
				? ''
				: (rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`).replace(/\/+$/, '');
		this.#wsPath = resolveWsPath(apiPrefix);
		this.#userWsPath = resolveUserWsPath(apiPrefix);
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
				const afterOrder = lastOrder;
				const query = await createWsAuthQuery(params.signer, params.groupId, afterOrder);
				const wsUrl = `${relayerUrlToWsBase(this.#relayerUrl)}${this.#wsPath}?${query}`;

				for await (const event of this.#connectAndStream(wsUrl, params.signal, (data) =>
					parseGroupFrame(data, afterOrder),
				)) {
					if (this.#disconnected || params.signal?.aborted) return;
					yield event;
					if (event.type === 'message.created') {
						lastOrder = event.message.order;
					}
					reconnectAttempt = 0;
				}
				return;
			} catch (error) {
				reconnectAttempt = await this.#handleStreamError(error, reconnectAttempt, params.signal);
				if (reconnectAttempt < 0) return;
			}
		}
	}

	async *subscribeUserEvents(params: SubscribeUserEventsParams): AsyncIterable<RelayerUserEvent> {
		let reconnectAttempt = 0;

		while (!this.#disconnected && !params.signal?.aborted) {
			try {
				const query = await createUserWsAuthQuery(params.signer);
				const wsUrl = `${relayerUrlToWsBase(this.#relayerUrl)}${this.#userWsPath}?${query}`;

				for await (const event of this.#connectAndStream(wsUrl, params.signal, parseUserFrame)) {
					if (this.#disconnected || params.signal?.aborted) return;
					yield event;
					reconnectAttempt = 0;
				}
				return;
			} catch (error) {
				reconnectAttempt = await this.#handleStreamError(error, reconnectAttempt, params.signal);
				if (reconnectAttempt < 0) return;
			}
		}
	}

	/**
	 * Shared stream error handling: rethrows non-retryable errors, returns -1
	 * to end the stream on abort/disconnect, otherwise waits with exponential
	 * backoff and returns the incremented attempt count.
	 */
	async #handleStreamError(
		error: unknown,
		reconnectAttempt: number,
		signal: AbortSignal | undefined,
	): Promise<number> {
		if (this.#disconnected || signal?.aborted) return -1;
		if (error instanceof RelayerTransportError && error.status >= 400 && error.status < 500) {
			throw error;
		}
		if (error instanceof WsConnectionError && !error.retryable) {
			throw error;
		}
		if (error instanceof DOMException && error.name === 'AbortError') {
			return -1;
		}

		const attempt = reconnectAttempt + 1;
		if (attempt > this.#maxReconnectAttempts) {
			throw error instanceof Error ? error : new WsConnectionError('WebSocket subscribe failed');
		}

		const backoff = Math.min(this.#reconnectInitialMs * 2 ** (attempt - 1), this.#reconnectMaxMs);
		try {
			await delay(backoff, signal);
		} catch {
			return -1;
		}
		return attempt;
	}

	async *#connectAndStream<TEvent>(
		wsUrl: string,
		signal: AbortSignal | undefined,
		parseFrame: (data: string) => TEvent | null,
	): AsyncIterable<TEvent> {
		if (this.#disconnected) {
			return;
		}

		const socket = new this.#WebSocket(wsUrl);
		this.#openSockets.add(socket);
		const messageQueue: TEvent[] = [];
		let resolveNext: ((value: TEvent | typeof STREAM_END) => void) | undefined;
		let streamEnded = false;
		const STREAM_END = Symbol('stream_end');

		const pushEvent = (event: TEvent) => {
			if (resolveNext) {
				resolveNext(event);
				resolveNext = undefined;
			} else {
				messageQueue.push(event);
			}
		};

		const onAbort = () => {
			socket.close();
			if (resolveNext) {
				resolveNext(STREAM_END);
				resolveNext = undefined;
			}
			streamEnded = true;
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		const waitForOpen = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new WsConnectionError('WebSocket connect timed out'));
			}, CONNECT_TIMEOUT_MS);

			const onAbortDuringOpen = () => {
				clearTimeout(timer);
				socket.close();
				reject(new DOMException('Aborted', 'AbortError'));
			};
			signal?.addEventListener('abort', onAbortDuringOpen, { once: true });

			socket.onopen = () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbortDuringOpen);
				resolve();
			};

			socket.onerror = () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbortDuringOpen);
				reject(new WsConnectionError('WebSocket connection failed'));
			};
		});

		socket.onmessage = (event) => {
			try {
				const data = typeof event.data === 'string' ? event.data : String(event.data);
				const parsed = parseFrame(data);
				if (parsed !== null) {
					pushEvent(parsed);
				}
			} catch {
				// Ignore malformed frames; server should only send valid JSON events.
			}
		};

		socket.onclose = () => {
			this.#openSockets.delete(socket);
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

			while (!this.#disconnected && !signal?.aborted && !streamEnded) {
				if (messageQueue.length > 0) {
					yield messageQueue.shift()!;
					continue;
				}

				const next = await new Promise<TEvent | typeof STREAM_END>((resolve) => {
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
			signal?.removeEventListener('abort', onAbort);
			this.#openSockets.delete(socket);
			const openState = this.#WebSocket.OPEN ?? 1;
			const connectingState = this.#WebSocket.CONNECTING ?? 0;
			if (socket.readyState === openState || socket.readyState === connectingState) {
				socket.close();
			}
		}
	}

	disconnect(): void {
		this.#disconnected = true;
		const openState = this.#WebSocket.OPEN ?? 1;
		const connectingState = this.#WebSocket.CONNECTING ?? 0;
		for (const socket of this.#openSockets) {
			if (socket.readyState === openState || socket.readyState === connectingState) {
				socket.close();
			}
		}
		this.#openSockets.clear();
	}
}
