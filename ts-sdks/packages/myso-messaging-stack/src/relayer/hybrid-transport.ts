// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { HTTPRelayerTransport, type HTTPRelayerTransportConfig } from './http-transport.js';
import type { RelayerTransport } from './transport.js';
import type {
	CheckDmGateParams,
	DeleteMessageParams,
	DeletePushTokenParams,
	DmGateResult,
	FetchMessageParams,
	FetchMessagesParams,
	FetchMessagesResult,
	FetchUnreadCountsParams,
	GetGroupPresenceParams,
	GetGroupReceiptsParams,
	GetUserReadStateParams,
	GroupPresenceEntry,
	GroupReceiptState,
	GroupUnreadCount,
	ListGroupPinsParams,
	ListGroupReactionsParams,
	ListAgentConversationsParams,
	ListGroupsForAgentParams,
	PostGroupReceiptsParams,
	PostGroupReactionParams,
	PostPresenceParams,
	PostPushTokenParams,
	PutUserReadStateParams,
	PutUserReadStateResult,
	RelayerMessage,
	RelayerReactionEntry,
	RelayerSubscriptionEvent,
	RelayerUserEvent,
	RelayerAgentConversation,
	SendMessageParams,
	SendMessageResult,
	SendTypingParams,
	SetGroupPinParams,
	SubscribeParams,
	SubscribeUserEventsParams,
	UpdateMessageParams,
	UserReadStateWire,
} from './types.js';
import { RelayerTransportError } from './types.js';
import { WSRelayerTransport, WsConnectionError } from './ws-transport.js';

export interface HybridRelayerTransportConfig extends HTTPRelayerTransportConfig {
	/**
	 * When `false`, `subscribe()` uses HTTP polling only (same as `realtime: 'poll'`).
	 * @default true
	 */
	preferWebSocket?: boolean;
	/**
	 * When `false`, WebSocket failures do not fall back to HTTP polling.
	 * @default true
	 */
	fallbackToHttp?: boolean;
	wsReconnectInitialMs?: number;
	wsReconnectMaxMs?: number;
	wsMaxReconnectAttempts?: number;
	WebSocket?: typeof WebSocket;
}

/**
 * Hybrid relayer transport: WebSocket for live `subscribe()`, HTTP for everything else.
 *
 * On persistent WebSocket failure, falls back to HTTP polling unless the error is a
 * non-retryable client error (4xx).
 */
export class HybridRelayerTransport implements RelayerTransport {
	readonly #http: HTTPRelayerTransport;
	readonly #ws: WSRelayerTransport;
	readonly #preferWebSocket: boolean;
	readonly #fallbackToHttp: boolean;

	constructor(config: HybridRelayerTransportConfig) {
		this.#http = new HTTPRelayerTransport(config);
		this.#ws = new WSRelayerTransport({
			relayerUrl: config.relayerUrl,
			apiPrefix: config.apiPrefix,
			reconnectInitialMs: config.wsReconnectInitialMs,
			reconnectMaxMs: config.wsReconnectMaxMs,
			maxReconnectAttempts: config.wsMaxReconnectAttempts,
			WebSocket: config.WebSocket,
		});
		this.#preferWebSocket = config.preferWebSocket ?? true;
		this.#fallbackToHttp = config.fallbackToHttp ?? true;
	}

	sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
		return this.#http.sendMessage(params);
	}

	fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult> {
		return this.#http.fetchMessages(params);
	}

	fetchMessage(params: FetchMessageParams): Promise<RelayerMessage> {
		return this.#http.fetchMessage(params);
	}

	updateMessage(params: UpdateMessageParams): Promise<void> {
		return this.#http.updateMessage(params);
	}

	deleteMessage(params: DeleteMessageParams): Promise<void> {
		return this.#http.deleteMessage(params);
	}

	async *subscribe(params: SubscribeParams): AsyncIterable<RelayerSubscriptionEvent> {
		if (!this.#preferWebSocket) {
			yield* this.#http.subscribe(params);
			return;
		}

		try {
			yield* this.#ws.subscribe(params);
		} catch (error) {
			if (this.#shouldEndStream(error)) return;
			yield* this.#http.subscribe(params);
		}
	}

	async *subscribeUserEvents(
		params: SubscribeUserEventsParams,
	): AsyncIterable<RelayerUserEvent> {
		if (!this.#preferWebSocket) {
			yield* this.#http.subscribeUserEvents(params);
			return;
		}

		try {
			yield* this.#ws.subscribeUserEvents(params);
		} catch (error) {
			if (this.#shouldEndStream(error)) return;
			yield* this.#http.subscribeUserEvents(params);
		}
	}

	/**
	 * Shared WS failure handling: throws non-retryable errors, returns `true`
	 * for aborts, and returns `false` when HTTP fallback should take over.
	 */
	#shouldEndStream(error: unknown): boolean {
		if (error instanceof RelayerTransportError && error.status >= 400 && error.status < 500) {
			throw error;
		}
		if (error instanceof WsConnectionError && !error.retryable) {
			throw error;
		}
		if (error instanceof DOMException && error.name === 'AbortError') {
			return true;
		}
		if (!this.#fallbackToHttp) {
			throw error;
		}
		return false;
	}

	fetchUnreadCounts(params: FetchUnreadCountsParams): Promise<GroupUnreadCount[]> {
		return this.#http.fetchUnreadCounts(params);
	}

	listGroupReactions(params: ListGroupReactionsParams): Promise<RelayerReactionEntry[]> {
		return this.#http.listGroupReactions(params);
	}

	postGroupReaction(params: PostGroupReactionParams): Promise<void> {
		return this.#http.postGroupReaction(params);
	}

	sendTyping(params: SendTypingParams): Promise<void> {
		return this.#http.sendTyping(params);
	}

	getGroupPresence(params: GetGroupPresenceParams): Promise<GroupPresenceEntry[]> {
		return this.#http.getGroupPresence(params);
	}

	listGroupPins(params: ListGroupPinsParams): Promise<number[]> {
		return this.#http.listGroupPins(params);
	}

	setGroupPin(params: SetGroupPinParams): Promise<void> {
		return this.#http.setGroupPin(params);
	}

	getGroupReceipts(params: GetGroupReceiptsParams): Promise<GroupReceiptState> {
		return this.#http.getGroupReceipts(params);
	}

	postGroupReceipts(params: PostGroupReceiptsParams): Promise<void> {
		return this.#http.postGroupReceipts(params);
	}

	getUserReadState(params: GetUserReadStateParams): Promise<UserReadStateWire> {
		return this.#http.getUserReadState(params);
	}

	putUserReadState(params: PutUserReadStateParams): Promise<PutUserReadStateResult> {
		return this.#http.putUserReadState(params);
	}

	postPushToken(params: PostPushTokenParams): Promise<void> {
		return this.#http.postPushToken(params);
	}

	deletePushToken(params: DeletePushTokenParams): Promise<void> {
		return this.#http.deletePushToken(params);
	}

	postPresence(params: PostPresenceParams): Promise<void> {
		return this.#http.postPresence(params);
	}

	listAgentConversations(
		params: ListAgentConversationsParams,
	): Promise<RelayerAgentConversation[]> {
		return this.#http.listAgentConversations(params);
	}

	listGroupsForAgent(params: ListGroupsForAgentParams): Promise<RelayerAgentConversation[]> {
		return this.#http.listGroupsForAgent(params);
	}

	checkDmGate(params: CheckDmGateParams): Promise<DmGateResult> {
		return this.#http.checkDmGate(params);
	}

	disconnect(): void {
		this.#http.disconnect();
		this.#ws.disconnect();
	}
}
