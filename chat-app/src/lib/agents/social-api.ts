import {
  parseSerializedSignature,
  type Signer,
} from '@socialproof/myso/cryptography';
import { toHex } from '@socialproof/myso/utils';

import type { PageResult } from '../pagination';

/**
 * Social server reads for the agents workspace. Row shapes mirror
 * `myso-indexer-alt-social-schema` models (snake_case JSON, i64 as number), except the
 * messaging-agent-group route which serializes camelCase.
 *
 * Every list read returns a {@link PageResult} so callers can page with
 * `collectAllPages` / `usePaginatedList` instead of silently truncating at the server's
 * 100-row clamp.
 */

export interface MemoryAccountRow {
  account_id: string;
  principal_owner: string;
  profile_id: string;
  active: boolean;
  created_at_ms: number;
}

export interface SubAgentRow {
  agent_object_id: string;
  derived_address: string;
  account_id: string;
  label: string;
  identity_class: number;
  capabilities: number;
  delegatable_caps: number;
  parent_object_id: string | null;
  depth: number;
  registered_by: string;
  expires_at_ms: number | null;
  active: boolean;
  created_at_ms: number;
  deactivated_at_ms: number | null;
  revoked_at_ms: number | null;
  updated_at_ms: number;
  organization_id: string | null;
}

export interface SubAgentListResponse {
  sub_agents: SubAgentRow[];
  total_count: number;
}

export interface AiCreditBalanceRow {
  balance_id: string;
  memory_account_id: string;
  principal_owner: string;
  balance_mist: number;
  spent_total_mist: number;
  reserved_mist: number;
  daily_cap_mist: number | null;
  monthly_cap_mist: number | null;
  spent_day_mist: number;
  spent_month_mist: number;
  active: boolean;
  updated_at_ms: number;
}

export interface AiCreditAgentBudgetRow {
  balance_id: string;
  agent_object_id: string;
  budget_mist: number | null;
  spent_mist: number;
  reserved_mist: number;
  daily_cap_mist: number | null;
  monthly_cap_mist: number | null;
  require_approval_above_mist: number | null;
  enabled: boolean;
  updated_at_ms: number;
}

export interface AiSpendReservationRow {
  balance_id: string;
  reservation_nonce: number;
  agent_object_id: string;
  status: string;
  max_amount_mist: number;
  captured_mist: number | null;
  hard_expiry_ms: number;
}

export interface AiCreditBalanceResponse {
  balance: AiCreditBalanceRow;
  billing_unit: string;
  available_mist: number;
  agent_budgets: AiCreditAgentBudgetRow[];
  active_reservations: AiSpendReservationRow[];
}

export interface AiCreditUsageLineRow {
  id: number;
  receipt_id: string;
  balance_id: string;
  agent_object_id: string;
  usage_kind: number;
  amount_mist: number;
  model_id: string | null;
  tool_id: string | null;
  settled: boolean;
  created_at: string;
  organization_id: string | null;
}

export interface AiCreditConfigRow {
  min_deposit_mist: number;
  oracle_markup_bps: number;
}

export interface AgenticOrganizationRow {
  organization_id: string;
  account_id: string;
  principal_owner: string;
  profile_id: string;
  name: string | null;
  description: string | null;
  org_type: number;
  root_agent_id: string | null;
  active: boolean;
  created_at_ms: number;
  deactivated_at_ms: number | null;
  org_memory_group_id: string | null;
}

export interface AgenticOrganizationListResponse {
  organizations: AgenticOrganizationRow[];
  total_count: number;
}

export interface OrgMemoryPermissionRow {
  organization_id: string;
  member_address: string;
  permission_kind: number;
  active: boolean;
  granted_by: string;
}

export interface OrgRoleRow {
  organization_id: string;
  role_name: string;
  mask: number;
  is_builtin: boolean;
  active: boolean;
}

export interface OrgRoleAssignmentRow {
  organization_id: string;
  member_address: string;
  role_name: string;
  role_mask: number;
  assigned_mask: number;
  active: boolean;
  assigned_at_ms: number;
}

export interface OrgInvitationRow {
  organization_id: string;
  invitee_address: string;
  role_name: string | null;
  permissions_mask: number;
  status: string;
  invited_by: string;
  created_at_ms: number;
  expires_at_ms: number | null;
}

