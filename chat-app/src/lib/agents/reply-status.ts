/** What the agent is doing while its reply is in flight, shown instead of a typing bubble. */
export const REPLY_STATUS = {
  preparing: 'Getting ready…',
  saving: 'Saving to memory…',
  recalling: 'Searching memory…',
  thinking: 'Thinking…',
  finishing: 'Finishing the reply…',
  sending: 'Writing reply…',
} as const;

export type ReplyStatus = string;

/** How long the "searching memory" phase shows before it settles into plain thinking. */
export const RECALL_STATUS_MS = 1800;

/** "List my tasks" → "Running: list my tasks…" for an action that runs at once. */
export function actionStatus(title: string): string {
  const plain = title.trim().replace(/[.…]+$/, '');
  return `Running: ${plain.charAt(0).toLowerCase()}${plain.slice(1)}…`;
}

/** "Thinking…" with how many of the user's later messages are waiting behind it. */
export function withQueued(status: string | null | undefined, waiting: number): string | null {
  if (!status) return null;
  if (waiting <= 0) return status;
  return `${status.replace(/[.…]+$/, '')} · ${waiting} more queued`;
}

/** The text announced and shown for an agent that is working. */
export function thinkingLabel(status: string | null | undefined): string {
  return status?.trim() || REPLY_STATUS.thinking;
}
