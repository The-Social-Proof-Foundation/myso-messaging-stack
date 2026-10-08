import {useSyncExternalStore} from 'react';

interface ChatProgress {
  agentId: string | null;
  message: string | null;
  error: string | null;
}

let state: ChatProgress = {agentId: null, message: null, error: null};
const listeners = new Set<() => void>();

function set(next: ChatProgress) {
  state = next;
  listeners.forEach((listener) => listener());
}

/** Opening a chat spans on-chain steps and relayer sync; this lets any button show where it is. */
export function startChatProgress(agentId: string, message: string) {
  set({agentId, message, error: null});
}

export function updateChatProgress(message: string) {
  if (state.agentId) set({...state, message});
}

export function finishChatProgress() {
  set({agentId: null, message: null, error: null});
}

export function failChatProgress(agentId: string, error: string) {
  set({agentId, message: null, error});
}

export function useAgentChatProgress(agentId: string): {busy: boolean; message: string | null; error: string | null} {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  const mine = snapshot.agentId === agentId;
  return {
    busy: mine && snapshot.message != null,
    message: mine ? snapshot.message : null,
    error: mine ? snapshot.error : null,
  };
}