export interface AiCreditSpendApprovalRow {
  balance_id: string;
  agent_object_id: string;
  status: string;
  requested_amount_mist: number | null;
  threshold_mist: number | null;
  max_amount_mist: number | null;
  expires_at_ms: number | null;
  organization_id: string | null;
  requested_at: string;
}

export interface OrgAuditLogRow {
  id: number;
  time: string;
  source: string;
  actor_address: string;
  actor_type: string;
  action: string;
  target_type: string;
  target_id: string;
  organization_id: string | null;
  account_id: string | null;
  prev_state: unknown;
  new_state: unknown;
  tx_digest: string | null;
  event_id: string | null;
  idempotency_key: string | null;
  metadata: unknown;
}

export interface AgentSpendBreakdownEntry {
  agent_object_id: string;
  label: string;
  derived_address: string;
  spent_mist: number;
  usage_events: number;
  budget_mist: number | null;
  require_approval_above_mist: number | null;
  budget_enabled: boolean;
  memory_entries: number;
  memory_bytes: number;
  org_shared_memory_entries: number;
}

/** `GET /organizations/:id/messaging-groups` — the one camelCase agent-group route. */
export interface MessagingAgentGroupInfo {
  groupId: string;
  creatorActor: string;
  creatorPrincipal: string;
  creatorSubAgentId: string | null;
  creatorIdentityClass: number;
  organizationId: string | null;
  groupName: string;
  groupUuid: string;
  createdAtMs: number;
  transactionId: string;
}

export type OrgStatsWindow = 'days7' | 'days30' | 'days180' | 'days365' | 'all';

export class SocialServerNotConfiguredError extends Error {
  constructor() {
    super('Set VITE_SOCIAL_SERVER_URL to load agents, organizations and AI credits.');
    this.name = 'SocialServerNotConfiguredError';
  }
}

/** Read failure carrying the HTTP status so callers can branch on 400/403/404. */
export class SocialServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SocialServerError';
  }
}

export function socialServerBase(): string {
  return (import.meta.env.VITE_SOCIAL_SERVER_URL || '').replace(/\/+$/, '');
}

function requireBase(): string {
  const base = socialServerBase();
  if (!base) throw new SocialServerNotConfiguredError();
  return base;
}

async function readError(res: Response, path: string): Promise<SocialServerError> {
  const text = await res.text().catch(() => '');
  let message = text;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    message = body.error ?? body.message ?? text;
  } catch {
    // non-JSON body
  }
  return new SocialServerError(
    `Social server ${path} returned ${res.status}${message ? `: ${message}` : ''}`,
    res.status,
    path,
  );
}

