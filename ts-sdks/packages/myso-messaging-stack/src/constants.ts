// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoMessagingStackPackageConfig } from './types.js';

export const TESTNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG = {
	originalPackageId: '0x047696be0e98f1b47a99727fecf2955cadb23c56f67c6b872b74e3ad59d51b46',
	latestPackageId: '0x047696be0e98f1b47a99727fecf2955cadb23c56f67c6b872b74e3ad59d51b46',
	namespaceId: '0x9442bdc5c0aef62b2c9ac797db3f74db9c99400547992d8fb49cc7b0ef709cf2',
	versionId: '0x491ab1b3041a0d4ece9dd3b72b73a414b34109edb7a74206838161f195f6f20e',
} satisfies MySoMessagingStackPackageConfig;

export const MAINNET_MYSO_MESSAGING_STACK_PACKAGE_CONFIG = {
	originalPackageId: '0xcbd2f4c25c7f799c45c0c9f221850178b711b2c89916c8e99038aa8ac609a62e',
	latestPackageId: '0xcbd2f4c25c7f799c45c0c9f221850178b711b2c89916c8e99038aa8ac609a62e',
	namespaceId: '0xfa4496a3ebcf5dd414220cb968cc912064c41322b2245382b531d8faaf4bcdff',
	versionId: '0x7b4f0fd7c9e51c81722cea023de92319b01c129ad550c7f37a46e739ac484dd8',
} satisfies MySoMessagingStackPackageConfig;

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
 * Derivation key for [`GroupHandleRegistry`](move/packages/myso_messaging_stack/sources/group_handle_registry.move)
 * from `MessagingNamespace`. Must match Move `GROUP_HANDLE_REGISTRY_DERIVATION_KEY` (`b"group_handle_registry"`).
 */
export const GROUP_HANDLE_REGISTRY_DERIVATION_KEY = 'group_handle_registry';

/**
 * Returns full Move type paths for all messaging-specific permissions.
 *
 * @param packageId - The **original (V1)** package ID. The TypeNames stored in the
 *   PermissionsTable always use V1 addresses (via `type_name::with_original_ids`).
 *
 * @example
 * ```ts
 * const perms = messagingPermissionTypes('0xabc...');
 * // perms.MessagingSender === '0xabc...::messaging::MessagingSender'
 *
 * await client.groups.grantPermission({
 *   groupId, member, signer,
 *   permissionType: perms.MessagingSender,
 * });
 * ```
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
 *
 * Includes the four core messaging capabilities: send, read, edit, and delete.
 * Does **not** include group-management permissions (`EncryptionKeyRotator`,
 * `GroupHandleAdmin`, `MetadataAdmin`) — grant those selectively to trusted members.
 *
 * @param packageId - The **original (V1)** messaging package ID.
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
