// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { fromRelayerConversation } from '../../src/agent-discovery.js';
import type { RelayerAgentConversation } from '../../src/relayer/types.js';

describe('agent discovery relayer wire mapping', () => {
	it('maps relayer snake_case fields to AgentConversation', () => {
		const wire: RelayerAgentConversation = {
			groupId: '0xgroup',
			creatorActor: '0xagent',
			creatorPrincipal: '0xprincipal',
			creatorSubAgentId: '0xsub',
			creatorIdentityClass: 1,
			groupName: 'Support',
			groupUuid: 'uuid-1',
			createdAt: 1710000000,
		};

		expect(fromRelayerConversation(wire)).toEqual({
			groupId: '0xgroup',
			creatorActor: '0xagent',
			creatorPrincipal: '0xprincipal',
			creatorSubAgentId: '0xsub',
			creatorIdentityClass: 1,
			groupName: 'Support',
			groupUuid: 'uuid-1',
			createdAt: 1710000000,
		});
	});
});
