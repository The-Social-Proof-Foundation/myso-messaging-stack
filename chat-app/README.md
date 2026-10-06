# MySocial Messaging — Reference Application

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
| Create / New Message | Recipient picker (following, search, wallet paste → chips); full-width Create; paid 1:1 escrow when required | `messaging.createAndShareGroup()` / paid DM path |
| Discover groups | Sidebar showing user's groups via MySo GraphQL event queries | `MySoGraphQLClient.query()`        |
| Leave group     | Confirmation dialog, removes from local list                | `messaging.leave()`               |
| View members    | List all group members with their permissions               | `groups.view.getMembers()`        |

### Messaging

| Feature                | Description                                              | SDK Method                                        |
|------------------------|----------------------------------------------------------|---------------------------------------------------|
| Send text message      | Text input with Enter-to-send                            | `messaging.sendMessage()`                          |
| Read message history   | Paginated message display with "load older"              | `messaging.getMessages()`                          |
| Real-time subscription | Live messages + reaction updates (WS, polling fallback)  | `messaging.subscribe()`                            |
| Away when unfocused    | Mark-read / push-suppress / typing require visible+focused (`usePageEngaged`); peer Online follows tab visibility only (`usePageVisible`) — Offline on other browser tab, stay Online when switching to another OS app with the chat tab open | `usePageEngaged` / `usePageVisible` |
| Show online in this chat | Per-conversation toggle in Chat Details (default on); when off, peers see you Offline in that chat only (`hide_online_presence`) | `getConversationPrefs` / `putConversationPrefs` |
| Edit message           | Inline edit on own messages                              | `messaging.editMessage()`                          |
| Delete message         | Delete with confirmation                                 | `messaging.deleteMessage()`                        |
| React to message       | Left-click a bubble for the emoji picker; click chips to toggle | `messaging.addReaction()` / `removeReaction()` |

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
- **Distributed state** — React component state + localStorage caching for group metadata (no centralized store needed)
- **In-session message plaintext cache** — decrypted threads stay in a RAM-only module Map for the tab session (stale-while-revalidate on group switch). Never written to disk; cleared when the messaging client tears down on logout. Attachment bytes are not cached.

---

## 7. Dependencies

### SDK Dependencies

| Dependency                    | Version   | Purpose                 |
|-------------------------------|-----------|-------------------------|
| `@socialproof/myso-messaging-stack`    | ^0.0.6 | E2E encrypted messaging |
| `@socialproof/myso-groups` | ^0.0.1 | Permission management   |
| `@socialproof/mysocial-auth`         | npm       | MySocial OAuth + session APIs    |
| `@socialproof/myso`                 | ^0.x      | MySo RPC (`MySoJsonRpcClient`) |
| `@socialproof/mydata`               | ^0.x      | Threshold encryption           |
| `@socialproof/memory`               | ^0.0.5    | Agent memory client (`/api/remember`, `/api/recall`, signed requests) |

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

`VITE_MYSOCIAL_AUTH_API_BASE_URL` must be the **salt service origin** (e.g. `https://salt.testnet.mysocial.network`) — the SDK calls `/auth/refresh` and `/auth/logout` there. `VITE_MYSOCIAL_SALT_URL` is the full `/salt` path for keypair derivation and stays separate. `VITE_MYSOCIAL_AUTH_ORIGIN` is the auth frontend (e.g. `https://auth.testnet.mysocial.network`).

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
- `pnpm install && pnpm dev`
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
| `VITE_SOCIAL_SERVER_URL` | Loads paid policy in the sidebar panel, DM block pre-check, and relayer paid-DM gate lookups |
| `VITE_MYSO_RPC_URL` | MySo JSON-RPC for on-chain writes (Save policy, create group). Localnet dev auto-proxies via `/api/rpc` |
| `VITE_ENABLE_AGENT_DEV=true` | Shows dev agent send panel in chat |
| `VITE_AGENT_SUB_AGENT_ID` | Sub-agent object id (dev panel) |
| `VITE_AGENT_SECRET_KEY` | Agent Ed25519 secret key hex (dev panel) |
| `VITE_AGENT_PLATFORM_ID` | Platform shared object id (agent send panel only) |
| `VITE_PLATFORM_ID` | Optional platform shared object id for paid-DM escrow claims; routes platform fees to `Platform.treasury` instead of ecosystem treasury |
| `VITE_AGENT_MEMORY_ACCOUNT_ID` | Principal (human parent) MemoryAccount object id — created once per human with profile; sub-agents are registered on this account via `register_sub_agent` and do not have their own |

