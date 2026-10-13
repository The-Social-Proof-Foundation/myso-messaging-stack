import type {JurorAssignmentInfo, JurorRosterInfo, SubAgentRow} from './social-api';

/** `memory::CAP_JURY`: the capability an agent needs to join the juror roster. */
export const CAP_JURY = 262144;

export function hasJuryCapability(agent: Pick<SubAgentRow, 'capabilities'>): boolean {
  return (agent.capabilities & CAP_JURY) !== 0;
}

/** Self-declared model family, advisory only: it helps spot a jury that all runs the same model. */
export const MODEL_FAMILY_LABEL: Record<number, string> = {
  0: 'Not declared',
  1: 'Claude',
  2: 'GPT',
  3: 'Gemini',
  4: 'Llama',
  5: 'Other',
};

export const DUTY_LABEL: Record<NonNullable<JurorAssignmentInfo['dutyKind']>, string> = {
  accept: 'Accept the assignment',
  commit: 'Cast a sealed vote',
  reveal: 'Reveal the vote',
};

export const SUBJECT_KIND_LABEL: Record<number, string> = {
  1: 'Task dispute',
  2: 'Governance proposal',
};

export function isSuspended(entry: Pick<JurorRosterInfo, 'status' | 'suspendedUntilMs'>, nowMs: number): boolean {
  return entry.status === 3 && entry.suspendedUntilMs != null && entry.suspendedUntilMs > nowMs;
}

/** Duties with a deadline first, soonest first; ones waiting on the next phase go last. */
export function sortDuties(rows: readonly JurorAssignmentInfo[]): JurorAssignmentInfo[] {
  return [...rows].sort((a, b) => {
    if ((a.deadlineMs == null) !== (b.deadlineMs == null)) return a.deadlineMs == null ? 1 : -1;
    return (a.deadlineMs ?? 0) - (b.deadlineMs ?? 0) || a.caseId.localeCompare(b.caseId);
  });
}
