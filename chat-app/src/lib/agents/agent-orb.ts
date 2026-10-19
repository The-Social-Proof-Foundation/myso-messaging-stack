import {orb27Orb} from '@/components/orbs/orb-27/meta';

import {normalizeMetadataHex} from './agent-chats';

export type AgentOrbState = 'idle' | 'thinking';

export interface AgentOrbSpec {
  /** Canonical `0x` + 64 hex when the input is an address; otherwise the trimmed key. */
  agentKey: string;
  /** Drives the shader's starting phase, so one agent always draws the same weather. */
  seed: number;
  /** Base hue in degrees. */
  hue: number;
  /** Palette keyed like orb-27's colors: `paper` plus `c0`..`c6`, quiet to peak. */
  colors: Record<string, string>;
  /** Paper tint per state, so thinking and idle read differently at a glance. */
  stateColors: Record<AgentOrbState, Record<string, string>>;
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

/** h in degrees, s and l in 0..1. */
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Hex `#rrggbb` to CSS rgb(). */
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255})`;
}

/** Orb-27 quantizes the field into these keys, quiet to peak. */
const CLASS_KEYS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] as const;

/**
 * Client-side orb identity for one agent address. Seed and palette both come
 * from the address hash, so every surface matches and no two agents share a
 * palette: the base hue, the direction and width of the hue sweep, and the
 * saturation and lightness band each vary per agent.
 */
export function agentOrbSpec(address: string): AgentOrbSpec {
  const agentKey = normalizeMetadataHex(address) ?? address.trim().toLowerCase();
  const seed = fnv1a(agentKey);
  const bits = fnv1a(`${agentKey}:palette`);

  const hue = seed % 360;
  const direction = bits & 1 ? 1 : -1;
  // Total hue travel from the coolest class to the peak: 90..180 degrees.
  const sweep = 90 + ((bits >>> 1) % 91);
  const saturation = 0.62 + (((bits >>> 9) % 25) / 100);
  const lightness = 0.5 + (((bits >>> 14) % 9) / 100);

  const colors: Record<string, string> = {
    // Quiet class: the same hue, nearly grey.
    c0: hslToHex(hue, 0.14, 0.42),
  };
  CLASS_KEYS.forEach((key, index) => {
    const t = index / (CLASS_KEYS.length - 1);
    const classHue = hue + direction * sweep * t;
    // Peaks run brighter and more saturated than the mid classes.
    colors[key] = hslToHex(
      classHue,
      Math.min(1, saturation + t * 0.12),
      Math.min(0.72, lightness + t * 0.06),
    );
  });
  const paperHue = hue + direction * sweep * 0.35;
  // Dark charcoal ground with a faint tint of the agent's hue.
  colors.paper = hslToHex(paperHue, 0.18, 0.09);

  return {
    agentKey,
    seed,
    hue,
    colors,
    stateColors: {
      idle: {paper: colors.paper},
      // Cooler and a touch deeper while thinking.
      thinking: {paper: hslToHex(paperHue + 24, 0.22, 0.06)},
    },
  };
}

/**
 * Grid zoom for an orb of `size` px. orb-27 maps `scale * cells / 2.3` cells
 * per unit radius at the centre, so we choose the on-screen cell size and
 * solve for scale. Small orbs get fewer, larger cells so they stay a legible
 * mosaic instead of mush; the default of 2.4 suits the 280px reference orb.
 */
export function agentOrbGridZoom(size: number): number {
  const cells = orbParam('cells').default;
  const radius = orbParam('radius').default;
  const cellPx = Math.min(3.5, Math.max(2.4, 2.4 + size * 0.015));
  const cellsAcrossDiameter = (size * radius) / cellPx;
  const zoom = (cellsAcrossDiameter * 2.3) / (2 * cells);
  const def = orbParam('scale');
  return Math.min(def.max, Math.max(def.min, zoom));
}

function orbParam(key: string) {
  const def = orb27Orb.params.find((p) => p.key === key);
  if (!def) throw new Error(`orb-27 is missing param ${key}`);
  return def;
}

/** Static face used when WebGPU is not available. Same colors as the orb. */
export function agentOrbFallbackBackground(spec: AgentOrbSpec): string {
  const {c2, c4, c5, c0, paper} = spec.colors;
  return [
    `radial-gradient(circle at 62% 40%, ${hexToRgb(c4)} 0%, transparent 42%)`,
    `radial-gradient(circle at 36% 62%, ${hexToRgb(c2)} 0%, transparent 48%)`,
    `radial-gradient(circle at 50% 50%, ${hexToRgb(paper)} 0 68%, ${hexToRgb(c5)} 90%, ${hexToRgb(c0)} 100%)`,
  ].join(', ');
}
