// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MyDataClient } from '@socialproof/mydata';
import type { Signer } from '@socialproof/myso/cryptography';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Transaction } from '@socialproof/myso/transactions';

import { MySoMessagingStackClientError } from './error.js';
import {
	TESTNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG,
	MAINNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG,
} from './constants.js';
import { AttachmentsManager } from './attachments/attachments-manager.js';
import type { Attachment, AttachmentFile, AttachmentHandle } from './attachments/types.js';
import { EnvelopeEncryption, buildMessageAad } from './encryption/envelope-encryption.js';
import type { EncryptOptions, DecryptOptions } from './encryption/envelope-encryption.js';
import { HTTPRelayerTransport } from './relayer/http-transport.js';
import type { RelayerTransport } from './relayer/transport.js';
import type { RelayerConfig, RelayerMessage } from './relayer/types.js';
import {
	signMessageContent,
	verifyMessageSender,
	type VerifyMessageSenderParams,
} from './verification.js';
import type {
	DecryptedMessage,
	DeleteMessageOptions,
	EditMessageOptions,
	GetMessageOptions,
	GetMessagesOptions,
	GetMessagesResult,
	RecoverMessagesOptions,
	SendMessageOptions,
	SubscribeOptions,
} from './messaging-types.js';
import type { RecoveryTransport } from './recovery/transport.js';
import type {
	ArchiveGroupOptions,
	ClearGroupHandleOptions,
	CreateGroupOptions,
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
 * // Subscribe to new messages
 * for await (const msg of client.messaging.subscribe({
 *   signer: keypair,
 *   groupRef: { uuid: 'my-group' },
 *   signal: controller.signal,
 * })) {
 *   console.log(msg.text, msg.attachments);
 * }
 *
 * // For fine-grained permissions, use the groups extension:
 * await client.groups.grantPermission({ ... });
 * ```
 */
export class MySoMessagingStackClient<TApproveContext = void> {
	#packageConfig: MySoMessagingStackPackageConfig;
	#client: ClientWithCoreApi;
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
	/** Low-level transport for direct relayer access. Use `sendMessage()`, `getMessage()`, etc. for the high-level API. */
	transport: RelayerTransport;

	constructor(options: MySoMessagingStackClientOptions<TApproveContext, string, string>) {
		if (!options.client) {
			throw new MySoMessagingStackClientError('client must be provided');
		}
		this.#client = options.client;

		// Use custom packageConfig if provided, otherwise determine from network
		if (options.packageConfig) {
			this.#packageConfig = options.packageConfig;
		} else {
			const network = options.client.network;
			switch (network) {
				case 'testnet':
					this.#packageConfig = TESTNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG;
					break;
				case 'mainnet':
					this.#packageConfig = MAINNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG;
					break;
				default:
					throw new MySoMessagingStackClientError(
						`Unsupported network: ${network}. Provide a custom packageConfig for localnet/devnet.`,
					);
			}
		}

		// Resolve extension dependencies by their registered names
		const groupsExt = options.client[options.groupsName];
		const mydataExt = options.client[options.mydataName] as MyDataClient;

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
		});
		this.tx = new MySoMessagingStackTransactions({
			call: this.call,
		});

		this.#attachments = options.attachments
			? new AttachmentsManager(this.encryption, options.attachments)
			: undefined;

		this.transport = options.relayer.transport
			? options.relayer.transport
			: new HTTPRelayerTransport({
					relayerUrl: options.relayer.relayerUrl,
					apiPrefix: 'apiPrefix' in options.relayer ? options.relayer.apiPrefix : undefined,
					pollingIntervalMs: options.relayer.pollingIntervalMs,
					fetch: options.relayer.fetch,
					timeout: options.relayer.timeout,
					onError: options.relayer.onError,
				});

		this.#recovery = options.recovery;
	}

	// === Private Helpers ===

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
		const senderAddress = options.signer.toMySoAddress();

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
		);

		// 3. Sign the ciphertext for sender verification.
		const messageSignature = await signMessageContent(options.signer, {
			groupId,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
		});

		// 4. Send via transport.
		const result = await this.transport.sendMessage({
			signer: options.signer,
			groupId,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
			attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
			messageSignature,
		});

		return { messageId: result.messageId };
	}

	/**
	 * Fetch and decrypt a single message.
	 */
	async getMessage(options: GetMessageOptions<TApproveContext>): Promise<DecryptedMessage> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

		const raw = await this.transport.fetchMessage({
			signer: options.signer,
			messageId: options.messageId,
			groupId,
		});

		return this.#decryptMessage(raw, { groupId, encryptionHistoryId }, approveContext);
	}

	/**
	 * Fetch and decrypt a paginated list of messages.
	 */
	async getMessages(options: GetMessagesOptions<TApproveContext>): Promise<GetMessagesResult> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

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
		const senderAddress = options.signer.toMySoAddress();

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
		let finalAttachments: Attachment[] | undefined;
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
			);

			finalAttachments = [...kept, ...uploaded];
			if (removeSet.size > 0) {
				removedStorageIds = [...removeSet];
			}
		}

		// 3. Sign the ciphertext for sender verification.
		const messageSignature = await signMessageContent(options.signer, {
			groupId,
			encryptedText: envelope.ciphertext,
			nonce: envelope.nonce,
			keyVersion: envelope.keyVersion,
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
		const { groupId } = this.derive.resolveGroupRef(options.groupRef);

		await this.transport.deleteMessage({
			signer: options.signer,
			messageId: options.messageId,
			groupId,
		});
	}

	/**
	 * Subscribe to real-time messages for a group.
	 *
	 * Wraps the transport's subscribe stream and decrypts each message.
	 * The iterable completes when the AbortSignal fires or {@link disconnect}
	 * is called.
	 *
	 * @example
	 * ```ts
	 * const controller = new AbortController();
	 * for await (const msg of client.messaging.subscribe({
	 *   signer: keypair,
	 *   groupRef: { uuid: '...' },
	 *   signal: controller.signal,
	 * })) {
	 *   console.log(msg.text, msg.attachments);
	 * }
	 * ```
	 *
	 * @yields Decrypted messages as they arrive from the transport.
	 */
	async *subscribe(options: SubscribeOptions<TApproveContext>): AsyncIterable<DecryptedMessage> {
		const { groupId, encryptionHistoryId } = this.derive.resolveGroupRef(options.groupRef);
		const approveContext = this.#approveContextSpread(options);

		for await (const raw of this.transport.subscribe({
			signer: options.signer,
			groupId,
			afterOrder: options.afterOrder,
			signal: options.signal,
		})) {
			try {
				yield this.#decryptMessage(raw, { groupId, encryptionHistoryId }, approveContext);
			} catch {
				// Skip messages that fail decryption (e.g. key not available yet).
			}
		}
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
	): Promise<DecryptedMessage> {
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
				senderVerified: false,
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

		const text = this.#textDecoder.decode(plaintext);

		// Verify sender signature (fail-safe: false if missing or invalid).
		const senderVerified =
			raw.signature && raw.publicKey
				? await verifyMessageSender({
						groupId: raw.groupId,
						encryptedText: raw.encryptedText,
						nonce: raw.nonce,
						keyVersion: raw.keyVersion,
						senderAddress: raw.senderAddress,
						signature: raw.signature,
						publicKey: raw.publicKey,
					})
				: false;

		// Resolve attachments.
		const attachments = await this.#resolveAttachments(
			raw.attachments,
			groupIds,
			raw.keyVersion,
			approveContext,
		);

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
			senderVerified,
		};
	}

	// === Private: Attachments ===

	async #uploadAttachments(
		files: AttachmentFile[] | undefined,
		groupIds: { groupId: string; encryptionHistoryId: string },
		approveContext: Record<string, unknown>,
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
		);
	}

	async #resolveAttachments(
		rawAttachments: Attachment[],
		groupIds: { groupId: string; encryptionHistoryId: string },
		keyVersion: bigint,
		approveContext: Record<string, unknown>,
	): Promise<AttachmentHandle[]> {
		if (rawAttachments.length === 0) return [];
		if (!this.#attachments) return [];

		return this.#attachments.resolve(
			rawAttachments,
			groupIds,
			keyVersion,
			approveContext as Omit<DecryptOptions<TApproveContext>, 'envelope'>,
		);
	}

	// === Private: Validation ===

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
		...callOptions
	}: CreateGroupOptions & { transaction?: Transaction }) {
		return this.#executeTransaction(
			this.tx.createAndShareGroup({ transaction, ...callOptions }),
			signer,
			'create and share group',
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
