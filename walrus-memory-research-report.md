# Walrus Memory / Walrus Docs — Retrieval & Mechanics Report

**Retrieval method (applies to pages 1–9):** all nine `docs.wal.app` pages were fetched successfully. Rather than scraping rendered HTML, I used the Docusaurus raw-markdown endpoints (`<canonical-url>.md`), which return `Content-Type: text/markdown` and the exact source text of each page, including code fences and admonitions. Every one returned HTTP 200. **No page required search-snippet fallback, and no content below is inferred except where explicitly labeled.** Raw copies are saved at `/tmp/wm/*.md`.

**Page 10 (`blob.suilearn.io`) is not a Walrus Memory documentation page** — it is a third-party live block-explorer-style web app. Details in its section.

---

## 1. `/walrus-memory/contract/delegate-key-management`

- **Retrieved:** ✅ real full content (89 lines) — `https://docs.wal.app/walrus-memory/contract/delegate-key-management.md`. Canonical HTML URL also 200. Each snippet carries a provenance footer pointing at `https://github.com/MystenLabs/MemWal/blob/dev/docs/contract/delegate-key-management.md`.

**Core claim:** "Delegate keys are lightweight Ed25519 keys used for SDK authentication. They are registered onchain in a `MemWalAccount` and verified by the relayer on every request."

**Why they exist:** apps need a usable key for API calls without exposing the owner wallet; users should not hand over the owner wallet for day-to-day memory access; different apps or devices can each have their own delegate key with a descriptive label.

**Flow — 4 steps, verbatim code:**

```ts
// 1. Generate
import { generateDelegateKey } from "@mysten-incubation/memwal/account";
const delegate = await generateDelegateKey();
// delegate.privateKey — hex string, store securely
// delegate.publicKey — 32-byte Uint8Array
// delegate.suiAddress — derived Sui address (0x...)

// 2. Register the public key onchain (owner only)
import { addDelegateKey } from "@mysten-incubation/memwal/account";
await addDelegateKey({
  packageId: "0x...",
  registryId: "0x...",
  accountId: "0x...",
  publicKey: delegate.publicKey,
  label: "MacBook Pro",
  suiPrivateKey: "suiprivkey1...", // or walletSigner
});

// 3. Use the private key in the SDK
import { MemWal } from "@mysten-incubation/memwal";
const memwal = MemWal.create({ key: delegate.privateKey, accountId: "0x..." });

// 4. Revoke
import { removeDelegateKey } from "@mysten-incubation/memwal/account";
await removeDelegateKey({
  packageId: "0x...", registryId: "0x...", accountId: "0x...",
  publicKey: delegate.publicKey, suiPrivateKey: "suiprivkey1...", // or walletSigner
});
```

**Limits (exact):**
- Each account supports up to **20 delegate keys**
- Each delegate key must be a valid **32-byte Ed25519 public key**
- Duplicate keys are rejected (**error code 0**)
- Only the account owner can add or remove delegate keys

**Account deactivation (kill switch):** owner can deactivate/freeze the account. When deactivated: Seal decryption access is denied for **all** keys (owner and delegates); new delegate keys cannot be added, but the owner might still remove compromised keys; the owner can reactivate unless an **AdminCap quarantine** is active.

**Honest gap — sub-agent registration:** this page describes a **flat** delegation model (one account → ≤20 peer delegate keys, each with a `label`). It contains **no** notion of sub-agents, parent/child key hierarchies, scoped/narrowed permissions, per-key namespaces, or delegated sub-delegation. `label` is the only per-key metadata. If you need sub-agent semantics, that has to be built above this primitive (e.g. one account per sub-agent, or one delegate key per sub-agent plus app-side mapping).

---

## 2. `/walrus-memory/relayer/synthetic-seal-cross-account`

- **Retrieved:** ✅ real full content (64 lines) — `https://docs.wal.app/walrus-memory/relayer/synthetic-seal-cross-account.md`. Provenance footer → `github.com/MystenLabs/MemWal/blob/dev/docs/relayer/synthetic-seal-cross-account.md`.

**What it is:** "COMG-715 adds a production-safe **negative** synthetic on top of the Move unit test `test_seal_approve_delegate_requires_matching_owner`. The unit test covers the contract in isolation. This check would **alert** if a live identity from account A can authorize account B's Seal key."

**Isolation guarantee under test:** `account::seal_approve` must reject a delegate key from account A when asked to approve account B's Seal key.

**Read-only by construction:** "The script is **read-only**. It never calls remember, never fetches Seal decryption keys, and never executes a transaction. It `devInspect`s `account::seal_approve` only."

**When it runs:** `.github/workflows/synthetic-seal-cross-account.yml` is `workflow_dispatch` **only**. It does **not** run on pull requests, so a PR without production secrets cannot page and cannot touch chain. If the two account ids and two delegate keys are unset, the script prints `skip` and exits 0.

**Secrets / variables (verbatim table):**

| Name | Where | Purpose |
| --- | --- | --- |
| `SEAL_CROSS_ACCOUNT_A_ID` / `SEAL_CROSS_ACCOUNT_B_ID` | GitHub secret | Account object ids |
| `SEAL_CROSS_ACCOUNT_A_KEY` / `SEAL_CROSS_ACCOUNT_B_KEY` | GitHub secret | Delegate private keys (hex or `suiprivkey1…`) |
| `SUI_RPC_URL` | GitHub variable | JSON-RPC fullnode |
| `MEMWAL_PACKAGE_ID` | GitHub variable | Policy package id |
| `MEMWAL_REGISTRY_ID` | GitHub variable | `AccountRegistry` object id |
| `MEMWAL_SERVER_URL` | GitHub variable or workflow input | Optional; `GET /config` fills package id and RPC URL |
| `SUI_NETWORK` | GitHub variable | `mainnet` or `testnet` when the RPC URL does not say |

**Isolation prerequisites (the design constraint that matters):** use two **isolated** Walrus Memory accounts with **different owners**. Each key must be a delegate or owner of **its own** account and must **not** be registered on the other. "Do not commit private keys. Do not reuse the shared benchmark account as both A and B."

**Scheduling:**
```bash
$ gh workflow run synthetic-seal-cross-account.yml --ref main
```
Or Actions → **Synthetic Seal cross-account** → **Run workflow**. To cron it, add `on.schedule` once the two-account secrets exist — deliberately left off by default "so an empty repo cannot false-green or page":
```yaml
on:
  schedule:
    - cron: "17 6 * * *"   # daily 06:17 UTC
  workflow_dispatch:
```

