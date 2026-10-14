/**
 * First-in-first-out queue for an agent's replies. Questions asked while the agent is busy wait
 * their turn; exactly one is answered at a time, in the order they were asked.
 *
 * `hold()` pauses it before the next question (used while a proposed action waits on the owner's
 * decision) and `resume()` lets it carry on. A question already being answered is never cut off.
 */
export interface ReplyQueue {
  /** Add a question. Resolves when it is queued, not when it is answered. */
  push: (text: string) => void;
  /** Drop everything waiting. A question already being answered finishes. */
  clear: () => void;
  hold: () => void;
  resume: () => void;
  /** Questions waiting, not counting the one being answered. */
  readonly size: number;
}

export function createReplyQueue(
  run: (text: string) => Promise<void>,
  onSize: (waiting: number) => void = () => {},
): ReplyQueue {
  const items: string[] = [];
  let working = false;
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;

  async function drain() {
    if (working) return;
    working = true;
    try {
      while (items.length > 0) {
        while (gate) await gate;
        const next = items.shift();
        onSize(items.length);
        if (next === undefined) continue;
        try {
          await run(next);
        } catch {
          // One failed answer must not strand the questions behind it.
        }
      }
    } finally {
      working = false;
    }
  }

  return {
    push(text) {
      items.push(text);
      onSize(items.length);
      void drain();
    },
    clear() {
      items.length = 0;
      onSize(0);
    },
    hold() {
      if (gate) return;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    resume() {
      release?.();
      gate = null;
      release = null;
    },
    get size() {
      return items.length;
    },
  };
}
