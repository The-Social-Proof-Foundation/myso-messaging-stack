/**
 * Client-localized copy for system timeline events.
 * Never persist English on the server — only structured `{ type, member, actor }`.
 */

export type SystemMessageFields = {
  type: string;
  member: string;
  actor?: string | null;
};

/** English join line from display labels: "A and B joined the chat". */
export function formatJoinedMembers(labels: readonly string[]): string {
  const names = labels.map((l) => l.trim()).filter(Boolean);
  if (names.length === 0) return 'joined the chat';
  if (names.length === 1) return `${names[0]} joined the chat`;
  if (names.length === 2) return `${names[0]} and ${names[1]} joined the chat`;
  const head = names.slice(0, -1).join(', ');
  const last = names[names.length - 1]!;
  return `${head}, and ${last} joined the chat`;
}

/**
 * Format a system event for the chat timeline.
 * Returns a generic placeholder for unknown types (forward-compat).
 */
export function formatSystemMessage(
  system: SystemMessageFields,
  labelFor: (address: string) => string,
): string {
  const label = labelFor(system.member);
  switch (system.type) {
    case 'member_joined':
      return formatJoinedMembers([label]);
    case 'member_left':
      return `${label} left the chat`;
    case 'member_removed':
      return `${label} was removed`;
    default:
      return 'Group updated';
  }
}

export function isMembershipSystemType(type: string): boolean {
  return (
    type === 'member_joined' ||
    type === 'member_left' ||
    type === 'member_removed'
  );
}

/**
 * True for membership system rows whose `member` is GroupLeaver / GroupManager
 * (or any other address in `systemAddresses`). Used to hide ghost joins that
 * were persisted before the relayer disregarded system actors.
 */
export function isSystemActorMembershipEvent(
  system: SystemMessageFields,
  systemAddresses: ReadonlySet<string>,
): boolean {
  if (!isMembershipSystemType(system.type)) return false;
  if (systemAddresses.size === 0) return false;
  const member = system.member.toLowerCase();
  for (const addr of systemAddresses) {
    if (addr.toLowerCase() === member) return true;
  }
  return false;
}

export type JoinDisplayPlan = {
  /** messageId → coalesced / backfilled join copy */
  textById: Map<string, string>;
  /** Secondary join rows absorbed into an earlier line */
  hideIds: Set<string>;
};

type JoinRow = {
  messageId: string;
  member: string;
};

/**
 * Coalesce one adjacent `member_joined` run into a single line.
 * For a lone join in a 2-human DM, include the missing peer (backfill).
 */
export function planMemberJoinedDisplay(
  rows: readonly JoinRow[],
  labelFor: (address: string) => string,
  humanMemberAddresses: readonly string[] = [],
): JoinDisplayPlan {
  const textById = new Map<string, string>();
  const hideIds = new Set<string>();
  if (rows.length === 0) return { textById, hideIds };

  const humans = [
    ...new Set(
      humanMemberAddresses
        .map((a) => a.toLowerCase())
        .filter((a) => a.length > 0),
    ),
  ];

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.member.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(r.member);
  }

  if (ordered.length === 1 && humans.length === 2) {
    const only = ordered[0]!.toLowerCase();
    const missing = humans.find((h) => h !== only);
    if (missing) {
      // Prefer "other and joiner" so creator often appears first in DMs.
      ordered.unshift(missing);
      seen.add(missing);
    }
  }

  const labels = ordered.map((a) => labelFor(a));
  const text = formatJoinedMembers(labels);
  const leadId = rows[0]!.messageId;
  textById.set(leadId, text);
  for (let k = 1; k < rows.length; k++) {
    hideIds.add(rows[k]!.messageId);
  }
  return { textById, hideIds };
}

/**
 * Scan an ascending timeline and build join display overrides for all
 * contiguous `member_joined` runs.
 */
export function planTimelineMemberJoinedDisplay<
  T extends {
    messageId: string;
    kind?: string | null;
    system?: SystemMessageFields | null;
  },
>(
  messages: readonly T[],
  labelFor: (address: string) => string,
  humanMemberAddresses: readonly string[] = [],
): JoinDisplayPlan {
  const textById = new Map<string, string>();
  const hideIds = new Set<string>();

  let run: JoinRow[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const plan = planMemberJoinedDisplay(run, labelFor, humanMemberAddresses);
    for (const [id, text] of plan.textById) textById.set(id, text);
    for (const id of plan.hideIds) hideIds.add(id);
    run = [];
  };

  for (const m of messages) {
    if (m.kind === 'system' && m.system?.type === 'member_joined') {
      run.push({ messageId: m.messageId, member: m.system.member });
    } else {
      flush();
    }
  }
  flush();
  return { textById, hideIds };
}
