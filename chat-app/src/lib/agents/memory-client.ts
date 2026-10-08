import {
  AiCreditApprovalRequiredError,
  Memory,
  type MemoryVisibility,
  type RecallMemory,
  type RecallScope,
} from '@socialproof/memory';
import {AI_CREDIT_APPROVAL_REQUIRED_CODE} from '@socialproof/memory/account';

const AI_CREDIT_DEPLETED_CODE = 'insufficient_ai_credits';

import type {AgentSigningKey} from './passkey-vault';

export const CHAT_NAMESPACE = 'chat-app';

/**
 * Relayer batch ceiling. `rememberBulk` collapses up to 20 small writes into one
 * Walrus Quilt upload sharing far fewer settle transactions than 20 single
 * writes, so agents that record a few facts per turn stay affordable.
 */
export const REMEMBER_BULK_MAX = 20;

/** Per-cycle ceiling on new memories, so one runaway turn cannot drain credits. */
export const MAX_WRITES_PER_CYCLE = 50;

/** Server-side recall default. Reaching it means the result set may be truncated. */
export const RECALL_DEFAULT_LIMIT = 10;

/** The client never retries for us, so retries live here: 4 attempts, exponential + jitter. */
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_JITTER_MS = 250;

/**
 * Content-addressed ledger of memories this browser already persisted.
 * The relayer does not deduplicate, so a retry after a network blip would store
 * the same text twice and pollute later recall. Keyed `sha256(namespace + ':' + text)`.
 */
const WRITE_LEDGER_KEY = 'mysocial-agent-memory-writes-v1';
const WRITE_LEDGER_MAX = 1000;
let writeLedger: Set<string> | null = null;

export interface AskMemory {
  blob_id?: string;
  text?: string;
  distance?: number;
}

export interface AskResult {
  answer: string;
  memories_used: number;
  memories: AskMemory[];
  amount_mist: number | null;
}

export interface LlmModelOption {
  id: string;
  display_name: string;
  context_length: number | null;
  input_usd_per_1m: number | null;
  output_usd_per_1m: number | null;
}

export interface AgentLlmModel {
  model_id: string;
  source: 'saved' | 'default';
}

export type MemoryClientErrorKind =
  | 'insufficient_credits'
  | 'approval_required'
  | 'missing_capability'
  | 'unreachable'
  | 'revoked'
  | 'unknown';

export class MemoryClientError extends Error {
  constructor(
    message: string,
    readonly kind: MemoryClientErrorKind,
    readonly thresholdMist?: number,
    readonly estimatedMist?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MemoryClientError';
  }

