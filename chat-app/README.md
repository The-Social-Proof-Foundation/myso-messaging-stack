# MySo Messaging Chat — Reference Application

## 1. Overview

| Field       | Value          |
|-------------|----------------|
| **Version** | 1.0            |
| **Date**    | March 11, 2026 |
| **Network** | MySo Testnet    |

---

## 2. What This App Demonstrates

A fully functional chat application built on the MySo Groups SDK ecosystem, showcasing:

- **End-to-end encrypted group messaging** — Messages are encrypted client-side using AES-256-GCM with keys managed via [MyData](https://docs.mysocial.network/mysocial/mydata/overview) threshold encryption. Neither the relayer nor any intermediary ever sees plaintext.
- **On-chain permission management** — Group membership and fine-grained permissions (send, read, edit, delete, admin) are enforced on-chain via `@socialproof/myso-groups`, with the relayer and MyData key servers independently verifying permissions.
- **Atomic multi-step transactions** — The SDK's `call` layer composes multiple on-chain operations (e.g., remove member + rotate encryption key) into a single Programmable Transaction Block (PTB), guaranteeing atomicity.
- **Encrypted file attachments via File Storage** — Files are encrypted with the group's DEK and stored on [File Storage](https://docs.mysocial.network/mysocial/file-storage/overview) decentralized storage. Metadata (filename, MIME type, size) is encrypted separately.
- **MySocial Login** — Users authenticate with [`@socialproof/mysocial-auth`](https://www.npmjs.com/package/@socialproof/mysocial-auth) (popup). The app derives an in-memory Ed25519 keypair via the MySocial salt service (SHA256(sub + '_' + salt), first 32 bytes) so the messaging SDK can use Tier 1 session keys and sign PTBs without a browser wallet extension.
- **Real-time message delivery** — New messages appear automatically via HTTP polling with the SDK's `subscribe()` API.

**Tech stack:** React 19 · Vite · Tailwind CSS · @socialproof/mysocial-auth · @socialproof/myso

---

## 3. Motivation

This application serves as the canonical reference implementation for integrating three MySo SDKs:

| SDK                           | Purpose                                                      |
|-------------------------------|--------------------------------------------------------------|
| `@socialproof/myso-groups` | On-chain permission management for MySo objects               |
| `@socialproof/myso-messaging-stack`    | End-to-end encrypted group messaging                         |
| `messaging-sdk-relayer`       | Off-chain message storage and real-time delivery (Rust/Axum) |

The app provides working code for common integration patterns: **MySocial OAuth login**, salt-based key derivation, session key management, PTB composition, group discovery via GraphQL events, and File Storage file handling — making it easy for developers to understand how these components work together.

---

## 4. Features

### Sign-in & Authentication

| Feature                   | Description                                                                 | APIs / helpers                                      |
|---------------------------|-----------------------------------------------------------------------------|-----------------------------------------------------|
| MySocial Login            | Popup sign-in (`createMySocialAuth`, `signIn`); Sign out clears session       | `@socialproof/mysocial-auth`                         |
| Signing key derivation    | Bearer token → `POST` salt URL → `Ed25519Keypair.fromSecretKey(seed)`       | `deriveKeypairFromSaltService()` in `chat-app`       |
| SDK client initialization | `createMySoMessagingStackClient(MySoJsonRpcClient, …)` Tier 1 `sessionKey`   | `createMySoMessagingStackClient()`                   |

### Group Management

| Feature         | Description                                                 | SDK Method                        |
|-----------------|-------------------------------------------------------------|-----------------------------------|
| Create group    | Form with group name + optional initial members             | `messaging.createAndShareGroup()` |
| Discover groups | Sidebar showing user's groups via MySo GraphQL event queries | `MySoGraphQLClient.query()`        |
| Leave group     | Confirmation dialog, removes from local list                | `messaging.leave()`               |
| View members    | List all group members with their permissions               | `groups.view.getMembers()`        |

### Messaging

| Feature                | Description                                 | SDK Method                  |
|------------------------|---------------------------------------------|-----------------------------|
| Send text message      | Text input with Enter-to-send               | `messaging.sendMessage()`   |
| Read message history   | Paginated message display with "load older" | `messaging.getMessages()`   |
| Real-time subscription | Auto-poll for new messages                  | `messaging.subscribe()`     |
| Edit message           | Inline edit on own messages                 | `messaging.editMessage()`   |
| Delete message         | Delete with confirmation                    | `messaging.deleteMessage()` |

### Admin Controls

| Feature                  | Description                              | SDK Method                                           |
|--------------------------|------------------------------------------|------------------------------------------------------|
| Add members              | Address input + permission checkboxes    | `groups.grantPermissions()`                          |
| Remove members           | Per-member remove button                 | `groups.removeMember()`                              |
| Grant/revoke permissions | Toggle individual permissions per member | `groups.grantPermission()` / `revokePermission()`    |
| Rotate encryption key    | Single-button action                     | `messaging.rotateEncryptionKey()`                    |
| Atomic remove + rotate   | Remove member AND rotate key in one PTB  | `call.removeMember()` + `call.rotateEncryptionKey()` |
| Set group name           | Inline editable name                     | `messaging.setGroupName()`                           |
| Archive group            | Confirmation dialog                      | `messaging.archiveGroup()`                           |

### File Attachments (via File Storage)

| Feature               | Description                                      | SDK Method                         |
|-----------------------|--------------------------------------------------|------------------------------------|
| Send file attachments | File picker with preview (max 5MB, max 10 files) | `messaging.sendMessage({ files })` |
| Download attachments  | Download button with lazy decrypt                | `attachmentHandle.data()`          |
| Image preview         | Inline preview for image/* MIME types            | `attachmentHandle.data()`          |

### UX

| Feature             | Description                                                   |
|---------------------|---------------------------------------------------------------|
| Permission-aware UI | Controls hidden/disabled based on user's on-chain permissions |
| Error handling      | Inline error messages for SDK/relayer/transaction failures    |
| Loading states      | Spinners and disabled states during async operations          |
| Sync status badges  | SYNC_PENDING / SYNCED indicators on messages                  |
| Relative timestamps | Human-readable time display ("just now", "5m ago")            |
| Dark mode           | Full dark theme via Tailwind CSS                              |

---

## 5. Scope

This application is a focused reference implementation. It prioritizes demonstrating SDK integration patterns over being a production-ready chat product. The following are intentionally outside scope to keep the codebase clear and instructive:

- **User profiles / display names** — Truncated MySo addresses are used for identity
- **Custom MyData policies** — The app uses the SDK's default MyData configuration
- **Group handle registration** — `setGroupHandle` / `clearGroupHandle` exist in the SDK but are omitted in this demo UI

---

## 6. Architecture Overview

The app follows a 3-layer architecture:

### Layer 1 — Browser (React SPA)

- React 19 UI with Tailwind CSS styling
- `@socialproof/mysocial-auth` for Login with MySocial (popup session + salt-backed key derivation)
- Custom `MessagingClientProvider` that builds `MySoJsonRpcClient` + messaging stack extensions when the derived keypair is ready

### Layer 2 — SDK (in-browser, client-side)

- `MySoMessagingStackClient` — message encrypt/decrypt, send/receive, group lifecycle
- `MySoGroupsClient` — member and permission management
- `MyDataClient` — threshold encryption via MyData key servers
- `EnvelopeEncryption` — AES-256-GCM encryption of message payloads
- `HTTPRelayerTransport` — HTTP polling transport to the relayer
- `FileStorageHttpStorageAdapter` — file upload/download to File Storage

### Layer 3 — External Services

- `messaging-sdk-relayer` — Rust/Axum server for message storage, auth, and archival
- MyData Key Servers — threshold key shares for DEK encryption/decryption
- File Storage Publisher/Aggregator — decentralized file storage for attachments
- MySo Full Node (Testnet) — RPC for on-chain operations

### Key Architectural Decisions

- **Group discovery via MySo GraphQL** — query `MemberAdded`/`MemberRemoved` events from the indexer, cached in localStorage for instant sidebar rendering
- **Tier 1 session keys** — `encryption.sessionKey: { signer }` passes the derived `Ed25519Keypair` to the SDK (`SessionKey` + certificate flow is fully signer-driven)
- **Atomic PTBs via SDK `call` layer** — composed admin operations in single transactions
- **Distributed state** — React component state + localStorage caching (no centralized store needed)

---

## 7. Dependencies

### SDK Dependencies

| Dependency                    | Version   | Purpose                 |
|-------------------------------|-----------|-------------------------|
| `@socialproof/myso-messaging-stack`    | workspace | E2E encrypted messaging |
| `@socialproof/myso-groups` | workspace | Permission management   |
| `@socialproof/mysocial-auth`         | npm       | MySocial OAuth + session APIs    |
| `@socialproof/myso`                 | ^0.x      | MySo RPC (`MySoJsonRpcClient`) |
| `@socialproof/mydata`               | ^0.x      | Threshold encryption           |

### Application Dependencies

| Dependency     | Version | Purpose                 |
|----------------|---------|-------------------------|
| React          | ^19     | UI framework            |
| Vite           | ^6      | Build tool              |
| Tailwind CSS   | ^4      | Styling                 |
| TanStack Query | ^5      | Server state management |

### Infrastructure

| Service                    | Purpose                                           |
|----------------------------|---------------------------------------------------|
| messaging-sdk-relayer      | Message storage and authenticated delivery        |
| MySo Testnet                | On-chain operations (group creation, permissions) |
| MyData Key Servers (testnet) | Threshold key shares for DEK management           |
| File Storage Testnet             | Decentralized file storage for attachments        |

---

## 8. Troubleshooting

### "Missing MySocial auth env" but `.env` looks correct

- **`pnpm dev`**: Restart the dev server after editing `.env` (Vite reads env when the server starts).
- **`pnpm preview`**: The preview server only serves **`dist/`** from your last **`pnpm build`**. Env vars are inlined when that bundle was built — **not** from `.env` at preview runtime. Edit `.env`, then run **`pnpm build`** again, then `pnpm preview`.

`VITE_MYSOCIAL_AUTH_API_BASE_URL` must be the **MySocial API** host (see [@socialproof/mysocial-auth](https://www.npmjs.com/package/@socialproof/mysocial-auth)), **not** the salt URL (`VITE_MYSOCIAL_SALT_URL` is separate).

### Messaging client init fails: `Version` not found (`GraphQL found 0 and RPC publish-tx lookup found 0`)

The `0xe110::version::Version` shared object was never created at genesis. GraphQL may show `MessagingNamespace` but `version.nodes` is empty. Rebuild myso from **myso-core** (after the `version::share_initial` change in `messaging.init`), then force-regenesis.

**1. Rebuild binaries**

```bash
cd ../myso-mydata && cargo build -p key-server -p mydata-cli
cd ../myso-core && cargo build -p myso
```

**2. Reset indexer (after prior regenesis)**

```bash
cd ../myso-core
cargo run --bin myso-indexer-alt -- reset-database \
  --database-url postgresql://postgres@localhost:5432/sui_indexer
```

**3. Force regenesis**

```bash
cargo run --bin myso -- start --with-faucet --force-regenesis \
  --with-indexer=postgresql://postgres@localhost:5432/sui_indexer \
  --with-social-indexer --with-mydata --with-graphql
```

**4. Verify genesis singletons** (`http://localhost:9125/graphql`)

```graphql
query VerifyGenesisSingletons {
  version: objects(filter: { type: "0xe110::version::Version", ownerKind: SHARED }, first: 1) {
    nodes { address }
  }
  namespace: objects(filter: { type: "0xe110::messaging::MessagingNamespace", ownerKind: SHARED }, first: 1) {
    nodes { address }
  }
}
```

`version.nodes` and `namespace.nodes` must each have length **1**.

**5. Refresh chat-app**

- Copy new `KEY_SERVER_OBJECT_ID` into `VITE_MYDATA_KEY_SERVER_OBJECT_IDS`
- `pnpm run build:deps && pnpm dev`
- `myso client faucet --address <signer>`

### Create group fails with `Failed to fetch` / `ERR_CONNECTION_REFUSED` on port 2024 (localnet)

Group creation encrypts the group DEK via **MyData key servers**. On localnet, `myso start --with-mydata` registers a key server at `http://127.0.0.1:2024`.

1. Start localnet with MyData enabled, for example:
   `myso start --with-faucet --force-regenesis --with-mydata --with-graphql`
2. Copy the **parent** `KEY_SERVER_OBJECT_ID` from the startup log into `VITE_MYDATA_KEY_SERVER_OBJECT_IDS`.
   Verify with `myso client object <id>` — the type must be `key_server::KeyServer`, **not** `dynamic_field::Field<…KeyServerV1>`.
3. Set `VITE_MYDATA_THRESHOLD=1` (localnet bootstraps a single key server; the SDK default is 2).
4. Confirm the key server is listening:
   `curl "http://127.0.0.1:2024/v1/service?service_id=<KEY_SERVER_OBJECT_ID>"`
5. If startup logs show `Duplicate key server object ID`, rebuild/restart `myso` from a version that merges social + messaging into one key-server config entry.

### Create group fails after `--force-regenesis` (stale env, SDK version, or ghost objects)

After regenesis, genesis singleton IDs and the MyData key server object ID change. Update `chat-app/.env` from the latest `myso start` output, **restart `pnpm dev`**, and fund your dev signer again (`myso client faucet <address>`).

- **Console diagnostics (dev):** Create Group logs `[chat-app] mydata key servers`, `[chat-app] signer gas`, and `[chat-app] create-group tx inputs` before signing.
- **`DeprecatedSDKVersionError`:** Rebuild `myso` so generated `key-server-config.yaml` sets `ts_sdk_version_requirement: '>=0.0.5'` (matches `@socialproof/mydata` in this app). Regenesis and restart localnet.
- **Object `does not exist` with a derived-looking ID:** You likely set `VITE_MYDATA_KEY_SERVER_OBJECT_IDS` to the Field child instead of the parent `KeyServer` object.
- **Stale gas coin from `listCoins`:** The app resolves gas via RPC-verified coins before sign; compare `myso client gas` with `[chat-app] signer gas` in the console.
- **`InvalidKeyServerError`:** On-chain registered public key did not match the running key-server HTTP key. Rebuild `myso` from myso-core (uses `gen-seed` + `derive-key --index 0`), regenesis, and verify `PUBLIC_KEY` in `myso start` output equals `Client "local_key_server" uses public key` in key-server logs.

### Localnet replication checklist (after myso-core MyData fix)

1. **Build myso-mydata binaries** (sibling repo):
   ```bash
   cd ../myso-mydata && cargo build -p key-server -p mydata-cli
   ```
2. **Build myso** from myso-core:
   ```bash
   cd ../myso-core && cargo build -p myso
   ```
3. **Reset main indexer DB** (after prior regenesis):
   ```bash
   cargo run --bin myso-indexer-alt -- reset-database \
     --database-url postgresql://postgres@localhost:5432/sui_indexer
   ```
4. **Start localnet** (from myso-core):
   ```bash
   cargo run --bin myso -- start --with-faucet --force-regenesis \
     --with-indexer=postgres://postgres@localhost:5432/sui_indexer \
     --with-social-indexer --with-mydata --with-graphql
   ```
5. **Verify key alignment** in startup logs — these must match:
   - `PUBLIC_KEY=0x…` from `MyData key server (local):`
   - `Client "local_key_server" uses public key: "0x…"` from key-server
6. **Update chat-app `.env`:**
   - `VITE_MYDATA_KEY_SERVER_OBJECT_IDS=<KEY_SERVER_OBJECT_ID from step 4>`
   - `VITE_MYDATA_THRESHOLD=1`
7. **Restart chat-app:** `pnpm dev` (Vite reads `.env` at server start).
8. **Fund dev signer** (address shown in `[chat-app] signer gas` or app banner):
   ```bash
   myso client faucet --address <your-signer-address>
   ```
9. **Create Group** — console should show `[mydata] rpc ok (parent KeyServer)` and no `InvalidKeyServerError`.

Optional HTTP check:
```bash
curl -H "Client-Sdk-Version: 0.0.4" \
  "http://127.0.0.1:2024/v1/service?service_id=<KEY_SERVER_OBJECT_ID>"
```

---

## 8. Agent messaging and paid DMs

| Env var | Purpose |
|---------|---------|
| `VITE_SOCIAL_SERVER_URL` | Enables paid policy gating + sidebar **Paid messaging** panel |
| `VITE_ENABLE_AGENT_DEV=true` | Shows dev agent send panel in chat |
| `VITE_AGENT_SUB_AGENT_ID` | Sub-agent object id (dev panel) |
| `VITE_AGENT_SECRET_KEY` | Agent Ed25519 secret key hex (dev panel) |
| `VITE_AGENT_PLATFORM_ID` | Platform shared object id |
| `VITE_AGENT_MEMORY_ACCOUNT_ID` | Principal MemoryAccount id |

The sidebar lists **Agent conversations** from relayer `GET /v1/agent-conversations` (wallet auth). Agent messages show an **Agent** badge when relayer attribution is present.

Relayer env for indexing: `MESSAGING_PACKAGE_ID` (default genesis `0xe110`), optional `ATTRIBUTION_STRICT_VERIFY` + `MYSO_JSON_RPC_URL`.

See [AgentMessaging.md](../docs/myso-messaging-stack/AgentMessaging.md) and [PaidMessaging.md](../docs/myso-messaging-stack/PaidMessaging.md).

---

## 9. References

| Resource             | Link                                                                                                                      |
|----------------------|---------------------------------------------------------------------------------------------------------------------------|
| Groups SDK source    | [permissioned-groups](../ts-sdks/packages/permissioned-groups), [messaging-groups](../ts-sdks/packages/messaging-groups/) |
| System Design doc    | [SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)                                                                               |
| @socialproof/mysocial-auth | https://www.npmjs.com/package/@socialproof/mysocial-auth |
| MySo TypeScript SDK   | https://docs.mysocial.network.mysocialtypescript                                                                                     |
| File Storage Documentation | https://docs.mysocial.network/mysocial/file-storage.overviewapp                                                                                                  |
| MyData Documentation   | https://docs.mysocial.network/mysocial/mydata/overview.com                                                                                          |
