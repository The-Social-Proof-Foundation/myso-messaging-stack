// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoGroupsClient } from '@socialproof/myso-groups';
import type { MyDataClient } from '@socialproof/mydata';
import type { Signer } from '@socialproof/myso/cryptography';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Transaction } from '@socialproof/myso/transactions';
import { fromHex, toBase64 } from '@socialproof/myso/utils';

import { BlockedMessagingError, BlockGatingClient } from './block-gating.js';
import { emojiToStorage } from './emoji.js';
import { messagingPermissionTypes } from './constants.js';
import {
	validateRoomHistoryRequest,
	validateRoomHistoryPage,
	verifiedRoomEntry,
	type GetRoomMessagesOptions,
	type RoomHistoryEntry,
	type RoomHistoryPage,
} from './room-history.js';
import { MySoMessagingStackClientError } from './error.js';
import { MessagingSyncManager } from './sync/messaging-sync-manager.js';
import type { UserReadState } from './sync/types.js';
import { AttachmentsManager, type AttachmentAadBinding } from './attachments/attachments-manager.js';
import type { Attachment, AttachmentFile, AttachmentHandle } from './attachments/types.js';
import { EnvelopeEncryption, buildMessageAad } from './encryption/envelope-encryption.js';
import type { EncryptOptions, DecryptOptions } from './encryption/envelope-encryption.js';
import {
	decodeContentEnvelope,
	encodeContentEnvelope,
	relayerKindForEnvelope,
	type ContentEnvelope,
	type EnvelopeAttachment,
	type EnvelopeMessageType,
	type MessageEvent,
} from './content/envelope.js';
import {
	formatEncryptedGroupName,
	groupNameAad,
	isEncryptedGroupName,
	padGroupName,
	parseEncryptedGroupName,
	unpadGroupName,
} from './content/group-name.js';
import { HTTPRelayerTransport } from './relayer/http-transport.js';
import { HttpMlsRelayer } from './mls/relayer.js';
import { MlsSession, createCertificateVerifier } from './mls/session.js';
import { MlsGroupUnavailableError, type MlsUnavailableReason } from './mls/errors.js';
import type { MlsStateStore, MlsWasmModule, UnwrappedRow } from './mls/types.js';
import { ChainMlsDeviceRegistry, type MlsRegistrySubmitter } from './mls/registry.js';
import { HybridRelayerTransport } from './relayer/hybrid-transport.js';
import type { RelayerTransport } from './relayer/transport.js';
import { withRelayerAuthSigner, type RelayerAuthSigner } from './relayer/relayer-auth-signer.js';
import type {
	DmGateResult,
	ConversationPrefs,
	GroupPresenceEntry,
	GroupReceiptState,
	NotificationMode,
	ReceiptMode,
	RelayerConfig,
	RelayerHTTPConfig,
	RelayerMessage,
	RelayerReactionEntry,
	RelayerUserEvent,
} from './relayer/types.js';
import {
	normalizeSharedPostAddress,
	signMessageContent,
	transferIdempotencyKey,
	verifyMessageSender,
	type SignedMessageAttribution,
	type VerifyMessageSenderParams,
} from './verification.js';
import {
	encodePaymentRequestPayload,
	encodeTokenTransferPayload,
	parsePaymentPayload,
} from './payments.js';
import type {
	DecryptedMessage,
	DeleteMessageOptions,
	EditMessageOptions,
	GetMessageOptions,
	GetMessagesOptions,
	GetMessagesResult,
	ListReactionsOptions,
	MessagingEvent,
	ReactionOptions,
	RecoverMessagesOptions,
	RespondToPaymentRequestOptions,
	SendEventOptions,
	SendMessageOptions,
	SendPaymentRequestOptions,
	SendTokenTransferOptions,
	SubscribeOptions,
} from './messaging-types.js';
import type { RecoveryTransport } from './recovery/transport.js';
import type {
	ArchiveGroupOptions,
	ClearGroupHandleOptions,
	CreateGroupOptions,
	CreateAgentGroupCallOptions,
	GroupRef,
	InsertGroupDataOptions,
	LeaveOptions,
	MySoMessagingStackClientOptions,
	MySoMessagingStackCompatibleClient,
	MySoMessagingStackEncryptionOptions,
	MySoMessagingStackPackageConfig,
	RemoveGroupDataOptions,
	RemoveMembersAndRotateKeyOptions,
	RotateEncryptionKeyOptions,
	SetGroupNameOptions,
	SetGroupHandleOptions,
} from './types.js';
import { MySoMessagingStackCall } from './call.js';
import { MySoMessagingStackTransactions } from './transactions.js';
import { MySoMessagingStackBCS } from './bcs.js';
import { MySoMessagingStackDerive } from './derive.js';
import { MySoMessagingStackView } from './view.js';

/**
 * Client extension factory for messaging groups.
 *
 * Requires the base client to already have `mysoGroups` and `mydata`
 * extensions registered. For a simpler setup that handles all extensions
 * automatically, see {@link createMySoMessagingStackClient}.
 *
 * @example
 * ```ts
 * // Use a single $extend call with all extensions
 * const client = new MySoClient({ url: 'https://...' }).$extend(
 *   mysoGroups({ witnessType: `${pkg}::messaging::Messaging`, packageConfig }),
 *   mysoMessagingStack({ packageConfig, encryption: { sessionKey }, relayer: { relayerUrl } }),
 * );
 *
 * // Send a message
 * await client.messaging.sendMessage({ signer: keypair, groupRef: { uuid: 'my-group' }, text: 'Hello!' });
 * ```
 */
export function mysoMessagingStack<
	TApproveContext = void,
	const Name = 'messaging',
	const GroupsName extends string = 'groups',
	const MyDataName extends string = 'mydata',
>({
	name = 'messaging' as Name,
	groupsName = 'groups' as GroupsName,
	mydataName = 'mydata' as MyDataName,
	packageConfig,
	encryption,
	relayer,
	attachments,
	recovery,
	blockGating,
}: {
	name?: Name;
	/** Name under which the MySoGroupsClient extension is registered (default: 'groups'). */
	groupsName?: GroupsName;
	/** Name under which the MyDataClient extension is registered (default: 'mydata'). */
	mydataName?: MyDataName;
	packageConfig?: MySoMessagingStackPackageConfig;
	encryption: MySoMessagingStackEncryptionOptions<TApproveContext>;
	/** Relayer transport configuration. */
	relayer: RelayerConfig;
	/** Attachment support. When omitted, messages cannot include files. */
	attachments?: MySoMessagingStackClientOptions<TApproveContext>['attachments'];
	/** Optional recovery transport for fetching messages from an alternative storage backend. */
	recovery?: RecoveryTransport;
	blockGating?: MySoMessagingStackClientOptions<TApproveContext>['blockGating'];
}) {
	return {
		name,
		register: (client: MySoMessagingStackCompatibleClient<GroupsName, MyDataName>) => {
			return new MySoMessagingStackClient<TApproveContext>({
				client,
				groupsName,
				mydataName,
				packageConfig,
				encryption,
				relayer,
				attachments,
				recovery,
				blockGating,
			});
		},
	};
}

/**
 * Client for interacting with messaging groups.
 *
 * Provides on-chain group management (`call`, `tx`), view functions (`view`),
 * BCS parsing (`bcs`), and high-level E2EE messaging via the relayer transport.
 *
 * Requires a MySoClient extended with MySoGroupsClient and MyDataClient.
 *
 * @example
 * ```ts
 * // Send a message
 * const { messageId } = await client.messaging.sendMessage({
 *   signer: keypair,
 *   groupRef: { uuid: 'my-group' },
 *   text: 'Hello!',
 * });
 *
 * // Subscribe to new messages and reaction updates
 * for await (const event of client.messaging.subscribe({
 *   signer: keypair,
 *   groupRef: { uuid: 'my-group' },
 *   signal: controller.signal,
 * })) {
 *   if (event.type === 'message') console.log(event.message.text);
 * }
 *
 * // For fine-grained permissions, use the groups extension:
 * await client.groups.grantPermission({ ... });
 * ```
 */
/** Attachment metadata couldn't be resolved; the message body itself decrypted fine. */
class AttachmentResolutionError extends MySoMessagingStackClientError {
	constructor(cause: unknown) {
		super('attachment metadata unavailable');
		this.cause = cause;
	}
}

export class MySoMessagingStackClient<TApproveContext = void> {
	#packageConfig: MySoMessagingStackPackageConfig;
	#client: ClientWithCoreApi;
	#groupsClient: MySoGroupsClient;
	#blockGating: BlockGatingClient | undefined;
	#sync: MessagingSyncManager;
	#relayerAuthSigner: RelayerAuthSigner | undefined;
	#relayerUrl: string | undefined;
	/** Primary (reading) MLS session: the signed-in human's device. */
	#mls: MlsSession | undefined;
	/** Every opened session by wallet (human + agents, each its own MLS device). */
	#mlsSessions = new Map<string, MlsSession>();
	#attachments: AttachmentsManager<TApproveContext> | undefined;
	#recovery: RecoveryTransport | undefined;
	readonly #textEncoder = new TextEncoder();
	readonly #textDecoder = new TextDecoder();

	call: MySoMessagingStackCall;
	tx: MySoMessagingStackTransactions;
	view: MySoMessagingStackView;
	bcs: MySoMessagingStackBCS;
	derive: MySoMessagingStackDerive;
	encryption: EnvelopeEncryption<TApproveContext>;
	/** Resolved messaging package configuration. */
	readonly packageConfig: MySoMessagingStackPackageConfig;
	/** Base MySo client for advanced transaction composition. */
	readonly mysoClient: ClientWithCoreApi;
	/** Underlying permissioned-groups client (same instance registered on the base client). */
	readonly groups: MySoGroupsClient;
	/** Low-level transport for direct relayer access. Use `sendMessage()`, `getMessage()`, etc. for the high-level API. */
	transport: RelayerTransport;

