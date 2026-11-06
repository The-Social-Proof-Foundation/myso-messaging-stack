// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export { MlsSession, createCertificateVerifier } from './session.js';
export type { CertificateVerifier, MlsGroupState, MlsRenewalState, MlsSessionOptions } from './session.js';
export {
	ChainMlsDeviceRegistry,
	MLS_ROTATION_GRACE_MS,
	certificateCanonicalV2,
	issueCertificateV2,
	registryKeyIsValid,
} from './registry.js';
export type { ChainMlsDeviceRegistryOptions, MlsDeviceRecord, MlsDeviceRegistryReader, MlsRegistrySubmitter } from './registry.js';
export { CertificateCache, REGISTRY_MAX_STALE_MS, REGISTRY_TTL_MS, certificateDigest } from './certificates.js';
export type { CertificateVerifierOptions, ZkLoginVerifyHook } from './certificates.js';
export { MlsGroupUnavailableError, MlsMembersUnverifiedError } from './errors.js';
export type { MlsUnavailableReason } from './errors.js';
export {
	BACKUP_PRF_LABEL,
	BACKUP_SEGMENT_PLAINTEXT_BYTES,
	backupPrfSalt,
	deriveBackupKey,
	openBackupSegment,
	sealBackupSegment,
} from './backup.js';
export type { MessageBackupKey } from './backup.js';
export {
	HostedMlsBusyError,
	HostedMlsLeaseLostError,
	SnapshotMlsStateStore,
	deriveHostedSealKey,
	hostedDeviceId,
	withHostedMlsStore,
} from './hosted-store.js';
export type { HostedMlsLeaseBackend } from './hosted-store.js';
export { HttpMlsRelayer } from './relayer.js';
export type { MlsRelayer } from './relayer.js';
export { MemoryMlsStateStore, decodeInner, encodeInner } from './types.js';
export type {
	MlsCertificateStatus,
	MlsDeviceCertificate,
	MlsMember,
	MlsStateStore,
	MlsWasmModule,
	UnwrappedRow,
} from './types.js';
