const STORAGE_KEY = 'chat-app-selected-agent-v1';

export interface SelectedDerivedAgent {
  agentObjectId: string;
  derivedAddress: string;
  memoryAccountId: string;
  label: string;
  organizationId: string | null;
}

export function readSelectedAgent(): SelectedDerivedAgent | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SelectedDerivedAgent;
    if (!parsed.agentObjectId || !parsed.derivedAddress || !parsed.memoryAccountId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeSelectedAgent(agent: SelectedDerivedAgent | null): void {
  try {
    if (!agent) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(agent));
  } catch {
    // ignore quota / private mode
  }
}
