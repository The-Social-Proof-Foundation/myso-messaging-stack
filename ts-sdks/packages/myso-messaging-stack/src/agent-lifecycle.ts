// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { MySoMessagingStackClient } from './client.js';
import type { GroupRef } from './types.js';

export interface RevokeAgentFromAllGroupsOptions {
	messaging: MySoMessagingStackClient<unknown>;
	/** Principal signer with PermissionsAdmin on each group. */
	principalSigner: Signer;
	/** Agent derived address to remove from each group. */
	agentDerivedAddress: string;
	/** Group refs to clean up (from relayer `listGroupsForAgent` or local discovery). */
	groupRefs: GroupRef[];
}

export interface RevokeAgentFromAllGroupsResult {
	digests: string[];
	groupsProcessed: number;
}

/**
 * Removes a revoked/deactivated sub-agent from messaging groups and rotates keys.
 * Principal must hold PermissionsAdmin on each group.
 */
export async function revokeAgentFromAllGroups(
	options: RevokeAgentFromAllGroupsOptions,
): Promise<RevokeAgentFromAllGroupsResult> {
	const { messaging, principalSigner, agentDerivedAddress, groupRefs } = options;
	const digests: string[] = [];

	for (const groupRef of groupRefs) {
		const { digest } = await messaging.removeMembersAndRotateKey({
			signer: principalSigner,
			...groupRef,
			members: [agentDerivedAddress],
		});
		digests.push(digest);
	}

	return { digests, groupsProcessed: groupRefs.length };
}
