# Testing

## Contents

- [SDK Tests](#sdk-tests)
  - [Unit Tests](#unit-tests)
  - [Integration Tests (Localnet)](#integration-tests-localnet)
  - [E2E Tests (Testnet)](#e2e-tests-testnet)
- [Relayer Tests](#relayer-tests)
- [Move Contract Tests](#move-contract-tests)

---

## SDK Tests

All commands run from `ts-sdks/packages/myso-messaging-stack/`:

```bash
# Unit tests + type checking
pnpm test

# Unit tests only
pnpm test:unit

# Type checking only
pnpm test:typecheck
```

### Unit Tests

Unit tests use Vitest with mocked dependencies (MyDataClient, StorageAdapter, MySoClient). No network access required.

Coverage includes:
- Envelope encryption (encrypt/decrypt, AAD, nonce handling)
- DEK manager (generation, caching, TTL)
- Session key manager (tier 1/2/3 flows)
- MyData policy (default policy, identity encoding)
- Sender verification (signature creation and validation)
- Attachments manager (upload, resolve, validation, edit flow)
- File Storage HTTP storage adapter (upload/download, error handling)
- HTTP transport (request signing, header construction)
- Derive (UUID to object ID derivation)
- TTL map (expiry, lazy eviction)
- Client (method delegation, error handling)

### Integration Tests (Localnet)

On-chain tests against a local MySo node. No relayer required. Uses testcontainers to spin up MySo localnet and publishes Move packages automatically.

```bash
pnpm test:integration
```

Requires Docker. The setup bootstraps a local MySo node, funds an admin account, and publishes both `myso_groups` and `messaging` packages.

Coverage includes:
- Group creation, sharing, and configuration
- Metadata operations (set name, insert/remove data)
- View methods (membership, permissions, encryption history)
- Archive flow (pause + burn UnpauseCap)
- Paid join rule (example app integration)
- Custom MyData policy (example app integration)

### E2E Tests (Testnet)

Full end-to-end tests against MySo testnet with a live relayer. Tests the complete flow including encryption, relayer communication, File Storage archival, and message recovery.

```bash
# Run against testnet (default)
pnpm test:e2e

# Explicitly specify testnet
pnpm test:e2e:testnet
```

**Required environment variables:**

| Variable | Description |
|----------|-------------|
| `TEST_WALLET_PRIVATE_KEY` | Funded testnet wallet (`mysoprivkey1...`) |

**Optional environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MYSO_RPC_URL` | testnet fullnode | MySo RPC endpoint |
| `RELAYER_URL` | (starts container) | Pre-deployed relayer URL |
| `INDEXER_URL` | (starts container) | Pre-deployed indexer URL |
| `MYDATA_KEY_SERVERS` | testnet defaults | Comma-separated MyData key server IDs |
| `MYDATA_THRESHOLD` | 2 | MyData threshold |
| `FILE_STORAGE_PUBLISHER_MYSO_ADDRESS` | (none) | File Storage publisher filter for indexer |

Coverage includes:
- Message CRUD (send, get, edit, delete)
- Pagination and edge cases
- Multi-group messaging
- Permission-specific access control
- Encryption (key rotation, multi-version decrypt)
- File Storage sync (archival lifecycle)
- Recovery transport (message recovery from File Storage)
- Load testing

## Relayer Tests

All commands run from `relayer/`:

```bash
# All tests (unit + integration, no network required)
cargo test

# Specific test mysote
cargo test --test auth_integration_test
cargo test --test membership_sync_test
cargo test --test file_storage_sync_test

# File Storage integration tests (requires testnet access, ignored by default)
cargo test --test file_storage_integration_test -- --ignored
```

| Test MySote | What It Covers |
|-----------|----------------|
| `auth_integration_test` | Full auth pipeline for all 3 signature schemes, permission checks, replay protection, ownership enforcement |
| `membership_sync_test` | gRPC event subscription, membership cache updates, event parsing (uses mock gRPC server) |
| `file_storage_sync_test` | Background sync lifecycle, batching, status transitions, cross-group batching (uses wiremock) |
| `file_storage_integration_test` | File Storage HTTP client against real testnet (ignored in CI) |

See the [relayer README](../../relayer/README.md) for detailed test descriptions.

## Move Contract Tests

Use the **MySo CLI** for this repo (`myso move build`, `myso move test`), not `sui move`.

Run from `move/packages/messaging/`:

```bash
myso move build
myso move test
```
