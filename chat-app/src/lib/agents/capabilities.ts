/** Capability bits of `social_contracts::memory` (`memory::cap_*`). */
export const CAP = {
  MEMORY_READ: 1,
  MEMORY_WRITE: 2,
  MYDATA_READ: 4,
  POST_PUBLISH: 16,
  MESSAGE_READ: 32,
  MESSAGE_SEND: 64,
  TRADE_MONITOR: 128,
  TRADE_EXECUTE: 256,
  COMMENT: 512,
  REACT: 1024,
  AGENT_REVOKE: 2048,
  AGENT_UPDATE: 4096,
  AGENT_REGISTER: 8192,
  AI_SPEND: 16384,
  BUDGET_MANAGE: 32768,
  SOCIAL_GRAPH: 65536,
} as const;

export type CapabilityName = keyof typeof CAP;

export const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  MEMORY_READ: 'Read memory',
  MEMORY_WRITE: 'Write memory',
  MYDATA_READ: 'Read MyData',
  POST_PUBLISH: 'Publish posts',
  MESSAGE_READ: 'Read messages',
  MESSAGE_SEND: 'Send messages',
  TRADE_MONITOR: 'Monitor trades',
  TRADE_EXECUTE: 'Execute trades',
  COMMENT: 'Comment',
  REACT: 'React',
  AGENT_REVOKE: 'Revoke agents',
  AGENT_UPDATE: 'Update agents',
  AGENT_REGISTER: 'Register agents',
  AI_SPEND: 'Spend AI credits',
  BUDGET_MANAGE: 'Manage budgets',
  SOCIAL_GRAPH: 'Social graph',
};

export const CAPABILITY_NAMES = Object.keys(CAP) as CapabilityName[];

export type CapabilityPresetId = 'chat' | 'messenger' | 'manager' | 'custom';

const CHAT_ASSISTANT_MASK =
  CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.MYDATA_READ | CAP.AI_SPEND;
const MESSENGER_MASK = CHAT_ASSISTANT_MASK | CAP.MESSAGE_READ | CAP.MESSAGE_SEND;
const MANAGER_MASK =
  MESSENGER_MASK |
  CAP.AGENT_REGISTER |
  CAP.AGENT_UPDATE |
  CAP.AGENT_REVOKE |
  CAP.BUDGET_MANAGE;

export interface CapabilityPreset {
  id: Exclude<CapabilityPresetId, 'custom'>;
  label: string;
  description: string;
  mask: number;
}

export const CAPABILITY_PRESETS: readonly CapabilityPreset[] = [
  {
    id: 'chat',
    label: 'Chat assistant',
    description: 'Reads its MyData and memory, writes memory, and spends AI credits to answer.',
    mask: CHAT_ASSISTANT_MASK,
  },
  {
    id: 'messenger',
    label: 'Messenger',
    description: 'Chat assistant that can also read and send messages.',
    mask: MESSENGER_MASK,
  },
  {
    id: 'manager',
    label: 'Manager',
    description: 'Messenger that can register, update and revoke child agents and set their budgets.',
    mask: MANAGER_MASK,
  },
];

export function hasCapability(mask: number, cap: CapabilityName): boolean {
  return (mask & CAP[cap]) === CAP[cap];
}

export function toggleCapability(mask: number, cap: CapabilityName): number {
  return mask ^ CAP[cap];
}

export function capabilityNames(mask: number): CapabilityName[] {
  return CAPABILITY_NAMES.filter((name) => hasCapability(mask, name));
}

/** Preset whose mask matches exactly, or `'custom'`. A root's extra register bit still matches. Agents created before MyData read was part of the preset still match. */
export function presetForMask(mask: number): CapabilityPresetId {
  const candidates = [
    mask,
    mask & ~CAP.AGENT_REGISTER,
    mask | CAP.MYDATA_READ,
    (mask & ~CAP.AGENT_REGISTER) | CAP.MYDATA_READ,
  ];
  for (const candidate of candidates) {
    const found = CAPABILITY_PRESETS.find((preset) => preset.mask === candidate);
    if (found) return found.id;
  }
  return 'custom';
}

/** Root agents must be able to register the agents beneath them. */
export function withRootRegistration(mask: number): number {
  return mask | CAP.AGENT_REGISTER;
}

/**
 * Capability update a parent needs before it can register a child, or null when it already can.
 * The parent must hold `CAP_AGENT_REGISTER`, and its delegatable set must cover the child.
 */
export function registrationGrant(
  parent: {capabilities: number; delegatableCaps: number},
  childCapabilities: number,
): {capabilities: number; delegatableCaps: number} | null {
  const canRegister = hasCapability(parent.capabilities, 'AGENT_REGISTER');
  const canDelegate = (childCapabilities & parent.delegatableCaps) === childCapabilities;
  if (canRegister && canDelegate) return null;
  return {
    capabilities: parent.capabilities | childCapabilities | CAP.AGENT_REGISTER,
    delegatableCaps:
      parent.delegatableCaps | childCapabilities,
  };
}
