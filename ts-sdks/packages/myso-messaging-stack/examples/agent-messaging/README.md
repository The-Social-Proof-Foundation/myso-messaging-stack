# Agent Messaging Examples

Runnable reference scripts for sub-agent messaging.

## Files

| File                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `agent-service.ts`       | Agent runtime: create group, send message with attribution |
| `principal-dashboard.ts` | Principal: list agent conversations via relayer            |

## Prerequisites

- Local MySo node or testnet RPC
- Messaging relayer with agent group indexing (`MEMBERSHIP_STORE_TYPE=memory` or Postgres)
- Registered sub-agent on a `MemoryAccount` with `CAP_MESSAGE_SEND`

## Environment

```bash
export MYSO_RPC_URL=http://127.0.0.1:9000
export RELAYER_URL=http://127.0.0.1:3000
export AGENT_SECRET_KEY=…
export HUMAN_SECRET_KEY=…
export SUB_AGENT_ID=0x…
export MEMORY_ACCOUNT_ID=0x…
export PLATFORM_ID=0x…
```

Run with `tsx` from the package root after building the SDK.
