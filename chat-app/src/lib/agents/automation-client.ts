/**
 * Automation client.
 *
 * Mirrors `memory-client.ts`: the browser never holds an internal secret and
 * never talks to the automation engine directly. It signs requests with the
 * agent key and the memory relayer proxies them, enforcing that a caller only
 * ever sees its own jobs — the engine's own job API is secret-gated because a
 * job row names an organization, an account, and an agent key ref.
 *
 * Dev uses the Vite `/api/memory` proxy so the browser sees one origin;
 * production calls the relayer origin directly and the relayer's
 * ALLOWED_ORIGINS must include this app.
 */

import { MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION } from '@socialproof/memory';

/**
 * A relayer-signed request identity.
 *
 * The relayer's middleware verifies a raw Ed25519 signature over
 * `timestamp.method.path.bodyHash.nonce.accountId`, where `path` is the
 * path *with* query string.
 */
export interface AutomationSigner {
    /** 32-byte Ed25519 seed the agent signs with. */
    key: Uint8Array;
    /** `MemoryAccount` object id the agent is registered under. */
    accountId: string;
}

/** Same origin resolution the memory client uses — one relayer, one origin. */
function relayerBaseUrl(): string {
    if (import.meta.env.DEV) return '/api/memory';
    const raw = (import.meta.env.VITE_MEMORY_SERVER_URL || '').replace(/\/+$/, '');
    return raw || 'http://127.0.0.1:8000';
}

/** A trigger within a job's TriggerSet. Mirrors the engine's `EventTrigger`. */
export interface AutomationTrigger {
    kind: 'cron' | 'interval' | 'conditional' | 'event';
    cron_expr?: string;
    interval_ms?: number;
    event_family?: string;
    event_type?: string;
    organization_id?: string;
    account_id?: string;
    agent_object_id?: string;
    payload_filter?: Record<string, unknown>;
    debounce_window_ms?: number;
    cooldown_ms?: number;
    max_executions_per_window?: number;
    replay_behavior?: 'skip' | 'allow_once' | 'allow_all';
}

export interface AutomationTriggerSet {
    match_mode: 'any' | 'all';
    evaluation_window_ms: number;
    triggers: AutomationTrigger[];
}

/** `action.config` for a memory action. Mirrors the engine's memory action shape. */
export interface MemoryActionConfig {
    operation: 'recall' | 'remember' | 'recall_then_remember';
    key_ref?: string;
    query?: string;
    text?: string;
    limit?: number;
    namespace?: string;
    remember_prefix?: string;
    wait?: boolean;
}

/** A stored delegate, as listed. The encrypted key is never returned. */
export interface AutomationDelegate {
    delegate_ref: string;
    agent_object_id: string;
    mydata_key_id: string;
    created_at: string;
}

export interface AutomationJob {
    id: string;
    organization_id: string;
    account_id: string;
    name: string;
    enabled: boolean;
    trigger_set: AutomationTriggerSet;
    target_agent_object_id: string;
    target_agent_key_ref: string;
    action: {
        kind: 'memory_relayer_call' | 'social_action' | 'webhook';
        config: MemoryActionConfig;
    };
    memory_scope: string;
    max_mist_per_run: number;
    retry_policy: { max_attempts: number; jitter_ms: number };
}

export interface AutomationRun {
    id: string;
    job_id: string;
    status: 'running' | 'succeeded' | 'skipped' | 'failed';
    /** How many action attempts were made, so a retried run is visible. */
    attempt: number;
    cost_mist?: number;
    error?: string;
    started_at: string;
    finished_at?: string;
}

/**
 * A job to create.
 *
 * `organization_id` and `account_id` are absent on purpose: the relayer stamps
 * them from the verified signature, so a caller cannot create a job owned by
 * someone else by editing the payload.
 */
export interface CreateJobInput {
    name: string;
    trigger_set: AutomationTriggerSet;
    target_agent_object_id: string;
    target_agent_key_ref: string;
    action: { kind: 'memory_relayer_call'; config: MemoryActionConfig };
    memory_scope?: string;
    max_mist_per_run?: number;
    retry_policy?: { max_attempts: number; jitter_ms: number };
}

/**
 * Thrown for a non-2xx automation response, with retryability encoded.
 */
