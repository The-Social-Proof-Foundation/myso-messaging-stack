/** Live WebGL orbs. Browsers cap contexts, so hidden faces yield when someone is waiting. */
const MAX_LIVE_ORBS = 8;

type LiveSlot = {
  token: number;
  visible: boolean;
  seq: number;
  releaseHold: () => void;
  notifyRevoke: () => void;
};

let nextToken = 1;
let nextSeq = 1;
const live = new Map<number, LiveSlot>();
const waiting = new Set<number>();
const requests = new Map<number, () => boolean>();

function evictOldestHidden(): boolean {
  let oldest: LiveSlot | null = null;
  for (const slot of live.values()) {
    if (slot.visible) continue;
    if (!oldest || slot.seq < oldest.seq) oldest = slot;
  }
  if (!oldest) return false;
  live.delete(oldest.token);
  oldest.releaseHold();
  oldest.notifyRevoke();
  return true;
}

function promote() {
  for (const token of [...waiting]) {
    if (live.size >= MAX_LIVE_ORBS) break;
    const request = requests.get(token);
    if (!request) {
      waiting.delete(token);
      continue;
    }
    request();
  }
}

/**
 * Grants a WebGL slot. `onGrant` fires when this face may call `createOrb`.
 * `onRevoke` fires when the slot is taken for a visible face.
 */
export function acquireAgentOrb(handlers: {
  onGrant: () => void;
  onRevoke: () => void;
}): {
  request: () => boolean;
  setVisible: (visible: boolean) => void;
  release: () => void;
} {
  const token = nextToken;
  nextToken += 1;
  let held = false;
  let cancelled = false;
  let visible = false;

  const releaseHold = () => {
    held = false;
  };

  const request = (): boolean => {
    if (cancelled) return false;
    if (held) return true;
    if (live.size >= MAX_LIVE_ORBS && !evictOldestHidden()) {
      waiting.add(token);
      return false;
    }
    waiting.delete(token);
    held = true;
    const seq = nextSeq;
    nextSeq += 1;
    live.set(token, {
      token,
      visible,
      seq,
      releaseHold,
      notifyRevoke: handlers.onRevoke,
    });
    handlers.onGrant();
    return true;
  };

  requests.set(token, request);

  return {
    request,
    setVisible(next) {
      visible = next;
      const slot = live.get(token);
      if (slot) slot.visible = next;
      if (!next && held && waiting.size > 0) {
        held = false;
        live.delete(token);
        handlers.onRevoke();
        promote();
      }
    },
    release() {
      cancelled = true;
      waiting.delete(token);
      requests.delete(token);
      if (!held) return;
      held = false;
      live.delete(token);
      promote();
    },
  };
}
