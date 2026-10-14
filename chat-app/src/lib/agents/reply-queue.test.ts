import {describe, expect, it} from 'vitest';
import {createReplyQueue} from './reply-queue';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i += 1) await tick();
};

/** A run function whose answers the test finishes by hand. */
function manual() {
  const started: string[] = [];
  const finish: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const run = (text: string) => {
    started.push(text);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) => {
      finish.push(() => {
        active -= 1;
        resolve();
      });
    });
  };
  return {run, started, finish, maxActive: () => maxActive};
}

describe('createReplyQueue', () => {
  it('answers in the order asked, one at a time', async () => {
    const m = manual();
    const queue = createReplyQueue(m.run);
    queue.push('a');
    queue.push('b');
    queue.push('c');
    await tick();
    expect(m.started).toEqual(['a']);
    m.finish[0]!();
    await until(() => m.started.length === 2);
    expect(m.started).toEqual(['a', 'b']);
    m.finish[1]!();
    await until(() => m.started.length === 3);
    m.finish[2]!();
    await tick();
    expect(m.started).toEqual(['a', 'b', 'c']);
    expect(m.maxActive()).toBe(1);
  });

  it('accepts a question while one is being answered', async () => {
    const m = manual();
    const sizes: number[] = [];
    const queue = createReplyQueue(m.run, (n) => sizes.push(n));
    queue.push('first');
    await tick();
    queue.push('second');
    expect(queue.size).toBe(1);
    m.finish[0]!();
    await until(() => m.started.length === 2);
    expect(m.started[1]).toBe('second');
    expect(sizes).toEqual([1, 0, 1, 0]);
  });

  it('pauses before the next question while held, then carries on', async () => {
    const m = manual();
    const queue = createReplyQueue(m.run);
    queue.push('one');
    await tick();
    queue.push('two');
    queue.hold();
    m.finish[0]!();
    await tick();
    await tick();
    expect(m.started).toEqual(['one']);
    expect(queue.size).toBe(1);
    queue.resume();
    await until(() => m.started.length === 2);
    expect(m.started).toEqual(['one', 'two']);
  });

  it('holding twice and resuming once is enough', async () => {
    const m = manual();
    const queue = createReplyQueue(m.run);
    queue.hold();
    queue.hold();
    queue.push('x');
    await tick();
    expect(m.started).toEqual([]);
    queue.resume();
    await until(() => m.started.length === 1);
    expect(m.started).toEqual(['x']);
  });

  it('a failed answer does not strand the ones behind it', async () => {
    const seen: string[] = [];
    const queue = createReplyQueue(async (text) => {
      seen.push(text);
      if (text === 'bad') throw new Error('boom');
    });
    queue.push('bad');
    queue.push('good');
    await until(() => seen.length === 2);
    expect(seen).toEqual(['bad', 'good']);
  });

  it('clear drops what is waiting but not what is running', async () => {
    const m = manual();
    const queue = createReplyQueue(m.run);
    queue.push('running');
    await tick();
    queue.push('waiting');
    queue.clear();
    expect(queue.size).toBe(0);
    m.finish[0]!();
    await tick();
    await tick();
    expect(m.started).toEqual(['running']);
  });
});
