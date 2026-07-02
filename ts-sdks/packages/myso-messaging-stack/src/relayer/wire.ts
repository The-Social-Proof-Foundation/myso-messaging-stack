// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { fromHex } from '@socialproof/myso/utils';

import type { Attachment } from '../attachments/types.js';
import type {
	RelayerMessage,
	RelayerPresenceEvent,
	RelayerReactionEvent,
	RelayerTypingEvent,
	RelayerUserEvent,
	SyncStatus,
	WorkflowItem,
} from './types.js';

/** Raw attachment JSON shape from the relayer API (snake_case). */
export interface WireAttachment {
	storage_id: string;
	nonce: string;
	encrypted_metadata: string;
	metadata_nonce: string;
}

export interface WireMessageResponse {
	message_id: string;
	group_id: string;
	order: number;
	encrypted_text: string | null;
	nonce: string | null;
	key_version: number;
	sender_address: string;
	created_at: number;
	updated_at: number;
	attachments: WireAttachment[] | null;
	is_edited: boolean;
	is_deleted: boolean;
	sync_status: string;
	quilt_patch_id: string | null;
	signature: string;
	public_key: string;
	principal_owner?: string | null;
	sub_agent_id?: string | null;
	identity_class?: number | null;
}

export interface WireMessageCreatedEvent {
	type: 'message.created';
	message: WireMessageResponse;
}

/** `reaction.updated` WS frame / NOTIFY payload (snake_case). */
export interface WireReactionUpdatedEvent {
	type: 'reaction.updated';
	group_id: string;
	chain_seq: number;
	emoji: string;
	count: number;
	reactors: string[];
}

/** `typing.start` / `typing.stop` WS frames (snake_case). */
export interface WireTypingEvent {
	type: 'typing.start' | 'typing.stop';
	group_id: string;
	member: string;
	expires_at?: number;
}

/** `presence.updated` WS frame (snake_case). */
export interface WirePresenceEvent {
	type: 'presence.updated';
	group_id: string;
	member: string;
	online: boolean;
}

/** User feed (`/v1/users/ws`) frames (snake_case). */
export type WireUserFeedEvent =
	| { type: 'group.activity'; group_id: string; latest_order: number }
	| { type: 'read_state.updated'; wallet: string; blob_version: number }
	| { type: 'group.discovered'; group_id: string; reason: string }
	| { type: 'group.hidden'; group_id: string }
	| { type: 'workflow.item.created'; item_id: string; item_type: string; status: string }
	| { type: 'workflow.item.updated'; item_id: string; item_type: string; status: string };

/** Workflow inbox item from REST (snake_case). */
export interface WireWorkflowItem {
	id: string;
	idempotency_key: string;
	item_type: string;
	status: string;
	title: string;
	body?: string | null;
	payload: unknown;
	organization_id?: string | null;
	account_id?: string | null;
	source_service: string;
	action_deadline_ms?: number | null;
	conversation_ref?: string | null;
	created_at: string;
	updated_at: string;
}

export interface WireListWorkflowResponse {
	items: WireWorkflowItem[];
}

export interface WireWorkflowBadgeResponse {
	open_count: number;
}

export interface WireMessagesListResponse {
	messages: WireMessageResponse[];
	hasNext: boolean;
}

export function fromWireAttachment(wire: WireAttachment): Attachment {
	return {
		storageId: wire.storage_id,
		nonce: wire.nonce,
		encryptedMetadata: wire.encrypted_metadata,
		metadataNonce: wire.metadata_nonce,
	};
}

export function toWireAttachment(attachment: Attachment): WireAttachment {
	return {
		storage_id: attachment.storageId,
		nonce: attachment.nonce,
		encrypted_metadata: attachment.encryptedMetadata,
		metadata_nonce: attachment.metadataNonce,
	};
}

