# Relayer

## Table of Contents

- [What the Relayer Does](#what-the-relayer-does)
- [SDK Integration](#sdk-integration)
- [Reference Relayer](#reference-relayer)
  - [API Endpoints](#api-endpoints)
  - [Authentication](#authentication)
  - [Membership Sync](#membership-sync)
  - [File Storage Archival](#file-storage-archival)
  - [File Storage Discovery Indexer](#file-storage-discovery-indexer)
  - [Storage](#storage)
  - [Running the Relayer](#running-the-relayer)
  - [Configuration](#configuration-1)

**Documentation:** [Home](./README.md) | [Installation](./Installation.md) | [Setup](./Setup.md) | [API Reference](./APIRef.md) | [Examples](./Examples.md) | [Encryption](./Encryption.md) | [Security](./Security.md) | [Attachments](./Attachments.md) | [Archive & Recovery](./ArchiveRecovery.md) | [Group Discovery](./GroupDiscovery.md) | [Extending](./Extending.md) | [Testing](./Testing.md)

---

The relayer is an off-chain delivery operator that receives encrypted messages from clients, stores them in a local storage backend (in-memory by default, with support for pluggable persistent backends), and serves them back on request. It never decrypts messages or manages keys. For the trust model and security properties, see [Security](./Security.md).

## What the Relayer Does

1. **Authenticates** every request by verifying a cryptographic signature against the sender's MySo wallet address
2. **Authorizes** the action by checking that the sender holds the required permission (e.g., `MessagingSender` for POST) in the target group, using an on-chain-synced permission cache
3. **Stores** the encrypted message in a local storage backend (in-memory by default; pluggable for persistent storage such as PostgreSQL)
4. **Archives** messages to File Storage in the background for decentralized backup and cross-device recovery
5. **Stays in sync** with MySo via a gRPC subscription that listens for group membership events and updates the local permission cache in real time

## SDK Integration

The SDK communicates with the relayer through the `RelayerTransport` interface:

```typescript
interface RelayerTransport {
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult>;
  fetchMessage(params: FetchMessageParams): Promise<RelayerMessage>;
  updateMessage(params: UpdateMessageParams): Promise<void>;
  deleteMessage(params: DeleteMessageParams): Promise<void>;
  subscribe(params: SubscribeParams): AsyncIterable<RelayerMessage>;
  disconnect(): void;
}
```

The built-in `HTTPRelayerTransport` connects to the reference relayer via HTTP polling. You can implement a custom transport for WebSocket, SSE, or any other delivery backend. See [Extending](./Extending.md) for details.

### Configuration

```typescript
// Built-in HTTP transport
relayer: {
  relayerUrl: 'https://your-relayer.example.com',
  pollingIntervalMs: 3000,  // default
  timeout: 30000,           // default
  onError: (err) => console.error(err),
}

// Custom transport
relayer: {
  transport: myCustomTransport,  // implements RelayerTransport
}
```

## Reference Relayer

The SDK ships with a reference relayer implementation written in Rust (Axum). It is intended as a starting implementation, and we encourage adding rails to better fit your reliability, security, and scalability goals. For applications that require verifiable delivery, consider deploying the relayer within [Nautilus](https://docs.mysocial.network/guides/developer/cryptography/nautilus).

> **Info:** The reference relayer is provided as an example implementation. Applications are expected to run their own relayer or integrate messaging delivery into their existing backend infrastructure.

Full documentation, API reference, configuration, and deployment instructions are in the [relayer README](../../relayer/README.md). Additional docs are available in the [relayer/docs/](../../relayer/docs/) folder.

### API Endpoints

| Endpoint | Method | Permission | Description |
|----------|--------|------------|-------------|
| `/health_check` | GET | (none) | Liveness probe |
| `/messages` | POST | `MessagingSender` | Create a new message |
| `/messages` | GET | `MessagingReader` | Fetch a single message or paginated list |
| `/messages` | PUT | `MessagingEditor` | Update a message (owner only) |
| `/messages/:id` | DELETE | `MessagingDeleter` | Soft-delete a message (owner only) |

### Authentication

Every request (except `/health_check`) must include:
- `X-Signature`: hex-encoded 64-byte signature
- `X-Public-Key`: hex-encoded public key with scheme flag prefix (Ed25519, Secp256k1, Secp256r1)

The relayer verifies the signature, derives the MySo address from the public key, confirms it matches the claimed sender, and checks the local permission cache. See the [relayer README](../../relayer/README.md) for the full verification pipeline.

### Membership Sync

The relayer maintains a local permission cache by subscribing to MySo checkpoints via gRPC. It processes four event types from the Groups SDK contract:

| Event | Effect |
|-------|--------|
| `MemberAdded` | Adds member to cache (no permissions yet) |
| `MemberRemoved` | Removes member and all their permissions |
| `PermissionsGranted` | Adds specific permissions for a member |
| `PermissionsRevoked` | Removes specific permissions for a member |

This means the relayer reads on-chain state but never writes to it.

### File Storage Archival

The relayer archives messages to File Storage in the background, batching them into quilts. This enables cross-device message recovery without requiring centralized backups. Archival is triggered by either a timer (default: 1 hour) or a message count threshold (default: 50 new messages).

> **Info:** File Storage is used for durability and recovery, not real-time message delivery.

Messages follow a sync status lifecycle:

```
New message   --> SYNC_PENDING   --> SYNCED
Edited        --> UPDATE_PENDING --> UPDATED
Deleted       --> DELETE_PENDING --> DELETED
```

See [Archive & Recovery](./ArchiveRecovery.md) for the full archival and recovery pipeline.

### File Storage Discovery Indexer

We also provide a reference `file-storage-discovery-indexer` service that watches `BlobCertified` events on File Storage, inspects blobs for messaging patches, and serves a REST API for message recovery:

```
GET /v1/groups/:groupId/patches
```

This allows clients to recover messages when needed, or load messages across devices without having to configure backups to costlier and centralized storage systems. The `RecoveryTransport` interface in the SDK connects to this indexer. See [Extending](./Extending.md) for implementing a custom recovery transport.

### Storage

The reference relayer uses a pluggable `StorageAdapter` trait (Rust). The default backend is in-memory (all data lost on restart). A PostgreSQL adapter can be implemented against the same trait for durable persistence.

### Running the Relayer

```bash
# With cargo
cd relayer
cp .env.example .env  # fill in MYSO_RPC_URL and GROUPS_PACKAGE_ID
cargo run

# With Docker
docker compose up
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MYSO_RPC_URL` | (required) | MySo fullnode gRPC URL |
| `GROUPS_PACKAGE_ID` | (required) | Deployed Groups SDK package ID |
| `PORT` | `3000` | HTTP server port |
| `REQUEST_TTL_SECONDS` | `300` | Timestamp validity window for replay protection |
| `FILE_STORAGE_PUBLISHER_URL` | testnet publisher | File Storage publisher endpoint |
| `FILE_STORAGE_AGGREGATOR_URL` | testnet aggregator | File Storage aggregator endpoint |
| `FILE_STORAGE_STORAGE_EPOCHS` | `5` | File Storage storage duration in epochs |
| `FILE_STORAGE_SYNC_INTERVAL_SECS` | `3600` | Seconds between timer-based sync cycles |
| `FILE_STORAGE_SYNC_BATCH_SIZE` | `100` | Max messages per File Storage sync batch |
| `FILE_STORAGE_SYNC_MESSAGE_THRESHOLD` | `50` | New message count that triggers immediate sync |

See the [relayer README](../../relayer/README.md) for the full configuration reference, project structure, testing instructions, and deployment options.

---

[Back to table of contents](#table-of-contents)
