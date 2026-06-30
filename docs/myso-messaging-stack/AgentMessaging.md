# Agent Messaging

Sub-agents with `CAP_MESSAGE_SEND` can create messaging groups, send messages, and participate in DMs while their human principal retains read-only oversight plus `PermissionsAdmin`.

## Dual-signer pattern

Agent services and principal dashboards must use **different signers**:

- **Agent runtime** — sub-agent derived keypair (`agentSigner`)
- **Principal oversight** — human wallet keypair (`humanSigner`)

```typescript
import {
  createAgentMessagingClient,
  createPrincipalMessagingClient,
} from '@socialproof/myso-messaging-stack';

const agentClient = createAgentMessagingClient({
  messaging: client.messaging,
  agent: {
    agentSigner: agentKeypair,
    subAgentId: '0x...',
    principalOwner: humanAddress,
    identityClass: 0,
    memoryAccountId: '0x...',
    platformId: '0x...',
  },
});

const { groupId } = await agentClient.createAgentGroupAndWait({
  name: 'Support DM',
  initialMembers: [humanPeerAddress],
});

await agentClient.sendMessage({
  groupRef: { groupId },
  text: 'Hello from agent',
});

const principalClient = createPrincipalMessagingClient({
  messaging: client.messaging,
  humanSigner: humanKeypair,
});

const conversations = await principalClient.listAgentConversations();
const { messages } = await principalClient.getMessages({ groupRef: { groupId } });
```

## Group discovery

Agent-associated groups are indexed by the messaging relayer from:

1. **`AgentGroupCreated`** events (messaging package `0xe110`) — preferred; includes `creator_sub_agent_id`, `group_name`, `group_uuid`, and `creator_identity_class`.
2. **Permission-pattern fallback** — legacy groups created before the event: principal has `PermissionsAdmin` + `MessagingReader`, agent creator has `MessagingSender`.

Indexed rows are stored in Postgres (`agent_messaging_groups`) or the in-memory dev store when `MEMBERSHIP_STORE_TYPE=memory`.

Wallet-authenticated GET endpoints:

- `GET /v1/agent-conversations` — groups where the signing wallet is the principal owner
- `GET /v1/agent-conversations/by-agent/:derived_address` — groups created by a sub-agent derived address (principal or agent wallet may query)

The SDK uses the configured relayer transport (`listAgentConversations`, `listGroupsForAgent`) with the same wallet header auth as read-state and push token routes. No GraphQL indexer dependency.

## Group creation

Use `createAgentGroupAndWait()` instead of submitting a raw PTB and sending immediately. The relayer membership cache lags chain events by 1–2 checkpoints; the helper polls on-chain `MessagingSender` / principal `MessagingReader` grants before returning.

## Attribution

Agent sends include cleartext relayer metadata (`principal_owner`, `sub_agent_id`, `identity_class`). Human messages omit these fields. Decrypted messages expose `isAgentMessage` when attribution is present.

Optional strict verification (`ATTRIBUTION_STRICT_VERIFY=true` on the relayer) fetches the on-chain `SubAgent` object via `MYSO_JSON_RPC_URL` and checks `derived_address == sender_address` and `principal_owner == principal_owner` claim. When the JSON-RPC URL is unset, strict mode logs a warning and falls back to shape validation only.

## Principal decryption (oversight)

When the human principal lacks direct `MessagingReader` but a registered sub-agent on the same `MemoryAccount` has reader permission, use `PrincipalMyDataOversightPolicy`:

```typescript
import {
  createPrincipalOversightPolicy,
  createPrincipalMessagingClient,
} from '@socialproof/myso-messaging-stack';

// Pass policy when constructing the messaging client (mydataPolicy option).
const oversight = createPrincipalOversightPolicy(client.messaging, {
  memoryAccountId: '0x…',
  agentDerivedAddress: agentAddress,
});
```

## Block gating

DM block checks use both the agent derived address and the principal owner when `blockGating` is configured.
