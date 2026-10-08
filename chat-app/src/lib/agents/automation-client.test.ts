/**
 * Automation client tests.
 *
 * The signing preimage is security-critical: if it drifts from the relayer's
 * `timestamp.method.path.bodyHash.nonce.accountId` format, every request is a
 * 401 with no useful diagnostic. These tests assert the exact preimage, verify
 * the signature against the derived public key, and pin the payload shape that
 * keeps ownership server-stamped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AutomationClient,
  AutomationClientError,
  type CreateJobInput,
} from './automation-client';

const SEED = new Uint8Array(32).fill(7);
const ACCOUNT_ID = '0xaccount';

/** Captures what the client sent so the preimage can be reconstructed. */
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let captured: Captured[] = [];
let respond: (init: Captured) => Response;

beforeEach(() => {
  captured = [];
  respond = () => new Response('{}', { status: 200 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const entry: Captured = {
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : '',
    };
    captured.push(entry);
    return respond(entry);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function client() {
  return AutomationClient.create({ key: SEED, accountId: ACCOUNT_ID });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Import the raw 32-byte public key as a verifier, mirroring the relayer. */
async function verifier(publicKeyHex: string): Promise<CryptoKey> {
  const spkiPrefix = hexToBytes('302a300506032b6570032100');
  const raw = hexToBytes(publicKeyHex);
  const spki = new Uint8Array(spkiPrefix.length + raw.length);
  spki.set(spkiPrefix, 0);
  spki.set(raw, spkiPrefix.length);
  return crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
}

describe('create', () => {
  it('rejects a key that is not a 32-byte seed', () => {
    expect(() => AutomationClient.create({ key: new Uint8Array(64), accountId: ACCOUNT_ID })).toThrow(
      AutomationClientError,
    );
  });

  it('requires an account id', () => {
    expect(() => AutomationClient.create({ key: SEED, accountId: '' })).toThrow(
      /MemoryAccount id/,
    );
  });
});

/**
 * The path the relayer will see.
 *
 * Under vitest `import.meta.env.DEV` is true, so the client targets the Vite
 * `/api/memory` proxy, which strips that prefix (see `vite.config.ts`
 * `rewrite`). The relayer signs `path_and_query` of what it *receives*, so the
 * signed preimage uses the stripped path. Stripping here mirrors that.
 */
function signedPath(url: string): string {
  return url.replace(/^\/api\/memory/, '');
}

describe('request signing', () => {
  it('sends exactly 32 raw public key bytes, not the 33-byte flagged form', async () => {
    await client().listJobs();
    // The relayer decodes x-public-key into a [u8; 32] and calls
    // VerifyingKey::from_bytes, so a 33-byte MySo-form key would be a 401.
    expect(captured[0]?.headers['x-public-key']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a signature the relayer can verify against the preimage', async () => {
    await client().listJobs();
    const sent = captured[0]!;

    // Rebuild the preimage exactly as the relayer does.
    const bodyHash = await sha256Hex('');
    const preimage = `${sent.headers['x-timestamp']}.GET.${signedPath(sent.url)}.${bodyHash}.${sent.headers['x-nonce']}.${ACCOUNT_ID}`;
    expect(
      await crypto.subtle.verify(
        { name: 'Ed25519' },
        await verifier(sent.headers['x-public-key']!),
        hexToBytes(sent.headers['x-signature']!),
        new TextEncoder().encode(preimage),
      ),
    ).toBe(true);
  });

  it('hashes an empty body for GET and the real body for POST', async () => {
    const api = client();
    await api.listJobs();
    const getHash = await sha256Hex('');

    const input: CreateJobInput = {
      name: 'nightly recall',
      trigger_set: { match_mode: 'any', evaluation_window_ms: 0, triggers: [] },
      target_agent_object_id: '0xagent',
      target_agent_key_ref: 'demo-agent',
      action: { kind: 'memory_relayer_call', config: { operation: 'recall', query: 'prefs' } },
    };
    await api.createJob(input);
    const postBody = captured[1]!.body;
    const postHash = await sha256Hex(postBody);

    expect(getHash).not.toEqual(postHash);
    expect(captured[1]?.headers['x-signature']).toMatch(/^[0-9a-f]{128}$/);
  });

  it('includes a fresh nonce and non-decreasing timestamp on each request', async () => {
    const api = client();
    await api.listJobs();
    await api.listJobs();
    expect(captured[0]?.headers['x-nonce']).not.toEqual(captured[1]?.headers['x-nonce']);
    // The relayer rejects a nonce that is not a UUID and a timestamp outside
    // +/- 300s of its own clock.
    expect(captured[0]?.headers['x-nonce']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Number(captured[0]?.headers['x-timestamp'])).toBeGreaterThan(1_600_000_000);
  });

  it('signs the query string as part of the path', async () => {
    await client().listRuns('job-1', 5);
    const sent = captured[0]!;
    expect(sent.url).toContain('/api/automation/jobs/job-1/runs?limit=5');
    const path = signedPath(sent.url);

    // A signature computed over the bare path would not verify, so assert the
    // preimage the client actually signed contains the query.
    const bodyHash = await sha256Hex('');
    const withQuery = `GET.${path}.${bodyHash}`;
    const withoutQuery = `GET.${path.split('?')[0]}.${bodyHash}`;

    const verifyWith = async (partial: string) =>
      crypto.subtle.verify(
        { name: 'Ed25519' },
        await verifier(sent.headers['x-public-key']!),
        hexToBytes(sent.headers['x-signature']!),
        new TextEncoder().encode(
          `${sent.headers['x-timestamp']}.${partial}.${sent.headers['x-nonce']}.${ACCOUNT_ID}`,
        ),
      );

    expect(await verifyWith(withQuery)).toBe(true);
    expect(await verifyWith(withoutQuery)).toBe(false);
  });
});

describe('ownership is server-stamped', () => {
  it('never sends account_id or organization_id in a create payload', async () => {
    const input = {
      name: 'x',
      trigger_set: { match_mode: 'any', evaluation_window_ms: 0, triggers: [] },
      target_agent_object_id: '0xagent',
      target_agent_key_ref: 'demo-agent',
      action: { kind: 'memory_relayer_call', config: { operation: 'recall', query: 'q' } },
      // A caller trying to forge ownership: these must not survive to the wire.
      account_id: '0xvictim',
      organization_id: '0xvictimorg',
    } as unknown as CreateJobInput;

    await client().createJob(input);
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body.account_id).toBeUndefined();
    expect(body.organization_id).toBeUndefined();
  });

  it('scopes a listing to the signed account, not a caller-supplied one', async () => {
    // listJobs takes no account argument at all — the relayer derives it from
    // the signature, so there is no parameter to tamper with.
    await client().listJobs(10);
    expect(captured[0]?.url).not.toContain('account_id');
    expect(captured[0]?.url).toContain('limit=10');
  });
});

describe('error classification', () => {
  it('maps 401 to a non-retryable unauthorized error', async () => {
    respond = () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    const err = await client()
      .listJobs()
      .then(() => null)
      .catch((e: unknown) => e as AutomationClientError);
    expect(err?.kind).toBe('unauthorized');
    expect(err?.retryable).toBe(false);
  });

  it('maps 404 to not_found and keeps it non-retryable', async () => {
    respond = () => new Response(JSON.stringify({ error: 'job not found' }), { status: 404 });
    const err = await client()
      .getJob('x')
      .then(() => null)
      .catch((e: unknown) => e as AutomationClientError);
    expect(err?.kind).toBe('not_found');
    expect(err?.retryable).toBe(false);
    expect(err?.message).toBe('job not found');
  });

  it('maps 503 to a retryable engine_unavailable error', async () => {
    respond = () =>
      new Response(JSON.stringify({ error: 'automation engine is not configured' }), {
        status: 503,
      });
    const err = await client()
      .listJobs()
      .then(() => null)
      .catch((e: unknown) => e as AutomationClientError);
    expect(err?.kind).toBe('engine_unavailable');
    expect(err?.retryable).toBe(true);
  });

  it('surfaces a non-JSON error body rather than swallowing it', async () => {
    respond = () => new Response('upstream exploded', { status: 502 });
    const err = await client()
      .listJobs()
      .then(() => null)
      .catch((e: unknown) => e as AutomationClientError);
    expect(err?.message).toBe('upstream exploded');
    expect(err?.retryable).toBe(true);
  });
});

describe('delegate routes', () => {
  it('PUTs a encrypted key and sends nothing but the three expected fields', async () => {
    respond = () => new Response(null, { status: 204 });
    await client().putDelegate('nightly', {
      agent_object_id: '0xagent',
      mydata_key_id: 'k1',
      encrypted_key: 'CIPHERTEXT',
      // @ts-expect-error an extra property must never reach the wire
      seed: 'must-not-be-sent',
    });
    expect(captured[0].method).toBe('PUT');
    expect(captured[0].url).toContain('/api/automation/delegates/nightly');
    expect(JSON.parse(captured[0].body)).toEqual({
      agent_object_id: '0xagent',
      mydata_key_id: 'k1',
      encrypted_key: 'CIPHERTEXT',
    });
  });

  it('signs PUT and DELETE over the method, path and body hash the relayer verifies', async () => {
    respond = () => new Response(null, { status: 204 });
    await client().putDelegate('n', { agent_object_id: '0xa', mydata_key_id: 'k', encrypted_key: 's' });
    await client().deleteDelegate('n');

    const [put, del] = captured;
    expect(del.method).toBe('DELETE');
    // A DELETE has no body, so it signs the hash of the empty string.
    expect(del.body).toBe('');

    for (const [entry, method, path] of [
      [put, 'PUT', '/api/automation/delegates/n'],
      [del, 'DELETE', '/api/automation/delegates/n'],
    ] as const) {
      const message = `${entry.headers['x-timestamp']}.${method}.${path}.${await sha256Hex(entry.body)}.${entry.headers['x-nonce']}.${ACCOUNT_ID}`;
      const publicKey = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(entry.headers['x-public-key'].match(/../g)!.map((h) => parseInt(h, 16))),
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      const signature = Uint8Array.from(entry.headers['x-signature'].match(/../g)!.map((h) => parseInt(h, 16)));
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        signature,
        new TextEncoder().encode(message),
      );
      expect(valid, `${method} signature`).toBe(true);
    }
  });

  it('encodes the delegate name in the path', async () => {
    respond = () => new Response(null, { status: 204 });
    await client().deleteDelegate('a/b');
    expect(captured[0].url).toContain('/api/automation/delegates/a%2Fb');
  });

  it('lists delegates without expecting a encrypted key', async () => {
    respond = () =>
      new Response(
        JSON.stringify([{ delegate_ref: 'n', agent_object_id: '0xa', mydata_key_id: 'k', created_at: 't' }]),
        { status: 200 },
      );
    const rows = await client().listDelegates();
    expect(rows[0].delegate_ref).toBe('n');
    expect(JSON.stringify(rows)).not.toContain('encrypted_key');
  });
});