**Platform vs ecosystem treasury (paid-DM claims):** When a peer opens a paid DM and you reply to claim escrow, the on-chain settlement splits fees per `MessagingConfig` BPS. Without `VITE_PLATFORM_ID`, the app uses `reply_to_paid_message_claim_settled` and both fee slices route to the ecosystem treasury wallet (`0x0` sentinel). With `VITE_PLATFORM_ID` set to a shared `Platform` object address, claims use `reply_to_paid_message_claim_settled_with_platform` and the platform fee slice credits `Platform.treasury` on-chain. `VITE_AGENT_PLATFORM_ID` is separate — it scopes agent message sends, not claim settlement.

**Localnet ports** (typical `myso start --with-graphql --with-social-indexer --with-mydata`):

| Port | Service |
|------|---------|
| 9125 | GraphQL (`VITE_MYSO_GRAPHQL_URL`) |
| 9126 | Social server (`VITE_SOCIAL_SERVER_URL`) |
| 9001 | JSON-RPC (`VITE_MYSO_RPC_URL`; browser uses `/api/rpc` proxy in dev) |
| 2024 | MyData key server HTTP |
| 3003 | Relayer (`VITE_RELAYER_URL`) |
| 8000 | Memory server (`VITE_MEMORY_SERVER_URL`) |

### Paid messaging panel shows `Failed to fetch`

1. **Policy load** uses the social server when `VITE_SOCIAL_SERVER_URL` is set (recommended). Confirm `myso start` includes `--with-social-indexer` and the URL matches port **9126**.
2. **Save policy** submits an on-chain PTB and needs JSON-RPC. Set `VITE_MYSO_RPC_URL` to your local fullnode URL (e.g. `http://127.0.0.1:9001`); in dev the app routes browser RPC through `/api/rpc` automatically. Restart `pnpm dev` after editing `.env`.
3. Verify `VITE_MYSO_RPC_URL` responds (not `401 Unauthorized`):

```bash
curl -s -X POST "${VITE_MYSO_RPC_URL:-http://127.0.0.1:9001}" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"myso_getLatestCheckpointSequenceNumber","params":[]}'
```

Expect a JSON-RPC `result`. If you get `401`, restart or reconfigure localnet JSON-RPC (see `myso client envs` / `myso start` logs). After Save, indexed policy may lag a few seconds until `PaidMessagingPolicyUpdated` is indexed.

The sidebar lists **Agent conversations** from relayer `GET /v1/agent-conversations` (wallet auth). Agent messages show an **Agent** badge when relayer attribution is present.

Relayer env for indexing: `MESSAGING_PACKAGE_ID` (default genesis `0xe110`), optional `ATTRIBUTION_STRICT_VERIFY` + `MYSO_JSON_RPC_URL`.

See [AgentMessaging.md](../docs/myso-messaging-stack/AgentMessaging.md) and [PaidMessaging.md](../docs/myso-messaging-stack/PaidMessaging.md).

---

## 9. Agents workspace

`/agents` is the **configuration** workspace: AI credit balance, organizations, and agents
(tabs `Overview` / `Organizations` / `Agents`, selectable with `?tab=`). Agent **chats** do
not live here.

Agent conversations live in the **home sidebar**:

- A button at the **top** of the conversation list ("Agents & Organizations") swaps the list
  into a list of every organization and its agents; a back button returns to the human chat
  list.
- **An agent row is its chat row.** Clicking an agent opens its conversation — an on-chain
  `PermissionedGroup<Messaging>` rendered by the same `ChatArea` as every other chat. There is
  deliberately **one chat view**, so there is never a question of which surface you are in.
