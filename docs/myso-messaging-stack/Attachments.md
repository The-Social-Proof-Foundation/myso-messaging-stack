# Attachments

## Table of Contents

- [Configuration](#configuration)
- [Encryption Model](#encryption-model)
- [Upload Flow](#upload-flow)
- [Download Flow (Lazy)](#download-flow-lazy)
- [Wire Format](#wire-format)
- [Editing Attachments](#editing-attachments)
- [Built-in File Storage Adapter](#built-in-file-storage-adapter)
- [Custom Storage Adapters](#custom-storage-adapters)

**Documentation:** [Home](./README.md) | [Installation](./Installation.md) | [Setup](./Setup.md) | [API Reference](./APIRef.md) | [Examples](./Examples.md) | [Encryption](./Encryption.md) | [Security](./Security.md) | [Relayer](./Relayer.md) | [Archive & Recovery](./ArchiveRecovery.md) | [Group Discovery](./GroupDiscovery.md) | [Extending](./Extending.md) | [Testing](./Testing.md)

---

The SDK supports sending encrypted file attachments alongside messages. Each file is encrypted individually with the group's DEK, uploaded to a pluggable storage backend, and its encrypted metadata is stored inline with the message via the relayer. Attachments are entirely off-chain: the Move contracts are unaware of them.

## Configuration

Attachment support requires a `StorageAdapter` at client creation:

```typescript
import {
  createMessagingGroupsClient,
  FileStorageHttpStorageAdapter,
} from "@socialproof/myso-messaging-stack";

const client = createMessagingGroupsClient(baseClient, {
  // ...
  attachments: {
    storageAdapter: new FileStorageHttpStorageAdapter({
      publisherUrl: "https://publisher.file-storage-testnet.mysocial.network",
      aggregatorUrl: "https://aggregator.file-storage-testnet.mysocial.network",
      epochs: 5,
    }),
    maxAttachments: 10, // default
    maxFileSizeBytes: 10_485_760, // 10 MB default
    maxTotalFileSizeBytes: 52_428_800, // 50 MB default
  },
});
```

When omitted, `sendMessage` cannot include files and received attachment metadata is not resolvable. See [Setup](./Setup.md) for the full configuration reference.

## Encryption Model

Attachments use the same group DEK as message text, but each file gets its own encryption:

```
+------------------------------------------------------------------+
|  Per file:                                                        |
|                                                                   |
|  file bytes --> AES-GCM encrypt --> encrypted file data + nonce   |
|                 (DEK + random nonce)                              |
|                                                                   |
|  metadata JSON --> AES-GCM encrypt --> encrypted metadata         |
|  (fileName,        (DEK + separate      + metadataNonce           |
|   mimeType,         random nonce)                                 |
|   fileSize,                                                       |
|   extras)                                                         |
+------------------------------------------------------------------+
```

Metadata is encrypted separately from file data. This allows clients to decrypt metadata (to display file name, type, and size) without downloading the full file content.

See [Encryption](./Encryption.md) for the underlying DEK management and AES-GCM details.

## Upload Flow

When `sendMessage()` or `editMessage()` includes files:

1. **Validate**: check file count and sizes against configured limits
2. **Encrypt each file**: individually with the group DEK and a per-file random nonce
3. **Batch upload**: all encrypted files are uploaded to the `StorageAdapter` as a single batch (e.g., one File Storage quilt containing multiple patches)
4. **Encrypt metadata**: for each file, a JSON blob containing `fileName`, `mimeType`, `fileSize`, and optional `extras` is encrypted with a separate nonce
5. **Build wire format**: each file becomes an `Attachment` with `storageId`, `nonce`, `encryptedMetadata`, and `metadataNonce`
6. **Send to relayer**: the `Attachment[]` array is included in the relayer request alongside the encrypted message text

## Download Flow (Lazy)

When a message with attachments is received, the SDK decrypts the metadata immediately but defers file downloads:

1. **Decrypt metadata**: for each attachment, the encrypted metadata is decrypted to reveal `fileName`, `mimeType`, `fileSize`, and `extras`
2. **Create handles**: each attachment becomes an `AttachmentHandle` with the decrypted metadata and a `data()` closure
3. **Lazy download**: calling `handle.data()` triggers a download from the `StorageAdapter`, followed by decryption with the group DEK and the file's nonce

```typescript
for (const attachment of msg.attachments) {
  console.log(`${attachment.fileName} (${attachment.fileSize} bytes)`);

  // Download + decrypt on demand (not cached)
  const bytes = await attachment.data();
}
```

Each `data()` call triggers a fresh download and decryption. There is no attachment-level caching.

## Wire Format

The `Attachment` type travels through the relayer:

```typescript
interface Attachment {
  storageId: string; // Storage backend ID (e.g., File Storage quilt-patch-id)
  nonce: string; // Hex-encoded 12-byte AES-GCM nonce for file data
  encryptedMetadata: string; // Hex-encoded encrypted JSON metadata
  metadataNonce: string; // Hex-encoded 12-byte AES-GCM nonce for metadata
}
```

The relayer stores this array opaquely without interpreting the encrypted fields.

## Editing Attachments

When editing a message, you can add, remove, or keep attachments:

```typescript
await client.messaging.editMessage({
  signer: keypair,
  groupRef: { uuid: "my-group" },
  messageId: "abc123",
  text: "Updated message",
  attachments: {
    current: originalMsg.attachments.map((a) => a.wire), // current Attachment[]
    remove: ["storage-id-to-remove"], // storageIds to remove
    new: [{ fileName: "new.pdf", mimeType: "application/pdf", data: pdfBytes }],
  },
});
```

The SDK computes the final attachment list as: `current - remove + upload(new)`. Removed files are deleted from the storage backend on a best-effort basis (silently skipped if the adapter doesn't support deletion).

## Built-in File Storage Adapter

The `FileStorageHttpStorageAdapter` uses the File Storage HTTP publisher and aggregator:

- **Upload**: `PUT /v1/quilts?epochs=N` with all files as a single quilt. Each file becomes a patch, and the adapter returns the quilt-patch-id as the `storageId`.
- **Download**: `GET /v1/blobs/by-quilt-patch-id/{id}` to fetch a single file by its patch ID.
- **Delete**: not supported by the File Storage publisher HTTP API. Orphaned encrypted data expires naturally per File Storage retention policy.

## Custom Storage Adapters

Implement the `StorageAdapter` interface to use any storage backend. The adapter is encryption-unaware: it only handles opaque bytes. See [Extending](./Extending.md) for the interface definition and examples.

---

[Back to table of contents](#table-of-contents)
