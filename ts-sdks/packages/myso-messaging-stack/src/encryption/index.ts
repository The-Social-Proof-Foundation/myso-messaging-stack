// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// Types (re-exports from submodules)
export type {
	CryptoPrimitives,
	GeneratedDEK,
	DEKManagerConfig,
	EnvelopeEncryptionConfig,
	EncryptedEnvelope,
	EncryptOptions,
	DecryptOptions,
	MyDataPolicy,
} from './types.js';

export { DEK_LENGTH, NONCE_LENGTH } from './types.js';

// Crypto primitives
export { WebCryptoPrimitives, getDefaultCryptoPrimitives } from './crypto-primitives.js';

// DEK Manager
export { DEKManager } from './dek-manager.js';

// MyData Policy
export { DefaultMyDataPolicy, PrincipalMyDataOversightPolicy } from './mydata-policy.js';
export type { PrincipalOversightPolicyOptions } from './mydata-policy.js';

// Envelope Encryption
export { EnvelopeEncryption, buildMessageAad } from './envelope-encryption.js';
