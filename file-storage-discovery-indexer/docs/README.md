# File Storage Discovery Indexer - Reference Guide

## Overview

The File Storage Discovery Indexer is a standalone service that monitors the MySo blockchain for File Storage blob uploads and identifies which ones contain messaging data from the relayer. It exposes discovered message metadata via a REST API so clients can recover messages directly from File Storage without depending on the relayer.

## System Architecture

```
┌─────────────┐     POST /messages      ┌─────────────┐
│   Client     │ ──────────────────────▶ │   Relayer    │
│  (Groups SDK)│                         │  (Rust)      │
└──────┬───────┘                         └──────┬───────┘
       │                                        │
       │                              (timer or threshold)
       │                                        │
       │                                        ▼
       │                                ┌───────────────┐
       │                                │ File Storage Sync   │
       │                                │ Service       │
       │                                │ (background)  │
       │                                └───────┬───────┘
       │                                        │
       │                               PUT /v1/quilts
       │                                        │
       │                                        ▼
       │                                ┌───────────────┐
       │                                │    File Storage     │
       │                                │  (Storage)    │
       │                                └───────┬───────┘
       │                                        │
       │                        BlobCertified event on MySo
       │                                        │
       │                                        ▼
       │  GET /v1/groups/:id/patches    ┌───────────────┐
       │ ◀──────────────────────────────│   Discovery   │
       │                                │   Indexer     │
       │                                │  (this repo)  │
       │                                └───────────────┘
       │                                   Listens to MySo
       │                                   gRPC checkpoints
       ▼
  Client reads patches from
  File Storage using blobId + identifier
```

**Normal flow:** Client reads messages from the relayer (fast, live data).

**Recovery flow:** If the relayer is down or data is lost, the client queries the indexer to discover which File Storage quilts contain their group's messages, then reads them directly from File Storage storage nodes.

## Three-Tier Filtering Pipeline

Every event from the MySo gRPC checkpoint stream passes through three filters:

### Tier 1 - Sender Filter (optional)

If `FILE_STORAGE_PUBLISHER_MYSO_ADDRESS` is configured, skip events from other senders. This reduces noise - on mainnet with a self-hosted publisher, this eliminates ~99% of irrelevant events.

### Tier 2 - Event Type + BCS Parsing

Check if the event is a `BlobCertified` event from the File Storage system contract. BCS-deserialize the event contents to extract the `blob_id` (u256), then convert it to File Storage base64url format using `blobIdFromInt()` from `@socialproof/file-storage`.

### Tier 3 - Tag-Based Inspection

Use the File Storage SDK to read the blob's quilt index from storage nodes and filter by the `source: "myso-messaging-relayer"` tag. The relayer embeds per-patch tags when storing quilts, so the indexer reads metadata (group ID, sender, sync status, order) directly from the quilt index - no patch content downloads needed.

This tier runs in the background (fire-and-forget with a concurrency limit of 10) because reading from File Storage storage nodes takes 1-5 seconds per blob. Blocking the checkpoint loop would cause the gRPC stream to time out and disconnect.

### Per-Patch Tag Schema

The relayer stores these tags on each quilt patch:

| Tag Key | Example Value | Purpose |
|---|---|---|
| `source` | `myso-messaging-relayer` | Identifies patches from this relayer |
| `group_id` | `0x2998...` | Group the message belongs to |
| `sender` | `0x9bc6...` | Sender's MySo wallet address |
| `sync_status` | `SYNCED` / `UPDATED` / `DELETED` | Message lifecycle state |
| `order` | `1` | Message ordering within group |

## Message Lifecycle on File Storage

When a message goes through its lifecycle, the relayer creates new patches at each stage:

```
Message created → File Storage sync → Patch A (syncStatus: SYNCED)     [quilt-1]
Message edited  → File Storage sync → Patch B (syncStatus: UPDATED)    [quilt-2]
Message deleted → File Storage sync → Patch C (syncStatus: DELETED)    [quilt-3]
```

Each sync creates a new quilt (File Storage quilts are immutable). The indexer discovers ALL of these patches as they appear on-chain and deduplicates by `messageId`, keeping only the latest version (determined by checkpoint number). The API always returns the most recent state of each message.

## Ordering

The `order` field is auto-assigned by the relayer's storage layer (per-group sequential integer). It never changes - even when a message is edited or deleted, its order stays the same. This guarantees stable ordering for conversation reconstruction.

## REST API

### `GET /v1/groups/:groupId/patches`

Returns discovered patches for a group, sorted by order.

Query parameters (all optional):
- `limit` - max results (default: 50, max: 100)
- `after_order` - return patches with order > this value (scroll forward)
- `before_order` - return patches with order < this value (scroll backward)

Response:
```json
{
  "groupId": "0x2998...",
  "count": 3,
  "hasMore": false,
  "patches": [
    {
      "identifier": "msg-550e8400-e29b-41d4-a716-446655440000",
      "messageId": "550e8400-e29b-41d4-a716-446655440000",
      "groupId": "0x2998...",
      "senderAddress": "0x9bc6...",
      "syncStatus": "SYNCED",
      "blobId": "vwJb18Kpo...",
      "order": 1,
      "checkpoint": "307115199"
    }
  ]
}
```

### `GET /v1/patches`

Returns a summary of all discovered groups and patch counts. Supports optional `?groupId=` filter.

### `GET /health`

Health check with last processed checkpoint number and discovery stats.

```json
{
  "status": "ok",
  "lastCheckpoint": "307115764",
  "totalGroups": 1,
  "totalPatches": 3
}
```

## Client Recovery Flow

When the relayer is unavailable and a client needs to restore messages from File Storage:

### 1. Query the indexer for patch metadata

```typescript
const response = await fetch(
  `https://indexer.example.com/v1/groups/${groupId}/patches`
);
const { patches } = await response.json();
```

### 2. Read message content from File Storage

```typescript
import { FileStorageClient } from '@socialproof/file-storage';

const fileStorageClient = new FileStorageClient({ network: 'testnet', mysoClient });

for (const patch of patches) {
  if (patch.syncStatus === 'DELETED') continue;

  const blob = await fileStorageClient.getBlob({ blobId: patch.blobId });
  const files = await blob.files({ identifiers: [patch.identifier] });
  const message = await files[0].json();

  // message contains: encrypted_msg, nonce, key_version, etc.
  // Client decrypts using the group's shared key
}
```

### 3. Reconstruct ordered history

```typescript
const activeMessages = patches
  .filter(p => p.syncStatus !== 'DELETED')
  .sort((a, b) => a.order - b.order);
```

> **TODO:** The Groups SDK will be updated to integrate with the indexer directly, abstracting the recovery flow behind a single API call.

## Limitations

1. **No message decryption** - the indexer sees encrypted bytes, not plaintext
2. **No authentication** - the REST API is public (add auth in production)
3. **No persistence** - in-memory store by default, data lost on restart (implement the `DiscoveryStore` interface with a database for production)
4. **No backfill** - starts from the latest checkpoint when launched
5. **No attachment handling** - only discovers message patches (`msg-*` prefix)

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `NETWORK` | Yes | - | `testnet` or `mainnet` |
| `FILE_STORAGE_PUBLISHER_MYSO_ADDRESS` | No | - | Publisher's MySo address for tier 1 filtering |
| `PORT` | No | `3001` | REST API port |

The File Storage package ID is auto-derived from the SDK at startup - no manual configuration needed.
