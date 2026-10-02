import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';

import {collectAllPages} from '../pagination';
import {
  fetchMemoryAccount,
  fetchOrganizationMessagingGroups,
  fetchOrganizationRoles,
  fetchOrganizations,
  fetchSubAgents,
  SocialServerError,
} from './social-api';

const BASE = 'http://social.test';

const QUERY_DESERIALIZE_ERROR =
  'Failed to deserialize query string: invalid type: string "50", expected i64';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {status, headers: {'content-type': 'text/plain'}});
}

function orgRow(index: number) {
  return {
    organization_id: `0xorg${index}`,
    account_id: '0xacc',
    principal_owner: '0xowner',
    profile_id: '0xprofile',
    name: `Org ${index}`,
    description: null,
    org_type: 9,
    root_agent_id: null,
    active: true,
    created_at_ms: index,
    deactivated_at_ms: null,
    org_memory_group_id: null,
  };
}

describe('social-api pagination', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SOCIAL_SERVER_URL', BASE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends limit, offset and filters, and reads total_count', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({organizations: [orgRow(0)], total_count: 7}),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchOrganizations('0xowner', {
      activeOnly: false,
      limit: 100,
      offset: 200,
    });

    expect(page.items).toHaveLength(1);
    expect(page.totalCount).toBe(7);
    expect(page.pagingSupported).toBe(true);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/profiles/0xowner/organizations');
    expect(url.searchParams.get('active_only')).toBe('false');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('200');
  });

  it('retries once without pagination params when the server rejects them', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=')) return textResponse(QUERY_DESERIALIZE_ERROR, 400);
      return jsonResponse({organizations: [orgRow(0), orgRow(1)], total_count: 2});
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchOrganizations('0xowner', {
      activeOnly: false,
      limit: 100,
      offset: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.pagingSupported).toBe(false);
    expect(page.items).toHaveLength(2);

    const retryUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(retryUrl.searchParams.get('limit')).toBeNull();
    expect(retryUrl.searchParams.get('offset')).toBeNull();
    expect(retryUrl.searchParams.get('page')).toBeNull();
    // Filters must survive the fallback, or the list would silently change meaning.
    expect(retryUrl.searchParams.get('active_only')).toBe('false');
  });

  it('does not retry a 400 that is not a query-deserialization failure', async () => {
    const fetchMock = vi.fn(async () => textResponse('Unknown leaderboard sort', 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchOrganizations('0xowner', {activeOnly: true, limit: 10, offset: 0}),
    ).rejects.toBeInstanceOf(SocialServerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates server errors with their status', async () => {
    const fetchMock = vi.fn(async () => textResponse('boom', 500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSubAgents('0xowner', {activeOnly: false, limit: 100, offset: 0}),
    ).rejects.toMatchObject({status: 500});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a missing memory account (404) to null instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('not found', 404)));

    await expect(fetchMemoryAccount('0xnobody')).resolves.toBeNull();
  });

  it('parses the camelCase messaging-agent-group shape', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          groupId: '0xgroup',
          creatorActor: '0xagent',
          creatorPrincipal: '0xowner',
          creatorSubAgentId: '0xsub',
          creatorIdentityClass: 1,
          organizationId: '0xorg',
          groupName: 'Agent Chat',
          groupUuid: 'uuid-1',
          createdAtMs: 123,
          transactionId: 'digest',
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchOrganizationMessagingGroups('0xorg', {limit: 50, offset: 0});

    expect(page.items[0]!.groupUuid).toBe('uuid-1');
    expect(page.items[0]!.creatorSubAgentId).toBe('0xsub');
    expect(page.items[0]!.groupName).toBe('Agent Chat');
    expect(page.totalCount).toBeNull();
    expect(page.pagingSupported).toBe(true);
  });

  it('binds a fresh wallet signature per signed request', async () => {
    const signer = Ed25519Keypair.generate();
    const signSpy = vi.spyOn(signer, 'signPersonalMessage');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await fetchOrganizationRoles('0xorg', signer, {limit: 50, offset: 0});
    await fetchOrganizationRoles('0xorg', signer, {limit: 50, offset: 50});

    expect(signSpy).toHaveBeenCalledTimes(2);
    const first = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    const second = new Headers(fetchMock.mock.calls[1]![1]!.headers);
    expect(first.get('X-Signature')).toBeTruthy();
    expect(first.get('X-Public-Key')).toBeTruthy();
    expect(first.get('X-Sender-Address')).toBe(signer.toMySoAddress());
    expect(second.get('X-Timestamp')).toBeTruthy();
  });

  it('retries a signed read without pagination params and re-signs', async () => {
    const signer = Ed25519Keypair.generate();
    const signSpy = vi.spyOn(signer, 'signPersonalMessage');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=')) return textResponse(QUERY_DESERIALIZE_ERROR, 400);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchOrganizationRoles('0xorg', signer, {limit: 50, offset: 0});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signSpy).toHaveBeenCalledTimes(2);
    expect(page.pagingSupported).toBe(false);
  });
});

describe('social-api + collectAllPages', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SOCIAL_SERVER_URL', BASE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('walks all 150 organizations across the 100-row server clamp', async () => {
    const all = Array.from({length: 150}, (_, i) => orgRow(i));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return jsonResponse({
        organizations: all.slice(offset, offset + limit),
        total_count: all.length,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await collectAllPages(
      (request) => fetchOrganizations('0xowner', {activeOnly: false, ...request}),
      {keyOf: (row) => row.organization_id},
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(150);
    expect(new Set(result.items.map((r) => r.organization_id)).size).toBe(150);
    expect(result.complete).toBe(true);
    expect(result.totalCount).toBe(150);
  });

  it('reports an explicitly incomplete list when pagination is unsupported', async () => {
    const all = Array.from({length: 20}, (_, i) => orgRow(i));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=')) return textResponse(QUERY_DESERIALIZE_ERROR, 400);
      return jsonResponse({organizations: all, total_count: 150});
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await collectAllPages(
      (request) => fetchOrganizations('0xowner', {activeOnly: false, ...request}),
      {keyOf: (row) => row.organization_id},
    );

    expect(result.items).toHaveLength(20);
    expect(result.totalCount).toBe(150);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('unsupported');
  });
});