  /**
   * Whether the same call could succeed on a retry.
   *
   * A 4xx is a configuration, permission or credit problem and fails identically
   * every attempt, so retrying only delays the real fix. Network failures and
   * server errors (including the 503 `upstream unavailable` the relayer returns
   * when it cannot consult chain state) are worth another try.
   */
  get retryable(): boolean {
    if (this.kind === 'unreachable') return true;
    if (
      this.kind === 'insufficient_credits' ||
      this.kind === 'approval_required' ||
      this.kind === 'missing_capability' ||
      this.kind === 'revoked'
    ) {
      return false;
    }
    if (this.status === undefined) return true;
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

/** Dev uses the Vite `/api/memory` proxy; production calls the server origin directly. */
export function memoryServerUrl(): string {
  if (import.meta.env.DEV) return '/api/memory';
  const raw = (import.meta.env.VITE_MEMORY_SERVER_URL || '').replace(/\/+$/, '');
  return raw || 'http://127.0.0.1:8000';
}

/**
 * Headless agent init: key + account id + server URL, nothing else.
 *
 * This is the same three-field shape the Walrus Memory headless-setup guide uses,
 * and it is what lets an agent run at boot with no wallet prompt. `serverUrl` is
 * always passed explicitly so the target network is never ambiguous — a network
 * mismatch is the most common cause of an otherwise opaque auth failure.
 */
export interface HeadlessAgentMemoryConfig {
  /** Ed25519 seed the agent signs with. Never the human login key. */
  key: Uint8Array | number[];
  /** `MemoryAccount` object id the agent is registered under. */
  accountId: string;
  /** Memory server origin. Defaults to `memoryServerUrl()`. */
  serverUrl?: string;
  /** Namespace scoping recall and writes. Defaults to {@link CHAT_NAMESPACE}. */
  namespace?: string;
  signal?: AbortSignal;
  platformId?: string;
}

/**
 * Build a memory client from a headless config. No vault, no wallet, no prompt —
 * suitable for a service, a worker, or a scheduled automation.
 */
export function createHeadlessAgentMemoryClient(
  config: HeadlessAgentMemoryConfig,
): Memory {
  const key = config.key instanceof Uint8Array ? config.key : Uint8Array.from(config.key);
  if (key.length !== 32) {
    throw new MemoryClientError(
      `Agent memory key must be a 32-byte Ed25519 seed, got ${key.length} bytes.`,
      'unknown',
    );
  }
  if (!config.accountId) {
    throw new MemoryClientError(
      'Agent memory client needs the MemoryAccount id it was registered under.',
      'unknown',
    );
  }
  return Memory.create({
    key: new Uint8Array(key),
    signal: config.signal,
    platformId: config.platformId,
    accountId: config.accountId,
    serverUrl: (config.serverUrl || memoryServerUrl()).replace(/\/+$/, ''),
    namespace: config.namespace ?? CHAT_NAMESPACE,
  });
}

export function createAgentMemoryClient(
  key: AgentSigningKey,
  accountId: string,
): Memory {
  return Memory.create({
    key: new Uint8Array(key.seed),
    signal: key.signal,
    platformId: key.platformId,
    accountId,
    serverUrl: memoryServerUrl(),
    namespace: CHAT_NAMESPACE,
  });
}

/**
 * Liveness probe used before an agent does memory work.
 *
 * `health()` is unauthenticated: it confirms the server answers, not that this
 * key and account id are authorized. It is a cheap "is memory up at all" gate so
 * a temporary outage degrades a turn instead of failing it.
 */
export async function probeAgentMemory(memory: Memory): Promise<boolean> {
  try {
    await memory.health();
    return true;
  } catch {
    return false;
  }
}

/** Retry a memory operation, failing fast on anything a retry cannot fix. */
export async function withMemoryRetry<T>(
  operation: () => Promise<T>,
  attempts = RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: MemoryClientError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const classified = classifyMemoryError(error);
      if (!classified.retryable || attempt === attempts - 1) throw classified;
      lastError = classified;
      const backoff = 2 ** attempt * RETRY_BASE_MS + Math.random() * RETRY_MAX_JITTER_MS;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError ?? new MemoryClientError('Memory request failed', 'unknown');
}

async function memoryWriteKey(namespace: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${namespace}:${text}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ledger(): Set<string> {
  if (!writeLedger) {
    try {
      const raw = globalThis.localStorage?.getItem(WRITE_LEDGER_KEY);
      writeLedger = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      writeLedger = new Set<string>();
    }
  }
  return writeLedger;
}

function persistLedger(): void {
  if (!writeLedger) return;
  try {
    const trimmed = Array.from(writeLedger).slice(-WRITE_LEDGER_MAX);
    globalThis.localStorage?.setItem(WRITE_LEDGER_KEY, JSON.stringify(trimmed));
  } catch {
    // Private mode or a full quota: the guard stays best-effort in-memory.
  }
}

/** Test seam: forget which memories this browser believes it already wrote. */
export function resetMemoryWriteLedger(): void {
  writeLedger = null;
}

export interface RememberFactsResult {
  /** Memories that reached a terminal `done` job and were recorded as written. */
  written: number;
  /** Duplicates, blanks, and writes dropped by the per-cycle budget. */
  skipped: number;
  jobIds: string[];
}

/**
 * Write → confirm persistence, batched.
 *
 * Duplicate texts are dropped by the content-addressed ledger, the batch is
 * chunked to {@link REMEMBER_BULK_MAX}, and the call only returns once every job
 * reports `done`. A job that is not `done` throws: an agent must not act on a
 * memory it only believes it wrote.
 */
export async function rememberAgentFacts(
  memory: Memory,
  texts: readonly string[],
  visibility: MemoryVisibility = 'private',
): Promise<RememberFactsResult> {
  const pending: string[] = [];
  const pendingKeys: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const candidate of texts) {
    const text = candidate.trim();
    if (!text) {
      skipped++;
      continue;
    }
    const key = await memoryWriteKey(CHAT_NAMESPACE, text);
    if (seen.has(key) || ledger().has(key)) {
      skipped++;
      continue;
    }
    if (pending.length >= MAX_WRITES_PER_CYCLE) {
      skipped++;
      continue;
    }
    seen.add(key);
    pending.push(text);
    pendingKeys.push(key);
  }

  if (pending.length === 0) return {written: 0, skipped, jobIds: []};

  const jobIds: string[] = [];
  let written = 0;
  for (let offset = 0; offset < pending.length; offset += REMEMBER_BULK_MAX) {
    const chunk = pending.slice(offset, offset + REMEMBER_BULK_MAX);
    const chunkKeys = pendingKeys.slice(offset, offset + REMEMBER_BULK_MAX);
    const accepted = await withMemoryRetry(() =>
      memory.rememberBulk(chunk, {visibility, subLabel: CHAT_NAMESPACE}),
    );
    jobIds.push(...accepted.job_ids);
    const settled = await withMemoryRetry(() =>
      memory.waitForRememberBulk(accepted.job_ids),
    );
    const failed = settled.filter((job) => job.status !== 'done');
    if (failed.length > 0) {
      throw new MemoryClientError(
        `${failed.length} of ${settled.length} memories did not persist; not treating this turn as saved.`,
        'unknown',
      );
    }
    for (const key of chunkKeys) ledger().add(key);
    written += chunkKeys.length;
    persistLedger();
  }
  return {written, skipped, jobIds};
}

/** Single-fact write. Shares the dedupe ledger and confirm-before-return contract. */
export async function rememberAgentFact(
  memory: Memory,
  text: string,
  visibility: MemoryVisibility = 'private',
): Promise<void> {
  await rememberAgentFacts(memory, [text], visibility);
}

export interface AgentRecallResult {
  memories: AskMemory[];
  /**
   * The relayer caps recall at `limit` and drops the rest with no truncation
   * signal, so a full page is the only evidence there may be more matches.
   */
  truncated: boolean;
}

/** Recall stored facts for a query. Only called when a turn actually needs them. */
export async function recallAgentMemories(
  memory: Memory,
  query: string,
  limit = RECALL_DEFAULT_LIMIT,
): Promise<AgentRecallResult> {
  const recalled = await withMemoryRetry(() =>
    memory.recall(query, {limit, subLabel: CHAT_NAMESPACE}),
  );
  const results: RecallMemory[] = recalled.results ?? [];
  return {
    memories: results.map((row) => ({
      blob_id: row.blob_id,
      text: row.text,
      distance: row.distance,
    })),
    truncated: results.length >= limit,
  };
}

/**
 * `POST /api/ask` is not wrapped by `@socialproof/memory` yet. Reuses the
 * client's private `signedRequest` so the MyData session + Ed25519 envelope
 * (`{ts}.{method}.{path}.{body_sha256}.{nonce}.{account_id}`) stay in lockstep.
 *
 * Generation is served by the AI-credit gateway (`chat → gateway → OpenRouter`),
 * never by a provider key in the browser: the memory server owns the oracle
 * secret and the reservation, and `idempotencyKey` is what makes a retry of one
 * logical turn safe to bill.
 */
export async function askAgent(
  memory: Memory,
  args: {
    question: string;
    scope?: RecallScope;
    limit?: number;
    /** `false` answers from the model alone: no embedding, search, or decrypt. */
    recall?: boolean;
    idempotencyKey?: string;
    modelId?: string;
  },
): Promise<AskResult> {
  const send = () =>
    memory.request<{
      answer?: string;
      memories_used?: number;
      memories?: AskMemory[] | RecallMemory[];
      amount_mist?: number;
    }>('POST', '/api/ask', {
      question: args.question,
      limit: args.limit ?? 5,
      namespace: CHAT_NAMESPACE,
      ...(args.scope ? {scope: args.scope} : {}),
      ...(args.recall === undefined ? {} : {recall: args.recall}),
      ...(args.idempotencyKey ? {idempotency_key: args.idempotencyKey} : {}),
      ...(args.modelId ? {model_id: args.modelId} : {}),
    });

  // A retry without an idempotency key could reserve and bill twice, so an
  // unkeyed ask is attempted exactly once.
  try {
    const body = args.idempotencyKey
      ? await withMemoryRetry(send)
      : await send();
    const memories = (body.memories ?? []).map((row) => ({
      blob_id: row.blob_id,
      text: row.text,
      distance: row.distance,
    }));
    return {
      answer: body.answer ?? '',
      memories_used: body.memories_used ?? memories.length,
      memories,
      amount_mist: typeof body.amount_mist === 'number' ? body.amount_mist : null,
    };
  } catch (error) {
    throw classifyMemoryError(error);
  }
}

async function signedMemoryRequest<T>(
  memory: Memory,
  method: string,
  path: string,
  body: object,
): Promise<T> {
  try {
    return await withMemoryRetry(() => memory.request<T>(method, path, body));
  } catch (error) {
    throw classifyMemoryError(error);
  }
}

export function listLlmModels(memory: Memory): Promise<{models: LlmModelOption[]}> {
  return signedMemoryRequest(memory, 'GET', '/api/models', {});
}

export async function getAgentLlmModel(memory: Memory): Promise<AgentLlmModel> {
  const body = await signedMemoryRequest<{model_id?: string; source?: string}>(
    memory,
    'GET',
    '/api/agent/llm-model',
    {},
  );
  return {
    model_id: body.model_id ?? '',
    source: body.source === 'saved' ? 'saved' : 'default',
  };
}

export async function setAgentLlmModel(memory: Memory, modelId: string): Promise<AgentLlmModel> {
  const body = await signedMemoryRequest<{model_id?: string; source?: string}>(
    memory,
    'PUT',
    '/api/agent/llm-model',
    {model_id: modelId},
  );
  return {
    model_id: body.model_id ?? modelId,
    source: body.source === 'default' ? 'default' : 'saved',
  };
}

export function classifyMemoryError(error: unknown): MemoryClientError {
  if (error instanceof MemoryClientError) return error;
  if (error instanceof AiCreditApprovalRequiredError) {
    return new MemoryClientError(
      error.message,
      'approval_required',
      error.thresholdMist,
      error.estimatedMist,
    );
  }

  const err = error as Error & {status?: number; serverCode?: string; cause?: string};
  const message = err.message || 'Memory request failed';
  const status = typeof err.status === 'number' ? err.status : undefined;
  const combined = `${message} ${err.serverCode ?? ''} ${err.cause ?? ''}`.toLowerCase();

  if (
    err.name === 'TypeError' ||
    /failed to fetch|networkerror|econnrefused|unreachable/i.test(message)
  ) {
    return new MemoryClientError(
      'Memory server is unreachable. Confirm it is running and VITE_MEMORY_SERVER_URL is set.',
      'unreachable',
      undefined,
      undefined,
      status,
    );
  }
  if (
    err.serverCode === AI_CREDIT_DEPLETED_CODE ||
    /insufficient[_ ]ai[_ ]credits|insufficient credits/i.test(combined)
  ) {
    return new MemoryClientError(message, 'insufficient_credits', undefined, undefined, status);
  }
  if (
    err.serverCode === AI_CREDIT_APPROVAL_REQUIRED_CODE ||
    err.status === 402
  ) {
    return new MemoryClientError(message, 'approval_required', undefined, undefined, status);
  }
  if (
    /cap_ai_spend|cap_memory|missing cap|e_sub_agent_missing_cap|capability/i.test(combined)
  ) {
    return new MemoryClientError(message, 'missing_capability', undefined, undefined, status);
  }
  if (/revok|deactiv|not active|e_sub_agent_not_active/i.test(combined)) {
    return new MemoryClientError(
      'This agent was revoked or deactivated and can no longer chat.',
      'revoked',
      undefined,
      undefined,
      status,
    );
  }
  return new MemoryClientError(message, 'unknown', undefined, undefined, status);
}
