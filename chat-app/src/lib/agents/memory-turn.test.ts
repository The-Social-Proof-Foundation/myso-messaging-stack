import {describe, expect, it} from 'vitest';

import {decideRecall, decideRemember, parseAgentCommand, turnIdempotencyKey} from './memory-turn';

describe('decideRecall', () => {
  it('skips memory for small talk', () => {
    expect(decideRecall('gm').recall).toBe(false);
    expect(decideRecall('thanks!').reason).toBe('small-talk');
  });

  it('recalls for any real question, even without cue words', () => {
    expect(decideRecall('Hello, who do you report to?').recall).toBe(true);
    expect(decideRecall('what is 2+2?').recall).toBe(true);
  });

  it('recalls when the turn refers to stored facts', () => {
    expect(decideRecall('what did we discuss earlier?').recall).toBe(true);
    expect(decideRecall('what is my favourite colour?').recall).toBe(true);
    expect(decideRecall('do you remember my budget?').reason).toBe(
      'refers-to-prior-context',
    );
  });

  it('treats a short follow-up as needing prior context', () => {
    expect(decideRecall('and the other one?', 4).recall).toBe(true);
  });

  it('never recalls on an empty turn', () => {
    expect(decideRecall('   ').recall).toBe(false);
  });
});

describe('decideRemember', () => {
  it('stores a stated durable fact', () => {
    expect(decideRemember('my favourite colour is black').facts).toEqual([
      'my favourite colour is black',
    ]);
    expect(decideRemember('I prefer concise summaries').reason).toBe('stated-a-fact');
  });

  it('does not store questions or small talk', () => {
    expect(decideRemember('what is 2+2?').facts).toEqual([]);
    expect(decideRemember('hey there').facts).toEqual([]);
  });

  it('honours an explicit /remember command', () => {
    expect(decideRemember('/remember I drink oat milk')).toEqual({
      facts: ['I drink oat milk'],
      reason: 'explicit-remember',
    });
    expect(decideRemember('/remember').facts).toEqual([]);
  });

  it('refuses to store an oversized turn verbatim', () => {
    expect(decideRemember(`my name is ${'x'.repeat(600)}`).facts).toEqual([]);
  });
});

describe('decideRemember explicit requests', () => {
  it('stores the fact from a polite remember request', () => {
    expect(decideRemember('can you remember the fact that I like key lime pie.')).toEqual({
      facts: ['I like key lime pie'],
      reason: 'explicit-remember',
    });
    expect(decideRemember('please remember my dog is called Rex').facts).toEqual([
      'my dog is called Rex',
    ]);
  });

  it('does not store a question about memory', () => {
    expect(decideRemember('do you remember what I like?').facts).toEqual([]);
    expect(decideRemember('can you remember?').facts).toEqual([]);
  });
});

describe('turnIdempotencyKey', () => {
  it('is stable for the same turn and differs across turns', async () => {
    const first = await turnIdempotencyKey('group-1', 'hello');
    expect(await turnIdempotencyKey('group-1', 'hello')).toBe(first);
    expect(await turnIdempotencyKey('group-1', 'hello!')).not.toBe(first);
    expect(await turnIdempotencyKey('group-2', 'hello')).not.toBe(first);
  });
});

describe('parseAgentCommand', () => {
  it('parses known commands and their arguments', () => {
    expect(parseAgentCommand('/help')).toEqual({name: 'help', args: ''});
    expect(parseAgentCommand('/Recall my pie')).toEqual({name: 'recall', args: 'my pie'});
    expect(parseAgentCommand('/remember I like pie')).toEqual({name: 'remember', args: 'I like pie'});
  });
  it('leaves other text for the model', () => {
    expect(parseAgentCommand('/unknown thing')).toBeNull();
    expect(parseAgentCommand('what does /help do?')).toBeNull();
    expect(parseAgentCommand('/helpful')).toBeNull();
  });
});