**Failure signal:** point the workflow failure at on-call. A red job whose log contains **`SYNTHETIC_SEAL_CROSS_ACCOUNT_FAIL`** means live `seal_approve` allowed a cross-account identity. "That is a Seal policy regression, not a flake."

---

## 3. `/walrus-memory/sdk/headless-setup`

- **Retrieved:** ✅ real full content (88 lines) — `https://docs.wal.app/walrus-memory/sdk/headless-setup.md`.

**Premise:** a server or agent runtime has no human to click through a wallet or paste a key at a prompt; the SDK initializes entirely from configuration.

**Credentials generated once (only browser step):** Mainnet dashboard `https://memory.walrus.xyz`; Testnet `https://staging.memory.walrus.xyz`. "This is the only step that involves a browser. Your runtime never opens one."

**Initialization sample (verbatim):**
```ts title="service.ts"
import { MemWal } from "@mysten-incubation/memwal";
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
const memwal = MemWal.create({
  key: requireEnv("MEMWAL_PRIVATE_KEY"),
  accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  // Mainnet relayer. Use https://relayer-staging.memory.walrus.xyz for Testnet.
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: "service-memory",
});
// Confirm the relayer is reachable at boot.
await memwal.health();
```

**`MemWal.create` config — exactly 4 fields:**

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | Yes | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | `MemWalAccount` object ID on Sui |
| `serverUrl` | `string` | No | Relayer URL for your network. Pass it explicitly so the target network is unambiguous |
| `namespace` | `string` | No | Default namespace, falls back to `"default"` |

**Two explicit warnings worth internalizing:**
1. "`health()` is an unauthenticated liveness and version check. It confirms the relayer is reachable, but it does not validate your delegate key or account ID. A bad key or account ID surfaces on the first authenticated call, such as `remember` or `recall`. If you want to validate credentials at boot, make a cheap authenticated call, for example a `recall` with a trivial query, and handle its error."
2. "The SDK reads the delegate key from the `key` config field, not from any specific environment variable. The examples in these docs use both `MEMWAL_PRIVATE_KEY` and `MEMWAL_KEY` as the variable name for that value. Pick one name and use it consistently."
3. **Isolation:** "Recall is scoped per **account plus namespace**. Never hardcode an account ID copied from docs or another project, and never share one delegate key across tenants that should not read each other's memories. Load every credential from the environment."

**`MemWalManual` — when the runtime must hold its own keys:**
```ts
import { MemWalManual } from "@mysten-incubation/memwal/manual";
const manual = MemWalManual.create({
  key: requireEnv("MEMWAL_PRIVATE_KEY"),
  accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  packageId: requireEnv("MEMWAL_PACKAGE_ID"),
  serverUrl: "https://relayer.memory.walrus.xyz",
  // The Sui key authorizes Seal encryption and decryption. The relayer still
  // handles the Walrus upload, registration, search, and restore.
  suiPrivateKey: requireEnv("SUI_PRIVATE_KEY"),
  embeddingApiKey: requireEnv("OPENAI_API_KEY"),
  suiNetwork: "mainnet",
  namespace: "service-memory",
});
```
Division of labour: with the manual client the runtime embeds and Seal-encrypts locally; the relayer uploads the resulting ciphertext to Walrus and stores the vector row, so **the relayer never sees plaintext**. It requires "a few more fields, including a Sui key that authorizes Seal."

---

## 4. `/walrus-memory/sdk/agent-storage-loop`

- **Retrieved:** ✅ real full content (210 lines) — `https://docs.wal.app/walrus-memory/sdk/agent-storage-loop.md`.

**The loop — four stages:** (1) **Set up** the client from env vars, no browser or prompt. (2) **Write** many small state blobs in one batched call. (3) **Confirm** each write reached a durable `done` state before the agent acts on it. (4) **Recall** the stored context back into the agent. Runs end-to-end on **Testnet**.

**Stage 1 — setup, same 4-field config; Testnet relayer URL:**
```ts title="agent.ts"
const memwal = MemWal.create({
  key: requireEnv("MEMWAL_KEY"),
  accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  // Testnet relayer. Use https://relayer.memory.walrus.xyz for Mainnet.
  serverUrl: "https://relayer-staging.memory.walrus.xyz",
  namespace: "agent-state",
});
// Fail fast at boot if the relayer is unreachable or the key is rejected,
// rather than discovering it on the first write mid-run.
await memwal.health();
```
Isolation warning repeated: "recall is scoped per **account plus namespace**, so a shared ID puts your agent's memories in a space other readers can see."

**Stage 2 — batching (the key mechanic):**
- Agents produce many small state blobs (observations, intermediate results, per-step notes). One-at-a-time writes mean "a separate round trip and Sui transaction set for each."
- **`rememberBulk` accepts up to 20 items per call.** "The relayer embeds and Seal-encrypts every item concurrently and uploads them to Walrus in parallel, so the whole batch shares far fewer Sui transactions than writing each item on its own would." Backed by **Walrus Quilt** under the hood.
- "For an agent writing dozens of small memories a minute, that is the difference between a workable cost profile and an unworkable one."
```ts
const items = [
  { text: "Observed: user prefers concise summaries." },
  { text: "Step 1 result: parsed 42 records, 3 flagged." },
  { text: "Hypothesis: the spike correlates with the Tuesday deploy." },
];
// Fire the batch and wait for every item to finish.
const result = await memwal.rememberBulkAndWait(items);
```
- "Keep each batch at 20 items or fewer. If you have more, chunk the array and call `rememberBulkAndWait` per chunk. To fan out without blocking, use `rememberBulkAsync` and collect the returned `job_ids` to confirm later."

**Stage 3 — encrypt agent state.** "All blobs on Walrus are public, so you must encrypt private agent state." Two models, chosen by who should hold the keys:
1. **Relayer-managed encryption (default):** with the standard `MemWal` client the relayer encrypts every item with Seal before it reaches Walrus. You do not manage keys. Right default for most agents.
2. **Client-managed encryption:** `MemWalManual` performs Seal encryption client-side so plaintext never leaves the agent process.
```ts
const manual = MemWalManual.create({
  key: requireEnv("MEMWAL_KEY"), accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  packageId: requireEnv("MEMWAL_PACKAGE_ID"), registryId: requireEnv("MEMWAL_REGISTRY_ID"),
  serverUrl: "https://relayer-staging.memory.walrus.xyz",
  // The agent signs SEAL and Walrus operations with its own Sui key, no wallet popup.
  suiPrivateKey: requireEnv("SUI_PRIVATE_KEY"),
  embeddingApiKey: requireEnv("OPENAI_API_KEY"),
  suiNetwork: "testnet", namespace: "agent-state",
});
// Encrypts locally, then relays the ciphertext. The relayer never sees plaintext.
await manual.rememberManual("Private: internal risk score for account 0xabc is 0.82.");
```
Warning: client-managed encryption makes the agent responsible for its key material — **if the delegate key is lost you cannot recover the encrypted memories**; rotate through the dashboard if it might be exposed.

