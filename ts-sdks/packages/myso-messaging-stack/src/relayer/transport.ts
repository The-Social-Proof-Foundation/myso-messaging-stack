// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type {
	DeleteMessageParams,
	FetchMessageParams,
	FetchMessagesParams,
	FetchMessagesResult,
	GetGroupReceiptsParams,
	GroupReceiptState,
	ListGroupPinsParams,
	ListGroupReactionsParams,
	PostGroupReceiptsParams,
	PostGroupReactionParams,
	RelayerMessage,
	RelayerReactionEntry,
	SendMessageParams,
	SendMessageResult,
	SetGroupPinParams,
	SubscribeParams,
	UpdateMessageParams,
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
	disconnect(): void;
}
