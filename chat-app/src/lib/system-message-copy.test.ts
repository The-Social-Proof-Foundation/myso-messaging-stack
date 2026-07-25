import { describe, expect, it } from 'vitest';
import {
  formatJoinedMembers,
  formatSystemMessage,
  isMembershipSystemType,
  isSystemActorMembershipEvent,
  planMemberJoinedDisplay,
  planTimelineMemberJoinedDisplay,
} from './system-message-copy';

describe('formatSystemMessage', () => {
  const labelFor = (a: string) => (a === '0xabc' ? 'Alice' : a);

  it('formats known membership types', () => {
    expect(
      formatSystemMessage({ type: 'member_joined', member: '0xabc' }, labelFor),
    ).toBe('Alice joined the chat');
    expect(
      formatSystemMessage({ type: 'member_left', member: '0xabc' }, labelFor),
    ).toBe('Alice left the chat');
    expect(
      formatSystemMessage({ type: 'member_removed', member: '0xabc' }, labelFor),
    ).toBe('Alice was removed');
  });

  it('uses generic copy for unknown types', () => {
    expect(
      formatSystemMessage({ type: 'group_renamed', member: '0xabc' }, labelFor),
    ).toBe('Group updated');
  });
});

describe('formatJoinedMembers', () => {
  it('formats one, two, and many names', () => {
    expect(formatJoinedMembers(['Alice'])).toBe('Alice joined the chat');
    expect(formatJoinedMembers(['Alice', 'Bob'])).toBe(
      'Alice and Bob joined the chat',
    );
    expect(formatJoinedMembers(['A', 'B', 'C'])).toBe(
      'A, B, and C joined the chat',
    );
  });
});

describe('planMemberJoinedDisplay', () => {
  const labelFor = (a: string) => {
    if (a === '0xjoe' || a.toLowerCase() === '0xjoe') return 'Joe Schmoe';
    if (a === '0xuno' || a.toLowerCase() === '0xuno') return 'Uno Brandon';
    return a;
  };

  it('coalesces adjacent joins into one line', () => {
    const plan = planMemberJoinedDisplay(
      [
        { messageId: '1', member: '0xuno' },
        { messageId: '2', member: '0xjoe' },
      ],
      labelFor,
    );
    expect(plan.textById.get('1')).toBe(
      'Uno Brandon and Joe Schmoe joined the chat',
    );
    expect(plan.hideIds.has('2')).toBe(true);
  });

  it('backfills the missing DM peer for a lone invitee join', () => {
    const plan = planMemberJoinedDisplay(
      [{ messageId: '1', member: '0xjoe' }],
      labelFor,
      ['0xuno', '0xjoe'],
    );
    expect(plan.textById.get('1')).toBe(
      'Uno Brandon and Joe Schmoe joined the chat',
    );
    expect(plan.hideIds.size).toBe(0);
  });
});

describe('planTimelineMemberJoinedDisplay', () => {
  it('splits runs around non-join rows', () => {
    const labelFor = (a: string) => a;
    const plan = planTimelineMemberJoinedDisplay(
      [
        {
          messageId: 'j1',
          kind: 'system',
          system: { type: 'member_joined', member: '0xa' },
        },
        {
          messageId: 'j2',
          kind: 'system',
          system: { type: 'member_joined', member: '0xb' },
        },
        { messageId: 't1', kind: 'text', system: null },
        {
          messageId: 'j3',
          kind: 'system',
          system: { type: 'member_joined', member: '0xc' },
        },
      ],
      labelFor,
    );
    expect(plan.textById.get('j1')).toBe('0xa and 0xb joined the chat');
    expect(plan.hideIds.has('j2')).toBe(true);
    expect(plan.textById.get('j3')).toBe('0xc joined the chat');
  });
});

describe('isMembershipSystemType', () => {
  it('recognizes v1 membership types', () => {
    expect(isMembershipSystemType('member_joined')).toBe(true);
    expect(isMembershipSystemType('group_renamed')).toBe(false);
  });
});

describe('isSystemActorMembershipEvent', () => {
  const system = new Set([
    '0xba8f4446fabd4c64bf3a096e86fbcdd615e4ffdacbb340666d82c0f226231470',
  ]);

  it('hides membership events for system actors', () => {
    expect(
      isSystemActorMembershipEvent(
        {
          type: 'member_joined',
          member: '0xBA8F4446FABD4C64BF3A096E86FBCDD615E4FFDACBB340666D82C0F226231470',
        },
        system,
      ),
    ).toBe(true);
  });

  it('keeps human membership events', () => {
    expect(
      isSystemActorMembershipEvent(
        { type: 'member_joined', member: '0xabc' },
        system,
      ),
    ).toBe(false);
  });
});
