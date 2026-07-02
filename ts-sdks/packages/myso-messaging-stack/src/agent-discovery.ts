// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import { createWalletHeaderAuth } from './relayer/auth-headers.js';
import type { RelayerAgentConversation } from './relayer/types.js';

/** Agent-associated messaging group returned by relayer discovery. */
export interface AgentConversation {
	groupId: string;
	creatorActor?: string | null;
	creatorPrincipal: string;
	creatorSubAgentId?: string | null;
	creatorIdentityClass?: number | null;
	organizationId?: string | null;
	groupName?: string | null;
	groupUuid?: string | null;
	createdAt?: number | null;
}

export interface AgentDiscoveryClientOptions {
	relayerUrl: string;
	apiPrefix?: string;
	fetch?: typeof fetch;
}

export interface FetchAgentConversationsOptions extends AgentDiscoveryClientOptions {
	signer: Signer;
	limit?: number;
}

export interface FetchGroupsForAgentOptions extends AgentDiscoveryClientOptions {
	signer: Signer;
	derivedAddress: string;
	limit?: number;
}

interface WireAgentConversation {
	group_id: string;
	creator_actor: string;
	creator_principal: string;
	creator_sub_agent_id?: string | null;
	creator_identity_class?: number | null;
	organization_id?: string | null;
	group_name?: string | null;
	group_uuid?: string | null;
	created_at: number;
}

interface WireAgentConversationsResponse {
	conversations: WireAgentConversation[];
}

function relayerPath(relayerUrl: string, apiPrefix: string | undefined, path: string): string {
	const prefix = apiPrefix ?? '/v1';
	const base = relayerUrl.replace(/\/$/, '');
	return `${base}${prefix}${path}`;
}

function fromWire(wire: WireAgentConversation): AgentConversation {
	return {
		groupId: wire.group_id,
		creatorActor: wire.creator_actor,
		creatorPrincipal: wire.creator_principal,
		creatorSubAgentId: wire.creator_sub_agent_id,
		creatorIdentityClass: wire.creator_identity_class,
		organizationId: wire.organization_id,
		groupName: wire.group_name,
		groupUuid: wire.group_uuid,
		createdAt: wire.created_at,
	};
}

function fromRelayerConversation(conv: RelayerAgentConversation): AgentConversation {
	return {
		groupId: conv.groupId,
		creatorActor: conv.creatorActor,
		creatorPrincipal: conv.creatorPrincipal,
		creatorSubAgentId: conv.creatorSubAgentId,
		creatorIdentityClass: conv.creatorIdentityClass,
		organizationId: conv.organizationId,
		groupName: conv.groupName,
		groupUuid: conv.groupUuid,
		createdAt: conv.createdAt,
	};
}

async function fetchAgentConversationsFromRelayer(
	options: FetchAgentConversationsOptions,
): Promise<AgentConversation[]> {
	const fetchFn = options.fetch ?? fetch;
	const limit = options.limit ?? 100;
	const headers = await createWalletHeaderAuth(options.signer);
	const response = await fetchFn(
		relayerPath(options.relayerUrl, options.apiPrefix, `/agent-conversations?limit=${limit}`),
		{ method: 'GET', headers },
	);

	if (!response.ok) {
		throw new Error(
			`agent-conversations request failed: ${response.status} ${response.statusText}`,
		);
	}

	const body = (await response.json()) as WireAgentConversationsResponse;
	return body.conversations.map(fromWire);
}

/** Fetch agent-associated groups for the signing principal via relayer wallet auth. */
export async function fetchAgentConversations(
	options: FetchAgentConversationsOptions,
): Promise<AgentConversation[]> {
	return fetchAgentConversationsFromRelayer(options);
}

/** Fetch groups where the given agent derived address is the creator actor. */
export async function fetchGroupsForAgent(
	options: FetchGroupsForAgentOptions,
): Promise<AgentConversation[]> {
	const fetchFn = options.fetch ?? fetch;
	const limit = options.limit ?? 100;
	const headers = await createWalletHeaderAuth(options.signer);
	const encoded = encodeURIComponent(options.derivedAddress);
	const response = await fetchFn(
		relayerPath(
			options.relayerUrl,
			options.apiPrefix,
			`/agent-conversations/by-agent/${encoded}?limit=${limit}`,
		),
		{ method: 'GET', headers },
	);

	if (!response.ok) {
		throw new Error(
			`agent-conversations/by-agent request failed: ${response.status} ${response.statusText}`,
		);
	}

	const body = (await response.json()) as WireAgentConversationsResponse;
	return body.conversations.map(fromWire);
}

export { fromRelayerConversation };