**Stage 3b — confirm a write before depending on it.** "An autonomous agent should not act on a memory it only believes it wrote."
- The `*AndWait` helpers already block until the relayer reports each job **`done`**, "which is the signal that the relayer embedded, encrypted, and uploaded the memory to Walrus."
- Non-blocking variant, verbatim:
```ts
const accepted = await memwal.rememberBulkAsync(items);
// ... agent does other work ...
// Block until every job reaches `done` before relying on the memories.
const settled = await memwal.waitForRememberJobs(accepted.job_ids);
const failed = settled.results.filter((r) => r.status !== "done");
if (failed.length > 0) {
  throw new Error(`${failed.length} memories did not persist; do not proceed.`);
}
```
- **Roadmap note:** "A dedicated `verify()` helper that reconstructs a memory from its onchain blob object is on the roadmap. Until it ships, a job reaching `done` is the durability signal to gate on, and the memory's Walrus blob object on Sui is the onchain record of the write."

**Stage 4 — recall.** Relayer flow, in order: "verifies the request, embeds the query, searches, downloads from Walrus, decrypts, and returns plaintext."
```ts
const recalled = await memwal.recall({ query: "What do we know about the Tuesday spike?", limit: 5 });
for (const memory of recalled.results) {
  console.log(memory.distance.toFixed(3), memory.text);
}
```
Recall is scoped to the client's namespace by default; pass `namespace` to read another, `limit` to cap results.

**Full end-to-end script** (set up → batch → confirm → recall, with `main().catch(...)` → `process.exit(1)`) is printed in full on the page and is liftable straight into a runtime.

---

## 5. `/walrus-memory/sdk/production-readiness`

- **Retrieved:** ✅ real full content (154 lines) — `https://docs.wal.app/walrus-memory/sdk/production-readiness.md`.

Framing: the SDK gives storage primitives; running them in a long-lived agent "where there is no human to retry a failed write or notice a runaway bill" takes patterns on top. The page **explicitly labels which code is a permanent pattern vs. a stopgap for a roadmap feature** — unusually honest and useful.

**1. Make writes idempotent.**
- "**The relayer does not deduplicate writes.** A `remember` call that retries after a network blip, or fired twice by an at-least-once job queue, stores the same text twice and pollutes later recall."
- Until content-based dedup is native, gate writes on a key your agent controls:
```ts
import { createHash } from "crypto";
const written = new Set<string>(); // back this with Redis or a DB in production
async function rememberOnce(memwal: MemWal, text: string, namespace?: string) {
  const id = createHash("sha256").update(`${namespace ?? "default"}:${text}`).digest("hex");
  if (written.has(id)) return; // already stored this exact memory
  const job = await memwal.remember(text, namespace);
  await memwal.waitForRememberJob(job.job_id);
  written.add(id);
}
```
- The idempotency key is `sha256(namespace + ":" + text)`; note that `remember` returns a **single** `job_id` polled by `waitForRememberJob`.

**2. Retry with backoff — but only retryable failures.**
- "**The client does not retry for you.**" Retry transient network errors and relayer timeouts. "A `401 AUTH_REJECTED` is a configuration problem that fails identically on every attempt, so retrying it just delays the real fix."
```ts
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      const status = (err as { status?: number }).status;
      // Do not retry auth or client errors; they will not succeed on a retry.
      if (status === 401 || (status && status >= 400 && status < 500)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2 ** i * 500 + Math.random() * 250));
    }
  }
  throw lastErr;
}
```
So: **4 attempts, backoff `2^i * 500 ms` + up to 250 ms jitter, fail fast on any 4xx.**

**3. Confirm durability before acting.** `*AndWait` helpers block until each job reports `done`; otherwise capture job ids and wait:
```ts
const accepted = await memwal.rememberBulkAsync(items);
const settled = await memwal.waitForRememberJobs(accepted.job_ids);
if (settled.failed > 0) {
  const bad = settled.results.filter((r) => r.status !== "done");
  throw new Error(`${settled.failed} writes did not persist: ${bad.map((b) => b.status).join(", ")}`);
}
```
- **Critical read-after-write caveat (a real distributed-systems gotcha):** "A job reaching `done` confirms that the relayer stored the memory, but **the vector index can briefly lag behind that signal**, so a `recall` fired in the same instant might not return the memory yet. For read-after-write critical paths, tolerate a short delay or re-query rather than treating an empty first result as a missing memory." Note this **contradicts the naive reading of the agent-storage-loop page**, where `done` is presented as sufficient to gate on.

**4. Bound cost.** "Every write registers storage on Walrus and costs gas and WAL. An agent in a tight loop can run up spend quickly, so put ceilings in the agent, not just in your head."
- **Batch with Quilt** — `rememberBulkAndWait` (up to 20 items) collapses many small writes into far fewer transactions; buffer small state blobs and flush as a batch.
- **Do not store what you never recall** — ephemeral scratch state that never feeds a future `recall` stays in process memory.
- **Cap writes per cycle** — give the loop a budget, e.g. max memories per run or per hour, and drop or summarize past the cap rather than write unbounded:
```ts
let writesThisCycle = 0;
const MAX_WRITES_PER_CYCLE = 50;
async function budgetedRemember(memwal: MemWal, text: string) {
  if (writesThisCycle >= MAX_WRITES_PER_CYCLE) return false;
  await rememberOnce(memwal, text);
  writesThisCycle++;
  return true;
}
```
- **Honest note:** there is **no spend/credit limit API** described. Cost control is entirely caller-side (batching, budget counters, cycle caps). See §11 for the relayer's own server-side rate limits.

**5. Custody the agent's keys.** Delegate key authenticates the agent to the relayer; the **Sui key signs the Seal and Walrus operations** for client-managed encryption. Load both from a secret manager, never from source or logs. "Scope each agent to its own delegate key so you can revoke one without taking down the rest, and rotate through the dashboard if a key might be exposed. If the Sui key behind client-managed encryption is lost, you cannot recover the encrypted memories, so back it up with the same care as any data-encryption key."

