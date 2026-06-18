# Encrypted Read State

Cross-device unread sync uses a **wallet-scoped encrypted blob** stored on the Relayer. The server never sees plaintext `readUpto` watermarks.

## Schema (inside ciphertext)

```typescript
interface UserReadState {
  version: 1;
  updatedAt: number;
  groups: Record<string, { readUpto: number; muted?: boolean }>;
}
```

Unread for group `G` = count of messages where `order > groups[G].readUpto` (computed on device).

## Relayer API

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/users/read-state` | Wallet signature (`timestamp:sender_address`) |
| PUT | `/v1/users/read-state` | Signed JSON body |

## SDK

```typescript
const state = await client.messaging.getReadState({ signer });
await client.messaging.updateReadState({ signer, groupId, readUpto: 42 });
const counts = await client.messaging.getUnreadCounts({ signer, groupIds: ['0x...'] });
```

Encryption: HKDF-SHA256(wallet seed, `myso-messaging-read-state-v1`) + AES-256-GCM.

## Deprecation

Plaintext `/v1/groups/:id/receipts` remains for one release but should not be used in new clients.

## Production

Use `STORAGE_TYPE=postgres` so read-state blobs survive Relayer restarts.