- An agent with no chat yet shows a small start state in the main pane with a single
  **Start chat** action.
- **Ask its memory** (the brain icon on an agent row) opens the memory ask/remember dialog.
  It is a dialog rather than a second full-height conversation view for the same reason.
- Creating is done from dialogs: **New** in the sidebar agents header, the Agents tab, or the
  Organizations tab all open a modal form.
- `/agents → Agents → Chat` hands the agent over to the home view via router state.

Agent signing keys are random 32-byte Ed25519 seeds generated in the browser. Each seed is
encrypted under a random per-account recovery root, and only encrypted wraps of that root ever
reach a server. The root is unlocked through a **custody tier**: a WebAuthn PRF passkey
(`passkey-prf-v1`), the salt-derived login key (`zklogin-root-v1`), the login key plus a
user-held recovery code (`recovery-code-v1`), or a device-only key with no server-side wrap
(`device-key-v1`). Passkeys are therefore an optional upgrade, not a requirement. See
`docs/agent-custody-tiers-plan.md` and the memory-repo `docs/security/agent-key-backups.md`.

Deterministic derivation (`sha256("mysocial-agent-v1" || human secret || org id || u32 index)`)
is retired and retained only for explicit migration tooling — see
`src/lib/agents/legacy-agent-keys.ts`.

### Agent chat lifecycle

Before any of the on-chain steps below, the app must be able to **unlock agent keys**: creating,
chatting as, and asking the memory of an agent all require the agent's signing seed, which is
stored only as an encrypted envelope. The unlock is a custody tier (passkey, login key, or login
key plus a recovery code) — a passkey is not required. When no root exists yet the app asks which
tier to adopt. The seed is never persisted: the vault locks after 15 minutes idle, on logout, and
on any 401 from the Memory server.

Creating an agent chat requires three things, all enforced on chain:

1. **`CAP_MESSAGE_SEND` (64)** on the registered sub-agent. The `Chat assistant` preset does
   not include it — the UI offers "Enable messaging", which adds `MESSAGE_SEND` +
   `MESSAGE_READ` via `update_sub_agent`.
2. **The agent key must sign.** `create_agent_and_share_group` asserts
   `actor_address == ctx.sender()`, so there is no human-signed path that attributes to an
   agent. Derived agent addresses hold no MYSO, so gas comes from the human as gas owner
   (the same `executeAsAgent` path used by child-agent registration).
3. **`platform::has_joined_platform(platform, principal)`** — the human owner must belong to
   an approved `Platform`. This is an on-chain precondition of
   `create_agent_and_share_group`, not a product choice, so it is **never a user-facing
   step**: approved platforms are discovered from the indexer
   (`platforms(approvedOnly: true)`), membership is read with `platformUserAccess`, and the
   join transaction is sent automatically as the first stage of starting a chat.
   `VITE_PLATFORM_ID` remains an optional override and is not required.

4. **The owner must be able to send.** `create_agent_and_share_group` grants the human
   principal only `MessagingReader` + `PermissionsAdmin`, so an agent chat is readable but
   *not writable* until someone grants `MessagingSender`. The app does it automatically: the
   grant is sent as the final stage of starting a chat, and opening an existing agent chat
   repairs it once per session. Because the principal holds `PermissionsAdmin`, they can grant
   it to themselves — no other party is involved.

The association is **on-chain group metadata** written by `attach_agent_creator_metadata`:
`agent_chat="true"`, `creator_actor`, `creator_principal`, `creator_sub_agent_id`,
`creator_identity_class`. `organization_id` is event-only, so it is recovered by mapping
`creator_sub_agent_id` onto the sub-agent rows.

**Discovery is device-independent.** `MemberAdded` fires for the human principal (granting a
permission adds the member), so agent groups arrive through the normal group-discovery path;
`groupsMetadata` then classifies them. Three sources are merged and de-duplicated by group
id: chain metadata (authoritative, self-healing), the social indexer's
`/organizations/:id/messaging-groups` (watermark-resumable), and the relayer's
`/v1/agent-conversations` (insert-only, no backfill, so never the sole source).