**6. Degrade gracefully.** A memory layer that is down should slow the agent, not stop it:
```ts
let memory: MemWal | null = null;
try {
  memory = MemWal.create({ key, accountId, serverUrl, namespace });
  await memory.health();
} catch (err) {
  console.log("Memory unavailable, continuing without it this cycle:", err);
  memory = null;
}
if (memory) { await budgetedRemember(memory, "..."); }
```
Same defensive pattern as the Cloudflare Workers guide.

**7. Mind the recall result cap.** **`recall` returns up to `limit` results, defaulting to `10`.** "When more memories match than the cap, the relayer does not return the extra results, **with no signal that it truncated the set.**" Treat `results.length === limit` as a possible truncation signal:
```ts
const result = await memwal.recall({ query: "open incidents", limit: 50 });
if (result.results.length === 50) {
  console.warn("Recall hit the limit; there may be more matches than returned.");
}
```

---

## 6. `/walrus-memory/examples/chatbot`

- **Retrieved:** ✅ real full content (45 lines) — `https://docs.wal.app/walrus-memory/examples/chatbot.md`.

**What it is:** `apps/chatbot` — a production-style AI chat app on **Next.js** + the **Vercel AI SDK**. "It shows the lightest-touch Walrus Memory integration: wrap the model once, and memory works for every conversation turn."

**Integration (the whole thing):**
```ts
import { withMemWal } from "@mysten-incubation/memwal/ai";
const model = withMemWal(baseModel, {
  key,
  accountId,
  serverUrl,
  maxMemories: 5,
  autoSave: true,
});
```
"the server wraps the selected model with `withMemWal`, so **recall runs before each generation** and the middleware can **save new context after each turn**." Options shown: `key`, `accountId`, `serverUrl`, `maxMemories: 5`, `autoSave: true`. Full option list is on the AI Integration page (`/walrus-memory/sdk/usage/with-memwal`).

The UI lets the user enable Walrus Memory, collect a delegate key and account ID, and pass them to the chat API. "Everything else stays a normal AI SDK chat app, which is the point: the middleware adds memory without changing the generation code."

**Run locally:**
```bash
$ pnpm install
$ cp apps/chatbot/.env.example apps/chatbot/.env
$ pnpm --filter chatbot db:migrate
$ pnpm dev:chatbot
```
Env vars: `AUTH_SECRET`, `OPENROUTER_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `POSTGRES_URL`, `REDIS_URL`, plus the Walrus Memory values from the dashboard (`MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, `MEMWAL_SERVER_URL`).
**Notable:** `pnpm --filter chatbot verify:memwal` — "catch credential mismatches before the first relayer call." This is a **preflight credential-validation script**, which is exactly the gap the `health()` warning in §3 leaves open.
Runs on `localhost:3001`; source at `github.com/MystenLabs/MemWal/tree/main/apps/chatbot`.

---

## 7. `/walrus-memory/fundamentals/architecture/funding-storage`

- **Retrieved:** ✅ real full content (127 lines) — `https://docs.wal.app/walrus-memory/fundamentals/architecture/funding-storage.md`.

**Framing:** "In a typical Walrus Memory setup, the relayer operates the Walrus write path for you, so most agents never touch WAL directly. Whether the storage is sponsored or self-funded then depends on how the relayer is deployed: a **public relayer abstracts funding away from the agent**, while **self-hosting means you fund the writes**."

### A write costs 2 tokens, not 1
- **WAL** pays for storage: per **encoded storage unit per epoch**, plus a **one-time write fee per blob**. Walrus prices storage at a **fixed fiat rate (~0.023 USD per GB per month)** and adjusts the WAL amount automatically as the WAL price changes. **1 WAL = 1 billion FROST.**
- **SUI** pays gas for the Sui transactions that coordinate the write: **`reserve_space`, `register_blob`, `certify_blob`**, plus any later **`extend`, `delete`, `burn`**. **1 SUI = 1 billion MIST.**
- Cost shape: WAL scales with blob size and epoch count; SUI gas stays roughly fixed per transaction. **"A typical store runs as 2 transactions: one for `reserve_space` and `register_blob`, which changes both your SUI and WAL balances, and one for `certify_blob`, which changes only your SUI balance."**
- "The funding question is really 2 questions: **who supplies the WAL, and who supplies the SUI gas.** Different sponsored mechanisms cover different halves."
- **Ownership:** a successful write produces a **`Blob` object on Sui**. "Whoever owns that object controls the blob lifecycle, such as extending its lifetime, deleting it, adding attributes, or burning it to reclaim Sui storage. Ownership matters as much as payment."

### Model A — the agent holds WAL directly
Agent has its own Sui address (key pair) holding both SUI and WAL, and signs and pays for its own writes. Default model for a long-lived autonomous agent that owns its data.
```bash
$ walrus store memory.json --epochs 10
```
```ts
await client.walrus.writeFiles({
  files: [file],
  epochs: 10,
  deletable: true,
  signer: keypair, // must hold enough SUI for gas and enough WAL for storage and the write fee
});
```
Acquiring WAL: `walrus get-wal --amount AMOUNT_IN_FROST` (swaps SUI onchain), or transfer / bridge / exchange. "On Testnet, WAL has no value and you obtain it 1:1 from Testnet SUI."
Two responsibilities: **keep both balances funded** ("Running out of either SUI or WAL stalls writes") and **manage the blob lifecycle** — "Blobs expire after the paid number of epochs (an epoch is about **2 weeks on Mainnet and about 1 day on Testnet**, and you can buy **up to about 2 years in advance**), so the agent extends them before expiry or the network drops the data."

