// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type {
	DeleteMessageParams,
	DeletePushTokenParams,
	FetchMessageParams,
	FetchMessagesParams,
	FetchMessagesResult,
	GetGroupReceiptsParams,
	GetUserReadStateParams,
	GroupReceiptState,
	ListGroupPinsParams,
	ListGroupReactionsParams,
	ListAgentConversationsParams,
	ListGroupsForAgentParams,
	PostGroupReceiptsParams,
	PostGroupReactionParams,
	PostPresenceParams,
	PostPushTokenParams,
	PutUserReadStateParams,
	RelayerMessage,
	RelayerReactionEntry,
	RelayerAgentConversation,
	SendMessageParams,
	SendMessageResult,
	SetGroupPinParams,
	SubscribeParams,
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
	/** Subscribe to real-time messages. Use afterOrder for resumability. */
	subscribe(params: SubscribeParams): AsyncIterable<RelayerMessage>;
	/** Off-chain reaction tallies (`/v1/groups/.../reactions`). */
	listGroupReactions(params: ListGroupReactionsParams): Promise<RelayerReactionEntry[]>;
	postGroupReaction(params: PostGroupReactionParams): Promise<void>;
	/** Pinned `chain_seq` indices (`/v1/groups/.../pins`). */
	listGroupPins(params: ListGroupPinsParams): Promise<number[]>;
	setGroupPin(params: SetGroupPinParams): Promise<void>;
	getGroupReceipts(params: GetGroupReceiptsParams): Promise<GroupReceiptState>;
	postGroupReceipts(params: PostGroupReceiptsParams): Promise<void>;
	getUserReadState(params: GetUserReadStateParams): Promise<UserReadStateWire>;
	putUserReadState(params: PutUserReadStateParams): Promise<void>;
	postPushToken(params: PostPushTokenParams): Promise<void>;
	deletePushToken(params: DeletePushTokenParams): Promise<void>;
	postPresence(params: PostPresenceParams): Promise<void>;
	/** Wallet-authenticated agent group discovery for the signing principal. */
	listAgentConversations(params: ListAgentConversationsParams): Promise<RelayerAgentConversation[]>;
	/** Wallet-authenticated groups where `derivedAddress` is the creator actor. */
	listGroupsForAgent(params: ListGroupsForAgentParams): Promise<RelayerAgentConversation[]>;
	disconnect(): void;
}
