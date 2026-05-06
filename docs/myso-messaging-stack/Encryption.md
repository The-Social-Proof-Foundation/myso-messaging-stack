# Encryption

## Contents

- [Envelope Encryption Model](#envelope-encryption-model)
- [Send Flow](#send-flow)
- [Receive Flow](#receive-flow)
- [Additional Authenticated Data (AAD)](#additional-authenticated-data-aad)
- [Sender Verification](#sender-verification)
- [Session Key Management](#session-key-management)
- [Key Versioning](#key-versioning)
- [DEK Caching](#dek-caching)
- [Attachment Encryption](#attachment-encryption)
- [Nonce Handling](#nonce-handling)

---

This document describes how the SDK encrypts and decrypts messages. For security properties, guarantees, and threat model, see [Security](./Security.md).

## Envelope Encryption Model

Each messaging group has a **Data Encryption Key (DEK)**, an AES-256-GCM symmetric key. The DEK is:

1. Generated client-side
2. **MyData-encrypted** (threshold encryption across independent key servers)
3. Stored on-chain in an `EncryptionHistory` object (a versioned list of encrypted DEKs)

Messages are encrypted with the DEK using AES-256-GCM. The relayer only ever sees ciphertext.

```
Message plaintext
       |
       v
  AES-256-GCM encrypt (DEK + random nonce + AAD)
       |
       v
  Ciphertext + nonce + keyVersion --> Relayer
```

To decrypt, a group member fetches the encrypted DEK from on-chain, proves access via MyData's `mydata_approve` mechanism, and receives the plaintext DEK for local AES-GCM decryption.

## Send Flow

When `sendMessage()` is called:

1. **Resolve DEK**: check local cache. On miss: fetch encrypted DEK from `EncryptionHistory` on-chain, build a `mydata_approve` transaction, MyData-decrypt, cache the result.
2. **Generate nonce**: random 96-bit (12-byte) nonce.
3. **Build AAD**: Additional Authenticated Data binding ciphertext to context (see below).
4. **AES-GCM encrypt**: encrypt the message text with DEK + nonce + AAD.
5. **Sign**: sign the canonical message content for sender verification.
6. **Send**: transmit ciphertext, nonce, keyVersion, and signature to the relayer.

## Receive Flow

When `getMessage()`, `getMessages()`, or `subscribe()` is called:

1. **Fetch**: retrieve encrypted message(s) from the relayer.
2. **Resolve DEK**: same cache-first flow as sending.
3. **Reconstruct AAD**: from context fields (groupId, keyVersion, senderAddress).
4. **AES-GCM decrypt**: decrypt the ciphertext. If AAD mismatches, decryption fails.
5. **Verify sender**: check the per-message signature against the sender's public key.
6. **Resolve attachments**: decrypt attachment metadata, provide lazy download handles.

## Additional Authenticated Data (AAD)

Every message is encrypted with AAD that binds the ciphertext to its context:

```
[groupId (32 bytes)][keyVersion (8 bytes LE u64)][senderAddress (32 bytes)]
```

AAD is never stored; both sender and receiver reconstruct it from known context. If any field mismatches (e.g., a message is replayed into a different group or attributed to a different sender), AES-GCM decryption fails with an authentication error.

## Sender Verification

Each message includes a per-message signature over the canonical content, protecting against message forgery by allowing clients to validate that a message was authored by the claimed sender:

```
"{groupId}:{hex(encryptedText)}:{hex(nonce)}:{keyVersion}"
```

The sender's public key (with scheme flag prefix identifying Ed25519, Secp256k1, or Secp256r1) is stored alongside the message. All group members can independently verify that:

1. The signature is valid for the canonical content
2. The public key derives to the claimed `senderAddress`

The SDK performs this verification automatically during decryption and populates `DecryptedMessage.senderVerified`. Messages where verification fails or signature data is missing have `senderVerified: false`.

## Session Key Management

MyData operations require a **session key**, a short-lived key that authorizes decryption requests to MyData key servers. The SDK manages session keys internally via three tiers. See [Setup](./Setup.md) for configuration details.

**Tier 1: Signer-based** (recommended):
```typescript
encryption: { sessionKey: { signer: keypair } }
```
The SDK calls `SessionKey.create()` with the signer and handles certification automatically. Works with dapp-kit-next `CurrentAccountSigner`, `Keypair`, and Enoki.

**Tier 2: Callback-based:**
```typescript
encryption: {
  sessionKey: {
    address: '0x...',
    onSign: async (message) => signPersonalMessage(message),
  },
}
```
The SDK creates a session key, then calls `onSign()` with the personal message bytes for wallet signing. For current dapp-kit without the Signer abstraction.

**Tier 3: Manual:**
```typescript
encryption: { sessionKey: { getSessionKey: () => mySessionKey } }
```
Full control over the session key lifecycle. The SDK calls `getSessionKey()` whenever it needs a key.

Session keys are refreshed automatically before expiry (configurable via `ttlMin` and `refreshBufferMs`).

## Key Versioning

The `EncryptionHistory` on-chain object stores encrypted DEKs as a versioned list (0-indexed):

- **Version 0** is created with the group (initial DEK)
- Each `rotateEncryptionKey()` call appends a new version
- Messages reference their `keyVersion` so receivers know which DEK to use
- Old versions remain accessible to current group members via MyData

Key rotation creates a new, independent DEK. Old DEKs cannot be derived from new ones and vice versa. The protection rotation provides is against **removed members**: after rotation, a member who has lost `MessagingReader` permission cannot obtain the new DEK from MyData. See [Security](./Security.md) for the full picture on forward secrecy and post-compromise security.

## DEK Caching

Decrypted DEKs are cached in-memory (via `ClientCache` backed by a `TtlMap`), keyed by `[groupId, keyVersion]`. Cached entries expire automatically when the MyData session key expires, so the DEK cache lifetime matches the session key TTL. This avoids repeated MyData decryption calls:

- **Cache warm on create/rotate**: when the SDK generates a new DEK (group creation or key rotation), it immediately caches the plaintext DEK.
- **Cache miss on decrypt**: first decryption for a given group/version triggers a MyData round-trip. Subsequent decryptions use the cached DEK.
- **Manual invalidation**: `client.messaging.encryption.clearCache(groupId?)` clears all or group-specific cached DEKs.

## Attachment Encryption

Each file attachment is encrypted with the same group DEK but a separate random nonce. File metadata (fileName, mimeType, fileSize) is encrypted separately with its own nonce. See [Attachments](./Attachments.md) for the full attachment encryption model.

## Nonce Handling

AES-GCM uses random 96-bit nonces. NIST SP 800-38D recommends at most 2^32 (~4 billion) encryptions per key to keep the nonce collision probability at or below 2^-32. A nonce collision under the same key is catastrophic: it leaks the XOR of two plaintexts and breaks authentication. In practice this limit is extremely high and unlikely to be reached in typical messaging usage before key rotation.

For high-volume groups, rotate keys periodically to reset the nonce space.
