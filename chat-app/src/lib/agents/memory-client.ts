import {
  AiCreditApprovalRequiredError,
  Memory,
  type MemoryVisibility,
  type RecallMemory,
  type RecallScope,
} from '@socialproof/memory';
import {AI_CREDIT_APPROVAL_REQUIRED_CODE} from '@socialproof/memory/account';

const AI_CREDIT_DEPLETED_CODE = 'insufficient_ai_credits';

import type {DerivedAgentKey} from './agent-keys';

export const CHAT_NAMESPACE = 'chat-app';

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
  input_mist_per_1m: number;
  output_mist_per_1m: number;
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
  ) {
    super(message);
    this.name = 'MemoryClientError';
  }
}

type SignedRequestFn = {
  signedRequest<T>(
    method: string,
    path: string,
    body: object,
    options?: {acceptedStatuses?: number[]},
  ): Promise<T>;
};

/** Dev uses the Vite `/api/memory` proxy; production calls the server origin directly. */
export function memoryServerUrl(): string {
  if (import.meta.env.DEV) return '/api/memory';
  const raw = (import.meta.env.VITE_MEMORY_SERVER_URL || '').replace(/\/+$/, '');
  return raw || 'http://127.0.0.1:8000';
}

export function createAgentMemoryClient(
  key: DerivedAgentKey,
  accountId: string,
): Memory {
  return Memory.create({
    key: key.seed,
    accountId,
    serverUrl: memoryServerUrl(),
    namespace: CHAT_NAMESPACE,
  });
}

/**
 * `POST /api/ask` is not wrapped by `@socialproof/memory` yet. Reuses the
 * client's private `signedRequest` so the MyData session + Ed25519 envelope
 * (`{ts}.{method}.{path}.{body_sha256}.{nonce}.{account_id}`) stay in lockstep.
 */
export async function askAgent(
  memory: Memory,
  args: {question: string; scope?: RecallScope; limit?: number},
): Promise<AskResult> {
  try {
    const body = await (memory as unknown as SignedRequestFn).signedRequest<{
      answer?: string;
      memories_used?: number;
      memories?: AskMemory[] | RecallMemory[];
      amount_mist?: number;
    }>('POST', '/api/ask', {
      question: args.question,
      limit: args.limit ?? 5,
      namespace: CHAT_NAMESPACE,
      ...(args.scope ? {scope: args.scope} : {}),
    });
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
    return await (memory as unknown as SignedRequestFn).signedRequest<T>(method, path, body);
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

export async function rememberAgentFact(
  memory: Memory,
  text: string,
  visibility: MemoryVisibility = 'private',
): Promise<void> {
  try {
    const accepted = await memory.remember(text, {
      visibility,
      subLabel: CHAT_NAMESPACE,
    });
    await memory.waitForRememberJob(accepted.job_id);
  } catch (error) {
    throw classifyMemoryError(error);
  }
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
  const combined = `${message} ${err.serverCode ?? ''} ${err.cause ?? ''}`.toLowerCase();

  if (
    err.name === 'TypeError' ||
    /failed to fetch|networkerror|econnrefused|unreachable/i.test(message)
  ) {
    return new MemoryClientError(
      'Memory server is unreachable. Confirm it is running and VITE_MEMORY_SERVER_URL is set.',
      'unreachable',
    );
  }
  if (
    err.serverCode === AI_CREDIT_DEPLETED_CODE ||
    /insufficient[_ ]ai[_ ]credits|insufficient credits/i.test(combined)
  ) {
    return new MemoryClientError(message, 'insufficient_credits');
  }
  if (
    err.serverCode === AI_CREDIT_APPROVAL_REQUIRED_CODE ||
    err.status === 402
  ) {
    return new MemoryClientError(message, 'approval_required');
  }
  if (
    /cap_ai_spend|cap_memory|missing cap|e_sub_agent_missing_cap|capability/i.test(combined)
  ) {
    return new MemoryClientError(message, 'missing_capability');
  }
  if (/revok|deactiv|not active|e_sub_agent_not_active/i.test(combined)) {
    return new MemoryClientError(
      'This agent was revoked or deactivated and can no longer chat.',
      'revoked',
    );
  }
  return new MemoryClientError(message, 'unknown');
}
