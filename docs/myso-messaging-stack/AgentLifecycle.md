# Agent Lifecycle and Group Cleanup

When a sub-agent is deactivated or revoked in `memory.move`, its derived address may retain messaging permissions on existing groups. Principals must remove the agent and rotate encryption keys for each affected group.

## Runbook

1. Deactivate or revoke the sub-agent on-chain (`deactivate_sub_agent` / `revoke_sub_agent`).
2. Enumerate groups via relayer `GET /v1/agent-conversations/by-agent/:derived_address` (wallet auth) or `fetchGroupsForAgent()`.
3. Call `revokeAgentFromAllGroups()` with the principal signer.

```typescript
import { fetchGroupsForAgent, revokeAgentFromAllGroups } from '@socialproof/myso-messaging-stack';

const groups = await fetchGroupsForAgent({
  relayerUrl: 'https://relayer.example.com',
  signer: humanKeypair,
  derivedAddress: agentDerivedAddress,
});

await revokeAgentFromAllGroups({
  messaging: client.messaging,
  principalSigner: humanKeypair,
  agentDerivedAddress,
  groupRefs: groups.map((g) => ({ groupId: g.groupId })),
});
```

Each group is processed with `removeMembersAndRotateKey()` so the revoked agent cannot decrypt new messages.

## Key rotation

`removeMembersAndRotateKey` atomically removes members and appends a new MyData-encrypted DEK. Principals need `PermissionsAdmin` on agent-associated groups (granted automatically at creation).

## Strict attribution verify

Production relayers may enable `ATTRIBUTION_STRICT_VERIFY=true` with `MYSO_JSON_RPC_URL` so agent message POSTs verify the claimed `sub_agent_id` against on-chain `SubAgent` fields before persistence.

## Example scripts

See `ts-sdks/packages/myso-messaging-stack/examples/agent-messaging/` for runnable agent-service and principal-dashboard samples.

## Future automation

A follow-up phase may emit cleanup events from chain listeners; v1 requires explicit principal action documented above.
