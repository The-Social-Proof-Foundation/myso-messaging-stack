// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export { MessagingSyncManager } from './messaging-sync-manager.js';
export {
	/** @deprecated Renamed — use {@link MessagingSyncManager}. */
	MessagingSyncManager as ReadStateManager,
} from './messaging-sync-manager.js';
export { encryptReadState, decryptReadState } from './read-state-crypto.js';
export { createEmptyReadState, mergeReadState, type UserReadState } from './types.js';