	constructor(options: MySoMessagingStackClientOptions<TApproveContext, string, string>) {
		if (!options.client) {
			throw new MySoMessagingStackClientError('client must be provided');
		}
		this.#client = options.client;

		// Use custom packageConfig if provided, otherwise resolve genesis shared objects lazily.
		if (options.packageConfig) {
			this.#packageConfig = options.packageConfig;
		} else {
			throw new MySoMessagingStackClientError(
				'packageConfig is required. Use createMySoMessagingStackClientAsync to resolve genesis shared objects.',
			);
		}

		// Resolve extension dependencies by their registered names
		const groupsExt = options.client[options.groupsName];
		const mydataExt = options.client[options.mydataName] as MyDataClient;

		this.#groupsClient = groupsExt;
		this.groups = groupsExt;
		this.packageConfig = this.#packageConfig;
		this.mysoClient = this.#client;
		this.#blockGating = options.blockGating
			? new BlockGatingClient(options.blockGating)
			: undefined;

		// Build order matters: bcs → derive → view → encryption → call → tx
		this.bcs = new MySoMessagingStackBCS({ packageConfig: this.#packageConfig });
		this.derive = new MySoMessagingStackDerive({ packageConfig: this.#packageConfig });
		this.view = new MySoMessagingStackView({
			packageConfig: this.#packageConfig,
			client: this.#client,
			derive: this.derive,
			bcs: this.bcs,
		});
		this.encryption = new EnvelopeEncryption({
			mydataClient: mydataExt,
			mysoClient: this.#client,
			view: this.view,
			derive: this.derive,
			originalPackageId: this.#packageConfig.originalPackageId,
			latestPackageId: this.#packageConfig.latestPackageId,
			versionId: this.#packageConfig.versionId,
			encryption: options.encryption,
		});
		this.call = new MySoMessagingStackCall({
			packageConfig: this.#packageConfig,
			encryption: this.encryption,
			derive: this.derive,
			permissionedGroupTypeName: groupsExt.bcs.PermissionedGroup.name,
			encryptionHistoryTypeName: this.bcs.EncryptionHistory.name,
			messageLogTypeName: `${this.#packageConfig.originalPackageId}::message_log::MessageLog`,
			groupsCall: groupsExt.call,
			resolveMemoryAccountId: async (owner) => {
				return this.view.memoryAccountIdForOwner({ owner });
			},
		});
		this.tx = new MySoMessagingStackTransactions({
			call: this.call,
		});

		this.#attachments = options.attachments
			? new AttachmentsManager(this.encryption, options.attachments)
			: undefined;

		const transport = options.relayer.transport
			? options.relayer.transport
			: buildDefaultRelayerTransport(options.relayer);
		this.#relayerUrl = (options.relayer as { relayerUrl?: string }).relayerUrl;
		this.#relayerAuthSigner = options.relayer.authSigner;
		this.transport = this.#relayerAuthSigner
			? withRelayerAuthSigner(transport, this.#relayerAuthSigner)
			: transport;

		this.#sync = new MessagingSyncManager(this.transport);

		this.#recovery = options.recovery;
	}

	// === Private Helpers ===

	/** Address the relayer authenticates `signer` as (after `relayer.authSigner`). */
	#relayerAddress(signer: Signer): string {
		return (this.#relayerAuthSigner ? this.#relayerAuthSigner(signer) : signer).toMySoAddress();
	}

	/**
	 * Executes a transaction with the given signer and waits for confirmation.
	 * @throws {MySoMessagingStackClientError} if the transaction fails
	 */
	async #executeTransaction(transaction: Transaction, signer: Signer, action: string) {
		transaction.setSenderIfNotSet(signer.toMySoAddress());

		const result = await signer.signAndExecuteTransaction({
			transaction,
			client: this.#client,
		});

		const tx = result.Transaction ?? result.FailedTransaction;
		if (!tx) {
			throw new MySoMessagingStackClientError(`Failed to ${action}: no transaction result`);
		}

		if (!tx.status.success) {
			throw new MySoMessagingStackClientError(
				`Failed to ${action} (${tx.digest}): ${tx.status.error}`,
			);
		}

		await this.#client.core.waitForTransaction({ result });

		return { digest: tx.digest, effects: tx.effects };
	}

	// === Messaging Methods ===

	/**
	 * Encrypt and send a message to a group.
	 *
	 * At least one of `text` or `files` must be provided.
	 * When `files` is provided, attachments support must be configured.
	 *
	 * @returns The relayer-assigned message ID.
	 */
	async sendMessage(options: SendMessageOptions<TApproveContext>): Promise<{ messageId: string }> {
		this.#validateSendInput(options);

		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);
		const senderAddress = this.#relayerAddress(options.signer);

		await this.#assertDmNotBlocked(
			groupId,
			senderAddress,
			options.principalOwner ?? options.attribution?.principalOwner,
		);

		if (await this.writesContentEnvelopeV2(options.groupRef)) {
			return this.#sendMessageV2(options, { groupId, encryptionHistoryId }, approveContext, senderAddress);
		}

		// 1. Encrypt text (empty string for attachment-only messages).
		const textBytes = this.#textEncoder.encode(options.text ?? '');
		const keyVersion = await this.view.getCurrentKeyVersion({ encryptionHistoryId });
		const aad = buildMessageAad({ groupId, keyVersion, senderAddress });

		const envelope = await this.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			data: textBytes,
			keyVersion,
			aad,
			...approveContext,
		} as EncryptOptions<TApproveContext>);

		// 2. Upload attachments if present.
		const attachmentRefs = await this.#uploadAttachments(
			options.files,
			{ groupId, encryptionHistoryId },
			approveContext,
			{ groupId, keyVersion, senderAddress },
		);

		const kind = options.kind ?? 'text';
		const sharedPostAddress =
			kind === 'post'
				? (normalizeSharedPostAddress(options.sharedPostAddress) ?? undefined)
				: undefined;
		if (kind === 'post') {
			if (!sharedPostAddress) {
				throw new Error('sharedPostAddress is required when kind is post');
			}
			if (!options.idempotencyKey?.trim()) {
				throw new Error('idempotencyKey is required when kind is post');
			}
		}

		// 1:1 DM payments: the relayer rejects these in groups with more than two members.
		let transferDigest: string | undefined;
		if (kind === 'token_transfer') {
			transferDigest = options.paymentMetadata?.digest?.trim();
			if (!transferDigest) {
				throw new Error('paymentMetadata.digest is required when kind is token_transfer');
			}
			if (options.idempotencyKey !== transferIdempotencyKey(senderAddress, transferDigest)) {
				throw new Error('idempotencyKey must be transferIdempotencyKey(sender, digest)');
			}
		} else if (kind === 'request_payment') {
			if (!options.paymentMetadata?.assetKind) {
				throw new Error('paymentMetadata.assetKind is required when kind is request_payment');
			}
			if (!options.idempotencyKey?.startsWith('request:')) {
				throw new Error('idempotencyKey must start with "request:" when kind is request_payment');
			}
		}

		// 3. Sign the ciphertext for sender verification (includes kind;
		// post binds sharedPostAddress + idempotencyKey; token_transfer binds digest + key).
		const signatureVersion: 1 | 2 = attachmentRefs.length > 0 || Boolean(options.attribution) ? 2 : 1;
		const messageSignature = await signMessageContent(options.signer, {
			groupId,
			kind,
			signatureVersion,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
			sharedPostAddress,
			transferDigest,
			idempotencyKey: options.idempotencyKey,
			attachments: attachmentRefs,
			attribution: options.attribution,
		});

		// 4. Send via transport.
		const result = await this.transport.sendMessage({
			signer: options.signer,
			groupId,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
			kind,
			signatureVersion,
			idempotencyKey: options.idempotencyKey,
			sharedPostAddress,
			paymentMetadata:
				kind === 'token_transfer' || kind === 'request_payment'
					? options.paymentMetadata
					: undefined,
			attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
			messageSignature,
			attribution: options.attribution
				? {
						principalOwner: options.attribution.principalOwner,
						subAgentId: options.attribution.subAgentId,
						identityClass: options.attribution.identityClass,
					}
				: undefined,
		});

