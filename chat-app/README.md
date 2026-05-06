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
- **Wallet-based authentication** — No usernames or passwords. Users authenticate with their MySo wallet via `@socialproof/dapp-kit`.
- **Real-time message delivery** — New messages appear automatically via HTTP polling with the SDK's `subscribe()` API.

**Tech stack:** React 19 · Vite · Tailwind CSS · @socialproof/dapp-kit

---

## 3. Motivation

This application serves as the canonical reference implementation for integrating three MySo SDKs:

| SDK                           | Purpose                                                      |
|-------------------------------|--------------------------------------------------------------|
| `@socialproof/myso-groups` | On-chain permission management for MySo objects               |
| `@socialproof/myso-messaging-stack`    | End-to-end encrypted group messaging                         |
| `messaging-sdk-relayer`       | Off-chain message storage and real-time delivery (Rust/Axum) |

The app provides working code for common integration patterns: wallet setup, session key management, PTB composition, group discovery via GraphQL events, and File Storage file handling — making it easy for developers to understand how these components work together.

---

## 4. Features

### Wallet & Authentication

| Feature                   | Description                                           | SDK Method                      |
|---------------------------|-------------------------------------------------------|---------------------------------|
| Wallet connection         | Connect/disconnect via @socialproof/dapp-kit ConnectButton | `useCurrentAccount()`           |
| SDK client initialization | Create MySoMessagingStackClient from wallet signer       | `createMySoMessagingStackClient()` |

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
- **MySoNS integration** — Supported by the SDK but omitted for simplicity

---

## 6. Architecture Overview

The app follows a 3-layer architecture:

### Layer 1 — Browser (React SPA)

- React 19 UI with Tailwind CSS styling
- @socialproof/dapp-kit for MySo wallet integration (ConnectButton, useCurrentAccount, useSignPersonalMessage)
- Custom `MessagingClientProvider` context that creates and memoizes the SDK client

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
- **Tier 2 session keys** — dapp-kit's `signPersonalMessage` feeds the SDK callback config
- **Atomic PTBs via SDK `call` layer** — composed admin operations in single transactions
- **Distributed state** — React component state + localStorage caching (no centralized store needed)

---

## 7. Dependencies

### SDK Dependencies

| Dependency                    | Version   | Purpose                 |
|-------------------------------|-----------|-------------------------|
| `@socialproof/myso-messaging-stack`    | workspace | E2E encrypted messaging |
| `@socialproof/myso-groups` | workspace | Permission management   |
| `@socialproof/dapp-kit`            | ^0.x      | Wallet adapter          |
| `@socialproof/myso`                 | ^2.6      | MySo RPC client          |
| `@socialproof/mydata`                | ^1.1      | Threshold encryption    |

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

## 8. References

| Resource             | Link                                                                                                                      |
|----------------------|---------------------------------------------------------------------------------------------------------------------------|
| Groups SDK source    | [permissioned-groups](../ts-sdks/packages/permissioned-groups), [messaging-groups](../ts-sdks/packages/messaging-groups/) |
| System Design doc    | [SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)                                                                               |
| @socialproof/dapp-kit     | https://docs.mysocial.network.mysocialdapp-kit                                                                                       |
| MySo TypeScript SDK   | https://docs.mysocial.network.mysocialtypescript                                                                                     |
| File Storage Documentation | https://docs.mysocial.network/mysocial/file-storage.overviewapp                                                                                                  |
| MyData Documentation   | https://docs.mysocial.network/mysocial/mydata/overview.com                                                                                          |
