// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export type {
	RelayerMessage,
	SyncStatus,
	SendMessageParams,
	SendMessageResult,
	FetchMessagesParams,
	FetchMessagesResult,
	FetchMessageParams,
	UpdateMessageParams,
	DeleteMessageParams,
	SubscribeParams,
	RelayerReactionEntry,
	ListGroupReactionsParams,
	PostGroupReactionParams,
	ListGroupPinsParams,
	SetGroupPinParams,
	GroupReceiptState,
	GetGroupReceiptsParams,
	PostGroupReceiptsParams,
	GetUserReadStateParams,
	PutUserReadStateParams,
	UserReadStateWire,
	PostPushTokenParams,
	DeletePushTokenParams,
	PostPresenceParams,
	RelayerConfig,
	RelayerHTTPConfig,
} from './types.js';

export { RelayerTransportError } from './types.js';

export type { RelayerTransport } from './transport.js';

export { HTTPRelayerTransport, type HTTPRelayerTransportConfig } from './http-transport.js';
export { HybridRelayerTransport, type HybridRelayerTransportConfig } from './hybrid-transport.js';
export {
	WSRelayerTransport,
	WsConnectionError,
	type WSRelayerTransportConfig,
} from './ws-transport.js';
export { fromWireMessage, toWireAttachment, type WireMessageResponse } from './wire.js';
export { createHeaderAuth, createWsAuthQuery } from './auth-headers.js';
