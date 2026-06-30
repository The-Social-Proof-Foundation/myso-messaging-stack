// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoMessagingStackPackageConfig } from './types.js';

export {
	GENESIS_PACKAGE_IDS,
	GENESIS_MYSO_GROUPS_PACKAGE_CONFIG,
	GENESIS_MYSO_MESSAGING_STACK_PACKAGE_CONFIG,
	GENESIS_MESSAGING_WITNESS_TYPE,
} from './genesis.js';

/**
 * Schema version for the Metadata dynamic field key.
 * Must match `METADATA_SCHEMA_VERSION` in `metadata.move`.
 */
export const METADATA_SCHEMA_VERSION = 1n;

/**
 * Returns the full Move type path for the `MetadataKey` struct.
 * Used to derive the dynamic field ID for Metadata on a group.
 *
 * @param packageId - The **original (V1)** messaging package ID.
 */
export function metadataKeyType(packageId: string): string {
	return `${packageId}::metadata::MetadataKey`;
}

/**
 * The derivation key used by `group_leaver.move` to derive the `GroupLeaver` singleton
 * from `MessagingNamespace`. Must match the Move constant `GROUP_LEAVER_DERIVATION_KEY`.
 */
export const GROUP_LEAVER_DERIVATION_KEY = 'group_leaver';

/**
 * The derivation key used by `group_manager.move` to derive the `GroupManager` singleton
 * from `MessagingNamespace`. Must match the Move constant `GROUP_MANAGER_DERIVATION_KEY`.
 */
export const GROUP_MANAGER_DERIVATION_KEY = 'group_manager';

/**
 * Derivation key for [`GroupHandleRegistry`](move/packages/messaging/sources/group_handle_registry.move)
 * from `MessagingNamespace`. Must match Move `GROUP_HANDLE_REGISTRY_DERIVATION_KEY` (`b"group_handle_registry"`).
 */
export const GROUP_HANDLE_REGISTRY_DERIVATION_KEY = 'group_handle_registry';

/**
 * Derivation key for `PaidMessagingRegistry` from `MessagingNamespace`.
 * Must match Move `PAID_MESSAGING_REGISTRY_DERIVATION_KEY` (`b"paid_messaging_registry"`).
 */
export const PAID_MESSAGING_REGISTRY_DERIVATION_KEY = 'paid_messaging_registry';

/** Metadata keys for agent-associated messaging groups (must match messaging.move). */
export const METADATA_AGENT_CHAT = 'agent_chat';
export const METADATA_CREATOR_ACTOR = 'creator_actor';
export const METADATA_CREATOR_PRINCIPAL = 'creator_principal';
export const METADATA_CREATOR_SUB_AGENT_ID = 'creator_sub_agent_id';
export const METADATA_CREATOR_IDENTITY_CLASS = 'creator_identity_class';
export const METADATA_AGENT_CHAT_TRUE = 'true';

/**
 * Returns full Move type paths for all messaging-specific permissions.
 *
 * @param packageId - The **original (V1)** package ID. The TypeNames stored in the
 *   PermissionsTable always use V1 addresses (via `type_name::with_original_ids`).
 */
export function messagingPermissionTypes(packageId: string) {
	return {
		MessagingSender: `${packageId}::messaging::MessagingSender`,
		MessagingReader: `${packageId}::messaging::MessagingReader`,
		MessagingEditor: `${packageId}::messaging::MessagingEditor`,
		MessagingDeleter: `${packageId}::messaging::MessagingDeleter`,
		EncryptionKeyRotator: `${packageId}::encryption_history::EncryptionKeyRotator`,
		GroupHandleAdmin: `${packageId}::messaging::GroupHandleAdmin`,
		MetadataAdmin: `${packageId}::messaging::MetadataAdmin`,
	} as const;
}

/**
 * Returns the baseline messaging permissions for a regular group member.
 */
export function defaultMemberPermissionTypes(packageId: string) {
	const types = messagingPermissionTypes(packageId);
	return {
		MessagingSender: types.MessagingSender,
		MessagingReader: types.MessagingReader,
		MessagingEditor: types.MessagingEditor,
		MessagingDeleter: types.MessagingDeleter,
	} as const;
}

/** Default genesis messaging config shell (shared object IDs filled by {@link resolveGenesisMessagingConfig}). */
export const GENESIS_MYSO_MESSAGING_STACK_PACKAGE_CONFIG_SHELL = {
	originalPackageId: '0x000000000000000000000000000000000000000000000000000000000000e110',
	latestPackageId: '0x000000000000000000000000000000000000000000000000000000000000e110',
	namespaceId: '',
	versionId: '',
	blockListRegistryId: '',
	socialGraphId: '',
	memoryRegistryId: '',
} satisfies MySoMessagingStackPackageConfig;