Reload, a second browser, or a relayer restart therefore all reproduce the same list with no
session storage involved. Opening a chat hydrates the local group store from
`groupsMetadata` before selecting, because selecting a group absent from the store is a
no-op.

Readiness waits on **`MessagingReader`**, not `MessagingSender`: the principal of an agent
group is granted `MessagingReader` + `PermissionsAdmin`, and the agent's admin caps are
revoked in the same transaction.

### Pagination

Every list read goes through `src/lib/pagination.ts`. The social server clamps `limit` to 100
and reports `total_count` on the organization and sub-agent endpoints, so lists page with
`limit` + `offset` instead of silently truncating:

| Behaviour | Where |
|---|---|
| Stops on empty page, short page, or when `total_count` is reached | `collectAllPages` / `nextPageRequest` |
| De-duplicates rows across page boundaries | `flattenPages` |
| Stops on a full page that adds nothing new (no infinite loop) | `reason: 'no-progress'` |
| Hard page ceiling (50) | `DEFAULT_MAX_PAGES` |
| A later page failing keeps the rows already fetched and shows the error | `partialError` |
| Endpoints without `offset` support degrade to an explicit "first N" state | `pagingSupported: false` |

Servers older than the pagination fix reject numeric query params outright
(`#[serde(flatten)]` made `serde_urlencoded` buffer them as strings). `social-api.ts` detects
that specific 400, retries once with only the pagination params removed (filters such as
`active_only` are preserved), and reports the list as partial — so the app works against both
patched and unpatched social servers rather than failing outright.

### Chat-app env

| Env var | Purpose |
|---------|---------|
| `VITE_MEMORY_SERVER_URL` | myso-memory server (default `http://127.0.0.1:8000`). Dev traffic goes through the Vite `/api/memory` proxy. |
| `VITE_SOCIAL_SERVER_URL` | Social server for memory-account, AI-credit, org, sub-agent, and messaging-group reads. |
| `VITE_PLATFORM_ID` | Optional. Overrides the auto-discovered Platform used for agent chats. |
| `VITE_AGENT_KEY_BACKUPS_ENABLED` | `true` to enable agent-key custody (off by default). Also injects the vault CSP in production builds. |
| `VITE_AGENT_CUSTODY_TIERS` | Optional comma list overriding the server's advertised tiers (`passkey-prf-v1`, `zklogin-root-v1`, `recovery-code-v1`). Leave unset to trust `GET /config`. |
| `VITE_PASSKEY_CONNECT_ORIGINS` | Optional exact MYDATA key-server/websocket origins added to the production vault CSP. |

### Server prerequisites

The agent memory chat talks to the myso-memory server (`myso-memory/services/server`, default
port 8000). Set these on the memory server:

| Memory server env | Value |
|-------------------|-------|
| `ALLOWED_ORIGINS` | Must include the chat-app origin (e.g. `http://localhost:5173`) for production builds. In `pnpm dev` the browser goes through the `/api/memory` proxy, so CORS is not involved. |
| `AI_CREDIT_ENABLED` | `true`, so `/api/ask` reserves and captures AI credits for each reply. |
| `AI_CREDIT_ORACLE_URL` | The AI credit oracle (localnet default `http://127.0.0.1:8095`), plus `AI_CREDIT_ORACLE_API_SECRET`. |
| `SOCIAL_SERVER_URL` | The local social server (`http://127.0.0.1:9126`), used to resolve the signing agent. |
| `ENABLE_AGENT_KEY_BACKUPS` | `true` to enable agent-key custody routes and the `agentKeyBackups` config flag. |
| `AGENT_KEY_CUSTODY_TIERS` | Comma list of accepted custody methods. `AGENT_KEY_CUSTODY_TIERS=passkey-prf-v1` keeps the passkey-only posture. |
| `AGENT_KEY_REQUIRE_TIER` | Optional minimum tier; a weaker unlock is refused with `custody_tier_required`. |
| `AGENT_KEY_UNLOCK_PER_MINUTE` | Per-account custody unlock/challenge attempts per minute (default 10). |
| `PASSKEY_RP_ID` / `PASSKEY_ALLOWED_ORIGINS` | Required only when the `passkey-prf-v1` tier is enabled; exact RP ID and exact HTTPS origins. |
| `KEY_BACKUP_SERVICE_ORIGIN` | Exact origin bound into owner challenges; required when backups are enabled. |
| `SIDECAR_AUTH_TOKEN` | Shared secret for the private verification sidecar. |