### Model B — sponsored storage (not one feature; several patterns)
- **Publisher — sponsor pays WAL *and* SUI.** An HTTP service that accepts raw bytes and runs the entire write flow. Its **sub-wallets** hold SUI and WAL and pay for everything, "so the agent needs no tokens at all and only sends the data. **A Walrus Memory relayer plays this role for your memories.**" Most complete sponsorship (sponsoring application carries 100% of WAL and SUI cost). By default the publisher's sub-wallet owns the resulting `Blob`; set the publisher's **`send-object-to`** parameter to the agent's Sui address so the publisher transfers the blob after upload. **Warning:** "Mainnet has no public, unauthenticated publisher, because each upload spends the operator's real WAL and SUI. In production, this is a private, authenticated publisher that the sponsoring application runs and gates for its own agents."
- **Sui sponsored transactions — sponsor pays SUI gas only.** Sponsor account provides the gas coin for a transaction the agent signs. "This covers only the SUI side. The WAL storage fee still comes from somewhere else."
- **Pre-funding — transfer WAL or storage resources.** WAL is a coin and storage resources are transferable Sui objects: send WAL to the agent (agent then uses Model A), or buy storage resources in bulk and transfer them — "you can split, merge, transfer, and even trade storage resources on marketplaces. The agent then pays only SUI gas to call `register_blob` and `certify_blob` against pre-bought capacity. Buying larger resources once and splitting them amortizes gas."
- **What an upload relay does *not* do.** "An upload relay is easy to mistake for a sponsor, but it is **not** one. A relay only distributes the encoded slivers to storage nodes for the client" (helps browser/mobile/edge where "opening thousands of connections is impractical"). "The agent still registers and certifies the blob onchain and still pays the WAL and SUI." A relay can charge a tip configured as **`const`** (flat amount per blob) or **`linear`** (scales with blob size), paid in **MIST or WAL**. "**Do not confuse a Walrus upload relay with the Walrus Memory relayer**: the Walrus Memory relayer runs the full write flow and can fund it, while a bare Walrus upload relay only forwards slivers."
- **Protocol subsidies are network-level, not per-agent.** Walrus reserves a portion of WAL supply as subsidies supplementing storage-node rewards while the network grows. "This lowers effective costs across the whole network, but it is not a way for one party to fund a specific agent's blob. **Do not model subsidies as sponsored storage.**"

### Choose-a-model table (verbatim)
| **If the agent** | **Use** | **Pays WAL** | **Pays SUI gas** | **Owns the blob** |
| --- | --- | --- | --- | --- |
| Is long-lived, owns its data, and manages its own lifecycle | Hold WAL directly | Agent | Agent | Agent |
| Holds no tokens, such as in a browser or untrusted environment | Publisher or relayer | Sponsor | Sponsor | Sponsor, unless you set `send-object-to` the agent |
| Holds WAL but should not manage gas | Sui sponsored transactions | Agent | Sponsor | Agent |
| Is one of many, funded from a central treasury | Pre-funded WAL or storage resources | Sponsor (upfront) | Agent | Agent |
| Needs help distributing slivers and still self-funds | Upload relay | Agent | Agent | Agent |

### Operating a self-funding agent
- **Watch both balances.** "The publisher reference design keeps each sub-wallet **between 0.5 and 1.0 SUI and WAL** in steady state with an automatic refill loop, which is a good pattern to copy for any self-funded agent."
- **Plan for expiry** — durable memory needs an extend-before-expiry loop, or hand that to the sponsor.
- **Track ownership** — `send-object-to` if the agent is meant to manage the blob.
- **Estimate before you spend** — `walrus info` shows current storage and write prices; `walrus store --dry-run` reports the encoded size used for the WAL cost. "Neither command submits a transaction."
- **Develop on Testnet first** — free Testnet WAL swapped 1:1 from Testnet SUI. "Testnet might wipe data and uses 1-day epochs."

---

## 8. `/walrus-memory/relayer/public-relayer`

- **Retrieved:** ✅ real full content (32 lines) — `https://docs.wal.app/walrus-memory/relayer/public-relayer.md`. This is a **short page**.

**Walrus Foundation hosted endpoints (verbatim):**

| **Network** | **Relayer URL** |
|---|---|
| **Production** (Mainnet) | `https://relayer.memory.walrus.xyz` |
| **Staging** (Testnet) | `https://relayer-staging.memory.walrus.xyz` |

```ts
const memwal = MemWal.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memwal-account-id>",
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: "demo",
});
```

**What to know — the four bullets, verbatim:**
- **Shared App ID** — "all users of the managed relayer share the same Walrus Memory package ID. Your own `owner + namespace` (Memory Space) isolates your data, but the underlying deployment is shared."
- **Trust assumption** — "the relayer sees plaintext during encryption and embedding. By using the managed relayer, you're trusting the Walrus Foundation-hosted instance with that data."
- **Availability** — "the Walrus Foundation provides the managed relayer as a public good **without SLA guarantees**."
- **Storage costs** — "the server wallet covers Walrus storage fees. **The service can apply usage limits.**"

**Honest gap — hosted limits/quotas:** this page publishes **no numeric quota, rate limit, burst limit, storage ceiling, or error-code table** for the hosted relayer. The only statement is the non-specific "The service can apply usage limits." Concrete numbers exist only for **self-hosted** deployments (see §11). If exact hosted quotas are needed, they are not documented on this page and I am not going to invent them.

---

## 9. `/docs/console/storage-epochs`

- **Retrieved:** ✅ real full content (22 lines) — `https://docs.wal.app/docs/console/storage-epochs.md`. **Short page.**

**Framing:** "Walrus storage is time-bound. Your data stays available for a set amount of storage, measured in epochs, and expires when that storage runs out. Walrus Console tracks and pays for this so you do not manage epochs by hand, and it extends storage automatically before it runs out."

**How epochs work:** "One epoch lasts **two weeks on Mainnet and one day on Testnet**, and storage can be bought for **at most 53 epochs at a time**." When you store a file you reserve storage for a number of epochs; while it lasts the network keeps data available; when it runs out and nobody renews, **the data expires and is no longer retrievable**. Console handles payment and epoch accounting through your **Pearl wallet**: "You store a file, and Console reserves and funds its storage. **You do not buy epochs or sign renewal transactions yourself.**"

**Automatic extension:** a **background task checks the files in your account on a schedule**, and when a file's storage is close to its end it extends the storage for more epochs. "Data you store through Console stays available without any manual step."

**Checking storage status:** the dashboard shows how much storage each space is using. **Storage used and your storage cap also appear per space when you list spaces through the API**, and **each folder reports an `expires_at` timestamp**.

**Storage limits (the console allowances, verbatim):** "Each space holds up to **5 GB** of storage and **five folders**, and each upload is capped at **100 MiB**."

**Corroboration** (supplementary fetch, `https://docs.wal.app/docs/console/overview.md`): the same limits repeat — "Each space holds up to 5 GB of storage and five folders, and each upload is capped at 100 MiB. Console manages WAL token handling on your behalf." Same page adds: sign-in via Google/Apple using Sui **zkLogin**, which derives a Sui address and silently provisions a **Pearl wallet** ("you do not manage private keys or hold tokens to get started", "There is no invite or waitlist"); Console generates a **service private key prefixed `suiprivkey1`** shown once next to the API key (Console stores only the derived public address; "It does not need a token balance"); folders are **Seal-encrypted client-side** using a "reserve, sign, and finalize handshake that provisions the folder's Seal access policy onchain"; **uploads are asynchronous** — "you upload a file, then poll its status until Console confirms that Walrus stores it"; and there is an **MCP server** exposing file/folder operations as tools. Deleting the Console account is permanent and removes folders/files/API keys, but **"Memories stored in Walrus Memory are not deleted and remain available outside Console"** — only the link between accounts is removed.