		return { messageId: result.messageId };
	}

	/**
	 * Post a `token_transfer` message for an already-submitted on-chain transfer (1:1 DMs only).
	 *
	 * The caller submits the transfer first and passes its `digest`. The amount, asset and
	 * note are encrypted; the relayer verifies the digest on-chain and sets the status
	 * (`pending` -> `success` | `failed`). Retries are idempotent per `(sender, digest)`.
	 */
	async sendTokenTransfer(
		options: SendTokenTransferOptions<TApproveContext>,
	): Promise<{ messageId: string }> {
		const senderAddress = this.#relayerAddress(options.signer);
		const digest = options.digest.trim();
		return this.sendMessage({
			signer: options.signer,
			groupRef: options.groupRef,
			text: encodeTokenTransferPayload(options.payload),
			kind: 'token_transfer',
			idempotencyKey: transferIdempotencyKey(senderAddress, digest),
			paymentMetadata: {
				digest,
				assetKind: options.payload.asset.kind,
				requestMessageId: options.requestMessageId,
				senderWallet: options.senderWallet,
			},
			...this.#approveContextSpread(options),
		} as unknown as SendMessageOptions<TApproveContext>);
	}

	/**
	 * Send a `request_payment` message asking the DM counterpart to pay (1:1 DMs only).
	 * The counterpart can Confirm (by sending a `token_transfer` with `requestMessageId`) or
	 * Reject via {@link respondToPaymentRequest}; the requester can cancel.
	 */
	async sendPaymentRequest(
		options: SendPaymentRequestOptions<TApproveContext>,
	): Promise<{ messageId: string }> {
		const requestId = options.requestId?.trim() || globalThis.crypto.randomUUID();
		return this.sendMessage({
			signer: options.signer,
			groupRef: options.groupRef,
			text: encodePaymentRequestPayload(options.payload),
			kind: 'request_payment',
			idempotencyKey: `request:${requestId}`,
			paymentMetadata: { assetKind: options.payload.asset.kind },
			...this.#approveContextSpread(options),
		} as unknown as SendMessageOptions<TApproveContext>);
	}

	/**
	 * Reject (payer) or cancel (requester) an open payment request. The relayer enforces who
	 * may act and that the request is still open; subscribers receive the updated message.
	 */
	async respondToPaymentRequest(options: RespondToPaymentRequestOptions): Promise<void> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		await this.transport.respondToPaymentRequest({
			signer: options.signer,
			groupId,
			messageId: options.messageId,
			action: options.action,
		});
	}

	/**
	 * Fetch and decrypt a single message.
	 */
	async getMessage(options: GetMessageOptions<TApproveContext>): Promise<DecryptedMessage> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

		// MLS groups: the readable copy is the one this device stored when it synced (or sent) it.
		if (await this.#readsMls(groupId)) {
			let stored = await this.#storedMlsRow(groupId, options.messageId);
			if (!stored) {
				await this.#mls!.sync(groupId);
				stored = await this.#storedMlsRow(groupId, options.messageId);
			}
			if (!stored) throw new MySoMessagingStackClientError('Message not found on this device');
			const [message] = await this.#decryptUnwrapped([stored], { groupId, encryptionHistoryId }, approveContext);
			if (!message) throw new MySoMessagingStackClientError('Message could not be decrypted');
			return message;
		}

		const raw = await this.transport.fetchMessage({
			signer: options.signer,
			messageId: options.messageId,
			groupId,
		});

		if (raw.messageId !== options.messageId) {
			throw new MySoMessagingStackClientError('Message does not match the requested ID');
		}
		return this.#decryptMessage(raw, { groupId, encryptionHistoryId }, approveContext);
	}

	/**
	 * Fetch and decrypt a paginated list of messages.
	 */
	async getMessages(options: GetMessagesOptions<TApproveContext>): Promise<GetMessagesResult> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

		// MLS groups: process the log forward into the local store, then page from the store
		// (MLS keys are single use; the relayer copy can't be decrypted twice).
		if (await this.#readsMls(groupId)) {
			await this.#mls!.sync(groupId);
			const limit = options.limit ?? 50;
			const rows = await this.#mls!.rows(groupId, { before: options.beforeOrder, limit });
			const after = options.afterOrder;
			return {
				messages: await this.#decryptUnwrapped(
					after === undefined ? rows : rows.filter((r) => r.order > after),
					{ groupId, encryptionHistoryId },
					approveContext,
				),
				hasNext: rows.length === limit,
			};
		}

		const result = await this.transport.fetchMessages({
			signer: options.signer,
			groupId,
			afterOrder: options.afterOrder,
			beforeOrder: options.beforeOrder,
			limit: options.limit,
		});

		const settled = await Promise.allSettled(
			result.messages.map((raw) =>
				this.#decryptMessage(raw, { groupId, encryptionHistoryId }, approveContext),
			),
		);

		const messages: DecryptedMessage[] = [];
		for (const entry of settled) {
			if (entry.status === 'fulfilled') {
				messages.push(entry.value);
			}
			// Silently skip messages that fail decryption (e.g. key not available yet).
		}

		return { messages, hasNext: result.hasNext };
	}

	/**
	 * Read a bounded room page without silently dropping failed decryptions.
	 * Normal reader permission is checked before and after fetching/decrypting.
	 * Only signature-verified text is released. Attribution, chronology, attachment
	 * metadata and system/deletion events are not promoted to signed evidence.
	 * This is not an agent-capability/organization-role or complete-history proof.
	 */
	async getRoomMessages(
		options: GetRoomMessagesOptions<TApproveContext>,
	): Promise<RoomHistoryPage> {
		const limit = validateRoomHistoryRequest(options);
		const groupIds = this.derive.resolveGroupRef(options.groupRef);
		const member = this.#relayerAddress(options.signer);
		const assertReader = async () => {
			if (this.#relayerAddress(options.signer) !== member) {
				this.encryption.clearCache(groupIds.groupId);
				throw new MySoMessagingStackClientError('Room signer changed during the request');
			}
			const allowed = await this.groups.view.hasPermission({
				groupId: groupIds.groupId,
				member,
				permissionType: messagingPermissionTypes(this.packageConfig.originalPackageId)
					.MessagingReader,
			});
			if (!allowed) {
				this.encryption.clearCache(groupIds.groupId);
				throw new MySoMessagingStackClientError('Current room reader permission is required');
			}
		};
		await assertReader();
		// MLS rooms: the relayer copy is MLS ciphertext whose keys are used up once read, so the
		// page comes from this device's store (after syncing the log). Rows there are already
		// verified against their MLS sender (`senderVerified`).
		const mls = await this.#readsMls(groupIds.groupId);
		const result = mls
			? await this.#mlsPage(groupIds.groupId, { afterOrder: options.afterOrder, beforeOrder: options.beforeOrder, limit })
			: await this.transport.fetchMessages({
					signer: options.signer,
					groupId: groupIds.groupId,
					afterOrder: options.afterOrder,
					beforeOrder: options.beforeOrder,
					limit,
				});
		const nextCursor = validateRoomHistoryPage(result, groupIds.groupId, { ...options, limit });
		const hasNext = result.hasNext;
		// Snapshot signed fields before asynchronous verification/decryption. Custom
		// transports may reuse mutable row objects for incoming realtime updates.
		const rows = result.messages.map((raw) => ({
			...raw,
			encryptedText: raw.encryptedText.slice(),
			nonce: raw.nonce instanceof Uint8Array ? raw.nonce.slice() : new Uint8Array(),
			paymentMetadata: raw.paymentMetadata ? { ...raw.paymentMetadata } : undefined,
			attachments: raw.attachments.map((attachment) => ({ ...attachment })),
		}));
		const approveContext = this.#approveContextSpread(options);
		const readRow = async (raw: RelayerMessage): Promise<RoomHistoryEntry> => {
			const row = { messageId: raw.messageId, order: raw.order };
			if (raw.kind === 'system') return { ...row, status: 'system_metadata' };
			if (raw.isDeleted) return { ...row, status: 'deleted_metadata' };
			const verified = mls ? (raw as UnwrappedRow).senderVerified === true : await this.#verifyRawMessage(raw);
			if (!verified) return { ...row, status: 'unverified_content' };
			try {
				let message: DecryptedMessage;
				try {
					message = await this.#decryptMessage(raw, groupIds, approveContext, {
						senderVerified: true,
					});
				} catch (error) {
					// Keep valid text readable if separately encrypted attachment metadata is
					// unavailable or malformed. Any other failure (e.g. the body's key) is final.
					if (!(error instanceof AttachmentResolutionError)) throw error;
					message = await this.#decryptMessage(raw, groupIds, approveContext, {
						senderVerified: true,
						resolveAttachments: false,
					});
				}
				return verifiedRoomEntry(raw, message);
			} catch {
				// Never expose provider errors, encrypted bytes, keys or partial plaintext.
				return { ...row, status: 'unavailable_content' };
			}
		};
		const entries: RoomHistoryEntry[] = [];
		// Keep at most four key/decryption requests in flight and preserve row order.
		for (let start = 0; start < rows.length; start += 4) {
			entries.push(...(await Promise.all(rows.slice(start, start + 4).map(readRow))));
		}
		await assertReader();
		return {
			groupId: groupIds.groupId,
			entries,
			hasNext,
			nextCursor,
			allContentVerified:
				entries.length > 0 && entries.every((entry) => entry.status === 'verified_content'),
			metadataSource: 'relayer_unverified',
		};
	}

	/**
	 * Encrypt and update an existing message.
	 * Only the original sender can edit their messages.
	 *
	 * When `attachments` is provided, the SDK computes the final attachment list
	 * from the diff and attempts best-effort storage cleanup for removed entries.
	 * When omitted, attachments are left unchanged.
	 */
	async editMessage(options: EditMessageOptions<TApproveContext>): Promise<void> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);
		const senderAddress = this.#relayerAddress(options.signer);

		// v2: edits are encrypted events; the relayer never learns which message changed.
		if (await this.writesContentEnvelopeV2(options.groupRef)) {
			let att: EnvelopeAttachment[] | undefined;
			if (options.attachments) {
				const removeSet = new Set(options.attachments.remove ?? []);
				const kept = (options.attachments.currentEnvelope ?? []).filter((a) => !removeSet.has(a.id));
				const added =
					options.attachments.new && options.attachments.new.length > 0
						? await this.#requireAttachments().uploadV2(options.attachments.new, { groupId, encryptionHistoryId })
						: [];
				att = [...kept, ...added];
			}
			await this.#sendEnvelope({
				signer: options.signer,
				groupIds: { groupId, encryptionHistoryId },
				approveContext,
				senderAddress,
				envelope: {
					t: 'event',
					e: { type: 'edit', target: options.messageId, text: options.text, ...(att ? { att } : {}) },
				},
			});
			return;
		}

		// Resolve existing kind for the signed canonical string.
		const existing = await this.transport.fetchMessage({
			signer: options.signer,
			messageId: options.messageId,
			groupId,
		});
		const kind = existing.kind && existing.kind !== 'system' ? existing.kind : 'text';

		// 1. Encrypt new text.
		const textBytes = this.#textEncoder.encode(options.text);
		const keyVersion = await this.view.getCurrentKeyVersion({ encryptionHistoryId });
		const aad = buildMessageAad({ groupId, keyVersion, senderAddress });

		const envelope = await this.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			data: textBytes,
			keyVersion,
			aad,
			...approveContext,
		} as EncryptOptions<TApproveContext>);

		// 2. Compute attachment changes if requested.
		let finalAttachments: Attachment[] = existing.attachments;
		let removedStorageIds: string[] | undefined;

		if (options.attachments) {
			const { current, remove, new: newFiles } = options.attachments;
			const removeSet = new Set(remove ?? []);

			// Keep current attachments that are not in the remove set.
			const kept =
				removeSet.size > 0 ? current.filter((a) => !removeSet.has(a.storageId)) : current;

			// Upload new files.
			const uploaded = await this.#uploadAttachments(
				newFiles,
				{ groupId, encryptionHistoryId },
				approveContext,
				{ groupId, keyVersion, senderAddress },
			);

			finalAttachments = [...kept, ...uploaded];
			if (removeSet.size > 0) {
				removedStorageIds = [...removeSet];
			}
		}

		// 3. Sign the ciphertext for sender verification (includes kind).
		const hasAttribution = Boolean(existing.principalOwner || existing.subAgentId || existing.identityClass !== undefined);
		const attribution: SignedMessageAttribution | undefined = hasAttribution ? {
			...(existing.principalOwner ? { principalOwner: existing.principalOwner } : {}),
			...(existing.subAgentId ? { subAgentId: existing.subAgentId } : {}),
			...(existing.identityClass !== undefined ? { identityClass: existing.identityClass } : {}),
		} : undefined;
		const signatureVersion: 1 | 2 = finalAttachments.length > 0 || hasAttribution ? 2 : 1;
		const messageSignature = await signMessageContent(options.signer, {
			groupId,
			kind,
			signatureVersion,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
			attachments: finalAttachments,
			attribution,
		});

		// 4. Update via transport.
		await this.transport.updateMessage({
			signer: options.signer,
			messageId: options.messageId,
			groupId,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
			attachments: finalAttachments,
			signatureVersion,
			messageSignature,
		});

		// 4. Best-effort storage cleanup for removed attachments.
		if (removedStorageIds && this.#attachments) {
			this.#attachments.deleteStorageEntries(removedStorageIds).catch(() => {});
		}
	}

	/**
	 * Soft-delete a message.
	 * Only the original sender can delete their messages.
	 */
	async deleteMessage(options: DeleteMessageOptions): Promise<void> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);

		// v2: an encrypted delete event lets every device drop its local copy (required once
		// messages live in local stores under MLS); the DELETE below drops the relayer ciphertext.
		if (await this.writesContentEnvelopeV2(options.groupRef)) {
			await this.#sendEnvelope({
				signer: options.signer,
				groupIds: { groupId, encryptionHistoryId },
				approveContext: {},
				senderAddress: this.#relayerAddress(options.signer),
				envelope: { t: 'event', e: { type: 'delete', target: options.messageId } },
			});
		}

		await this.transport.deleteMessage({
			signer: options.signer,
			messageId: options.messageId,
			groupId,
		});
	}

	/**
	 * Subscribe to real-time messages and reaction updates for a group as a
	 * single event stream.
	 *
	 * Message events are decrypted before yielding; reaction events are passed
	 * through as absolute state (count + reactor list), keyed by the target
	 * message's relayer `order` (`chainSeq`). The iterable completes when the
	 * AbortSignal fires or {@link disconnect} is called.
	 *
	 * @example
	 * ```ts
	 * const controller = new AbortController();
	 * for await (const event of client.messaging.subscribe({
	 *   signer: keypair,
	 *   groupRef: { uuid: '...' },
	 *   signal: controller.signal,
	 * })) {
	 *   if (event.type === 'message') {
	 *     console.log(event.message.text, event.message.attachments);
	 *   } else {
	 *     console.log(event.reaction.emoji, event.reaction.count);
	 *   }
	 * }
	 * ```
	 *
	 * @yields {@link MessagingEvent} items as they arrive from the transport.
	 */
	async *subscribe(options: SubscribeOptions<TApproveContext>): AsyncIterable<MessagingEvent> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

		for await (const event of this.transport.subscribe({
			signer: options.signer,
			groupId,
			afterOrder: options.afterOrder,
			signal: options.signal,
		})) {
			switch (event.type) {
				case 'message.created':
				case 'message.deleted':
				case 'message.edited': {
					let mlsGroup = false;
					try {
						mlsGroup = await this.#readsMls(groupId);
					} catch {
						break; // `mls1` group not readable here yet; the next event retries
					}
					if (mlsGroup) {
						// Any new row (message, event, commit) advances the ordered MLS log.
						try {
							const fresh = await this.#mls!.sync(groupId);
							for (const message of await this.#decryptUnwrapped(fresh, { groupId, encryptionHistoryId }, approveContext)) {
								yield { type: 'message', message };
							}
						} catch {
							// Retried on the next event / page load.
						}
						break;
					}
					try {
						const message = await this.#decryptMessage(
							event.message,
							{ groupId, encryptionHistoryId },
							approveContext,
						);
						yield { type: 'message', message };
					} catch {
						// Skip messages that fail decryption (e.g. key not available yet).
					}
					break;
				}
				case 'reaction.updated':
					yield { type: 'reaction', reaction: event.reaction };
					break;
				case 'typing.start':
					yield {
						type: 'typing',
						typing: {
							member: event.typing.member,
							typing: true,
							expiresAt: event.typing.expiresAt,
						},
					};
					break;
				case 'typing.stop':
					yield {
						type: 'typing',
						typing: { member: event.typing.member, typing: false },
					};
					break;
				case 'presence.updated':
					yield {
						type: 'presence',
						presence: { member: event.presence.member, online: event.presence.online },
					};
					break;
				case 'receipt.updated':
					yield { type: 'receipt', receipt: event.receipt };
					break;
			}
		}
	}

	// === Reactions ===

	/**
	 * List reaction tallies for a group (optionally a single message).
	 * Entries are keyed by the message's relayer `order` (`chainSeq`).
	 */
	async listReactions(options: ListReactionsOptions): Promise<RelayerReactionEntry[]> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		return this.transport.listGroupReactions({
			signer: options.signer,
			groupId,
			chainSeq: options.order,
		});
	}

	/**
	 * Add the signer's reaction to a message. Idempotent — re-adding an
	 * existing reaction is a no-op on the relayer.
	 */
	async addReaction(options: ReactionOptions): Promise<void> {
		if (await this.#reactV2(options, true)) return;
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		await this.transport.postGroupReaction({
			signer: options.signer,
			groupId,
			chainSeq: options.order,
			emoji: emojiToStorage(options.emoji),
			add: true,
		});
	}

	/**
	 * Remove the signer's reaction from a message. Idempotent — removing an
	 * absent reaction is a no-op on the relayer.
	 */
	async removeReaction(options: ReactionOptions): Promise<void> {
		if (await this.#reactV2(options, false)) return;
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		await this.transport.postGroupReaction({
			signer: options.signer,
			groupId,
			chainSeq: options.order,
			emoji: emojiToStorage(options.emoji),
			add: false,
		});
	}

	/** v2 groups: reactions are encrypted events. Returns false for v1 groups (caller uses the legacy API). */
	async #reactV2(options: ReactionOptions, add: boolean): Promise<boolean> {
		if (!(await this.writesContentEnvelopeV2(options.groupRef))) return false;
		if (!options.messageId) {
			throw new MySoMessagingStackClientError(
				'messageId is required to react in a content-envelope-v2 group',
			);
		}
		const sender = this.#relayerAddress(options.signer);
		const target = options.targetSenderAddress?.toLowerCase();
		await this.sendEvent({
			signer: options.signer,
			groupRef: options.groupRef,
			event: {
				type: 'reaction',
				target: options.messageId,
				emoji: emojiToStorage(options.emoji),
				add,
			},
			// Push the author on add, never on removal; reacting to yourself notifies nobody.
			notifyWallets: add && target && target !== sender.toLowerCase() ? [target] : undefined,
		});
		return true;
	}

	// === Content envelope v2 ===

	/**
	 * Whether `groupRef` writes content envelope v2: its on-chain metadata `data["e2ee"]` is `v2`
	 * (or a later protocol). Reads cached metadata; pass `refresh` after changing the flag.
	 */
	async writesContentEnvelopeV2(groupRef: GroupRef, refresh = false): Promise<boolean> {
		const { groupId } = this.derive.resolveGroupRef(groupRef);
		try {
			const meta = (await this.view.groupsMetadata({ groupIds: [groupId], refresh }))[groupId];
			const entry = meta?.data?.contents?.find((c: { key: string }) => c.key === 'e2ee');
			return entry?.value === 'v2' || entry?.value === 'mls1';
		} catch {
			return false;
		}
	}

	/** Turn on content envelope v2 for a group (requires `MetadataAdmin`). Readers must already support v2. */
	async enableContentEnvelopeV2(options: { signer: Signer; groupRef: GroupRef }) {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		const result = await this.insertGroupData({
			signer: options.signer,
			groupId,
			key: 'e2ee',
			value: 'v2',
		});
		await this.view.groupsMetadata({ groupIds: [groupId], refresh: true }).catch(() => {});
		return result;
	}

	/**
	 * Send an encrypted event (reaction, edit, delete, pin, poll vote) in a v2 group. The relayer
	 * stores an opaque `event` row; it never learns the type or the target.
	 */
	async sendEvent(options: SendEventOptions): Promise<{ messageId: string }> {
		const groupIds = this.derive.resolveGroupRef(options.groupRef);
		return this.#sendEnvelope({
			signer: options.signer,
			groupIds,
			approveContext: {},
			senderAddress: this.#relayerAddress(options.signer),
			envelope: { t: 'event', e: options.event },
			notifyWallets: options.notifyWallets,
		});
	}

	/** Seal `name` with the group's current DEK for on-chain storage (`enc:v1:<v>:…`). */
	async encryptGroupName(groupRef: GroupRef, name: string): Promise<string> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(groupRef);
		const keyVersion = await this.view.getCurrentKeyVersion({ encryptionHistoryId });
		const sealed = await this.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			data: padGroupName(name),
			keyVersion,
			aad: groupNameAad(groupId),
		} as EncryptOptions<TApproveContext>);
		return formatEncryptedGroupName(keyVersion, sealed.nonce, sealed.ciphertext);
	}

	/**
	 * Display name for an on-chain `Metadata.name`: cleartext names pass through; `enc:v1:` names are
	 * decrypted (members only). Returns `null` when an encrypted name can't be opened.
	 */
	async decryptGroupName(groupRef: GroupRef, name: string): Promise<string | null> {
		const parsed = parseEncryptedGroupName(name);
		if (!parsed) return isEncryptedGroupName(name) ? null : name;
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(groupRef);
		try {
			const padded = await this.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope: {
					ciphertext: parsed.ciphertext,
					nonce: parsed.nonce,
					keyVersion: parsed.keyVersion,
					aad: groupNameAad(groupId),
				},
			} as DecryptOptions<TApproveContext>);
			return unpadGroupName(padded);
		} catch {
			return null;
		}
	}

	/** Pin or unpin a message (v2 groups). */
	async setPinned(options: { signer: Signer; groupRef: GroupRef; messageId: string; pinned: boolean }) {
		return this.sendEvent({
			signer: options.signer,
			groupRef: options.groupRef,
			event: { type: 'pin', target: options.messageId, pinned: options.pinned },
		});
	}

	async #sendMessageV2(
		options: SendMessageOptions<TApproveContext>,
		groupIds: { groupId: string; encryptionHistoryId: string },
		approveContext: Record<string, unknown>,
		senderAddress: string,
	): Promise<{ messageId: string }> {
		const kind = options.kind ?? 'text';
		const att =
			options.files && options.files.length > 0
				? await this.#requireAttachments().uploadV2(options.files, groupIds)
				: undefined;
		const sharedPostAddress =
			kind === 'post' ? (normalizeSharedPostAddress(options.sharedPostAddress) ?? undefined) : undefined;
		if (kind === 'post' && (!sharedPostAddress || !options.idempotencyKey?.trim())) {
			throw new Error('sharedPostAddress and idempotencyKey are required when kind is post');
		}
		let transferDigest: string | undefined;
		if (kind === 'token_transfer') {
			transferDigest = options.paymentMetadata?.digest?.trim();
			if (!transferDigest) throw new Error('paymentMetadata.digest is required when kind is token_transfer');
			if (options.idempotencyKey !== transferIdempotencyKey(senderAddress, transferDigest)) {
				throw new Error('idempotencyKey must be transferIdempotencyKey(sender, digest)');
			}
		} else if (kind === 'request_payment') {
			if (!options.paymentMetadata?.assetKind) {
				throw new Error('paymentMetadata.assetKind is required when kind is request_payment');
			}
			if (!options.idempotencyKey?.startsWith('request:')) {
				throw new Error('idempotencyKey must start with "request:" when kind is request_payment');
			}
		}
		return this.#sendEnvelope({
			signer: options.signer,
			groupIds,
			approveContext,
			senderAddress,
			envelope: { t: kind as EnvelopeMessageType, text: options.text ?? '', ...(att ? { att } : {}) },
			idempotencyKey: options.idempotencyKey,
			sharedPostAddress,
			transferDigest,
			paymentMetadata:
				kind === 'token_transfer' || kind === 'request_payment' ? options.paymentMetadata : undefined,
			attribution: options.attribution,
		});
	}

	/** Encrypt + sign + POST one content-envelope-v2 row. */
	async #sendEnvelope(params: {
		signer: Signer;
		groupIds: { groupId: string; encryptionHistoryId: string };
		approveContext: Record<string, unknown>;
		senderAddress: string;
		envelope: ContentEnvelope;
		notifyWallets?: string[];
		idempotencyKey?: string;
		sharedPostAddress?: string;
		transferDigest?: string;
		paymentMetadata?: SendMessageOptions<TApproveContext>['paymentMetadata'];
		attribution?: SendMessageOptions<TApproveContext>['attribution'];
	}): Promise<{ messageId: string }> {
		const { groupId, encryptionHistoryId } = params.groupIds;
		const kind = relayerKindForEnvelope(params.envelope);
		const keyVersion = await this.view.getCurrentKeyVersion({ encryptionHistoryId });
		const aad = buildMessageAad({ groupId, keyVersion, senderAddress: params.senderAddress });
		const sealed = await this.encryption.encrypt({
			groupId,
			encryptionHistoryId,
			data: encodeContentEnvelope(params.envelope),
			keyVersion,
			aad,
			...params.approveContext,
		} as EncryptOptions<TApproveContext>);
		// MLS groups: the sender's own MLS device wraps the DEK-sealed row (agents have their own),
		// after enforcing the on-chain membership rule.
		let rowText = sealed.ciphertext;
		let rowNonce = sealed.nonce;
		const sender = await this.#senderMlsSession(groupId, params.senderAddress);
		const mls = sender !== null;
		if (sender) {
			// Membership rule + encrypt atomically; pauses (MlsMembersUnverifiedError) rather than
			// encrypt to a device it couldn't verify.
			rowText = await sender.seal(groupId, await this.#onChainReaders(groupId), {
				nonce: sealed.nonce,
				keyVersion: sealed.keyVersion,
				ciphertext: sealed.ciphertext,
			});
			rowNonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
		}
		const signatureVersion: 1 | 2 = params.attribution ? 2 : 1;
		const messageSignature = await signMessageContent(params.signer, {
			groupId,
			kind,
			signatureVersion,
			encryptedText: rowText,
			nonce: rowNonce,
			keyVersion: sealed.keyVersion,
			sharedPostAddress: params.sharedPostAddress,
			transferDigest: params.transferDigest,
			idempotencyKey: params.idempotencyKey,
			attachments: [],
			attribution: params.attribution,
		});
		const result = await this.transport.sendMessage({
			signer: params.signer,
			groupId,
			encryptedText: rowText,
			nonce: rowNonce,
			keyVersion: sealed.keyVersion,
			kind,
			signatureVersion,
			idempotencyKey: params.idempotencyKey,
			sharedPostAddress: params.sharedPostAddress,
			paymentMetadata: params.paymentMetadata,
			messageSignature,
			notifyWallets: params.notifyWallets,
			attribution: params.attribution
				? {
						principalOwner: params.attribution.principalOwner,
						subAgentId: params.attribution.subAgentId,
						identityClass: params.attribution.identityClass,
					}
				: undefined,
		});
		if (mls) {
			// MLS never hands our own message back; keep the readable copy now.
			const stored = await this.transport.fetchMessage({
				signer: params.signer,
				messageId: result.messageId,
				groupId,
			});
			// Stored in the reading (primary) session so the human's view shows it too.
			await (this.#mls ?? sender!).storeOwn(groupId, {
				...stored,
				encryptedText: sealed.ciphertext,
				nonce: sealed.nonce,
				keyVersion: sealed.keyVersion,
				senderVerified: true,
			});
		}
		return { messageId: result.messageId };
	}

	// === MLS (E2EE M4–M6) ===

	/**
	 * Open this device's MLS session (restores or creates the device, certifies it with `signer`,
	 * publishes KeyPackages) and attach it to the client. `wasm` is the `myso-mls` module the app
	 * loads; `store` persists device state and unwrapped rows (sealed at rest by the app).
	 */
	async openMlsSession(options: {
		wasm: MlsWasmModule;
		store: MlsStateStore;
		signer: Signer;
		deviceId: string;
		/**
		 * zkLogin certificate check via a fullnode (`verifyZkloginSignature`): resolve its
		 * `success`, throw when unreachable. Defaults to this client's own fullnode.
		 */
		verifyZkLogin?: (message: Uint8Array, signatureHex: string, wallet: string) => Promise<boolean>;
		/**
		 * `false` for an agent's own device: it only sends (as itself) and never becomes the
		 * session messages are read through. Defaults to `true` for the first session.
		 */
		primary?: boolean;
		/**
		 * Certificate renewal through the on-chain `MlsDeviceRegistry` (requires the registry object
		 * to exist on this chain). `submitter` executes registry transactions with sponsored gas;
		 * without it the session verifies others' v2 certificates but doesn't renew its own.
		 */
		registry?: { submitter?: MlsRegistrySubmitter; rotateAfterMs?: number };
	}): Promise<MlsSession> {
		if (!this.#relayerUrl) {
			throw new MySoMessagingStackClientError('MLS needs relayer.relayerUrl in the client options');
		}
		const core = this.#client.core;
		const session = await MlsSession.open({
			wasm: options.wasm,
			store: options.store,
			signer: options.signer,
			// The account the groups list as the member (zkLogin: the zkLogin address, not the
			// ephemeral key), so the certificate names a wallet that is an on-chain reader.
			identity: this.#relayerAuthSigner ? this.#relayerAuthSigner(options.signer) : options.signer,
			deviceId: options.deviceId,
			relayer: new HttpMlsRelayer({ relayerUrl: this.#relayerUrl, transport: this.transport }),
			verifyCertificate: createCertificateVerifier(
				(c) => options.wasm.mlsCertificateCanonical(c.wallet, c.device_id, c.mls_key, c.issued_at_ms),
				{
					verifyZkLogin:
						options.verifyZkLogin ??
						(async (message, signatureHex, address) => {
							const res = await core.verifyZkLoginSignature({
								bytes: toBase64(message),
								signature: toBase64(fromHex(signatureHex)),
								intentScope: 'PersonalMessage',
								address,
							});
							return res.success;
						}),
					currentEpoch: async () => BigInt((await core.getCurrentSystemState()).systemState.epoch),
				},
			),
			verifyRow: (row) => this.#verifyRawMessage(row),
			onChainReaders: (groupId) => this.#onChainReaders(groupId),
			registry: options.registry
				? {
						chain: this.mlsDeviceRegistry(),
						submitter: options.registry.submitter,
						rotateAfterMs: options.registry.rotateAfterMs,
					}
				: undefined,
			historyShareDays: async (groupId) => {
				try {
					const meta = (await this.view.groupsMetadata({ groupIds: [groupId] }))[groupId];
					const raw = meta?.data?.contents?.find((c: { key: string }) => c.key === 'e2ee_history_days')?.value;
					const days = Number(raw ?? 0);
					return Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 0;
				} catch {
					return 0;
				}
			},
		});
		this.#mlsSessions.set(session.wallet, session);
		const primary = options.primary ?? !this.#mls;
		if (primary) this.#mls = session;
		await session.acceptWelcomes();
		if (primary) {
			// Own-device history: join/create the self-group; a new device receives history from
			// an existing one, an existing one sends to any device that just joined.
			await session.ensureSelfGroup().catch(() => {});
			await session.syncSelf().catch(() => {});
		}
		return session;
	}

	/**
	 * Use an already-open session (e.g. from another client of the same app and network) instead of
	 * opening a second one. One device must have exactly one live session: two would each encrypt
	 * from their own copy of the state.
	 */
	attachMlsSession(session: MlsSession, options: { primary?: boolean } = {}): void {
		this.#mlsSessions.set(session.wallet, session);
		if (options.primary ?? !this.#mls) this.#mls = session;
	}

	#mlsRegistry: ChainMlsDeviceRegistry | undefined;

	/** The on-chain MLS device registry (reads + transaction builders). */
	mlsDeviceRegistry(): ChainMlsDeviceRegistry {
		this.#mlsRegistry ??= new ChainMlsDeviceRegistry({
			client: this.#client,
			originalPackageId: this.packageConfig.originalPackageId,
			latestPackageId: this.packageConfig.latestPackageId,
			registryId: this.derive.mlsDeviceRegistryId(),
			versionId: this.packageConfig.versionId,
		});
		return this.#mlsRegistry;
	}

	get mlsSession(): MlsSession | undefined {
		return this.#mls;
	}

	/** On-chain `data["e2ee"]` for a group (cached metadata). Throws if it can't be read. */
	async #e2eeFlag(groupId: string): Promise<string | undefined> {
		const meta = (await this.view.groupsMetadata({ groupIds: [groupId] }))[groupId];
		return meta?.data?.contents?.find((c: { key: string }) => c.key === 'e2ee')?.value;
	}

	/**
	 * Read path: `true` = read through MLS. For an `mls1` group this device isn't in yet, first
	 * picks up a Welcome or joins by external commit; throws {@link MlsGroupUnavailableError} if
	 * that isn't possible here (so the UI can say why instead of showing an empty thread).
	 */
	async #readsMls(groupId: string): Promise<boolean> {
		let flag: string | undefined;
		try {
			flag = await this.#e2eeFlag(groupId);
		} catch {
			return false; // metadata unreachable: legacy rows still decrypt; MLS rows are skipped
		}
		if (flag !== 'mls1') return false;
		if (!this.#mls) throw new MlsGroupUnavailableError(groupId, 'no-device');
		if (await this.#mls.ensureGroup(groupId)) return true;
		throw new MlsGroupUnavailableError(groupId, 'not-joined');
	}

	/** Whether `groupRef` runs MLS (`e2ee=mls1`) and this device is (now) in its MLS group. */
	async usesMls(groupRef: GroupRef): Promise<boolean> {
		const { groupId } = this.derive.resolveGroupRef(groupRef);
		try {
			return await this.#readsMls(groupId);
		} catch {
			return false;
		}
	}

	/**
	 * MLS status of a group on this device: `off` (not an MLS group), `ready`, or why it can't be
	 * used here ({@link MlsUnavailableReason}).
	 */
	async mlsStatus(groupRef: GroupRef): Promise<'off' | 'ready' | MlsUnavailableReason> {
		const { groupId } = this.derive.resolveGroupRef(groupRef);
		try {
			return (await this.#readsMls(groupId)) ? 'ready' : 'off';
		} catch (error) {
			return error instanceof MlsGroupUnavailableError ? error.reason : 'not-joined';
		}
	}

	/**
	 * Set up the MLS group of a group created as `mls1` (`createAndShareGroup({ groupData: {
	 * e2ee: 'mls1' } })`): the MLS group with every device of the current on-chain readers.
	 * Race-safe and idempotent; retried while the relayer catches up with the new group's
	 * membership. If it still can't finish, the first member to open the group finishes it.
	 * Returns whether this device ended up in the MLS group.
	 */
	async setupMlsGroup(options: { groupRef: GroupRef; attempts?: number }): Promise<boolean> {
		if (!this.#mls) throw new MlsGroupUnavailableError(this.derive.resolveGroupRef(options.groupRef).groupId, 'no-device');
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		const attempts = options.attempts ?? 5;
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				const readers = [...(await this.#onChainReaders(groupId))];
				if (await this.#mls.createGroup(groupId, readers)) return true;
			} catch {
				// Relayer / chain not caught up yet: retry.
			}
			await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
		}
		return false;
	}

	/**
	 * The MLS session `senderAddress` sends with in `mls1` group `groupId`, joining via external
	 * commit if this device isn't in the group yet. `null` for non-MLS groups.
	 */
	async #senderMlsSession(groupId: string, senderAddress: string): Promise<MlsSession | null> {
		// Never fall back to a non-MLS write because metadata couldn't be read: that would send
		// without forward secrecy (and MLS readers couldn't see it).
		const flag = await this.#e2eeFlag(groupId);
		if (flag !== 'mls1') return null;
		const session = this.#mlsSessions.get(senderAddress.toLowerCase());
		if (!session) throw new MlsGroupUnavailableError(groupId, 'no-device');
		if (!(await session.ensureGroup(groupId))) throw new MlsGroupUnavailableError(groupId, 'not-joined');
		return session;
	}

	/**
	 * Opt-in: share the last `days` of messages with members who join this MLS group later
	 * (0 = off, max 365). Requires MetadataAdmin. Shared rows show as unverified to the newcomer.
	 */
	async setHistorySharing(options: { signer: Signer; groupRef: GroupRef; days: number }) {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		const days = Math.max(0, Math.min(365, Math.floor(options.days)));
		const result = await this.insertGroupData({
			signer: options.signer,
			groupId,
			key: 'e2ee_history_days',
			value: String(days),
		});
		await this.view.groupsMetadata({ groupIds: [groupId], refresh: true }).catch(() => {});
		return result;
	}

	/** Lowercase wallets holding MessagingReader on-chain (the MLS membership rule's source of truth). */
	async #onChainReaders(groupId: string): Promise<Set<string>> {
		const reader = messagingPermissionTypes(this.packageConfig.originalPackageId).MessagingReader;
		const { members } = await this.#groupsClient.view.getMembers({ groupId, exhaustive: true });
		return new Set(members.filter((m) => m.permissions.includes(reader)).map((m) => m.address.toLowerCase()));
	}

	async #storedMlsRow(groupId: string, messageId: string): Promise<UnwrappedRow | undefined> {
		return (await this.#mls!.rows(groupId, { limit: 1_000_000 })).find((r) => r.messageId === messageId);
	}

	/** A room-history page from this device's MLS store (relayer page shape). */
	async #mlsPage(
		groupId: string,
		o: { afterOrder?: number; beforeOrder?: number; limit: number },
	): Promise<{ messages: UnwrappedRow[]; hasNext: boolean }> {
		await this.#mls!.sync(groupId);
		const all = (await this.#mls!.rows(groupId, { limit: 1_000_000 })).filter(
			(r) => (o.afterOrder === undefined || r.order > o.afterOrder) && (o.beforeOrder === undefined || r.order < o.beforeOrder),
		);
		// Same paging as the relayer: oldest-first after a cursor, else the newest page.
		const page = o.afterOrder !== undefined ? all.slice(0, o.limit) : all.slice(Math.max(0, all.length - o.limit));
		return { messages: page, hasNext: all.length > page.length };
	}

	async #decryptUnwrapped(
		rows: UnwrappedRow[],
		groupIds: { groupId: string; encryptionHistoryId: string },
		approveContext: Record<string, unknown>,
	): Promise<DecryptedMessage[]> {
		const settled = await Promise.allSettled(
			rows.map((row) =>
				this.#decryptMessage(row, groupIds, approveContext, { senderVerified: row.senderVerified }),
			),
		);
		return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
	}

	#requireAttachments(): AttachmentsManager<TApproveContext> {
		if (!this.#attachments) {
			throw new MySoMessagingStackClientError(
				'Attachments support is not configured. Provide `attachments` ' +
					'with a StorageAdapter when creating the messaging groups client.',
			);
		}
		return this.#attachments;
	}

	// === User-scoped synchronization ===

	/**
	 * Subscribe to the wallet-scoped user feed: `group.activity` (a message
	 * landed in one of your groups), `read_state.updated` (another device/tab
	 * advanced your read state), and `group.discovered` / `group.hidden`
	 * (conversations appearing/leaving).
	 *
	 * One socket per wallet; frames are metadata-only notifications — re-fetch
	 * canonical state over REST. Read-state cache invalidation is wired
	 * automatically: a `read_state.updated` event drops the local cache so the
	 * next `getReadState`/`getUnreadCounts` refetches.
	 *
	 * @yields {@link RelayerUserEvent} items as they arrive from the transport.
	 */
	async *subscribeUserEvents(options: {
		signer: Signer;
		signal?: AbortSignal;
		/** Sidebar group ids for the HTTP polling fallback (WS path ignores it). */
		groupIds?: string[];
	}): AsyncIterable<RelayerUserEvent> {
		const address = options.signer.toMySoAddress();

		for await (const event of this.transport.subscribeUserEvents({
			signer: options.signer,
			signal: options.signal,
			groupIds: options.groupIds,
		})) {
			if (event.type === 'read_state.updated') {
				this.#sync.invalidateReadState(address, event.blobVersion);
			}
			yield event;
		}
	}

	/** Fetch and decrypt the wallet-scoped read-state document from the relayer. */
	async getReadState(options: { signer: Signer }): Promise<UserReadState> {
		return this.#sync.getReadState(options.signer);
	}

	/**
	 * Advance a group's read watermark. Compare-and-set protected: concurrent
	 * writes from other tabs/devices are merged and retried, never clobbered.
	 * Skips the network round trip when the watermark would not advance.
	 */
	async updateReadState(options: {
		signer: Signer;
		groupId: string;
		readUpto: number;
	}): Promise<UserReadState> {
		return this.#sync.updateReadState(options);
	}

	/**
	 * Exact unread counts for the given on-chain group IDs — one batch relayer
	 * request (no per-group message paging, no 100-message ceiling).
	 */
	async getUnreadCounts(options: {
		signer: Signer;
		groupIds: string[];
	}): Promise<Record<string, number>> {
		return this.#sync.getUnreadCounts(options);
	}

	/**
	 * Unread counts and latest message order per group — one batch relayer request.
	 */
	async getGroupActivitySummary(options: { signer: Signer; groupIds: string[] }): Promise<{
		counts: Record<string, number>;
		latestOrders: Record<string, number>;
	}> {
		return this.#sync.getGroupActivitySummary(options);
	}

	// === Typing & presence (ephemeral) ===

	/**
	 * Broadcast the signer's typing state to the group. `typing: true` emits
	 * `typing.start` (rate-limited server-side); `typing: false` emits
	 * `typing.stop`. Fire-and-forget — never persisted.
	 */
	async sendTyping(options: {
		signer: Signer;
		groupRef: GroupRef;
		typing: boolean;
	}): Promise<void> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		await this.transport.sendTyping({
			signer: options.signer,
			groupId,
			typing: options.typing,
		});
	}

	/**
	 * Presence snapshot for a group's members (online = recent heartbeat).
	 * Live transitions arrive as `presence` events on {@link subscribe}.
	 */
	async getGroupPresence(options: {
		signer: Signer;
		groupRef: GroupRef;
	}): Promise<GroupPresenceEntry[]> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		return this.transport.getGroupPresence({ signer: options.signer, groupId });
	}

	/**
	 * Peer-visible delivery/read watermarks for every member with a stored row.
	 * Live updates arrive as `receipt` events on {@link subscribe} and as
	 * `receipt.updated` on {@link subscribeUserEvents}.
	 */
	async getGroupReceipts(options: {
		signer: Signer;
		groupRef: GroupRef;
	}): Promise<GroupReceiptState> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		return this.transport.getGroupReceipts({ signer: options.signer, groupId });
	}

	/**
	 * Advance the signer's delivery/read watermarks (monotonic max-wins).
	 * Peers learn via `receipt.updated` fan-out.
	 */
	async postGroupReceipts(options: {
		signer: Signer;
		groupRef: GroupRef;
		deliveredUpto?: number;
		readUpto?: number;
	}): Promise<void> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		await this.transport.postGroupReceipts({
			signer: options.signer,
			groupId,
			deliveredUpto: options.deliveredUpto,
			readUpto: options.readUpto,
		});
	}

	/**
	 * Caller's per-conversation notification / read-receipt / online-visibility preferences.
	 * Missing server row returns defaults (`all` / `full` / show online, version 1).
	 */
	async getConversationPrefs(options: {
		signer: Signer;
		groupRef: GroupRef;
	}): Promise<ConversationPrefs> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		return this.transport.getConversationPrefs({ signer: options.signer, groupId });
	}

	/**
	 * Partial update of conversation prefs (omitted fields preserved server-side).
	 */
	async putConversationPrefs(options: {
		signer: Signer;
		groupRef: GroupRef;
		notificationMode?: NotificationMode;
		receiptMode?: ReceiptMode;
		hideOnlinePresence?: boolean;
	}): Promise<ConversationPrefs> {
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);
		return this.transport.putConversationPrefs({
			signer: options.signer,
			groupId,
			notificationMode: options.notificationMode,
			receiptMode: options.receiptMode,
			hideOnlinePresence: options.hideOnlinePresence,
		});
	}

	/**
	 * Advisory paid-DM gate pre-check against the relayer.
	 *
	 * Tells the UI whether messaging `recipient` is blocked or requires an
	 * on-chain payment first (recipient has paid messaging enabled, the signer
	 * does not follow them, and no escrow is indexed yet). Pass `groupRef` for
	 * an existing conversation so first-outbound-message and escrow state are
	 * evaluated; omit it before the DM group exists.
	 *
	 * Never trusted as enforcement — the relayer authoritatively rejects unpaid
	 * sends with a 402 that surfaces as {@link PaymentRequiredError}.
	 */
	async checkDmGate(options: {
		signer: Signer;
		recipient: string;
		groupRef?: GroupRef;
	}): Promise<DmGateResult> {
		const groupId = options.groupRef
			? this.derive.resolveGroupRef(options.groupRef).groupId
			: undefined;
		return this.transport.checkDmGate({
			signer: options.signer,
			recipient: options.recipient,
			groupId,
		});
	}

	/** Disconnect the underlying transport. Active subscriptions will complete. */
	disconnect(): void {
		this.transport.disconnect();
	}

	// === Recovery ===

	/**
	 * Fetch and decrypt messages from the recovery transport.
	 *
	 * Requires a `recovery` transport to be configured at client creation.
	 * Recovery is read-only and does not require a signer.
	 *
	 * @throws {MySoMessagingStackClientError} if no recovery transport is configured.
	 */
	async recoverMessages(
		options: RecoverMessagesOptions<TApproveContext>,
	): Promise<GetMessagesResult> {
		if (!this.#recovery) {
			throw new MySoMessagingStackClientError(
				'Recovery transport is not configured. Provide `recovery` when creating the messaging groups client.',
			);
		}

		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

		// MLS groups: archived rows are MLS ciphertext whose keys were used up when first read
		// (forward secrecy), so there is nothing to recover; readable copies live on the devices.
		if ((await this.#e2eeFlag(groupId).catch(() => undefined)) === 'mls1') {
			return { messages: [], hasNext: false };
		}

		const result = await this.#recovery.recoverMessages({
			groupId,
			afterOrder: options.afterOrder,
			beforeOrder: options.beforeOrder,
			limit: options.limit,
		});

		const settled = await Promise.allSettled(
			result.messages.map((raw) =>
				this.#decryptMessage(raw, { groupId, encryptionHistoryId }, approveContext),
			),
		);

		const messages: DecryptedMessage[] = [];
		for (const entry of settled) {
			if (entry.status === 'fulfilled') {
				messages.push(entry.value);
			}
		}

		return { messages, hasNext: result.hasNext };
	}

	// === Private: mydataApproveContext ===

	/**
	 * Build a spreadable object containing `mydataApproveContext` when present.
	 * Returns `{}` for the default `void` case.
	 */
	#approveContextSpread(
		options: object & { mydataApproveContext?: unknown },
	): Record<string, unknown> {
		const ctx = options.mydataApproveContext;
		return ctx !== undefined ? { mydataApproveContext: ctx } : {};
	}

	// === Private: Decryption ===

	async #decryptMessage(
		raw: RelayerMessage,
		groupIds: { groupId: string; encryptionHistoryId: string },
		approveContext: Record<string, unknown>,
		verifiedOptions: { senderVerified?: boolean; resolveAttachments?: boolean } = {},
	): Promise<DecryptedMessage> {
		if (
			normalizeSharedPostAddress(raw.groupId) !== normalizeSharedPostAddress(groupIds.groupId) ||
			!normalizeSharedPostAddress(groupIds.groupId)
		) {
			throw new MySoMessagingStackClientError('Message does not belong to the requested group');
		}
		// System messages: cleartext structured events — never decrypt.
		if (raw.kind === 'system') {
			return {
				messageId: raw.messageId,
				groupId: raw.groupId,
				order: raw.order,
				text: '',
				senderAddress: raw.senderAddress,
				createdAt: raw.createdAt,
				updatedAt: raw.updatedAt,
				isEdited: false,
				isDeleted: false,
				syncStatus: raw.syncStatus,
				attachments: [],
				attachmentIntegrity: 'none',
				attributionIntegrity: 'none',
				senderVerified: false,
				principalOwner: raw.principalOwner,
				subAgentId: raw.subAgentId,
				identityClass: raw.identityClass,
				isAgentMessage: false,
				kind: 'system',
				system: raw.system,
				contentVersion: 1,
			};
		}

		// Deleted messages: skip decryption.
		if (raw.isDeleted) {
			return {
				messageId: raw.messageId,
				groupId: raw.groupId,
				order: raw.order,
				text: '',
				senderAddress: raw.senderAddress,
				createdAt: raw.createdAt,
				updatedAt: raw.updatedAt,
				isEdited: raw.isEdited,
				isDeleted: true,
				syncStatus: raw.syncStatus,
				attachments: [],
				attachmentIntegrity: 'none',
				attributionIntegrity: 'signature_unverified',
				senderVerified: false,
				principalOwner: raw.principalOwner,
				subAgentId: raw.subAgentId,
				identityClass: raw.identityClass,
				isAgentMessage: raw.isAgentMessage,
				// v2 rows hide the inner type; a deleted `message` renders like a deleted text.
				kind: raw.kind === 'message' ? 'text' : (raw.kind ?? 'text'),
				contentVersion: raw.kind === 'message' || raw.kind === 'event' ? 2 : 1,
			};
		}

		// Decrypt text.
		const aad = buildMessageAad({
			groupId: groupIds.groupId,
			keyVersion: raw.keyVersion,
			senderAddress: raw.senderAddress,
		});

		const plaintext = await this.encryption.decrypt({
			...groupIds,
			...approveContext,
			envelope: {
				ciphertext: raw.encryptedText,
				nonce: raw.nonce,
				keyVersion: raw.keyVersion,
				aad,
			},
		} as DecryptOptions<TApproveContext>);

		const senderVerified = verifiedOptions.senderVerified ?? (await this.#verifyRawMessage(raw));

		// Content envelope v2: inner type, events and attachment refs live inside the ciphertext.
		const envelope = decodeContentEnvelope(plaintext);
		if (envelope) {
			return this.#fromEnvelope(raw, envelope, senderVerified, verifiedOptions.resolveAttachments !== false);
		}

		const text = this.#textDecoder.decode(plaintext);
		const kind = raw.kind ?? 'text';

		// Attachment references are relayer metadata until they are covered by a v2
		// sender signature. Never download/decrypt legacy or signature-invalid refs.
		const attachmentIntegrity: DecryptedMessage['attachmentIntegrity'] = raw.attachments.length === 0
			? 'none'
			: raw.signatureVersion !== 2
				? 'legacy_unverified'
				: !senderVerified ? 'signature_unverified' : 'verified';
		const hasAttribution = Boolean(raw.principalOwner || raw.subAgentId || raw.identityClass !== undefined);
		const attributionIntegrity: DecryptedMessage['attributionIntegrity'] = !hasAttribution
			? 'none'
			: raw.signatureVersion !== 2 ? 'legacy_unverified' : !senderVerified ? 'signature_unverified' : 'verified';
		const attachments =
			verifiedOptions.resolveAttachments === false || attachmentIntegrity !== 'verified'
				? []
				: await this.#resolveAttachments(
						raw.attachments,
						groupIds,
						raw.keyVersion,
						approveContext,
						raw.senderAddress,
					).catch((cause: unknown) => {
						throw new AttachmentResolutionError(cause);
					});

		return {
			messageId: raw.messageId,
			groupId: raw.groupId,
			order: raw.order,
			text,
			senderAddress: raw.senderAddress,
			createdAt: raw.createdAt,
			updatedAt: raw.updatedAt,
			isEdited: raw.isEdited,
			isDeleted: false,
			syncStatus: raw.syncStatus,
			attachments,
			attachmentIntegrity,
			attributionIntegrity,
			senderVerified,
			principalOwner: raw.principalOwner,
			subAgentId: raw.subAgentId,
			identityClass: raw.identityClass,
			isAgentMessage: raw.isAgentMessage && attributionIntegrity === 'verified',
			kind,
			paymentMetadata: raw.paymentMetadata,
			payment: parsePaymentPayload(kind, text),
			contentVersion: 1,
		};
	}

	/** Build a {@link DecryptedMessage} from a decoded v2 envelope. */
	#fromEnvelope(
		raw: RelayerMessage,
		envelope: ContentEnvelope,
		senderVerified: boolean,
		resolveAttachments: boolean,
	): DecryptedMessage {
		const hasAttribution = Boolean(raw.principalOwner || raw.subAgentId || raw.identityClass !== undefined);
		const attributionIntegrity: DecryptedMessage['attributionIntegrity'] = !hasAttribution
			? 'none'
			: raw.signatureVersion !== 2 ? 'legacy_unverified' : !senderVerified ? 'signature_unverified' : 'verified';
		const base = {
			messageId: raw.messageId,
			groupId: raw.groupId,
			order: raw.order,
			senderAddress: raw.senderAddress,
			createdAt: raw.createdAt,
			updatedAt: raw.updatedAt,
			isEdited: raw.isEdited,
			isDeleted: false,
			syncStatus: raw.syncStatus,
			attributionIntegrity,
			senderVerified,
			principalOwner: raw.principalOwner,
			subAgentId: raw.subAgentId,
			identityClass: raw.identityClass,
			isAgentMessage: raw.isAgentMessage && attributionIntegrity === 'verified',
			paymentMetadata: raw.paymentMetadata,
			contentVersion: 2 as const,
		};
		// The relayer-visible row kind must agree with the signed envelope; otherwise render nothing.
		const rowKind = raw.kind ?? 'text';
		if (rowKind !== relayerKindForEnvelope(envelope)) {
			return { ...base, text: '', attachments: [], attachmentIntegrity: 'none', kind: 'text' };
		}
		if (envelope.t === 'event') {
			return {
				...base,
				text: '',
				attachments: [],
				attachmentIntegrity: 'none',
				kind: 'event',
				// Unverified events must never change state.
				...(senderVerified ? { event: envelope.e as MessageEvent } : {}),
			};
		}
		const refs = envelope.att ?? [];
		const attachmentIntegrity: DecryptedMessage['attachmentIntegrity'] =
			refs.length === 0 ? 'none' : senderVerified ? 'verified' : 'signature_unverified';
		const attachments =
			resolveAttachments && attachmentIntegrity === 'verified' && this.#attachments
				? this.#attachments.resolveV2(refs)
				: [];
		return {
			...base,
			text: envelope.text,
			attachments,
			attachmentIntegrity,
			kind: envelope.t,
			...(refs.length > 0 && senderVerified ? { envelopeAttachments: refs } : {}),
			payment: parsePaymentPayload(envelope.t, envelope.text),
		};
	}

	async #verifyRawMessage(raw: RelayerMessage): Promise<boolean> {
		const kind = raw.kind ?? 'text';
		const signatureVersion = raw.signatureVersion ?? 1;
		if (signatureVersion !== 1 && signatureVersion !== 2) return false;
		const transferDigest =
			kind === 'token_transfer' && raw.paymentMetadata?.type === 'token_transfer'
				? raw.paymentMetadata.digest
				: undefined;
		return raw.signature && raw.publicKey
			? await verifyMessageSender({
					groupId: raw.groupId,
					kind,
					signatureVersion,
					transferDigest,
					idempotencyKey: transferDigest
						? transferIdempotencyKey(raw.senderAddress, transferDigest)
						: undefined,
					encryptedText: raw.encryptedText,
					nonce: raw.nonce,
					keyVersion: raw.keyVersion,
					attachments: raw.attachments,
					attribution: raw.principalOwner || raw.subAgentId || raw.identityClass !== undefined ? {
						...(raw.principalOwner ? { principalOwner: raw.principalOwner } : {}),
						...(raw.subAgentId ? { subAgentId: raw.subAgentId } : {}),
						...(raw.identityClass !== undefined ? { identityClass: raw.identityClass } : {}),
					} : undefined,
					senderAddress: raw.senderAddress,
					signature: raw.signature,
					publicKey: raw.publicKey,
				})
			: false;
	}

	// === Private: Attachments ===

	async #uploadAttachments(
		files: AttachmentFile[] | undefined,
		groupIds: { groupId: string; encryptionHistoryId: string },
		approveContext: Record<string, unknown>,
		binding: AttachmentAadBinding,
	): Promise<Attachment[]> {
		if (!files || files.length === 0) return [];

		if (!this.#attachments) {
			throw new MySoMessagingStackClientError(
				'Attachments support is not configured. Provide `attachments` ' +
					'with a StorageAdapter when creating the messaging groups client.',
			);
		}

		return this.#attachments.upload(
			files,
			groupIds,
			approveContext as Omit<EncryptOptions<TApproveContext>, 'data'>,
			binding,
		);
	}

	async #resolveAttachments(
		rawAttachments: Attachment[],
		groupIds: { groupId: string; encryptionHistoryId: string },
		keyVersion: bigint,
		approveContext: Record<string, unknown>,
		senderAddress: string,
	): Promise<AttachmentHandle[]> {
		if (rawAttachments.length === 0) return [];
		if (!this.#attachments) return [];

		return this.#attachments.resolve(
			rawAttachments,
			groupIds,
			keyVersion,
			approveContext as Omit<DecryptOptions<TApproveContext>, 'envelope'>,
			{ groupId: groupIds.groupId, senderAddress },
		);
	}

	// === Private: Validation ===

	async #assertDmNotBlocked(
		groupId: string,
		senderAddress: string,
		principalOwner?: string,
	): Promise<void> {
		if (!this.#blockGating) return;
		const { members } = await this.#groupsClient.view.getMembers({ groupId });
		const peers = members.filter((m) => m.address !== senderAddress);
		if (peers.length !== 1) return;
		const peerAddress = peers[0]!.address;
		const blocked = await this.#blockGating.checkEitherBlocked(senderAddress, peerAddress, {
			principalOwner,
		});
		if (blocked) {
			throw new BlockedMessagingError();
		}
	}

	#validateSendInput(options: { text?: string; files?: AttachmentFile[] }): void {
		const hasText = options.text !== undefined && options.text !== '';
		const hasFiles = options.files !== undefined && options.files.length > 0;

		if (!hasText && !hasFiles) {
			throw new MySoMessagingStackClientError(
				'sendMessage requires at least one of `text` or `files`.',
			);
		}
	}

	// === Verification ===

	/**
	 * Verify that a message was signed by the claimed sender.
	 *
	 * Reconstructs the canonical message from the ciphertext fields,
	 * rebuilds the serialized signature, and verifies using the public key.
	 *
	 * @returns `true` if the signature is valid and the derived address matches `senderAddress`.
	 */
	verifyMessageSender(params: VerifyMessageSenderParams): Promise<boolean> {
		return verifyMessageSender(params);
	}

	// === Top-Level Imperative Methods ===

	/**
	 * Creates a new messaging group and shares both objects.
	 * The transaction sender automatically becomes the creator with all permissions.
	 */
	async createAndShareGroup({
		signer,
		transaction,
		contentEnvelopeV2,
		...callOptions
	}: CreateGroupOptions & {
		transaction?: Transaction;
		/**
		 * Mark the new group as writing content envelope v2 (a second transaction, since a group
		 * shared in a transaction can't be mutated later in it). Only enable once every client
		 * that may join can read v2.
		 */
		contentEnvelopeV2?: boolean;
	}) {
		const uuid = callOptions.uuid ?? globalThis.crypto.randomUUID();
		const result = await this.#executeTransaction(
			this.tx.createAndShareGroup({
				transaction,
				sender: signer.toMySoAddress(),
				...callOptions,
				uuid,
				encryptName: callOptions.encryptName ?? contentEnvelopeV2,
			}),
			signer,
			'create and share group',
		);
		if (contentEnvelopeV2) {
			await this.enableContentEnvelopeV2({ signer, groupRef: { uuid } });
		}
		return result;
	}

	/**
	 * Creates and shares a messaging group on behalf of a sub-agent.
	 * The transaction sender must be the agent derived address with CAP_MESSAGE_SEND.
	 */
	async createAgentAndShareGroup({
		signer,
		transaction,
		...callOptions
	}: CreateAgentGroupCallOptions & { signer: Signer; transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.createAgentAndShareGroup({ transaction, ...callOptions }),
			signer,
			'create and share agent group',
		);
	}

	/**
	 * Rotates the encryption key for a group.
	 * Requires EncryptionKeyRotator permission.
	 */
	async rotateEncryptionKey({
		signer,
		transaction,
		...callOptions
	}: RotateEncryptionKeyOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.rotateEncryptionKey({ transaction, ...callOptions }),
			signer,
			'rotate encryption key',
		);
	}

	/**
	 * Atomically removes one or more members and rotates the encryption key.
	 * Ensures removed members cannot decrypt new messages.
	 */
	async removeMembersAndRotateKey({
		signer,
		transaction,
		...callOptions
	}: RemoveMembersAndRotateKeyOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.removeMembersAndRotateKey({ transaction, ...callOptions }),
			signer,
			'remove members and rotate key',
		);
	}

	/**
	 * Removes the transaction sender from a messaging group.
	 */
	async leave({
		signer,
		transaction,
		...callOptions
	}: LeaveOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.leave({ transaction, ...callOptions }),
			signer,
			'leave group',
		);
	}

	// === Archive Methods ===

	/**
	 * Permanently archives a messaging group.
	 * Requires `PermissionsAdmin` permission.
	 *
	 * After this call the group is paused and cannot be mutated.
	 */
	async archiveGroup({
		signer,
		transaction,
		...callOptions
	}: ArchiveGroupOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.archiveGroup({ transaction, ...callOptions }),
			signer,
			'archive group',
		);
	}

	// === Metadata Methods ===

	/**
	 * Sets the group name.
	 * Requires `MetadataAdmin` permission.
	 */
	async setGroupName({
		signer,
		transaction,
		...callOptions
	}: SetGroupNameOptions & { transaction?: Transaction }) {
		// v2 groups keep their name encrypted on-chain. The encryption history derives from the
		// group's uuid, which lives in its on-chain metadata.
		const meta = (await this.view.groupsMetadata({ groupIds: [callOptions.groupId] }))[callOptions.groupId];
		if (meta?.uuid && (await this.writesContentEnvelopeV2({ uuid: meta.uuid }))) {
			callOptions = {
				...callOptions,
				name: await this.encryptGroupName({ uuid: meta.uuid }, callOptions.name),
			};
		}
		return this.#executeTransaction(
			this.tx.setGroupName({ transaction, ...callOptions }),
			signer,
			'set group name',
		);
	}

	/**
	 * Inserts a key-value pair into the group's metadata data map.
	 * Requires `MetadataAdmin` permission.
	 */
	async insertGroupData({
		signer,
		transaction,
		...callOptions
	}: InsertGroupDataOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.insertGroupData({ transaction, ...callOptions }),
			signer,
			'insert group data',
		);
	}

	/**
	 * Removes a key-value pair from the group's metadata data map.
	 * Requires `MetadataAdmin` permission.
	 */
	async removeGroupData({
		signer,
		transaction,
		...callOptions
	}: RemoveGroupDataOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.removeGroupData({ transaction, ...callOptions }),
			signer,
			'remove group data',
		);
	}

	// === Group handle registry ===

	/**
	 * Registers or replaces the group's handle in `GroupHandleRegistry`.
	 * Requires `GroupHandleAdmin` permission.
	 */
	async setGroupHandle({
		signer,
		transaction,
		...callOptions
	}: SetGroupHandleOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.setGroupHandle({ transaction, ...callOptions }),
			signer,
			'set group handle',
		);
	}

	/**
	 * Clears the group's handle from `GroupHandleRegistry`.
	 * Requires `GroupHandleAdmin` permission.
	 */
	async clearGroupHandle({
		signer,
		transaction,
		...callOptions
	}: ClearGroupHandleOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.clearGroupHandle({ transaction, ...callOptions }),
			signer,
			'clear group handle',
		);
	}
}

function buildDefaultRelayerTransport(relayer: RelayerHTTPConfig): RelayerTransport {
	const baseConfig = {
		relayerUrl: relayer.relayerUrl,
		apiPrefix: relayer.apiPrefix,
		pollingIntervalMs: relayer.pollingIntervalMs,
		fetch: relayer.fetch,
		timeout: relayer.timeout,
		onError: relayer.onError,
	};

	const mode = relayer.realtime ?? 'hybrid';

	if (mode === 'poll') {
		return new HTTPRelayerTransport(baseConfig);
	}

	return new HybridRelayerTransport({
		...baseConfig,
		preferWebSocket: true,
		fallbackToHttp: mode === 'hybrid',
	});
}
