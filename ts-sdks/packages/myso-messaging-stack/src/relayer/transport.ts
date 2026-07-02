// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

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

/**
 * Protocol-agnostic interface for communicating with a message backend.
 *
 * Implement this to connect the SDK to any message delivery/storage system.
 * The SDK ships with {@link HTTPRelayerTransport} as a reference implementation.
 */
export interface RelayerTransport {
	sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
	fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult>;
	fetchMessage(params: FetchMessageParams): Promise<RelayerMessage>;
	updateMessage(params: UpdateMessageParams): Promise<void>;
	deleteMessage(params: DeleteMessageParams): Promise<void>;
	/**
	 * Subscribe to a group's real-time events (messages, reactions, typing,
	 * presence) as a single stream. Use afterOrder for message resumability.
	 */
	subscribe(params: SubscribeParams): AsyncIterable<RelayerSubscriptionEvent>;
	/**
	 * Subscribe to the wallet-scoped user feed (`/v1/users/ws`): group
	 * activity, cross-device read-state updates, and group discovery. One
	 * socket per wallet — metadata only, REST stays the source of truth.
	 */
	subscribeUserEvents(params: SubscribeUserEventsParams): AsyncIterable<RelayerUserEvent>;
	/**
	 * Batch per-group activity (`POST /v1/users/unread-counts`): exact unread
	 * counts + latest order in one round trip. Groups the wallet cannot read
	 * are omitted from the result.
	 */
	fetchUnreadCounts(params: FetchUnreadCountsParams): Promise<GroupUnreadCount[]>;
	/** Off-chain reaction tallies (`/v1/groups/.../reactions`). */
	listGroupReactions(params: ListGroupReactionsParams): Promise<RelayerReactionEntry[]>;
	postGroupReaction(params: PostGroupReactionParams): Promise<void>;
	/** Ephemeral typing indicator broadcast (`/v1/groups/.../typing`). */
	sendTyping(params: SendTypingParams): Promise<void>;
	/** Presence snapshot for a group's members (`/v1/groups/.../presence`). */
	getGroupPresence(params: GetGroupPresenceParams): Promise<GroupPresenceEntry[]>;
	/** Pinned `chain_seq` indices (`/v1/groups/.../pins`). */
	listGroupPins(params: ListGroupPinsParams): Promise<number[]>;
	setGroupPin(params: SetGroupPinParams): Promise<void>;
	getGroupReceipts(params: GetGroupReceiptsParams): Promise<GroupReceiptState>;
	postGroupReceipts(params: PostGroupReceiptsParams): Promise<void>;
	getUserReadState(params: GetUserReadStateParams): Promise<UserReadStateWire>;
	/**
	 * Stores the encrypted read-state blob. Pass `expectedVersion` for
	 * compare-and-set semantics; throws `ReadStateConflictError` (with the
	 * current record) on mismatch. Returns the server-assigned version.
	 */
	putUserReadState(params: PutUserReadStateParams): Promise<PutUserReadStateResult>;
	postPushToken(params: PostPushTokenParams): Promise<void>;
	deletePushToken(params: DeletePushTokenParams): Promise<void>;
	postPresence(params: PostPresenceParams): Promise<void>;
	/** Wallet-authenticated agent group discovery for the signing principal. */
	listAgentConversations(params: ListAgentConversationsParams): Promise<RelayerAgentConversation[]>;
	/** Wallet-authenticated groups where `derivedAddress` is the creator actor. */
	listGroupsForAgent(params: ListGroupsForAgentParams): Promise<RelayerAgentConversation[]>;
	/**
	 * Advisory DM-gate pre-check (`/v1/messaging/dm-gate`) — blocked / paid-DM
	 * status before sending. Enforcement stays on `sendMessage` (402).
	 */
	checkDmGate(params: CheckDmGateParams): Promise<DmGateResult>;
	disconnect(): void;
}
