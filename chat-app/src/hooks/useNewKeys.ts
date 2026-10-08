import {useEffect, useRef, useState} from 'react';

const ENTER_MS = 1000;
/** A burst larger than this is a page load or a view switch, not one thing being created. */
const MAX_ANIMATED = 3;

/**
 * Keys that appeared after the list was first shown, for a one-off enter animation. The first
 * population of a `scope` (and any bulk load) becomes the baseline silently, so only a row the
 * user just created animates in, not everything on screen at load.
 */
export function useNewKeys(keys: readonly string[], scope: string, ready = true): ReadonlySet<string> {
  const seen = useRef<{scope: string; keys: Set<string>} | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join('|');

  useEffect(() => {
    if (!ready) return;
    if (seen.current?.scope !== scope) {
      seen.current = {scope, keys: new Set(keys)};
      setFresh(new Set());
      return;
    }
    const known = seen.current.keys;
    const added = keys.filter((key) => !known.has(key));
    if (added.length === 0) return;
    added.forEach((key) => known.add(key));
    if (added.length > MAX_ANIMATED) return;
    setFresh((prev) => new Set([...prev, ...added]));
    window.setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        added.forEach((key) => next.delete(key));
        return next;
      });
    }, ENTER_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, scope, ready]);

  return fresh;
}
