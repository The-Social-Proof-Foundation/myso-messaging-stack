import {describe, expect, it} from 'vitest';
import {CAP} from './capabilities';
import {describeCapabilities} from './capability-brief';

const base = {delegatable_caps: 0, expires_at_ms: null};

describe('describeCapabilities', () => {
  it('lists only granted capabilities', () => {
    const text = describeCapabilities({...base, capabilities: CAP.MEMORY_READ | CAP.TASK_TRADE});
    expect(text).toContain('read its stored memories');
    expect(text).toContain('task market');
    expect(text).not.toContain('execute trades');
    expect(text).not.toContain('serve on AI juries');
  });
  it('says so when nothing is granted', () => {
    expect(describeCapabilities({...base, capabilities: 0})).toContain('no on-chain capabilities');
  });
  it('says it never signs, and teaches the action protocol', () => {
    const jury = describeCapabilities({...base, capabilities: CAP.JURY});
    expect(jury).toContain('never sign');
    expect(jury).toContain('[[action:NAME');
    expect(jury).toContain('join_jury_roster');
  });
  it('names permissions that only the app can exercise', () => {
    const trade = describeCapabilities({...base, capabilities: CAP.TRADE_EXECUTE});
    expect(trade).toContain('cannot use from chat');
    expect(trade).toContain('trade_execute');
    expect(describeCapabilities({...base, capabilities: CAP.JURY})).not.toContain('cannot use from chat');
  });
  it('reports real org memory access', () => {
    const caps = {...base, capabilities: CAP.MEMORY_READ};
    expect(describeCapabilities(caps)).not.toContain('Memory:');
    expect(describeCapabilities(caps, null)).toContain('no shared org memory');
    expect(describeCapabilities(caps, {organizationName: 'Ground Troops', read: true, write: false})).toContain('can read it but not write');
    expect(describeCapabilities(caps, {organizationName: 'Ground Troops', read: true, write: true})).toContain('read and write');
    expect(describeCapabilities(caps, {organizationName: null, read: false, write: false})).toContain('no access to it yet');
  });
  it('stays inside the server profile limit for a full mask, leaving room for the identity block and memory note', () => {
    const all = Object.values(CAP).reduce((a, b) => a | b, 0);
    expect(describeCapabilities({...base, capabilities: all, delegatable_caps: all}).length).toBeLessThan(6500);
  });
});
