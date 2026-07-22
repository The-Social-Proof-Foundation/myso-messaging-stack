import {describe, expect, it} from 'vitest';
import {
  MESSAGE_TIME_MARKER_EVERY,
  computeTimeMarkers,
  formatDaySeparator,
} from './message-time';

function msg(id: string, createdAt: number) {
  return {messageId: id, createdAt};
}

describe('computeTimeMarkers', () => {
  it('does not mark midnight calendar changes under 24h apart', () => {
    // 11pm → 1am next calendar day, only 2 hours apart
    const t0 = Math.floor(Date.parse('2026-07-21T23:00:00') / 1000);
    const t1 = Math.floor(Date.parse('2026-07-22T01:00:00') / 1000);
    const markers = computeTimeMarkers([msg('a', t0), msg('b', t1)]);
    expect(markers.has('b')).toBe(false);
  });

  it('marks a rolling ≥24h gap', () => {
    const t0 = 1_000_000;
    const t1 = t0 + 24 * 60 * 60;
    const markers = computeTimeMarkers([msg('a', t0), msg('b', t1)]);
    expect(markers.get('b')).toEqual({includeTime: false});
  });

  it(`inserts a timed marker every ${MESSAGE_TIME_MARKER_EVERY} messages in a streak`, () => {
    const base = 2_000_000;
    const messages = Array.from({length: MESSAGE_TIME_MARKER_EVERY + 1}, (_, i) =>
      msg(`m${i}`, base + i * 60),
    );
    const markers = computeTimeMarkers(messages);
    expect(markers.get(`m${MESSAGE_TIME_MARKER_EVERY}`)).toEqual({
      includeTime: true,
    });
    expect(markers.has('m0')).toBe(false);
    expect(markers.has(`m${MESSAGE_TIME_MARKER_EVERY - 1}`)).toBe(false);
  });
});

describe('formatDaySeparator', () => {
  it('appends clock time for density markers', () => {
    const now = Math.floor(Date.now() / 1000);
    const label = formatDaySeparator(now, {includeTime: true});
    expect(label.startsWith('Today, at ')).toBe(true);
  });
});