async function getJson<T>(
  path: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${requireBase()}${path}`, {
    headers: { Accept: 'application/json', ...headers },
    signal,
  });
  if (!res.ok) throw await readError(res, path);
  return (await res.json()) as T;
}

/** Same as {@link getJson}, but a 404 (nothing indexed yet) resolves to null. */
async function getJsonOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${requireBase()}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res, path);
  return (await res.json()) as T;
}

/** Query params plus the transport-only `signal`, which never becomes a parameter. */
type QueryValue = string | number | boolean | undefined | null | AbortSignal;
type QueryParams = Record<string, QueryValue>;

function signalOf(params: QueryParams): AbortSignal | undefined {
  const value = params.signal;
  return value && typeof value === 'object' && 'aborted' in value
    ? (value as AbortSignal)
    : undefined;
}

const PAGINATION_PARAMS = new Set(['limit', 'offset', 'page']);

function buildQuery(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'signal') continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function isUnsupportedPaginationError(error: unknown): boolean {
  return (
    error instanceof SocialServerError &&
    error.status === 400 &&
    /failed to deserialize query string/i.test(error.message)
  );
}

/**
 * Paged GET. Deployments built before the social server's pagination fix reject numeric
 * query params (`#[serde(flatten)]` made `serde_urlencoded` buffer them as strings), which
 * would otherwise turn every list into a hard 400. On that specific error we retry once
 * with the pagination params removed — keeping filters such as `active_only` intact — and
 * report `pagingSupported: false` so the UI can say the list is partial instead of
 * pretending it is complete.
 */
async function getPagedJson<T>(
  path: string,
  params: QueryParams,
): Promise<{json: T; pagingSupported: boolean}> {
  const signal = signalOf(params);
  const query = buildQuery(params);
  try {
    return {
      json: await getJson<T>(query ? `${path}?${query}` : path, undefined, signal),
      pagingSupported: true,
    };
  } catch (error) {
    if (!isUnsupportedPaginationError(error)) throw error;
    const withoutPaging: QueryParams = {signal};
    for (const [key, value] of Object.entries(params)) {
      if (PAGINATION_PARAMS.has(key)) continue;
      withoutPaging[key] = value;
    }
    const bare = buildQuery(withoutPaging);
    return {
      json: await getJson<T>(bare ? `${path}?${bare}` : path, undefined, signal),
      pagingSupported: false,
    };
  }
}

/**
 * Wallet-auth headers for the enterprise org reads: personal-message signature over
 * `"{unix seconds}:{sender}"`, raw 64-byte signature and flagged public key as hex.
 * One signature per request, matching the server's per-route middleware.
 */
async function walletAuthHeaders(signer: Signer): Promise<Record<string, string>> {
  const sender = signer.toMySoAddress();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const { signature } = await signer.signPersonalMessage(
    new TextEncoder().encode(`${timestamp}:${sender}`),
  );
  const parsed = parseSerializedSignature(signature);
  if (!parsed.signature) {
    throw new Error('Unsupported signature scheme for social server wallet auth.');
  }
  return {
    'X-Signature': toHex(parsed.signature),
    'X-Public-Key': toHex(signer.getPublicKey().toMySoBytes()),
    'X-Sender-Address': sender,
    'X-Timestamp': timestamp,
  };
}

async function getSignedPagedJson<T>(
  path: string,
  signer: Signer,
  params: QueryParams,
): Promise<{json: T; pagingSupported: boolean}> {
  const signal = signalOf(params);
  const query = buildQuery(params);
  const headers = await walletAuthHeaders(signer);
  const res = await fetch(`${requireBase()}${query ? `${path}?${query}` : path}`, {
    headers: { Accept: 'application/json', ...headers },
    signal,
  });
  if (res.ok) {
    return {json: (await res.json()) as T, pagingSupported: true};
  }
  const error = await readError(res, path);
  if (!isUnsupportedPaginationError(error)) throw error;
  const withoutPaging: QueryParams = {signal};
  for (const [key, value] of Object.entries(params)) {
    if (PAGINATION_PARAMS.has(key)) continue;
    withoutPaging[key] = value;
  }
  const bare = buildQuery(withoutPaging);
  const retryHeaders = await walletAuthHeaders(signer);
  const retry = await fetch(`${requireBase()}${bare ? `${path}?${bare}` : path}`, {
    headers: { Accept: 'application/json', ...retryHeaders },
    signal,
  });
  if (!retry.ok) throw await readError(retry, path);
  return {json: (await retry.json()) as T, pagingSupported: false};
}

const enc = encodeURIComponent;

function pageOf<T>(items: T[], totalCount: number | null, pagingSupported: boolean): PageResult<T> {
  return {items, totalCount, pagingSupported};
}

function arrayPage<T>(json: T[] | null | undefined, pagingSupported: boolean): PageResult<T> {
  return pageOf(Array.isArray(json) ? json : [], null, pagingSupported);
}

// ---------------------------------------------------------------------------
// Profile-scoped single reads
// ---------------------------------------------------------------------------

export function fetchMemoryAccount(address: string): Promise<MemoryAccountRow | null> {
  return getJsonOrNull(`/profiles/${enc(address)}/memory-account`);
}

export function fetchAiCreditBalance(address: string): Promise<AiCreditBalanceResponse | null> {
  return getJsonOrNull(`/profiles/${enc(address)}/ai-credit`);
}

export function fetchAiCreditConfig(): Promise<AiCreditConfigRow | null> {
  return getJsonOrNull('/ai-credit/config');
}

export function fetchOrganization(id: string): Promise<AgenticOrganizationRow | null> {
  return getJsonOrNull(`/organizations/${enc(id)}`);
}

// ---------------------------------------------------------------------------
// Paged profile-scoped lists
// ---------------------------------------------------------------------------

export interface PageArgs {
  limit: number;
  offset: number;
  /** Cancels the in-flight request (React Query passes this through). */
  signal?: AbortSignal;
}

export async function fetchAiCreditUsage(
  balanceId: string,
  {limit, offset, signal}: PageArgs,
): Promise<PageResult<AiCreditUsageLineRow>> {
  const {json, pagingSupported} = await getPagedJson<AiCreditUsageLineRow[]>(
    `/ai-credit/${enc(balanceId)}/usage-history`,
    {limit, offset, signal},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchAiCreditReservations(
  balanceId: string,
  {limit, offset, signal, status}: PageArgs & {status?: string},
): Promise<PageResult<AiSpendReservationRow>> {
  const {json, pagingSupported} = await getPagedJson<AiSpendReservationRow[]>(
    `/ai-credit/${enc(balanceId)}/reservations`,
    {limit, offset, signal, status},
  );
  return arrayPage(json, pagingSupported);
}

/** One sub-agent by object id — resolves an agent even before its page is loaded. */
export function fetchSubAgentByObjectId(agentObjectId: string): Promise<SubAgentRow | null> {
  return getJsonOrNull(`/sub-agents/by-object/${enc(agentObjectId)}`);
}

export async function fetchSubAgents(
  address: string,
  {activeOnly, limit, offset}: PageArgs & {activeOnly: boolean},
): Promise<PageResult<SubAgentRow>> {
  const {json, pagingSupported} = await getPagedJson<SubAgentListResponse>(
    `/profiles/${enc(address)}/sub-agents`,
    {active_only: activeOnly, limit, offset},
  );
  return pageOf(
    json.sub_agents ?? [],
    typeof json.total_count === 'number' ? json.total_count : null,
    pagingSupported,
  );
}

export async function fetchOrganizations(
  address: string,
  {activeOnly, orgType, limit, offset}: PageArgs & {activeOnly: boolean; orgType?: number},
): Promise<PageResult<AgenticOrganizationRow>> {
  const {json, pagingSupported} = await getPagedJson<AgenticOrganizationListResponse>(
    `/profiles/${enc(address)}/organizations`,
    {active_only: activeOnly, org_type: orgType, limit, offset},
  );
  return pageOf(
    json.organizations ?? [],
    typeof json.total_count === 'number' ? json.total_count : null,
    pagingSupported,
  );
}

export async function fetchProfileSpendApprovals(
  address: string,
  {limit, offset, signal, status, agent}: PageArgs & {status?: string; agent?: string},
): Promise<PageResult<AiCreditSpendApprovalRow>> {
  const {json, pagingSupported} = await getPagedJson<AiCreditSpendApprovalRow[]>(
    `/profiles/${enc(address)}/ai-credit/approvals`,
    {limit, offset, signal, status, agent},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchProfileAuditLogs(
  address: string,
  {
    limit,
    offset,
    action,
    actor,
    targetType,
    source,
  }: PageArgs & AuditLogFilters,
): Promise<PageResult<OrgAuditLogRow>> {
  const {json, pagingSupported} = await getPagedJson<OrgAuditLogRow[]>(
    `/profiles/${enc(address)}/audit-logs`,
    {
      limit,
      offset,
      action,
      actor,
      target_type: targetType,
      source,
    },
  );
  return arrayPage(json, pagingSupported);
}

// ---------------------------------------------------------------------------
// Organization-scoped reads
// ---------------------------------------------------------------------------

/** Agent messaging groups recorded for an organization (public, camelCase rows). */
export async function fetchOrganizationMessagingGroups(
  organizationId: string,
  {limit, offset, signal}: PageArgs,
): Promise<PageResult<MessagingAgentGroupInfo>> {
  const {json, pagingSupported} = await getPagedJson<MessagingAgentGroupInfo[]>(
    `/organizations/${enc(organizationId)}/messaging-groups`,
    {limit, offset, signal},
  );
  return arrayPage(json, pagingSupported);
}

export interface AuditLogFilters {
  action?: string;
  actor?: string;
  targetType?: string;
  source?: string;
}

export async function fetchOrganizationAuditLogs(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal, action, actor, targetType, source}: PageArgs & AuditLogFilters,
): Promise<PageResult<OrgAuditLogRow>> {
  const {json, pagingSupported} = await getSignedPagedJson<OrgAuditLogRow[]>(
    `/organizations/${enc(organizationId)}/audit-logs`,
    signer,
    {limit, offset, signal, action, actor, target_type: targetType, source},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchOrganizationMemoryPermissions(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal, member, activeOnly}: PageArgs & {member?: string; activeOnly?: boolean},
): Promise<PageResult<OrgMemoryPermissionRow>> {
  const {json, pagingSupported} = await getSignedPagedJson<OrgMemoryPermissionRow[]>(
    `/organizations/${enc(organizationId)}/memory-permissions`,
    signer,
    {limit, offset, signal, member, active_only: activeOnly},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchOrganizationRoles(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal}: PageArgs,
): Promise<PageResult<OrgRoleRow>> {
  const {json, pagingSupported} = await getSignedPagedJson<OrgRoleRow[]>(
    `/organizations/${enc(organizationId)}/roles`,
    signer,
    {limit, offset, signal},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchOrganizationRoleAssignments(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal, member, activeOnly}: PageArgs & {member?: string; activeOnly?: boolean},
): Promise<PageResult<OrgRoleAssignmentRow>> {
  const {json, pagingSupported} = await getSignedPagedJson<OrgRoleAssignmentRow[]>(
    `/organizations/${enc(organizationId)}/role-assignments`,
    signer,
    {limit, offset, signal, member, active_only: activeOnly},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchOrganizationInvitations(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal, invitee, status}: PageArgs & {invitee?: string; status?: string},
): Promise<PageResult<OrgInvitationRow>> {
  const {json, pagingSupported} = await getSignedPagedJson<OrgInvitationRow[]>(
    `/organizations/${enc(organizationId)}/invitations`,
    signer,
    {limit, offset, signal, invitee, status},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchOrganizationSpendApprovals(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal, status, agent}: PageArgs & {status?: string; agent?: string},
): Promise<PageResult<AiCreditSpendApprovalRow>> {
  const {json, pagingSupported} = await getSignedPagedJson<AiCreditSpendApprovalRow[]>(
    `/organizations/${enc(organizationId)}/approvals`,
    signer,
    {limit, offset, signal, status, agent},
  );
  return arrayPage(json, pagingSupported);
}

export async function fetchOrganizationSpendBreakdown(
  organizationId: string,
  signer: Signer,
  {limit, offset, signal, window}: PageArgs & {window?: OrgStatsWindow},
): Promise<PageResult<AgentSpendBreakdownEntry>> {
  const {json, pagingSupported} = await getSignedPagedJson<AgentSpendBreakdownEntry[]>(
    `/organizations/${enc(organizationId)}/spend-breakdown`,
    signer,
    {limit, offset, signal, window},
  );
  return arrayPage(json, pagingSupported);
}

export interface OrganizationDashboard {
  memoryPermissions: OrgMemoryPermissionRow[];
  roles: OrgRoleRow[];
  roleAssignments: OrgRoleAssignmentRow[];
  invitations: OrgInvitationRow[];
  approvals: AiCreditSpendApprovalRow[];
}

/**
 * First page of every dashboard list in one shot.
 *
 * Kept for callers that only need a summary; the dashboard UI uses the individual paged
 * fetchers so each section can load, filter, and page independently.
 */
export async function fetchOrganizationDashboard(
  id: string,
  signer: Signer,
): Promise<OrganizationDashboard> {
  const firstPage = {limit: 100, offset: 0};
  const [memoryPermissions, roles, roleAssignments, invitations, approvals] =
    await Promise.all([
      fetchOrganizationMemoryPermissions(id, signer, firstPage),
      fetchOrganizationRoles(id, signer, firstPage),
      fetchOrganizationRoleAssignments(id, signer, firstPage),
      fetchOrganizationInvitations(id, signer, firstPage),
      fetchOrganizationSpendApprovals(id, signer, firstPage),
    ]);
  return {
    memoryPermissions: memoryPermissions.items,
    roles: roles.items,
    roleAssignments: roleAssignments.items,
    invitations: invitations.items,
    approvals: approvals.items,
  };
}
