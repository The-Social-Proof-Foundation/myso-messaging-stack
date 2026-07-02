// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export interface UserReadState {
	version: 1;
	updatedAt: number;
	groups: Record<string, { readUpto: number; muted?: boolean }>;
}

export function createEmptyReadState(): UserReadState {
	return { version: 1, updatedAt: Date.now(), groups: {} };
}

export function mergeReadState(local: UserReadState, remote: UserReadState): UserReadState {
	const groups: UserReadState['groups'] = { ...remote.groups };
	for (const [groupId, localEntry] of Object.entries(local.groups)) {
		const remoteEntry = groups[groupId];
		if (!remoteEntry || localEntry.readUpto > remoteEntry.readUpto) {
			groups[groupId] = {
				readUpto: Math.max(localEntry.readUpto, remoteEntry?.readUpto ?? 0),
				muted: localEntry.muted ?? remoteEntry?.muted,
			};
		}
	}
	return {
		version: 1,
		updatedAt: Math.max(local.updatedAt, remote.updatedAt),
		groups,
	};
}
