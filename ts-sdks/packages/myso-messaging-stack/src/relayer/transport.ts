// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type {
	DeleteMessageParams,
	FetchMessageParams,
	FetchMessagesParams,
	FetchMessagesResult,
	RelayerMessage,
	SendMessageParams,
	SendMessageResult,
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
	disconnect(): void;
}
