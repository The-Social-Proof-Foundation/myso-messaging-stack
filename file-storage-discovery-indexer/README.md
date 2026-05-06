# File Storage Discovery Indexer

A standalone Node.js + TypeScript service that watches the MySo blockchain for new File Storage blob uploads and identifies which ones contain messaging data from the relayer.

## Problem

When the relayer syncs messages to File Storage, clients need a way to **discover** which blobs contain their group's messages - without scanning every blob on File Storage themselves. The indexer does that scanning work and exposes results via a REST API.

## Tech Stack

- **Runtime:** Node.js with TypeScript (`tsx` for dev, `tsc` for production)
- **gRPC:** `@socialproof/myso` - streams real-time MySo checkpoints
- **File Storage SDK:** `@socialproof/file-storage` - reads blob contents directly from storage nodes (no aggregator needed)
- **HTTP:** Express - REST API for clients to query discovered patches
- **Config:** `dotenv` for environment variables

## How It Works

The indexer subscribes to the MySo checkpoint stream via gRPC. Every checkpoint contains transactions, and every transaction can have events. Each event passes through a three-tier filtering pipeline:

**Tier 1 - Sender filter (optional):** If a publisher address is configured, skip events from other senders. Reduces noise.

**Tier 2 - Event type + BCS parsing:** Check if the event is a `BlobCertified` event from the File Storage package. BCS-deserialize it to extract the blob ID.

**Tier 3 - Tag-based inspection (non-blocking):** Use the File Storage SDK to read the blob's quilt index and filter by the `source: "myso-messaging-relayer"` tag. Metadata (group ID, sender, sync status, order) is read directly from quilt index tags - no patch content downloads needed. Runs in the background (fire-and-forget) because File Storage storage node reads take 1-5s and would otherwise block the gRPC stream.

### Data Flow

```
MySo gRPC checkpoint stream
        │
        ▼
  checkpoint-listener.ts - filters events through 3 tiers
        │
        ▼
  blob-inspector.ts - reads quilt tags via @socialproof/file-storage SDK
        │
        ▼
  discovery-store.ts - in-memory Map<groupId, patches[]>
        │
        ▼
  api.ts - Express REST endpoints
```

## REST API

| Endpoint | Description |
|---|---|
| `GET /v1/groups/:groupId/patches` | All discovered message patches for a group |
| `GET /v1/patches` | All discovered patches across all groups |
| `GET /health` | Health check + last processed checkpoint number |

### Example Response

```
GET /v1/groups/{groupId}/patches
```

```json
{
  "groupId": "0x2998...",
  "count": 3,
  "hasMore": false,
  "patches": [
    {
      "identifier": "msg-ad019b9d-...",
      "messageId": "ad019b9d-...",
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

## Project Structure

```
src/
├── index.ts              - entry point, wires everything, handles SIGINT/SIGTERM
├── config.ts             - loads .env, validates, derives gRPC URL from network
├── constants.ts          - shared constants (MSG_PREFIX, SOURCE_TAG)
├── checkpoint-listener.ts - gRPC subscription loop with auto-reconnect (5s backoff)
├── event-parser.ts       - BCS deserialization of BlobCertified events
├── blob-inspector.ts     - reads quilt index tags via @socialproof/file-storage SDK
├── discovery-store.ts    - DiscoveryStore interface + InMemoryDiscoveryStore
├── api.ts                - Express REST endpoints
└── types.ts              - shared TypeScript interfaces
```

## Setup

```bash
cp .env.example .env
# Edit .env - set NETWORK and optionally FILE_STORAGE_PACKAGE_ID
npm install
```

## Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `NETWORK` | Yes | - | `testnet` or `mainnet` |
| `FILE_STORAGE_PACKAGE_ID` | No | Auto-derived | File Storage system contract package ID |
| `FILE_STORAGE_PUBLISHER_MYSO_ADDRESS` | No | - | Filter events to a specific publisher |
| `PORT` | No | `3001` | REST API port |

## Design Decisions

- **No aggregator dependency** - the `@socialproof/file-storage` SDK talks directly to storage nodes, no single point of failure
- **Tag-based discovery** - metadata is read from quilt index tags, no patch content downloads needed
- **Non-blocking blob inspection** - fire-and-forget pattern prevents gRPC stream timeouts
- **DiscoveryStore interface** - in-memory implementation included; swap for a database in production
- **Auto-reconnect** - gRPC streams disconnect on network issues or idle timeout; the outer loop reconnects after 5 seconds
