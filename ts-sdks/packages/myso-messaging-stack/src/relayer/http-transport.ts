// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { parseSerializedSignature } from '@socialproof/myso/cryptography';
import { fromHex, toHex } from '@socialproof/myso/utils';

import type { Attachment } from '../attachments/types.js';
import type { HttpClientConfig } from '../http/types.js';
import { DEFAULT_HTTP_TIMEOUT } from '../http/types.js';
import { HttpTimeoutError } from '../http/errors.js';
import type { RelayerTransport } from './transport.js';
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
	SyncStatus,
	UpdateMessageParams,
} from './types.js';
import { RelayerTransportError } from './types.js';

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

/** Raw attachment JSON shape from the relayer API (snake_case). */
interface WireAttachment {
	storage_id: string;
	nonce: string;
	encrypted_metadata: string;
	metadata_nonce: string;
}

interface WireMessageResponse {
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
}

interface WireMessagesListResponse {
	messages: WireMessageResponse[];
	hasNext: boolean;
}

interface WireReactionEntry {
	chain_seq: number;
	emoji_code: number;
	count: number;
}

interface WireReceiptStateResponse {
	delivered_upto?: number;
	read_upto?: number;
}

interface WireCreateMessageResponse {
	message_id: string;
}

interface WireErrorResponse {
	error: string;
	code?: string;
}

/** Convert a wire attachment to a domain Attachment. */
function fromWireAttachment(wire: WireAttachment): Attachment {
	return {
		storageId: wire.storage_id,
		nonce: wire.nonce,
		encryptedMetadata: wire.encrypted_metadata,
		metadataNonce: wire.metadata_nonce,
	};
}

/** Convert a domain Attachment to the wire shape for POST/PUT payloads. */
function toWireAttachment(attachment: Attachment): WireAttachment {
	return {
		storage_id: attachment.storageId,
		nonce: attachment.nonce,
		encrypted_metadata: attachment.encryptedMetadata,
		metadata_nonce: attachment.metadataNonce,
	};
}

/** Convert a relayer JSON message to a RelayerMessage domain object. */
function fromWireMessage(wire: WireMessageResponse): RelayerMessage {
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
	};
}

function extractRawSignature(serializedSignature: string): Uint8Array {
	const parsed = parseSerializedSignature(serializedSignature);
	if (!parsed.signature) {
		throw new Error(
			'Unsupported signature scheme: only keypair signatures (Ed25519, Secp256k1, Secp256r1) are supported',
		);
	}
	return parsed.signature;
}

function getPublicKeyHex(signer: Signer): string {
	return toHex(signer.getPublicKey().toMySoBytes());
}

async function signAndCreateAuthHeaders(
	signer: Signer,
	messageBytes: Uint8Array,
): Promise<Record<string, string>> {
	const { signature } = await signer.signPersonalMessage(messageBytes);
	const rawSig = extractRawSignature(signature);
	// getPublicKey() is called after signPersonalMessage() so that signers which
	// lazily resolve their key from the first signature (e.g. wallets that don't
	// expose publicKey upfront) have it available by this point.
	return {
		'x-signature': toHex(rawSig),
		'x-public-key': getPublicKeyHex(signer),
	};
}

/**
 * Create body-based auth for POST/PUT requests.
 * Adds sender_address and timestamp to the payload, signs the full JSON body.
 */
async function createBodyAuth(
	signer: Signer,
	payload: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
	const timestamp = Math.floor(Date.now() / 1000);
	const body = {
		...payload,
		sender_address: signer.toMySoAddress(),
		timestamp,
	};
	const bodyStr = JSON.stringify(body);
	const bodyBytes = new TextEncoder().encode(bodyStr);
	const headers = await signAndCreateAuthHeaders(signer, bodyBytes);
	return { body, headers };
}

/**
 * Create header-based auth for GET/DELETE requests.
 * Signs the canonical string "timestamp:senderAddress:groupId".
 */
async function createHeaderAuth(signer: Signer, groupId: string): Promise<Record<string, string>> {
	const timestamp = Math.floor(Date.now() / 1000);
	const senderAddress = signer.toMySoAddress();
	const canonical = `${timestamp}:${senderAddress}:${groupId}`;
	const canonicalBytes = new TextEncoder().encode(canonical);
	const authHeaders = await signAndCreateAuthHeaders(signer, canonicalBytes);
	return {
		...authHeaders,
		'x-sender-address': senderAddress,
		'x-timestamp': timestamp.toString(),
		'x-group-id': groupId,
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

		const { body, headers } = await createBodyAuth(params.signer, wirePayload);
		const response = await this.#request<WireCreateMessageResponse>(this.#relayerPath('/messages'), {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

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
			params.chainSeq !== undefined ? `?chain_seq=${encodeURIComponent(String(params.chainSeq))}` : '';
		const rows = await this.#request<WireReactionEntry[]>(
			`${this.#relayerPath(`/groups/${params.groupId}/reactions`)}${q}`,
			{ method: 'GET', headers },
		);
		return rows.map((r) => ({
			chainSeq: r.chain_seq,
			emojiCode: r.emoji_code,
			count: r.count,
		}));
	}

	async postGroupReaction(params: PostGroupReactionParams): Promise<void> {
		const payload: Record<string, unknown> = {
			group_id: params.groupId,
			chain_seq: params.chainSeq,
			emoji_code: params.emojiCode,
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
		return this.#request<number[]>(
			this.#relayerPath(`/groups/${params.groupId}/pins`),
			{ method: 'GET', headers },
		);
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

	async *subscribe(params: SubscribeParams): AsyncIterable<RelayerMessage> {
		let lastOrder = params.afterOrder;

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
					yield message;
					lastOrder = message.order;
				}

				if (result.messages.length === 0) {
					await delay(this.#pollingIntervalMs, params.signal);
				}
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
	 * The relayer returns two error shapes:
	 */
	async #handleErrorResponse(response: Response): Promise<never> {
		try {
			const body = (await response.json()) as WireErrorResponse;
			throw new RelayerTransportError(body.error, response.status, body.code);
		} catch (error) {
			if (error instanceof RelayerTransportError) throw error;
			throw new RelayerTransportError(response.statusText, response.status);
		}
	}
}
