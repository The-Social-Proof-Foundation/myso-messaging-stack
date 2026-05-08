// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { bcs } from '@socialproof/myso/bcs';
import { deriveObjectID } from '@socialproof/myso/utils';

import { GROUP_HANDLE_REGISTRY_DERIVATION_KEY, GROUP_LEAVER_DERIVATION_KEY, GROUP_MANAGER_DERIVATION_KEY } from './constants.js';
import type { GroupRef, MySoMessagingStackPackageConfig } from './types.js';

export interface MySoMessagingStackDeriveOptions {
	packageConfig: MySoMessagingStackPackageConfig;
}

/**
 * Deterministic address derivation for messaging group objects.
 *
 * Given a UUID and the namespace configuration, derives the on-chain object IDs
 * for both the `PermissionedGroup<Messaging>` and `EncryptionHistory` objects.
 *
 * These derivations are pure and synchronous — no network calls needed.
 *
 * @example
 * ```ts
 * const uuid = crypto.randomUUID();
 * const groupId = client.messaging.derive.groupId({ uuid });
 * const encryptionHistoryId = client.messaging.derive.encryptionHistoryId({ uuid });
 * ```
 */
export class MySoMessagingStackDerive {
	#packageConfig: MySoMessagingStackPackageConfig;

	constructor(options: MySoMessagingStackDeriveOptions) {
		this.#packageConfig = options.packageConfig;
	}

	/**
	 * Derive the `PermissionedGroup<Messaging>` object ID from a UUID.
	 *
	 * @param options.uuid - The client-provided UUID used at group creation
	 * @returns The deterministic object ID for the PermissionedGroup
	 */
	groupId(options: { uuid: string }): string {
		const typeTag = `${this.#packageConfig.originalPackageId}::encryption_history::PermissionedGroupTag`;
		const key = bcs.string().serialize(options.uuid).toBytes();
		return deriveObjectID(this.#packageConfig.namespaceId, typeTag, key);
	}

	/**
	 * Derive the `EncryptionHistory` object ID from a UUID.
	 *
	 * @param options.uuid - The client-provided UUID used at group creation
	 * @returns The deterministic object ID for the EncryptionHistory
	 */
	encryptionHistoryId(options: { uuid: string }): string {
		const typeTag = `${this.#packageConfig.originalPackageId}::encryption_history::EncryptionHistoryTag`;
		const key = bcs.string().serialize(options.uuid).toBytes();
		return deriveObjectID(this.#packageConfig.namespaceId, typeTag, key);
	}

	/**
	 * Derive the shared **paid escrow** `MessageLog` object ID from a UUID.
	 *
	 * Matches `message_log::MessageLogTag` derivation in Move (same namespace + UUID key
	 * pattern as `EncryptionHistory`).
	 */
	messageLogId(options: { uuid: string }): string {
		const typeTag = `${this.#packageConfig.originalPackageId}::message_log::MessageLogTag`;
		const key = bcs.string().serialize(options.uuid).toBytes();
		return deriveObjectID(this.#packageConfig.namespaceId, typeTag, key);
	}

	/**
	 * Resolve a {@link GroupRef} to explicit `groupId` and `encryptionHistoryId`.
	 *
	 * When the ref contains a `uuid`, both IDs are derived deterministically.
	 * When explicit IDs are provided, they are returned as-is.
	 */
	resolveGroupRef(ref: GroupRef): {
		groupId: string;
		encryptionHistoryId: string;
		/** Present when the ref includes a `uuid` (deterministic third object). */
		messageLogId?: string;
	} {
		if ('uuid' in ref && ref.uuid) {
			return {
				groupId: this.groupId({ uuid: ref.uuid }),
				encryptionHistoryId: this.encryptionHistoryId({ uuid: ref.uuid }),
				messageLogId: this.messageLogId({ uuid: ref.uuid }),
			};
		}
		return {
			groupId: (ref as { groupId: string }).groupId,
			encryptionHistoryId: (ref as { encryptionHistoryId: string }).encryptionHistoryId,
		};
	}

	/**
	 * Derive the `GroupLeaver` singleton object ID.
	 *
	 * `GroupLeaver` is derived from `MessagingNamespace` with the fixed string key
	 * `GROUP_LEAVER_DERIVATION_KEY`. This matches the Move constant in `group_leaver.move`.
	 *
	 * @returns The deterministic object ID for the GroupLeaver shared object
	 */
	groupLeaverId(): string {
		const key = bcs.string().serialize(GROUP_LEAVER_DERIVATION_KEY).toBytes();
		return deriveObjectID(this.#packageConfig.namespaceId, '0x1::string::String', key);
	}

	/**
	 * Derive the `GroupManager` singleton object ID.
	 *
	 * `GroupManager` is derived from `MessagingNamespace` with the fixed string key
	 * `GROUP_MANAGER_DERIVATION_KEY`. This matches the Move constant in `group_manager.move`.
	 *
	 * @returns The deterministic object ID for the GroupManager shared object
	 */
	groupManagerId(): string {
		const key = bcs.string().serialize(GROUP_MANAGER_DERIVATION_KEY).toBytes();
		return deriveObjectID(this.#packageConfig.namespaceId, '0x1::string::String', key);
	}

	/**
	 * Derive the `GroupHandleRegistry` singleton object ID (handle → group id table).
	 *
	 * Matches `group_handle_registry::new` derivation from `MessagingNamespace`.
	 */
	groupHandleRegistryId(): string {
		const key = bcs.string().serialize(GROUP_HANDLE_REGISTRY_DERIVATION_KEY).toBytes();
		return deriveObjectID(this.#packageConfig.namespaceId, '0x1::string::String', key);
	}

	/**
	 * Returns the addresses of all singleton actor objects created by the messaging contract.
	 *
	 * These are system-level members automatically added to every group at creation:
	 * - `groupLeaver`: holds `PermissionsAdmin` — enables `leave()` for any member
	 * - `groupManager`: holds `ObjectAdmin` — metadata dynamic fields on the group UID
	 *
	 * Useful for filtering system entries out of the member list in UI:
	 * ```ts
	 * const system = client.messaging.derive.systemObjectAddresses();
	 * const humanMembers = allMembers.filter(m => !system.has(m.address));
	 * ```
	 */
	systemObjectAddresses(): Set<string> {
		return new Set([this.groupLeaverId(), this.groupManagerId()]);
	}
}