### Local run order

1. Localnet with social indexer, GraphQL, and MyData (`myso start --with-faucet --with-social-indexer --with-mydata --with-graphql`).
2. AI credit oracle.
3. myso-memory server (`AI_CREDIT_ENABLED=true`, `SOCIAL_SERVER_URL` pointing at the social server).
4. Relayer (for agent conversations and message delivery).
5. `pnpm dev` in `chat-app`.

### Permissions model

- Root agents are registered on an `AgenticOrganization` and signed by the human owner.
- Child agents are registered with `register_sub_agent_delegated`, signed by the parent agent's derived key (`CAP_AGENT_REGISTER`).
- Chat needs `MEMORY_READ`, `MEMORY_WRITE`, and `AI_SPEND`. Messenger adds message caps; Manager adds agent and budget caps.
- Agent messaging groups additionally need `CAP_MESSAGE_SEND` and a joined Platform (see above).
- Shared org memory requires `ensure_org_memory_group` plus an `OrgMemoryWriter` grant. Remember defaults to private visibility unless that grant exists.
- Governance voting is not available to agents: the contract checks the signing wallet, not the agent object.

### Organization permissions

Organization permissions (`ORG_PERM_*`) live on the organization's memory-share group and are
what the social server's dashboard routes read. **Nothing grants them implicitly — not even to
the creator** — so `create_agentic_organization` alone leaves the owner unable to read their own
dashboard. The app handles this two ways:

- Enabling shared memory also grants the owner the full mask (memory read/write, agent manager,
  budget manager, spend approver, dashboard viewer, auditor) in a follow-up transaction.
- If a dashboard read still returns 403, the dashboard shows a **Grant dashboard access**
  callout that sends the same grant for the group the organization already has.

### Organization dashboard

`/agents → Organizations` is a full dashboard, and every section is an independent paged
query so one failing read cannot blank the rest:

| Section | Endpoint | Auth |
|---|---|---|
| Agents | `/profiles/:addr/sub-agents` (complete walk, filtered by org) | none |
| Agent chats | `/organizations/:id/messaging-groups` | none |
| Memory permissions | `/organizations/:id/memory-permissions` | wallet + dashboard access |
| Roles | `/organizations/:id/roles` | wallet + dashboard access |
| Role assignments | `/organizations/:id/role-assignments` | wallet + dashboard access |
| Invitations | `/organizations/:id/invitations` | wallet + dashboard access |
| Spend approvals | `/organizations/:id/approvals` | wallet + dashboard access |
| Spend breakdown | `/organizations/:id/spend-breakdown` | wallet + dashboard access |
| Audit log | `/organizations/:id/audit-logs` | wallet + **auditor** access |

`member`, `active_only`, `invitee`, `status`, `agent`, `window`, `action`, and `actor` filters
are sent to the server rather than applied in the browser. A 403 on the audit log renders as
"auditor access required", distinct from a generic failure.

---

## 10. References

| Resource             | Link                                                                                                                      |
|----------------------|---------------------------------------------------------------------------------------------------------------------------|
| Groups SDK source    | [permissioned-groups](../ts-sdks/packages/permissioned-groups), [messaging-groups](../ts-sdks/packages/messaging-groups/) |
| System Design doc    | [SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)                                                                               |
| @socialproof/mysocial-auth | https://www.npmjs.com/package/@socialproof/mysocial-auth |
| MySo TypeScript SDK   | https://docs.mysocial.network.mysocialtypescript                                                                                     |
| File Storage Documentation | https://docs.mysocial.network/mysocial/file-storage.overviewapp                                                                                                  |
| MyData Documentation   | https://docs.mysocial.network/mysocial/mydata/overview.com                                                                                          |