---

## 10. `https://blob.suilearn.io/`

- **Retrieved:** ✅ full HTML (258 KB, HTTP 200), reduced to ~4.5 KB of text. **This is not a Walrus Memory docs page and not first-party Walrus documentation.** It is a **third-party, read-only web explorer** — `<title>Walrus Explorer — Look inside Walrus</title>`, meta description "Look inside Walrus. Find any blob, any storage node, any address — read-only and faithful to the chain." It is a **Next.js app** (root `/_next/static/chunks/…`), self-describes as **"Built by karan.sui ↗"** and **"@suilearn ↗"**, and links out to `https://docs.wal.app`, `https://aggregator.walrus-mainnet.walrus.space`, and `https://aggregator.walrus-testnet.walrus.space`.

**Surface / routes:** `Blobs`, `Nodes`, `Operators`; detail routes `/blob/<blobId>?n=<network>`, `/object/0x…?n=<network>`; a **Mainnet/Testnet network switcher**; **⌘K** command palette; a **"Recent blobs"** feed labelled **"Live · refreshes every 30 s"**; and a **"Blob events"** feed showing "Every Registered / Certified / Deleted event in order". Listing tables expose **Status · Blob ID · Sui object · Epoch · Size · When** — i.e. it surfaces exactly the onchain `Blob`-object facts that the funding page tells you to track.

**Live mainnet values at fetch time (point-in-time snapshot, will drift):**
- **Current epoch 41**; epoch length **14 days** ("14d 0h left")
- **Committee 94 nodes**; **Shards 1,000**
- **Total capacity 4.00 PB**; **used 2.26 PB**; **storage used 56.5%**
- **Max blob size 14.6 GB** (14,599,533,000 B); **stored for up to 53 epochs**; **storage unit 1.05 MB**
- **Storage price** (per unit · per epoch): **59,752 FROST ≈ 0.000059752 WAL**
- **Write price** (per unit): **108,599 FROST ≈ 0.000108599 WAL**
- **Metadata** (per blob · per epoch): **3,704,624 FROST ≈ 0.003704624 WAL**
- **Marginal** (per MiB unencoded): **358,512 FROST ≈ 0.000358512 WAL**
- **1 WAL = 1,000,000,000 FROST** (matches the funding page exactly)
- **RedStuff encoding** worked examples: 16 MiB → 134 MiB encoded ≈ **0.011711392 WAL/epoch**; 512 MiB → 2.31 GiB ≈ **0.145018104 WAL/epoch**; 13.6 GiB → 61.2 GiB ≈ **3.748302712 WAL/epoch**; custom 1 MiB ≈ **0.009440816 WAL/epoch**
- **System object** `0x2134d5…03ddd2`; sample blob events show epoch ranges like `41 → 54`, `41 → 51`, `41 → 56`, `41 → 48` with sizes spanning 776 B to 268 MB

**How to use this page:** as a **live corroboration** tool, not a spec. Independently confirms the docs' epoch cap (**53**), the FROST denomination (**1e9**), the ~14-day Mainnet epoch, and the RedStuff ~8.4× encoded-size blowup implied by the funding page. The WAL-per-MiB figures give a concrete order of magnitude for cost modelling (roughly **0.0094 WAL per MiB per epoch** at epoch 41).

---

## 11. Supplementary: exact numeric limits & error codes (adjacent canonical pages)

The ten pages do not fully answer the "limits / quotas / error codes" part of the brief. I fetched four adjacent canonical pages to close that gap; all retrieved as raw markdown, HTTP 200. **Labeled separately because they are not among the requested ten.**

**Hosted-relayer reality check first:** the numbers below are **self-hosting defaults**, from `https://docs.wal.app/walrus-memory/relayer/self-hosting.md`. The managed relayer page only says it "can apply usage limits" (§8). A self-hosted deployment is where you can actually *see* and set these.

**Rate limits and storage quotas (self-hosted; enforced through Redis; defaults verbatim):**
- `RATE_LIMIT_REQUESTS_PER_MINUTE` — "Max burst weighted-requests per minute per user (**default: 60**)"
- `RATE_LIMIT_REQUESTS_PER_HOUR` — "Max sustained weighted-requests per hour per user (**default: 500**)"
- `RATE_LIMIT_DELEGATE_KEY_PER_MINUTE` — "Max weighted-requests per minute **per delegate key** (**default: 30**)"
- `RATE_LIMIT_STORAGE_BYTES` — "Max storage per user in bytes (**default: 1 GB, `1073741824`**)"
- `REDIS_URL` — "Required to track sliding windows for rate limits (default: `redis://localhost:6379`)"
- "Configure the **same Redis cluster** (`REDIS_URL`) across all nodes so that the rate limiter sliding window accurately tracks global user quotas across your deployment."
- Note the limits are **weighted** requests, and are dimensioned **per user** (60/min, 500/hr) *and* **per delegate key** (30/min) — the per-key dimension is exactly the lever for isolating a misbehaving sub-agent.

**Storage-epoch defaults and cap (self-hosted sidecar upload route):** "defaults storage `epochs` by network: **`5` on `testnet`, `3` on `mainnet`** (unless the request passes `epochs`). Both the request value and the `WALRUS_STORAGE_EPOCHS` override **cap at `15`**; an over-cap override **falls back to the network default**." (Note this 15-epoch relayer-side cap is much lower than the 53-epoch protocol maximum — a deliberate cost/liability bound.)

**Other operational constants:** `SERVER_SUI_PRIVATE_KEYS` is "a comma-separated key pool for parallel Walrus uploads." The Rust relayer **starts the TypeScript sidecar as a child process on boot**, communicating over HTTP (**`localhost:9000`** by default); **if the sidecar fails to start within 15 seconds, the relayer exits.** Connection pool: **10 max (relayer), 3 max (indexer).** `WALRUS_AGGREGATOR_URLS` can add comma-separated proxy/aggregator candidates "for cold-read tail racing after Redis cache misses."

