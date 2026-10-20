import {useSyncExternalStore} from 'react';

import type {ChatActionProposal} from './chat-actions';
import type {SubAgentRow} from './social-api';

/** A write the agent proposed, held until the owner approves or denies it. */
export interface PendingChatAction {
  proposal: ChatActionProposal;
  agent: SubAgentRow;
  /** Posts a line into the chat as the agent. */
  post: (text: string) => Promise<unknown>;
}

/** One question for one chat. The thread is the conversation as it stood when the question was sent. */
export interface AgentReplyJob {
  groupId: string;
  groupUuid: string;
  question: string;
  historyLength: number;
  thread: {senderAddress?: string | null; text?: string | null}[];
}

export interface AgentReplySession {
  replying: boolean;
  status: string | null;
  error: string | null;
  queued: number;
  pending: PendingChatAction | null;
  actionBusy: boolean;
}

const EMPTY: AgentReplySession = {
  replying: false,
  status: null,
  error: null,
  queued: 0,
  pending: null,
  actionBusy: false,
};

const sessions = new Map<string, AgentReplySession>();
const listeners = new Set<() => void>();
let tick = 0;

interface GroupQueue {
  items: AgentReplyJob[];
  working: boolean;
  gate: Promise<void> | null;
  release: (() => void) | null;
}

const queues = new Map<string, GroupQueue>();

type Runner = (job: AgentReplyJob) => Promise<void>;
let runner: Runner | null = null;
let resolver: ((groupId: string, approve: boolean) => Promise<void>) | null = null;

function emit() {
  tick += 1;
  for (const listener of listeners) listener();
}

function queueFor(groupId: string): GroupQueue {
  let queue = queues.get(groupId);
  if (!queue) {
    queue = {items: [], working: false, gate: null, release: null};
    queues.set(groupId, queue);
  }
  return queue;
}

function publishQueueSize(groupId: string, queued: number) {
  const current = sessions.get(groupId) ?? EMPTY;
  if (current.queued === queued && sessions.has(groupId)) return;
  sessions.set(groupId, {...current, queued});
  emit();
}

async function drain(groupId: string) {
  const queue = queueFor(groupId);
  if (queue.working) return;
  queue.working = true;
  try {
    while (queue.items.length > 0) {
      while (queue.gate) await queue.gate;
      const job = queue.items.shift();
      publishQueueSize(groupId, queue.items.length);
      if (!job || !runner) {
        if (job) queue.items.unshift(job);
        break;
      }
      try {
        await runner(job);
      } catch {
        // One failed answer must not strand the questions behind it.
      }
    }
  } finally {
    queue.working = false;
    if (queue.items.length > 0 && runner) void drain(groupId);
  }
}

export function subscribeAgentReplies(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentReplyTick(): number {
  return tick;
}

export function getAgentReplySession(groupId: string): AgentReplySession {
  return sessions.get(groupId) ?? EMPTY;
}

export function patchAgentReplySession(groupId: string, patch: Partial<AgentReplySession>) {
  const current = sessions.get(groupId) ?? EMPTY;
  sessions.set(groupId, {...current, ...patch});
  emit();
}

/** Pause the next question in this chat while a proposed action waits on the owner. */
export function holdAgentReplyQueue(groupId: string) {
  const queue = queueFor(groupId);
  if (queue.gate) return;
  queue.gate = new Promise<void>((resolve) => {
    queue.release = resolve;
  });
}

export function resumeAgentReplyQueue(groupId: string) {
  const queue = queues.get(groupId);
  if (!queue) return;
  queue.release?.();
  queue.gate = null;
  queue.release = null;
  if (queue.items.length > 0 && !queue.working) void drain(groupId);
}

/**
 * Ask an agent to answer in a specific chat. The work lives outside the open conversation, so
 * switching chats does not drop it.
 */
export function enqueueAgentReply(job: AgentReplyJob) {
  const text = job.question.trim();
  if (!text) return;
  const queue = queueFor(job.groupId);
  queue.items.push({...job, question: text});
  publishQueueSize(job.groupId, queue.items.length);
  void drain(job.groupId);
}

export function setAgentReplyRunner(next: Runner | null) {
  runner = next;
  if (!next) return;
  for (const [groupId, queue] of queues) {
    if (queue.items.length > 0 && !queue.working) void drain(groupId);
  }
}

export function setAgentReplyResolver(next: ((groupId: string, approve: boolean) => Promise<void>) | null) {
  resolver = next;
}

export function resolveAgentReplyAction(groupId: string, approve: boolean): Promise<void> {
  if (!resolver) return Promise.resolve();
  return resolver(groupId, approve);
}

/** Re-render when any chat's agent reply changes. */
export function useAgentReplyClock(): number {
  return useSyncExternalStore(subscribeAgentReplies, getAgentReplyTick, getAgentReplyTick);
}

/** Preview line for a chat row: the agent's current step while it is still answering. */
export function agentReplyPreview(groupId: string, fallback: string): string {
  const session = getAgentReplySession(groupId);
  const working = session.replying || (session.queued > 0 && !session.pending);
  if (!working) return fallback;
  return session.status?.trim() || 'Thinking…';
}
