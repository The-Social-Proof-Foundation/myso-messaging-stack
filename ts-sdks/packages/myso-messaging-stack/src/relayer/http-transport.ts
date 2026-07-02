// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { fromHex, toHex } from '@socialproof/myso/utils';

import type { HttpClientConfig } from '../http/types.js';
import { DEFAULT_HTTP_TIMEOUT } from '../http/types.js';
import { HttpTimeoutError } from '../http/errors.js';
import {
	createBodyAuth,
	createHeaderAuth,
	createWalletHeaderAuth,
	signAndCreateAuthHeaders,
} from './auth-headers.js';
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
import { PaymentRequiredError, ReadStateConflictError, RelayerTransportError } from './types.js';
import {
	fromWireMessage,
	toWireAttachment,
	type WireMessageResponse,
	type WireMessagesListResponse,
} from './wire.js';

/** Configuration for the HTTP polling transport. */
export interface HTTPRelayerTransportConfig extends HttpClientConfig {
	relayerUrl: string;
	pollingIntervalMs?: number;
	/**
	 * Prefix for REST paths, e.g. `/v1` so message CRUD uses `/v1/messages`.
	 * Default `''` uses legacy `/messages`.
	 */
	apiPrefix?: string;
	/**
	 * The relayer's `REQUEST_TTL_SECONDS` value, in milliseconds.
	 * Cached auth headers are refreshed slightly before this deadline to
	 * account for network latency and clock skew.
	 *
	 * @default 900_000 (15 minutes — matches the relayer's default)
	 */
	headerAuthTtlMs?: number;
}

interface WireReactionEntry {
	chain_seq: number;
	emoji: string;
	count: number;
	reactors?: string[];
}

interface WireReceiptStateResponse {
	delivered_upto?: number;
	read_upto?: number;
}

interface WireCreateMessageResponse {
	message_id: string;
}

interface WireReadStateResponse {
	encrypted_blob: string;
	blob_version: number;
	updated_at?: string;
}

interface WirePutReadStateResponse {
	ok: boolean;
	/** Server-assigned version (absent on legacy relayers). */
	blob_version?: number;
}

interface WireUnreadCountsResponse {
	items: Array<{
		group_id: string;
		latest_order: number;
		unread_count: number;
	}>;
}

