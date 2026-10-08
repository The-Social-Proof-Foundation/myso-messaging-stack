import {describe, expect, it} from 'vitest';

import {JobFormError, buildJobInput, localTimeToUtcCron, scheduleToTriggerSet} from './automation-job';

const CDT = 300; // getTimezoneOffset() for UTC-5
const IST = -330; // UTC+5:30

describe('localTimeToUtcCron', () => {
  it('converts a local time to UTC', () => {
    expect(localTimeToUtcCron('09:00', null, CDT)).toBe('0 14 * * *');
    expect(localTimeToUtcCron('09:00', null, 0)).toBe('0 9 * * *');
    expect(localTimeToUtcCron('09:00', null, IST)).toBe('30 3 * * *');
  });

  it('moves the weekday when conversion crosses midnight', () => {
    // Monday 22:00 in UTC-5 is Tuesday 03:00 UTC.
    expect(localTimeToUtcCron('22:00', 1, CDT)).toBe('0 3 * * 2');
    // Sunday 01:00 in UTC+5:30 is Saturday 19:30 UTC.
    expect(localTimeToUtcCron('01:00', 0, IST)).toBe('30 19 * * 6');
  });

  it('rejects bad times', () => {
    for (const bad of ['', '9', '24:00', '09:60', 'ab:cd']) {
      expect(() => localTimeToUtcCron(bad, null, 0), bad).toThrow(JobFormError);
    }
  });
});

describe('scheduleToTriggerSet', () => {
  it('builds an interval in milliseconds', () => {
    const set = scheduleToTriggerSet({kind: 'interval', every: 2, unit: 'hours'}, 0);
    expect(set.triggers[0]).toMatchObject({kind: 'interval', interval_ms: 7_200_000});
  });

  it('rejects fractional or empty intervals', () => {
    expect(() => scheduleToTriggerSet({kind: 'interval', every: 0, unit: 'minutes'}, 0)).toThrow(JobFormError);
    expect(() => scheduleToTriggerSet({kind: 'interval', every: 1.5, unit: 'minutes'}, 0)).toThrow(JobFormError);
  });

  it('builds a weekly cron trigger', () => {
    const set = scheduleToTriggerSet({kind: 'weekly', day: 5, time: '08:30'}, 0);
    expect(set.triggers[0]).toMatchObject({kind: 'cron', cron_expr: '30 8 * * 5'});
  });
});

describe('buildJobInput', () => {
  const base = {
    name: ' Morning brief ',
    schedule: {kind: 'daily', time: '09:00'} as const,
    task: {kind: 'recall', query: ' what changed overnight '} as const,
    targetAgentObjectId: '0xagent',
    delegateKeyRef: 'delegate:nightly',
    utcOffsetMinutes: 0,
  };

  it('signs as the delegate and targets the owning agent', () => {
    const job = buildJobInput(base);
    expect(job.name).toBe('Morning brief');
    expect(job.target_agent_object_id).toBe('0xagent');
    expect(job.target_agent_key_ref).toBe('delegate:nightly');
    expect(job.action.config).toMatchObject({operation: 'recall', key_ref: 'delegate:nightly', query: 'what changed overnight'});
  });

  it('refuses incomplete jobs with a readable message', () => {
    expect(() => buildJobInput({...base, name: ' '})).toThrow('name');
    expect(() => buildJobInput({...base, delegateKeyRef: ''})).toThrow('delegate');
    expect(() => buildJobInput({...base, task: {kind: 'recall', query: ' '}})).toThrow('look up');
    expect(() => buildJobInput({...base, task: {kind: 'remember', text: ''}})).toThrow('save');
  });
});
