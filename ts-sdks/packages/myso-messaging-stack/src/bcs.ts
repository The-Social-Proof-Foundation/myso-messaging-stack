// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { BcsType } from '@socialproof/bcs';

import type { MySoMessagingStackPackageConfig } from './types.js';

// Messaging module types
import {
	Messaging,
	MessagingNamespace,
	MessagingSender,
	MessagingReader,
	MessagingEditor,
	MessagingDeleter,
	MySoNsAdmin,
	MetadataAdmin,
} from './contracts/myso_messaging_stack/messaging.js';

// Encryption history module types
import {
	EncryptionHistory,
	EncryptionHistoryCreated,
	EncryptionKeyRotated,
	EncryptionKeyRotator,
	EncryptionHistoryTag,
	PermissionedGroupTag,
} from './contracts/myso_messaging_stack/encryption_history.js';

// Metadata module types
import { Metadata, MetadataKey } from './contracts/myso_messaging_stack/metadata.js';

// Actor object types
import { GroupManager } from './contracts/myso_messaging_stack/group_manager.js';
import { GroupLeaver } from './contracts/myso_messaging_stack/group_leaver.js';

// Parsed type exports
export type ParsedMessagingNamespace = (typeof MessagingNamespace)['$inferType'];
export type ParsedMessaging = (typeof Messaging)['$inferType'];
export type ParsedMessagingSender = (typeof MessagingSender)['$inferType'];
export type ParsedMessagingReader = (typeof MessagingReader)['$inferType'];
export type ParsedMessagingEditor = (typeof MessagingEditor)['$inferType'];
export type ParsedMessagingDeleter = (typeof MessagingDeleter)['$inferType'];
export type ParsedEncryptionHistory = (typeof EncryptionHistory)['$inferType'];
export type ParsedEncryptionHistoryCreated = (typeof EncryptionHistoryCreated)['$inferType'];
export type ParsedEncryptionKeyRotated = (typeof EncryptionKeyRotated)['$inferType'];
export type ParsedEncryptionKeyRotator = (typeof EncryptionKeyRotator)['$inferType'];
export type ParsedEncryptionHistoryTag = (typeof EncryptionHistoryTag)['$inferType'];
export type ParsedPermissionedGroupTag = (typeof PermissionedGroupTag)['$inferType'];
export type ParsedMySoNsAdmin = (typeof MySoNsAdmin)['$inferType'];
export type ParsedMetadataAdmin = (typeof MetadataAdmin)['$inferType'];
export type ParsedMetadata = (typeof Metadata)['$inferType'];
export type ParsedMetadataKey = (typeof MetadataKey)['$inferType'];
export type ParsedGroupManager = (typeof GroupManager)['$inferType'];
export type ParsedGroupLeaver = (typeof GroupLeaver)['$inferType'];

export interface MySoMessagingStackBCSOptions {
	packageConfig: MySoMessagingStackPackageConfig;
}

/**
 * BCS type definitions for the messaging-groups package.
 *
 * Each instance creates transformed copies of the generated BCS types
 * with the correct package ID in the type name, ensuring multiple SDK
 * instances with different package configurations don't interfere.
 *
 * @example
 * ```ts
 * const bcs = new MySoMessagingStackBCS({
 *   packageConfig: { packageId: '0x123...', namespaceId: '0x456...' }
 * });
 *
 * const namespace = bcs.MessagingNamespace.parse(namespaceObject.content);
 * const history = bcs.EncryptionHistory.parse(historyObject.content);
 * ```
 */
export class MySoMessagingStackBCS {
	// === Messaging module types ===

	/** Package witness type for scoping permissions */
	readonly Messaging: BcsType<ParsedMessaging, unknown>;
	/** Shared singleton for namespace management */
	readonly MessagingNamespace: BcsType<ParsedMessagingNamespace, unknown>;
	/** Permission witness: send messages */
	readonly MessagingSender: BcsType<ParsedMessagingSender, unknown>;
	/** Permission witness: read/decrypt messages */
	readonly MessagingReader: BcsType<ParsedMessagingReader, unknown>;
	/** Permission witness: edit messages */
	readonly MessagingEditor: BcsType<ParsedMessagingEditor, unknown>;
	/** Permission witness: delete messages */
	readonly MessagingDeleter: BcsType<ParsedMessagingDeleter, unknown>;

	// === Encryption history module types ===