export class AutomationClientError extends Error {
    constructor(
        message: string,
        readonly kind:
            | 'unauthorized'
            | 'not_found'
            | 'invalid_request'
            | 'engine_unavailable'
            | 'unknown',
        readonly status?: number,
    ) {
        super(message);
        this.name = 'AutomationClientError';
    }

    /** Mirrors the memory client's rule: never retry a 4xx. */
    get retryable(): boolean {
        if (
            this.kind === 'unauthorized' ||
            this.kind === 'invalid_request' ||
            this.kind === 'not_found'
        ) {
            return false;
        }
        if (this.status === undefined) return true;
        return this.status >= 500 || this.status === 408 || this.status === 429;
    }
}

function classify(status: number, message: string): AutomationClientError {
    if (status === 401 || status === 403) {
        return new AutomationClientError(message, 'unauthorized', status);
    }
    if (status === 404) return new AutomationClientError(message, 'not_found', status);
    if (status >= 400 && status < 500) {
        return new AutomationClientError(message, 'invalid_request', status);
    }
    return new AutomationClientError(message, 'engine_unavailable', status);
}

/**
 * PKCS#8 DER prefix for an Ed25519 private key, followed by the 32-byte seed.
 *
 * Lets WebCrypto import a raw seed without a third-party Ed25519 dependency.
 * Verified to produce byte-identical signatures to the `@noble/ed25519` the
 * Memory SDK signs with, which is what makes the relayer accept them.
 */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
    0x20,
]);

function base64UrlToBytes(value: string): Uint8Array {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function toHex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return toHex(new Uint8Array(digest));
}

/** An imported Ed25519 signing key plus its raw 32-byte public key. */
interface ImportedKey {
    cryptoKey: CryptoKey;
    publicKeyHex: string;
}

async function importSigningKey(seed: Uint8Array): Promise<ImportedKey> {
    const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
    pkcs8.set(PKCS8_ED25519_PREFIX, 0);
    pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);

    let cryptoKey: CryptoKey;
    try {
        cryptoKey = await crypto.subtle.importKey(
            'pkcs8',
            pkcs8,
            { name: 'Ed25519' },
            true,
            ['sign'],
        );
    } catch {
        throw new AutomationClientError(
            'This browser cannot import an Ed25519 key for request signing. ' +
                'Automation needs WebCrypto Ed25519 (Chrome 113+, Safari 17+, Firefox 130+).',
            'unknown',
        );
    }

    // The relayer expects exactly 32 raw bytes; the JWK `x` field is
    // base64url of those bytes, whereas the MySo `toMySoBytes()` form is
    // 33 bytes with a scheme flag byte and would be rejected.
    const jwk = (await crypto.subtle.exportKey('jwk', cryptoKey)) as JsonWebKey;
    if (!jwk.x) {
        throw new AutomationClientError(
            'Could not derive the agent public key for request signing.',
            'unknown',
        );
    }
    return { cryptoKey, publicKeyHex: toHex(base64UrlToBytes(jwk.x)) };
}

export class AutomationClient {
    private keyPromise: Promise<ImportedKey> | null = null;

    private constructor(
        private readonly baseUrl: string,
        private readonly signer: AutomationSigner,
    ) {}

    static create(signer: AutomationSigner): AutomationClient {
        if (signer.key.length !== 32) {
            throw new AutomationClientError(
                `Agent signing key must be a 32-byte Ed25519 seed, got ${signer.key.length} bytes.`,
                'unknown',
            );
        }
        if (!signer.accountId) {
            throw new AutomationClientError(
                'Automation client needs the MemoryAccount id the agent is registered under.',
                'unknown',
            );
        }
        return new AutomationClient(relayerBaseUrl(), signer);
    }

    /** Imported once and reused; the relayer signs every request. */
    private importedKey(): Promise<ImportedKey> {
        this.keyPromise ??= importSigningKey(this.signer.key);
        return this.keyPromise;
    }

