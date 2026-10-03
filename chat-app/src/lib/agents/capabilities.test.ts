import {describe, expect, it} from 'vitest';

import {
  CAP,
  CAPABILITY_PRESETS,
  capabilityNames,
  hasCapability,
  presetForMask,
  registrationGrant,
  toggleCapability,
  withRootRegistration,
} from './capabilities';

function preset(id: string): number {
  const found = CAPABILITY_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found.mask;
}

describe('capability bits', () => {
  it('match memory.move cap_* values', () => {
    expect(CAP.MEMORY_READ).toBe(1);
    expect(CAP.MEMORY_WRITE).toBe(2);
    expect(CAP.MYDATA_READ).toBe(4);
    expect(CAP.MESSAGE_READ).toBe(32);
    expect(CAP.MESSAGE_SEND).toBe(64);
    expect(CAP.AGENT_REVOKE).toBe(2048);
    expect(CAP.AGENT_UPDATE).toBe(4096);
    expect(CAP.AGENT_REGISTER).toBe(8192);
    expect(CAP.AI_SPEND).toBe(16384);
    expect(CAP.BUDGET_MANAGE).toBe(32768);
  });
});

describe('capability presets', () => {
  it('chat assistant = memory read | memory write | MyData read | AI spend', () => {
    expect(preset('chat')).toBe(1 | 2 | 4 | 16384);
    expect(hasCapability(preset('chat'), 'MYDATA_READ')).toBe(true);
  });

  it('messenger adds message read and send', () => {
    expect(preset('messenger')).toBe(1 | 2 | 4 | 16384 | 32 | 64);
  });

  it('manager adds agent register/update/revoke and budget manage', () => {
    expect(preset('manager')).toBe(1 | 2 | 4 | 16384 | 32 | 64 | 8192 | 4096 | 2048 | 32768);
  });

  it('maps masks back to presets or custom', () => {
    expect(presetForMask(preset('messenger'))).toBe('messenger');
    expect(presetForMask(preset('chat') | CAP.REACT)).toBe('custom');
    expect(presetForMask(preset('messenger') | CAP.AGENT_REGISTER)).toBe('messenger');
    expect(presetForMask(preset('messenger') & ~CAP.MYDATA_READ)).toBe('messenger');
  });
});

describe('root registration', () => {
  it('gives a root the register capability without dropping its other caps', () => {
    expect(withRootRegistration(preset('messenger'))).toBe(
      preset('messenger') | CAP.AGENT_REGISTER,
    );
    expect(hasCapability(withRootRegistration(preset('chat')), 'AGENT_REGISTER')).toBe(true);
  });

  it('grants a parent register and the child caps only when it cannot delegate yet', () => {
    const messenger = preset('messenger');
    expect(registrationGrant({capabilities: messenger, delegatableCaps: messenger}, messenger)).toEqual({
      capabilities: messenger | CAP.AGENT_REGISTER,
      delegatableCaps: messenger | CAP.AGENT_REGISTER,
    });
    const ready = messenger | CAP.AGENT_REGISTER;
    expect(registrationGrant({capabilities: ready, delegatableCaps: ready}, messenger)).toBeNull();
  });
});

describe('mask helpers', () => {
  it('toggles and lists capabilities', () => {
    let mask = preset('chat');
    expect(hasCapability(mask, 'MESSAGE_SEND')).toBe(false);
    mask = toggleCapability(mask, 'MESSAGE_SEND');
    expect(hasCapability(mask, 'MESSAGE_SEND')).toBe(true);
    expect(capabilityNames(mask)).toEqual([
      'MEMORY_READ',
      'MEMORY_WRITE',
      'MYDATA_READ',
      'MESSAGE_SEND',
      'AI_SPEND',
    ]);
    mask = toggleCapability(mask, 'MESSAGE_SEND');
    expect(mask).toBe(preset('chat'));
  });
});