	/** Encryption history struct storing versioned DEKs */
	readonly EncryptionHistory: BcsType<ParsedEncryptionHistory, unknown>;
	/** Event emitted when encryption history is created */
	readonly EncryptionHistoryCreated: BcsType<ParsedEncryptionHistoryCreated, unknown>;
	/** Event emitted when encryption key is rotated */
	readonly EncryptionKeyRotated: BcsType<ParsedEncryptionKeyRotated, unknown>;
	/** Permission witness: rotate encryption keys */
	readonly EncryptionKeyRotator: BcsType<ParsedEncryptionKeyRotator, unknown>;
	/** Derivation key for EncryptionHistory address */
	readonly EncryptionHistoryTag: BcsType<ParsedEncryptionHistoryTag, unknown>;
	/** Derivation key for PermissionedGroup address */
	readonly PermissionedGroupTag: BcsType<ParsedPermissionedGroupTag, unknown>;
	/** Permission witness: manage MySoNS reverse lookups */
	readonly MySoNsAdmin: BcsType<ParsedMySoNsAdmin, unknown>;
	/** Permission witness: edit group metadata */
	readonly MetadataAdmin: BcsType<ParsedMetadataAdmin, unknown>;

	// === Metadata module types ===

	/** Group metadata (name, uuid, creator, data) */
	readonly Metadata: BcsType<ParsedMetadata, unknown>;
	/** Dynamic field key for Metadata on the group */
	readonly MetadataKey: BcsType<ParsedMetadataKey, unknown>;

	// === Actor object types ===

	/** Singleton actor: manages UID access for MySoNS + metadata */
	readonly GroupManager: BcsType<ParsedGroupManager, unknown>;
	/** Singleton actor: allows members to leave groups */
	readonly GroupLeaver: BcsType<ParsedGroupLeaver, unknown>;

	constructor(options: MySoMessagingStackBCSOptions) {
		const messagingModule = `${options.packageConfig.originalPackageId}::messaging`;
		const encryptionHistoryModule = `${options.packageConfig.originalPackageId}::encryption_history`;

		// Messaging module types
		this.Messaging = Messaging.transform({
			name: `${messagingModule}::Messaging`,
		});
		this.MessagingNamespace = MessagingNamespace.transform({
			name: `${messagingModule}::MessagingNamespace`,
		});
		this.MessagingSender = MessagingSender.transform({
			name: `${messagingModule}::MessagingSender`,
		});
		this.MessagingReader = MessagingReader.transform({
			name: `${messagingModule}::MessagingReader`,
		});
		this.MessagingEditor = MessagingEditor.transform({
			name: `${messagingModule}::MessagingEditor`,
		});
		this.MessagingDeleter = MessagingDeleter.transform({
			name: `${messagingModule}::MessagingDeleter`,
		});
		this.MySoNsAdmin = MySoNsAdmin.transform({
			name: `${messagingModule}::MySoNsAdmin`,
		});
		this.MetadataAdmin = MetadataAdmin.transform({
			name: `${messagingModule}::MetadataAdmin`,
		});

		// Metadata module types
		const metadataModule = `${options.packageConfig.originalPackageId}::metadata`;
		this.Metadata = Metadata.transform({
			name: `${metadataModule}::Metadata`,
		});
		this.MetadataKey = MetadataKey.transform({
			name: `${metadataModule}::MetadataKey`,
		});

		// Actor object types
		const groupManagerModule = `${options.packageConfig.originalPackageId}::group_manager`;
		const groupLeaverModule = `${options.packageConfig.originalPackageId}::group_leaver`;
		this.GroupManager = GroupManager.transform({
			name: `${groupManagerModule}::GroupManager`,
		});
		this.GroupLeaver = GroupLeaver.transform({
			name: `${groupLeaverModule}::GroupLeaver`,
		});

		// Encryption history module types
		this.EncryptionHistory = EncryptionHistory.transform({
			name: `${encryptionHistoryModule}::EncryptionHistory`,
		});
		this.EncryptionHistoryCreated = EncryptionHistoryCreated.transform({
			name: `${encryptionHistoryModule}::EncryptionHistoryCreated`,
		});
		this.EncryptionKeyRotated = EncryptionKeyRotated.transform({
			name: `${encryptionHistoryModule}::EncryptionKeyRotated`,
		});
		this.EncryptionKeyRotator = EncryptionKeyRotator.transform({
			name: `${encryptionHistoryModule}::EncryptionKeyRotator`,
		});
		this.EncryptionHistoryTag = EncryptionHistoryTag.transform({
			name: `${encryptionHistoryModule}::EncryptionHistoryTag`,
		});
		this.PermissionedGroupTag = PermissionedGroupTag.transform({
			name: `${encryptionHistoryModule}::PermissionedGroupTag`,
		});
	}
}
