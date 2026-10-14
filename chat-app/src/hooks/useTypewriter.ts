import {useEffect, useRef, useState} from 'react';

import {revealDurationMs, revealedCount} from '../lib/reveal';

interface TypewriterOptions {
  /** How many characters there are to reveal. */
  total: number;
  /** When false the full text is shown at once. */
  active: boolean;
  /** Called on each frame that revealed more, so a scrolled-to-bottom thread can keep up. */
  onProgress?: () => void;
}

/**
 * How many characters to show right now. Driven by the clock, not by counting frames, so a
 * throttled background tab or a slow frame finishes on time instead of crawling.
 */
export function useTypewriter({total, active, onProgress}: TypewriterOptions): {count: number; done: boolean} {
  const [count, setCount] = useState(active ? 0 : total);
  const progress = useRef(onProgress);
  progress.current = onProgress;

  useEffect(() => {
    if (!active || total <= 0) {
      setCount(total);
      return;
    }
    const duration = revealDurationMs(total);
    const start = performance.now();
    let frame = 0;
    let last = -1;
    const tick = (now: number) => {
      const next = revealedCount(total, now - start, duration);
      if (next !== last) {
        last = next;
        setCount(next);
        progress.current?.();
      }
      if (next < total) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, total]);

  return {count, done: !active || count >= total};
}