interface WirePresenceEntry {
	member: string;
	last_seen?: string | null;
	online: boolean;
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

function fromWireAgentConversation(wire: WireAgentConversation): RelayerAgentConversation {
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

interface WireErrorResponse {
	error: string;
	code?: string;
	/** PAYMENT_REQUIRED detail: minimum escrow in MYSO base units, as a string. */
	min_cost?: string | null;
	/** PAYMENT_REQUIRED detail: recipient wallet requiring payment. */
	recipient?: string | null;
}

interface WireDmGateResponse {
	allowed: boolean;
	reason?: string | null;
	blocked: boolean;
	following: boolean;
	paid: boolean;
	first_outbound?: boolean;
	peer_paid?: boolean;
	peer_escrow_amount?: string | null;
	min_cost?: string | null;
	recipient: string;
}

function parseMinCost(minCost: string | null | undefined): bigint | null {
	if (minCost === null || minCost === undefined || minCost === '') return null;
	try {
		return BigInt(minCost);
	} catch {
		return null;
	}
}

async function createWalletDeleteAuth(
	signer: Signer,
	token: string,
): Promise<Record<string, string>> {
	const timestamp = Math.floor(Date.now() / 1000);
	const senderAddress = signer.toMySoAddress();
	const canonical = `${timestamp}:${senderAddress}:${token}`;
	const canonicalBytes = new TextEncoder().encode(canonical);
	const authHeaders = await signAndCreateAuthHeaders(signer, canonicalBytes);
	return {
		...authHeaders,
		'x-sender-address': senderAddress,
		'x-timestamp': timestamp.toString(),
	};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

const DEFAULT_POLLING_INTERVAL_MS = 3000;

/**
 * HTTP REST transport for communicating with the off-chain relayer.
 *
 * @example
 * ```ts
 * const transport = new HTTPRelayerTransport({
 *   relayerUrl: 'https://relayer.example.com',
 * });
 *
 * const { messageId } = await transport.sendMessage({
 *   signer: keypair,
 *   groupId: '0x...',
 *   encryptedText: ciphertext,
 *   nonce: nonce,
 *   keyVersion: 0n,
 * });
 * ```
 */
export class HTTPRelayerTransport implements RelayerTransport {
	readonly #relayerUrl: string;
	readonly #apiPrefix: string;
	readonly #pollingIntervalMs: number;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeout: number;
	readonly #onError?: (error: Error) => void;
	#disconnected = false;
	#abortController = new AbortController();

	/** Cache signed auth headers per signer+groupId to avoid re-signing on every poll. */
	readonly #headerAuthCache = new Map<
		string,
		{ headers: Record<string, string>; createdAt: number }
	>();
	readonly #headerAuthCacheTtlMs: number;

	static readonly #DEFAULT_HEADER_AUTH_TTL_MS = 900_000; // 15 minutes
	static readonly #HEADROOM_FIXED_MS = 60_000;
	static readonly #HEADROOM_RATIO = 0.1;

	constructor(config: HTTPRelayerTransportConfig) {
		this.#relayerUrl = config.relayerUrl.replace(/\/+$/, '');
		const rawPrefix = (config.apiPrefix ?? '').trim();
		this.#apiPrefix =
			rawPrefix === ''
				? ''
				: (rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`).replace(/\/+$/, '');
		this.#pollingIntervalMs = config.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
		this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
		this.#timeout = config.timeout ?? DEFAULT_HTTP_TIMEOUT;
		this.#onError = config.onError;

		const serverTtl = config.headerAuthTtlMs ?? HTTPRelayerTransport.#DEFAULT_HEADER_AUTH_TTL_MS;
		// Headroom covers network latency and clock skew without eating
		// too much cache time on short TTLs.
		const headroom = Math.min(
			HTTPRelayerTransport.#HEADROOM_FIXED_MS,
			serverTtl * HTTPRelayerTransport.#HEADROOM_RATIO,
		);
		this.#headerAuthCacheTtlMs = Math.max(0, serverTtl - headroom);
	}

	#relayerPath(path: string): string {
		const rel = path.startsWith('/') ? path : `/${path}`;
		return this.#apiPrefix ? `${this.#apiPrefix}${rel}` : rel;
	}

	#v1Path(path: string): string {
		const rel = path.startsWith('/') ? path : `/${path}`;
		return `/v1${rel}`;
	}

	async #cachedHeaderAuth(signer: Signer, groupId: string): Promise<Record<string, string>> {
		const cacheKey = `${signer.toMySoAddress()}:${groupId}`;
		const cached = this.#headerAuthCache.get(cacheKey);
		if (cached && Date.now() - cached.createdAt < this.#headerAuthCacheTtlMs) {
			return cached.headers;
		}
		const headers = await createHeaderAuth(signer, groupId);
		this.#headerAuthCache.set(cacheKey, { headers, createdAt: Date.now() });
		return headers;
	}

	async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
		const wirePayload: Record<string, unknown> = {
			group_id: params.groupId,
			encrypted_text: toHex(params.encryptedText),
			nonce: toHex(params.nonce),
			key_version: Number(params.keyVersion),
			attachments: params.attachments?.map(toWireAttachment) ?? [],
		};

		if (params.messageSignature) {
			wirePayload.message_signature = params.messageSignature;
		}
		if (params.attribution) {
			wirePayload.principal_owner = params.attribution.principalOwner;
			wirePayload.sub_agent_id = params.attribution.subAgentId;
			wirePayload.identity_class = params.attribution.identityClass;
		}

		const { body, headers } = await createBodyAuth(params.signer, wirePayload);
		const response = await this.#request<WireCreateMessageResponse>(
			this.#relayerPath('/messages'),
			{
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		);

		return { messageId: response.message_id };
	}

	async fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);

		const queryParams = new URLSearchParams({ group_id: params.groupId });
		if (params.afterOrder !== undefined) {
			queryParams.set('after_order', params.afterOrder.toString());
		}
		if (params.beforeOrder !== undefined) {
			queryParams.set('before_order', params.beforeOrder.toString());
		}
		if (params.limit !== undefined) {
			queryParams.set('limit', params.limit.toString());
		}

		const wireResponse = await this.#request<WireMessagesListResponse>(
			`${this.#relayerPath('/messages')}?${queryParams.toString()}`,
			{ method: 'GET', headers },
		);