/** Convert a `reaction.updated` wire frame to a RelayerReactionEvent domain object. */
export function fromWireReactionEvent(wire: WireReactionUpdatedEvent): RelayerReactionEvent {
	return {
		groupId: wire.group_id,
		chainSeq: wire.chain_seq,
		emoji: wire.emoji,
		count: wire.count,
		reactors: wire.reactors ?? [],
	};
}

/** Convert a typing wire frame to a RelayerTypingEvent domain object. */
export function fromWireTypingEvent(wire: WireTypingEvent): RelayerTypingEvent {
	return {
		groupId: wire.group_id,
		member: wire.member,
		expiresAt: wire.expires_at,
	};
}

/** Convert a `presence.updated` wire frame to a RelayerPresenceEvent domain object. */
export function fromWirePresenceEvent(wire: WirePresenceEvent): RelayerPresenceEvent {
	return {
		groupId: wire.group_id,
		member: wire.member,
		online: wire.online,
	};
}

/** Convert a user feed wire frame to a RelayerUserEvent, or null when unknown. */
export function fromWireUserFeedEvent(wire: WireUserFeedEvent): RelayerUserEvent | null {
	switch (wire.type) {
		case 'group.activity':
			return {
				type: 'group.activity',
				groupId: wire.group_id,
				latestOrder: wire.latest_order,
			};
		case 'read_state.updated':
			return { type: 'read_state.updated', blobVersion: wire.blob_version };
		case 'group.discovered': {
			const reason =
				wire.reason === 'created' || wire.reason === 'joined' ? wire.reason : 'invited';
			return { type: 'group.discovered', groupId: wire.group_id, reason };
		}
		case 'group.hidden':
			return { type: 'group.hidden', groupId: wire.group_id };
		case 'workflow.item.created':
			return {
				type: 'workflow.item.created',
				itemId: wire.item_id,
				itemType: wire.item_type,
				status: wire.status,
			};
		case 'workflow.item.updated':
			return {
				type: 'workflow.item.updated',
				itemId: wire.item_id,
				itemType: wire.item_type,
				status: wire.status,
			};
		default:
			return null;
	}
}

/** Convert a workflow inbox REST row to a domain object. */
export function fromWireWorkflowItem(wire: WireWorkflowItem): WorkflowItem {
	return {
		id: wire.id,
		idempotencyKey: wire.idempotency_key,
		itemType: wire.item_type,
		status: wire.status,
		title: wire.title,
		body: wire.body ?? undefined,
		payload: wire.payload,
		organizationId: wire.organization_id ?? undefined,
		accountId: wire.account_id ?? undefined,
		sourceService: wire.source_service,
		actionDeadlineMs: wire.action_deadline_ms ?? undefined,
		conversationRef: wire.conversation_ref ?? undefined,
		createdAt: wire.created_at,
		updatedAt: wire.updated_at,
	};
}

/** Convert a relayer JSON message to a RelayerMessage domain object. */
export function fromWireMessage(wire: WireMessageResponse): RelayerMessage {
	return {
		messageId: wire.message_id,
		groupId: wire.group_id,
		order: wire.order,
		encryptedText: wire.encrypted_text ? fromHex(wire.encrypted_text) : new Uint8Array(),
		nonce: wire.nonce ? fromHex(wire.nonce) : new Uint8Array(),
		keyVersion: BigInt(wire.key_version ?? 0),
		senderAddress: wire.sender_address,
		createdAt: wire.created_at,
		updatedAt: wire.updated_at,
		attachments: wire.attachments?.map(fromWireAttachment) ?? [],
		isEdited: wire.is_edited,
		isDeleted: wire.is_deleted,
		syncStatus: wire.sync_status as SyncStatus,
		quiltPatchId: wire.quilt_patch_id,
		signature: wire.signature ?? '',
		publicKey: wire.public_key ?? '',
		principalOwner: wire.principal_owner ?? undefined,
		subAgentId: wire.sub_agent_id ?? undefined,
		identityClass:
			wire.identity_class === null || wire.identity_class === undefined
				? undefined
				: (wire.identity_class as 0 | 1 | 2),
		isAgentMessage: Boolean(wire.principal_owner),
	};
}