    private async request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<T> {
        const { cryptoKey, publicKeyHex } = await this.importedKey();

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const hasBody = method === 'POST' || method === 'PUT';
        const bodyStr = hasBody ? JSON.stringify(body ?? {}) : '';
        const bodyHash = await sha256Hex(bodyStr);
        const nonce = crypto.randomUUID();

        // Must match the relayer's preimage exactly, including the query string
        // in `path` — it signs `request.uri().path_and_query()`.
        const message = `${timestamp}.${method}.${path}.${bodyHash}.${nonce}.${this.signer.accountId}`;
        const signature = new Uint8Array(
            await crypto.subtle.sign(
                { name: 'Ed25519' },
                cryptoKey,
                new TextEncoder().encode(message),
            ),
        );

        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                'content-type': 'application/json',
                'x-public-key': publicKeyHex,
                'x-signature': toHex(signature),
                'x-timestamp': timestamp,
                'x-nonce': nonce,
                'x-account-id': this.signer.accountId,
                'x-sdk-compatibility': MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
            },
            body: hasBody ? bodyStr : undefined,
        });

        if (!res.ok) {
            const raw = await res.text();
            let detail = raw.trim();
            try {
                const parsed = JSON.parse(raw) as { error?: string };
                if (parsed.error) detail = parsed.error;
            } catch {
                /* not JSON; keep the raw text */
            }
            throw classify(res.status, detail || `automation request failed (${res.status})`);
        }
        // PUT/DELETE answer 204 with no body.
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
    }

    /** Jobs belonging to the authenticated account. */
    async listJobs(limit?: number): Promise<AutomationJob[]> {
        const query = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;
        return this.request<AutomationJob[]>('GET', `/api/automation/jobs${query}`);
    }

    /** One job. The relayer refuses a job owned by another account. */
    async getJob(jobId: string): Promise<AutomationJob> {
        return this.request<AutomationJob>('GET', `/api/automation/jobs/${jobId}`);
    }

    /** Recent runs for one job, newest first. */
    async listRuns(jobId: string, limit = 20): Promise<AutomationRun[]> {
        return this.request<AutomationRun[]>(
            'GET',
            `/api/automation/jobs/${jobId}/runs?limit=${encodeURIComponent(limit)}`,
        );
    }

    /**
     * Create a job owned by the authenticated identity.
     *
     * The payload is rebuilt field by field rather than forwarded as given, so
     * an unexpected property on the caller's object can never reach the wire.
     */
    async createJob(
        input: CreateJobInput,
    ): Promise<{ id: string; name: string; enabled: boolean }> {
        const payload: Record<string, unknown> = {
            name: input.name,
            trigger_set: input.trigger_set,
            target_agent_object_id: input.target_agent_object_id,
            target_agent_key_ref: input.target_agent_key_ref,
            action: input.action,
        };
        if (input.memory_scope !== undefined) payload.memory_scope = input.memory_scope;
        if (input.max_mist_per_run !== undefined) {
            payload.max_mist_per_run = input.max_mist_per_run;
        }
        if (input.retry_policy !== undefined) payload.retry_policy = input.retry_policy;
        return this.request('POST', '/api/automation/jobs', payload);
    }

    /** Delegates stored for this account. Metadata only. */
    async listDelegates(): Promise<AutomationDelegate[]> {
        return this.request<AutomationDelegate[]>('GET', '/api/automation/delegates');
    }

    /**
     * Store a encrypted delegate key.
     *
     * `encrypted` is ciphertext only the memory bridge can open; this client never
     * sends, and the relayer never returns, a plaintext delegate seed.
     */
    async putDelegate(
        name: string,
        input: {agent_object_id: string; mydata_key_id: string; encrypted_key: string},
    ): Promise<void> {
        await this.request<void>('PUT', `/api/automation/delegates/${encodeURIComponent(name)}`, {
            agent_object_id: input.agent_object_id,
            mydata_key_id: input.mydata_key_id,
            encrypted_key: input.encrypted_key,
        });
    }

    /**
     * Remove the stored copy. The delegate stays valid on-chain until the owner
     * revokes it there; this only stops the bridge from being able to find it.
     */
    async deleteDelegate(name: string): Promise<void> {
        await this.request<void>('DELETE', `/api/automation/delegates/${encodeURIComponent(name)}`);
    }

    /** Liveness probe. Confirms the automation engine is reachable at all. */
    async health(): Promise<{ status: string; service: string; configured: boolean }> {
        return this.request('GET', '/api/automation/health');
    }
}