**Error codes and status semantics** (from `https://docs.wal.app/walrus-memory/troubleshooting/overview.md`):
- **`401 AUTH_REJECTED`** — the relayer "cannot match your signed request to an active, registered delegate key on the account you named. It **verifies the Ed25519 signature**, then **resolves the owner by finding your public key in that account's onchain `delegate_keys`.** Anything that breaks that lookup returns the same 401." Documented causes, ordered by frequency for a fresh key: (1) key not registered onchain yet or registration tx not indexed; (2) **account ID does not match the account that owns the key** (stale `localStorage` value is a common source); (3) **client points at a different network** than where the account lives; (4) **system clock outside the 5-minute signing window** (fix via NTP); (5) key revoked or account deactivated. Triage order given: key listed under the right account → account ID matches exactly → relayer environment matches where the account was created.
- **`MemWalCompatibilityError`** — true SDK/relayer version mismatch. "The relayer reports its minimum supported SDK version, which is **TypeScript 0.0.4** at the time of writing, so 0.1.0 is supported."
- **HTTP `503 upstream unavailable`** — means **retry**. Cause: the relayer re-checks the delegate key on Sui on **every** signed request; when Sui gRPC `GetObject` returns **429** or is otherwise unavailable, **older** relayers treated that as a revoked key, evicted the cache, and returned an empty HTTP 401, which the SDK maps to a login hint (`"Walrus Memory isn't signed in. Call the memwal_login tool, then retry."`). "Current relayers keep the cached mapping when Sui cannot be consulted, or return HTTP 503 `upstream unavailable` on a cache miss. **A 503 from the SDK means 'retry'; it does not mean call `memwal_login`.**"
- **Contract error code `0`** — duplicate delegate key rejection (§1).
- **MCP auth-required mode:** no credentials file at `~/.memwal/credentials.json` → the host starts in authentication-required mode; the tool list still advertises the core tools but only `memwal_login` runs. `memwal_login` returns a **one-time sign-in URL valid for 5 minutes**; alternative: `npx -y @mysten-incubation/memwal-mcp login --prod`.

**Exact API shapes** (from `https://docs.wal.app/walrus-memory/sdk/api-reference.md`), for the signatures referenced above:
```ts
remember(text, namespace?): Promise<{ job_id: string; status: string /* "running" */ }>
rememberAndWait(text, namespace?, opts?): Promise<{ id, job_id, blob_id, owner, namespace }>
waitForRememberJob(jobId, opts?): Promise<RememberResult>   // until `done` or `failed`
rememberBulk(items): Promise<RememberBulkAcceptedResult>    // up to 20 items, returns job ids immediately
rememberBulkAndWait(items, opts?): Promise<RememberBulkResult>
recall(params): Promise<RecallResult>
  // preferred: recall({ query, limit?, topK?, namespace?, maxDistance?, sort?, scoringWeights? })
  // legacy positional still works: recall(query), recall(query, limit), recall(query, limit, namespace), recall(query, options)
analyze(text, namespace?): Promise<{ job_ids, facts: [{text,id,job_id}], fact_count, status, owner }>
restore(namespace, limit?): Promise<{ restored, skipped, failed, total, namespace, owner }>  // limit defaults to 10
listNamespaces(options?): Promise<NamespacesResult>          // metadata only, no fetch/decrypt
health(): Promise<{ status, version, relayerVersion?, apiVersion?, minSupportedSdk? }>
compatibility(): Promise<RelayerVersionMetadata>             // GET /version
getPublicKeyHex(): Promise<string>                           // hex pubkey of current delegate key
// lower-level: rememberManual({ encryptedData, vector, namespace? }), recallManual({ vector, limit?, namespace? })
```
Two sharp edges from that page: `remember` "returns after the relayer creates a background job; embedding, Seal encryption, Walrus upload, and vector indexing continue asynchronously" — so `job_id` is a **polling id**, distinct from the stable `id`. And **score polarity differs by surface**: "MCP `memwal_recall` displays `score = 1 - distance` (higher = more similar). Do not apply an SDK `maxDistance` threshold to those scores. **The polarities are inverted.**"

---

## Key mechanics worth mirroring