		return {
			messages: wireResponse.messages.map(fromWireMessage),
			hasNext: wireResponse.hasNext,
		};
	}

	async fetchMessage(params: FetchMessageParams): Promise<RelayerMessage> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);

		const queryParams = new URLSearchParams({
			message_id: params.messageId,
			group_id: params.groupId,
		});

		const wireResponse = await this.#request<WireMessageResponse>(
			`${this.#relayerPath('/messages')}?${queryParams.toString()}`,
			{ method: 'GET', headers },
		);

		return fromWireMessage(wireResponse);
	}

	async updateMessage(params: UpdateMessageParams): Promise<void> {
		const wirePayload: Record<string, unknown> = {
			message_id: params.messageId,
			group_id: params.groupId,
			encrypted_text: toHex(params.encryptedText),
			nonce: toHex(params.nonce),
			key_version: Number(params.keyVersion),
			attachments: params.attachments?.map(toWireAttachment) ?? [],
		};

		if (params.messageSignature) {
			wirePayload.message_signature = params.messageSignature;
		}

		const { body, headers } = await createBodyAuth(params.signer, wirePayload);
		await this.#request(this.#relayerPath('/messages'), {
			method: 'PUT',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async deleteMessage(params: DeleteMessageParams): Promise<void> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);

		await this.#request(`${this.#relayerPath('/messages')}/${params.messageId}`, {
			method: 'DELETE',
			headers,
		});
	}

	async listGroupReactions(params: ListGroupReactionsParams): Promise<RelayerReactionEntry[]> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);
		const q =
			params.chainSeq !== undefined
				? `?chain_seq=${encodeURIComponent(String(params.chainSeq))}`
				: '';
		const rows = await this.#request<WireReactionEntry[]>(
			`${this.#relayerPath(`/groups/${params.groupId}/reactions`)}${q}`,
			{ method: 'GET', headers },
		);
		return rows.map((r) => ({
			chainSeq: r.chain_seq,
			emoji: r.emoji,
			count: r.count,
			reactors: r.reactors ?? [],
		}));
	}

	async postGroupReaction(params: PostGroupReactionParams): Promise<void> {
		const payload: Record<string, unknown> = {
			group_id: params.groupId,
			chain_seq: params.chainSeq,
			emoji: params.emoji,
			add: params.add ?? true,
		};
		const { body, headers } = await createBodyAuth(params.signer, payload);
		await this.#request(this.#relayerPath(`/groups/${params.groupId}/reactions`), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async listGroupPins(params: ListGroupPinsParams): Promise<number[]> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);
		return this.#request<number[]>(this.#relayerPath(`/groups/${params.groupId}/pins`), {
			method: 'GET',
			headers,
		});
	}

	async setGroupPin(params: SetGroupPinParams): Promise<void> {
		const payload: Record<string, unknown> = {
			group_id: params.groupId,
			chain_seq: params.chainSeq,
			pin: params.pin ?? true,
		};
		const { body, headers } = await createBodyAuth(params.signer, payload);
		await this.#request(this.#relayerPath(`/groups/${params.groupId}/pins`), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async getGroupReceipts(params: GetGroupReceiptsParams): Promise<GroupReceiptState> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);
		const wire = await this.#request<WireReceiptStateResponse>(
			this.#relayerPath(`/groups/${params.groupId}/receipts`),
			{ method: 'GET', headers },
		);
		const out: GroupReceiptState = {};
		if (wire.delivered_upto !== undefined) out.deliveredUpto = wire.delivered_upto;
		if (wire.read_upto !== undefined) out.readUpto = wire.read_upto;
		return out;
	}

	async postGroupReceipts(params: PostGroupReceiptsParams): Promise<void> {
		const payload: Record<string, unknown> = {
			group_id: params.groupId,
		};
		if (params.deliveredUpto !== undefined) payload.delivered_upto = params.deliveredUpto;
		if (params.readUpto !== undefined) payload.read_upto = params.readUpto;
		const { body, headers } = await createBodyAuth(params.signer, payload);
		await this.#request(this.#relayerPath(`/groups/${params.groupId}/receipts`), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async getUserReadState(params: GetUserReadStateParams) {
		const headers = await createWalletHeaderAuth(params.signer);
		const wire = await this.#request<WireReadStateResponse>(this.#v1Path('/users/read-state'), {
			method: 'GET',
			headers,
		});
		return {
			encryptedBlob: fromHex(wire.encrypted_blob),
			blobVersion: wire.blob_version,
			updatedAt: wire.updated_at,
		};
	}

	async putUserReadState(params: PutUserReadStateParams): Promise<PutUserReadStateResult> {
		const payload: Record<string, unknown> = {
			encrypted_blob: toHex(params.encryptedBlob),
			blob_version: params.blobVersion,
		};
		if (params.expectedVersion !== undefined) {
			payload.expected_version = params.expectedVersion;
		}
		const { body, headers } = await createBodyAuth(params.signer, payload);

		try {
			const wire = await this.#request<WirePutReadStateResponse>(
				this.#v1Path('/users/read-state'),
				{
					method: 'PUT',
					headers: { ...headers, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
			);
			return { blobVersion: wire.blob_version ?? params.blobVersion };
		} catch (error) {
			throw toReadStateConflict(error) ?? error;
		}
	}

	async fetchUnreadCounts(params: FetchUnreadCountsParams): Promise<GroupUnreadCount[]> {
		const payload = {
			items: params.items.map((item) => ({
				group_id: item.groupId,
				after_order: item.afterOrder,
			})),
		};
		const { body, headers } = await createBodyAuth(params.signer, payload);
		const wire = await this.#request<WireUnreadCountsResponse>(
			this.#v1Path('/users/unread-counts'),
			{
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		);
		return wire.items.map((item) => ({
			groupId: item.group_id,
			latestOrder: item.latest_order,
			unreadCount: item.unread_count,
		}));
	}

	async sendTyping(params: SendTypingParams): Promise<void> {
		const payload = {
			group_id: params.groupId,
			typing: params.typing,
		};
		const { body, headers } = await createBodyAuth(params.signer, payload);
		await this.#request(this.#relayerPath(`/groups/${params.groupId}/typing`), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async getGroupPresence(params: GetGroupPresenceParams): Promise<GroupPresenceEntry[]> {
		const headers = await this.#cachedHeaderAuth(params.signer, params.groupId);
		const rows = await this.#request<WirePresenceEntry[]>(
			this.#relayerPath(`/groups/${params.groupId}/presence`),
			{ method: 'GET', headers },
		);
		return rows.map((row) => ({
			member: row.member,
			lastSeen: row.last_seen ?? undefined,
			online: row.online,
		}));
	}

	async postPushToken(params: PostPushTokenParams): Promise<void> {
		const payload = {
			platform: params.platform,
			token: params.token,
			environment: params.environment,
		};
		const { body, headers } = await createBodyAuth(params.signer, payload);
		await this.#request(this.#v1Path('/devices/push-tokens'), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async deletePushToken(params: DeletePushTokenParams): Promise<void> {
		const headers = await createWalletDeleteAuth(params.signer, params.token);
		await this.#request(this.#v1Path(`/devices/push-tokens/${params.token}`), {
			method: 'DELETE',
			headers,
		});
	}

	async postPresence(params: PostPresenceParams): Promise<void> {
		const payload = { active: params.active ?? true };
		const { body, headers } = await createBodyAuth(params.signer, payload);
		await this.#request(this.#v1Path('/devices/presence'), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async listAgentConversations(
		params: ListAgentConversationsParams,
	): Promise<RelayerAgentConversation[]> {
		const headers = await createWalletHeaderAuth(params.signer);
		const limit = params.limit ?? 100;
		const wire = await this.#request<WireAgentConversationsResponse>(
			this.#v1Path(`/agent-conversations?limit=${limit}`),
			{ method: 'GET', headers },
		);
		return wire.conversations.map(fromWireAgentConversation);
	}

	async listGroupsForAgent(params: ListGroupsForAgentParams): Promise<RelayerAgentConversation[]> {
		const headers = await createWalletHeaderAuth(params.signer);
		const limit = params.limit ?? 100;
		const encoded = encodeURIComponent(params.derivedAddress);
		const wire = await this.#request<WireAgentConversationsResponse>(
			this.#v1Path(`/agent-conversations/by-agent/${encoded}?limit=${limit}`),
			{ method: 'GET', headers },
		);
		return wire.conversations.map(fromWireAgentConversation);
	}

	async checkDmGate(params: CheckDmGateParams): Promise<DmGateResult> {
		const headers = await createWalletHeaderAuth(params.signer);
		const queryParams = new URLSearchParams({ recipient: params.recipient });
		if (params.groupId) {
			queryParams.set('group_id', params.groupId);
		}
		const wire = await this.#request<WireDmGateResponse>(
			this.#v1Path(`/messaging/dm-gate?${queryParams.toString()}`),
			{ method: 'GET', headers },
		);
		return {
			allowed: wire.allowed,
			reason: wire.reason ?? null,
			blocked: wire.blocked,
			following: wire.following,
			paid: wire.paid,
			firstOutbound: wire.first_outbound ?? true,
			peerPaid: wire.peer_paid ?? false,
			peerEscrowAmount: parseMinCost(wire.peer_escrow_amount),
			minCost: parseMinCost(wire.min_cost),
			recipient: wire.recipient,
		};
	}

	/**
	 * Polling fallback for the user feed: when `groupIds` is provided, diffs
	 * batch unread counts into synthetic `group.activity` events (the first
	 * snapshot is a baseline). Read-state and discovery events have no polling
	 * equivalent — consumers reconcile those through their own REST paths.
	 */
	async *subscribeUserEvents(
		params: SubscribeUserEventsParams,
	): AsyncIterable<RelayerUserEvent> {
		let snapshot: Map<string, number> | undefined;

		while (!this.#disconnected && !params.signal?.aborted) {
			try {
				const groupIds = params.groupIds ?? [];
				if (groupIds.length > 0) {
					const counts = await this.fetchUnreadCounts({
						signer: params.signer,
						items: groupIds.map((groupId) => ({ groupId, afterOrder: 0 })),
					});

					const next = new Map(counts.map((c) => [c.groupId, c.latestOrder]));
					if (snapshot) {
						for (const [groupId, latestOrder] of next) {
							if ((snapshot.get(groupId) ?? 0) < latestOrder) {
								if (this.#disconnected || params.signal?.aborted) return;
								yield { type: 'group.activity', groupId, latestOrder };
							}
						}
					}
					snapshot = next;
				}

				await delay(this.#pollingIntervalMs, params.signal);
			} catch (error) {
				if (this.#disconnected || params.signal?.aborted) return;
				// Client errors (4xx) are not retryable — throw immediately
				if (error instanceof RelayerTransportError && error.status >= 400 && error.status < 500) {
					throw error;
				}
				await delay(this.#pollingIntervalMs, params.signal);
			}
		}
	}

	/**
	 * Polling implementation of the realtime event stream: polls messages and
	 * diffs reaction listings into synthetic `reaction.updated` events. The
	 * first reaction snapshot is a baseline and does not emit events.
	 */
	async *subscribe(params: SubscribeParams): AsyncIterable<RelayerSubscriptionEvent> {
		let lastOrder = params.afterOrder;
		let reactionSnapshot: Map<string, RelayerReactionEntry> | undefined;

		while (!this.#disconnected && !params.signal?.aborted) {
			try {
				const result = await this.fetchMessages({
					signer: params.signer,
					groupId: params.groupId,
					afterOrder: lastOrder,
					limit: params.limit,
				});

				for (const message of result.messages) {
					if (this.#disconnected || params.signal?.aborted) return;
					yield { type: 'message.created', message };
					lastOrder = message.order;
				}
				if (this.#disconnected || params.signal?.aborted) return;

				const rows = await this.listGroupReactions({
					signer: params.signer,
					groupId: params.groupId,
				});
				const next = new Map(rows.map((r) => [`${r.chainSeq}:${r.emoji}`, r]));

				if (reactionSnapshot) {
					for (const [key, entry] of next) {
						const prev = reactionSnapshot.get(key);
						if (
							!prev ||
							prev.count !== entry.count ||
							prev.reactors.join(',') !== entry.reactors.join(',')
						) {
							if (this.#disconnected || params.signal?.aborted) return;
							yield {
								type: 'reaction.updated',
								reaction: {
									groupId: params.groupId,
									chainSeq: entry.chainSeq,
									emoji: entry.emoji,
									count: entry.count,
									reactors: entry.reactors,
								},
							};
						}
					}
					for (const [key, prev] of reactionSnapshot) {
						if (!next.has(key)) {
							if (this.#disconnected || params.signal?.aborted) return;
							yield {
								type: 'reaction.updated',
								reaction: {
									groupId: params.groupId,
									chainSeq: prev.chainSeq,
									emoji: prev.emoji,
									count: 0,
									reactors: [],
								},
							};
						}
					}
				}
				reactionSnapshot = next;

				await delay(this.#pollingIntervalMs, params.signal);
			} catch (error) {
				if (this.#disconnected || params.signal?.aborted) return;
				// Client errors (4xx) are not retryable — throw immediately
				if (error instanceof RelayerTransportError && error.status >= 400 && error.status < 500) {
					throw error;
				}
				await delay(this.#pollingIntervalMs, params.signal);
			}
		}
	}

	disconnect(): void {
		this.#disconnected = true;
		this.#abortController.abort();
		this.#headerAuthCache.clear();
	}

	/**
	 * Make an HTTP request and parse the JSON response.
	 */
	async #request<T>(path: string, init: RequestInit): Promise<T> {
		if (this.#disconnected) {
			throw new RelayerTransportError('Transport is disconnected', 0);
		}

		const url = `${this.#relayerUrl}${path}`;
		const timeoutSignal = AbortSignal.timeout(this.#timeout);
		const combinedSignal = AbortSignal.any([timeoutSignal, this.#abortController.signal]);

		try {
			const response = await this.#fetch(url, {
				...init,
				signal: init.signal ? AbortSignal.any([combinedSignal, init.signal]) : combinedSignal,
			});

			if (!response.ok) {
				await this.#handleErrorResponse(response);
			}

			return response.json() as Promise<T>;
		} catch (error) {
			if (error instanceof Error && error.name === 'TimeoutError') {
				const timeoutError = new HttpTimeoutError(url, this.#timeout);
				this.#onError?.(timeoutError);
				throw timeoutError;
			}
			if (error instanceof Error) {
				this.#onError?.(error);
			}
			throw error;
		}
	}

	/**
	 * Parse an error response from the relayer and throw a RelayerTransportError.
	 * `402 PAYMENT_REQUIRED` (paid-DM gate) maps to {@link PaymentRequiredError}
	 * carrying the recipient's minimum escrow.
	 */
	async #handleErrorResponse(response: Response): Promise<never> {
		try {
			const body = (await response.json()) as WireErrorResponse;
			if (response.status === 402 || body.code === 'PAYMENT_REQUIRED') {
				throw new PaymentRequiredError(body.error, {
					minCost: parseMinCost(body.min_cost),
					recipient: body.recipient ?? null,
				});
			}
			throw new RelayerTransportError(body.error, response.status, body.code, body);
		} catch (error) {
			if (error instanceof RelayerTransportError) throw error;
			throw new RelayerTransportError(response.statusText, response.status);
		}
	}
}

/**
 * Maps a `409 READ_STATE_CONFLICT` transport error to {@link ReadStateConflictError}
 * carrying the server's current record; returns null for any other error.
 */
function toReadStateConflict(error: unknown): ReadStateConflictError | null {
	if (
		!(error instanceof RelayerTransportError) ||
		error.status !== 409 ||
		error.code !== 'READ_STATE_CONFLICT'
	) {
		return null;
	}
	const body = error.body as { current?: WireReadStateResponse } | undefined;
	const current = body?.current;
	if (!current) {
		return null;
	}
	const wire: UserReadStateWire = {
		encryptedBlob: fromHex(current.encrypted_blob),
		blobVersion: current.blob_version,
		updatedAt: current.updated_at,
	};
	return new ReadStateConflictError(error.message, wire);
}
