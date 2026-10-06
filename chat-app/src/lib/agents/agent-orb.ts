import {createOrbTheme, orbVariantIds, type ResolvedOrbVariant} from 'orbloom';

import {normalizeMetadataHex} from './agent-chats';

const THEME_ID = /^[a-z][a-z0-9-]{0,63}$/;

export interface AgentOrbSpec {
  /** Canonical `0x` + 64 hex when the input is an address; otherwise the trimmed key. */
  agentKey: string;
  variantId: string;
  themeId: string;
  seed: number;
  timeOffset: number;
  theme: ResolvedOrbVariant;
}

/** FNV-1a, unsigned 32-bit. Same string always yields the same orb. */
function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rgbCss(channel: readonly [number, number, number]): string {
  const byte = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${byte(channel[0])} ${byte(channel[1])} ${byte(channel[2])})`;
}

/**
 * Client-side orb identity for one agent address.
 * Variant, seed, and animation phase come from one hash so every surface matches.
 */
export function agentOrbSpec(address: string): AgentOrbSpec {
  const agentKey = normalizeMetadataHex(address) ?? address.trim().toLowerCase();
  const hash = fnv1a(agentKey);
  const variantId = orbVariantIds[hash % orbVariantIds.length] ?? 'core-teal-01';
  const themeId = `a-${hash.toString(16).padStart(8, '0')}`;
  if (!THEME_ID.test(themeId)) {
    throw new Error(`Agent orb theme id is invalid: ${themeId}`);
  }
  const seed = hash;
  const timeOffset = hash % 4000;
  const theme = createOrbTheme({preset: variantId, id: themeId, seed});
  return {agentKey, variantId, themeId, seed, timeOffset, theme};
}

/** Static face used when a live WebGL context is not available. Same colors as the orb. */
export function agentOrbFallbackBackground(theme: ResolvedOrbVariant): string {
  const [primary, secondary, rim] = theme.accentColors;
  return [
    `radial-gradient(circle at 62% 40%, ${rgbCss(primary)} 0%, transparent 42%)`,
    `radial-gradient(circle at 36% 62%, ${rgbCss(secondary)} 0%, transparent 48%)`,
    `radial-gradient(circle, ${rgbCss(theme.baseColor)} 0 68%, ${rgbCss(rim)} 97%, transparent 100%)`,
  ].join(', ');
}