1. **Capability delegation without key surrender.** The owner wallet never enters the runtime. A separate Ed25519 delegate key authenticates, is registered onchain in the account's `delegate_keys`, and is verified **on every request** by re-resolving the signer's public key against chain state (§1, §11). Revocation is a single onchain removal, and there is an account-level freeze that denies Seal decryption to *all* keys including the owner's — a genuine emergency kill switch, gated against owner-triggered reactivation by an `AdminCap` quarantine.
2. **Bounded, labelled, flat delegation.** ≤20 keys per account, each 32-byte Ed25519, duplicates rejected with error code 0, each carrying a human `label`. There is no sub-delegation tree and no per-key scoping — so **scope by key, not by role object**: one key per agent/device/tenant, so one key can be revoked without touching the rest (§5). The self-hosted rate limiter's separate **per-delegate-key bucket (30/min)** shows the same idea expressed as a quota dimension (§11).
3. **Isolation is a tuple, not an ID.** Recall scope is **account + namespace**, and the docs warn in three separate places never to hardcode an account ID or share a key across tenants that shouldn't read each other (§3, §4, §8). Data isolation rests on `owner + namespace`, while the *deployment* (package ID) and even the key-verification path are shared — so isolation is enforced at lookup time, every time.
4. **Prove isolation negatively, in production.** The cross-account synthetic inverts the usual test: it asserts that identity A **cannot** authorize B's Seal key, using `devInspect` only — no transaction, no `remember`, no decryption-key fetch — so it is safe to run against live state. It is `workflow_dispatch`-only (never on PRs, so untrusted changes can't page or touch chain), **skips with exit 0 when secrets are absent** rather than false-greening, and ships with the cron deliberately commented out until the two accounts exist. Failure is a single greppable token, `SYNTHETIC_SEAL_CROSS_ACCOUNT_FAIL`, classified as "a policy regression, not a flake" (§2). The prerequisite — each key registered on its own account and *not* on the other — is itself the test fixture.
5. **Headless init is config-only: key + account id + server URL.** Four fields, two required (`key`, `accountId`), two optional with defaults (`serverUrl`, `namespace`). `serverUrl` is recommended explicitly "so the target network is unambiguous" — network ambiguity is a top documented cause of auth failure (§3, §11). Credentials come from the environment, never source or logs.
6. **Health checks lie about authorization.** `health()` is an unauthenticated liveness/version probe that passes with a bad key or account ID; a passing `health()` can be followed immediately by a `401`. The documented remedies are (a) make a cheap *authenticated* call at boot and handle its error, and (b) ship a preflight credential verifier — the chatbot app's `pnpm --filter chatbot verify:memwal` exists precisely to "catch credential mismatches before the first relayer call" (§3, §6).
7. **Write → job → confirm, with a terminal-state gate.** Writes are asynchronous and return a **job id**, not a stored object. `*AndWait` helpers block until each job reports terminal state; the non-blocking form returns `job_ids` to settle later. The agent is explicitly told not to act on a memory it "only believes it wrote," and to **throw rather than proceed** when any job is not `done` (§4, §5).
8. **`done` is durability, not read-after-write consistency.** The most valuable caveat in the set: a job reaching `done` means the relayer stored the memory, **but the vector index can lag behind that signal**, so an immediately-following `recall` may miss it. Read-after-write critical paths must tolerate a short delay or re-query, and must not treat an empty first result as "no memory" (§5). Related: a `verify()` helper that reconstructs a memory from its onchain blob object is *still on the roadmap* — the docs are explicit that today's guarantee is weaker than the eventual one.
9. **Batch with Quilt; 20 items per call.** `rememberBulk` / `rememberBulkAndWait` / `rememberBulkAsync` cap at 20 items, embed + Seal-encrypt concurrently, and upload in parallel under **Walrus Quilt**, collapsing many small blobs into far fewer Sui transactions. Overflow is handled by chunking, not by a bigger batch (§4). The cost rationale is stated bluntly: for an agent writing dozens of small memories a minute this "is the difference between a workable cost profile and an unworkable one" (§4).
10. **Retries are caller-owned, idempotency is caller-owned.** The client does not retry and the relayer **does not deduplicate**. The documented pairing is a `withRetry` wrapper (4 attempts, `2^i * 500 ms` + 250 ms jitter, **fail fast on every 4xx** — especially `401 AUTH_REJECTED`, which is deterministic) plus a content-addressed idempotency guard keyed on `sha256(namespace + ":" + text)`, **persisted outside the process** because "an in-memory set resets on restart, which is exactly when a retry storm is most likely" (§5).
11. **`503` means retry; `401` means fix config.** Retryability is a status-code contract, and the docs spend real effort making the two indistinguishable-looking failures distinguishable: an empty 401 is a cache-miss artifact mapped to a misleading "call `memwal_login`" hint, while a `503 upstream unavailable` is the honest signal. It also records *why* (Sui gRPC `GetObject` → 429 masquerading as key revocation) and confirms the bug was fixed in newer relayers (§11).
12. **Spend ceilings live in the caller; there is no spend-limit API.** Cost control is three caller-side levers — batch to reduce transactions, refuse to store what you will never recall, and hard-cap writes per cycle (`MAX_WRITES_PER_CYCLE = 50`) with drop-or-summarize overflow (§5). Server-side, the only backstops are the relayer's weighted rate limits (60/min and 500/hr per user, 30/min per key) and a **1 GB per-user storage quota**, plus a relayer-side **epoch cap of 15** far below the protocol's 53 (§11).
13. **Funding is two separate questions: who pays WAL, who pays SUI gas.** Never collapse them. WAL = storage per encoded unit per epoch + a one-time write fee per blob, priced at a **fixed fiat rate (~$0.023/GB/month)** so the WAL amount auto-adjusts to WAL price; SUI = gas for `reserve_space` + `register_blob` (tx 1, touches both balances) then `certify_blob` (tx 2, SUI only). Sponsorship mechanisms each cover a *half*: a **publisher** covers both (and a Walrus Memory relayer is a publisher), **Sui sponsored transactions** cover gas only, **pre-funding** moves WAL and transferable storage resources ahead of time, and an **upload relay covers neither** — it only distributes slivers and may charge a `const` or `linear` tip (§7).
14. **Whoever owns the `Blob` object controls the data's fate.** Payment and ownership are decoupled: a sponsor can pay while the agent owns, via `send-object-to`. The owner can extend, delete, add attributes, or burn to reclaim Sui storage. The funding page insists ownership is tracked "as much as payment, especially in sponsored flows" — and the explorer's blob tables surface exactly that `Blob` object id per blob (§7, §10).
15. **Durability is paid time, and expiry is an operational duty.** Epoch ≈ 2 weeks Mainnet / 1 day Testnet; **max 53 epochs purchased at once** (≈ 2 years), 53 independently confirmed by the live explorer. Blobs expire when paid epochs run out and become unretrievable. Every durable design needs an **extend-before-expiry loop** — a hosted relayer or Console can do it for you (Console's background task renews on a schedule and reports per-folder `expires_at`), but self-funding means you own that loop, plus a refill loop that keeps **both** SUI and WAL between **0.5 and 1.0** (§7, §9, §10).
16. **Budget for RedStuff's encoded-size multiplier.** Cost is charged on **encoded** bytes, not raw: 16 MiB → 134 MiB, 512 MiB → 2.31 GiB, 13.6 GiB → 61.2 GiB (~8.4×). `walrus store --dry-run` reports the encoded size used for the WAL cost and `walrus info` gives current prices, both without submitting a transaction — estimate before you spend (§7, §10).
17. **Public infrastructure as a public good, honestly scoped.** The hosted relayer is offered **without SLA**, with **no public unauthenticated publisher on Mainnet** because every upload spends the operator's real WAL and SUI, and with a stated trust assumption that the relayer **sees plaintext during embedding and encryption** — the explicit reason `MemWalManual` exists for client-side embedding and Seal encryption so "the relayer never sees plaintext" (§3, §7, §8). Publish the trust boundary rather than hiding it, and provide the escape hatch (self-hosting) for teams that can't accept it.
18. **Graceful degradation over hard dependency.** Wrap memory initialization in try/catch, null it out on failure, and guard every read and write on liveness so a memory outage **slows** the agent rather than stopping it (§5, §6).
19. **Truncation must be visible, or you must assume it.** `recall` defaults to `limit: 10` and **silently drops** extra matches with no truncation signal. The documented mitigation is to set `limit` deliberately high and treat `results.length === limit` as evidence of more. Related traps worth mirroring as warnings: `distance` (SDK) vs `score = 1 - distance` (MCP) have **inverted polarities**, and legacy positional `recall` signatures still work alongside the options-object form (§5, §11).
20. **Document what is a permanent pattern vs. a stopgap.** The production-readiness page repeatedly marks capabilities as roadmap ("a dedicated `verify()` helper… is on the roadmap", "built-in retry and backoff inside the client is on the roadmap", "until content-based deduplication is available natively"), so readers know which of their own code is load-bearing glue that can be deleted later. That single convention is worth copying wholesale in any fast-moving platform's docs.
