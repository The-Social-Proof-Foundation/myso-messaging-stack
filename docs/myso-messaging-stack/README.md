# MySocial Messaging Stack

## Contents

- [Architecture](#architecture)
- [Architecture Evolution](#architecture-evolution)
- [Dependencies](#dependencies)
- [Features](#features)
- [Use Cases](#use-cases)
- [Package](#package)
- [Quick Start](#quick-start)

**Documentation:**

- [Installation](./Installation.md)
- [Setup](./Setup.md)
- [Examples](./Examples.md)
- [API Reference](./APIRef.md)
- [Encryption](./Encryption.md)
- [Security](./Security.md)
- [Relayer](./Relayer.md)
- [Attachments](./Attachments.md)
- [Archive & Recovery](./ArchiveRecovery.md)
- [Group Discovery](./GroupDiscovery.md)
- [Extending](./Extending.md)
- [Testing](./Testing.md)

---

Messaging tooling for Web3 applications, built on [MySo](https://mysocial.network), [MyData](https://github.com/the-social-proof-foundation/myso-mydata), and [File Storage](https://mysocial.network/storage).

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Your App   │     │   Relayer    │     │     MySo      │
│              │     │              │  R  │              │
│  SDK encrypts├────►│ Stores E2EE  ├────►│ Permissions  │
│  client-side │     │  ciphertext  │     │ Encryption   │
│              │◄────┤ Serves msgs  │     │ Key History  │
└──┬───┬───┬───┘     └──────┬───────┘     └──────────────┘
   │   │   │                │                    ▲
   │   │   └─────────────────────────────────────┘
   │   │          R/W       │
   │  ┌▼─────────┐    ┌─────▼──────┐
   │  │   MyData   │    │   File Storage   │
   │  │ Key Mgmt │    │  Archival  │
   │  └──────────┘    └────────────┘
   │                        ▲
   └────────────────────────┘
```

Messages are encrypted client-side using AES-256-GCM with MyData-managed keys, stored off-chain via a relayer service, and optionally archived to File Storage. Group permissions and encryption key history live on-chain as MySo objects.

## Architecture Evolution

The MySocial Messaging Stack tooling is infrastructure for building encrypted, programmable messaging directly into applications, rather than a standalone messaging service.

The alpha version stored messages on-chain as MySo objects, providing on-chain verifiability for ordering and availability. The current architecture moves delivery logistics off-chain to a relayer, highly optimizing the total cost while preserving E2E encryption and sender verification. The relayer acts as a delivery operator for message routing and ordering; for applications that require verifiable delivery, you can adapt the available relayer template to run inside [Nautilus](https://docs.mysocial.network/guides/developer/cryptography/nautilus). See [Security](./Security.md) for the full trust model.

## Dependencies

- [**@socialproof/myso-groups**](https://github.com/the-social-proof-foundation/myso-groups): generic on-chain permissioned groups library for verifiable on-chain group governance
  - Conceptually, Groups provides the "who is allowed" layer, while Messaging tooling provides the "how they communicate" layer.
- [**@socialproof/mydata**](https://github.com/the-social-proof-foundation/myso-mydata): threshold encryption for DEK management
- [**@socialproof/myso**](https://docs.mysocial.network): MySo TypeScript SDK

## Features

- **Composable SDK**: client extension pattern following [MySocial SDK guidelines](https://docs.mysocial.network/mysocial)
- **Pluggable transport**: interface-driven transport layer; swap the built-in HTTP relayer for any custom backend
- **End-to-end encryption**: AES-256-GCM with MyData-managed keys; the relayer never sees plaintext
- **Sender verification**: per-message wallet signatures, independently verifiable by all group members
- **File attachments**: per-file encryption with lazy download via pluggable storage adapters (File Storage built-in)
- **Real-time subscriptions**: `AsyncIterable`-based message streaming with automatic decryption
- **Key rotation**: manual DEK rotation with atomic member-removal-and-rotate operations
- **Group lifecycle**: create, archive, and leave groups; batch member management with permission control
- **Cross-device recovery**: encrypted message history restorable from File Storage without requiring centralized backups
- **Custom MyData policies**: override default access control with application-specific logic (token-gated, subscription-based)
- **UUID-based addressing**: deterministic on-chain object IDs from client-provided UUIDs, enabling single-transaction group creation
- **Group handles**: on-chain `GroupHandleRegistry` (separate from profile usernames) for canonical handle → group id
- **Group metadata**: on-chain key-value store for application-specific group data

## Use Cases

The tooling is designed as communication infrastructure that apps can embed directly into their product workflows.

- Secure 1:1 DMs and group chats
- Token-gated or membership-gated communities
- Guild chats for games
- In-app support channels
- Cross-app coordination between protocols
- AI agents interacting inside encrypted channels
- Reputation or identity-driven messaging workflows

## Package

Primary developer entry point for building messaging features.

```
@socialproof/myso-messaging-stack
```

## Quick Start

```typescript
import { MySoGrpcClient } from '@socialproof/myso/grpc';
import { createMessagingGroupsClient } from '@socialproof/myso-messaging-stack';

const client = createMessagingGroupsClient(
  new MySoGrpcClient({
    baseUrl: 'https://fullnode.testnet.mysocial.network:443',
    network: 'testnet',
  }),
  {
    mydata: {
      serverConfigs: [
        { objectId: '0x...', weight: 1 },
        { objectId: '0x...', weight: 1 },
      ],
    },
    encryption: {
      sessionKey: { signer: keypair },
    },
    relayer: {
      relayerUrl: 'https://your-relayer.example.com',
    },
  },
);

// Create a group
await client.messaging.createAndShareGroup({
  signer: keypair,
  name: 'My Group',
  initialMembers: ['0xAlice...', '0xBob...'],
});

// Send a message
await client.messaging.sendMessage({
  signer: keypair,
  groupRef: { uuid: 'my-group-uuid' },
  text: 'Hello, world!',
});

// Subscribe to messages and reaction updates
for await (const event of client.messaging.subscribe({
  signer: keypair,
  groupRef: { uuid: 'my-group-uuid' },
  signal: new AbortController().signal,
})) {
  if (event.type === 'message') {
    console.log(event.message.text, event.message.senderVerified);
  } else {
    console.log(event.reaction.emoji, event.reaction.count);
  }
}
```
