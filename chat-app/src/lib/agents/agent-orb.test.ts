import {describe, expect, it} from 'vitest';
import {orbVariantIds} from 'orbloom';

import {agentOrbFallbackBackground, agentOrbSpec} from './agent-orb';

const ADDRESS = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;

describe('agentOrbSpec', () => {
  it('collapses case, 0x, and bare metadata hex to one spec', () => {
    const canonical = agentOrbSpec(ADDRESS);
    const upper = agentOrbSpec(ADDRESS.toUpperCase());
    const bare = agentOrbSpec('ab'.repeat(32));

    expect(upper).toEqual(canonical);
    expect(bare).toEqual(canonical);
    expect(canonical.agentKey).toBe(ADDRESS);
  });

  it('is stable and differs for another address', () => {
    const first = agentOrbSpec(ADDRESS);
    const second = agentOrbSpec(ADDRESS);
    const other = agentOrbSpec(OTHER);

    expect(second).toEqual(first);
    expect(other.seed).not.toBe(first.seed);
    expect(other.agentKey).not.toBe(first.agentKey);
  });

  it('picks a registered variant, a legal theme id, and a locked phase', () => {
    const spec = agentOrbSpec(ADDRESS);

    expect(orbVariantIds).toContain(spec.variantId);
    expect(spec.themeId).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    expect(spec.theme.id).toBe(spec.themeId);
    expect(spec.theme.sourceVariantId).toBe(spec.variantId);
    expect(spec.timeOffset).toBeGreaterThanOrEqual(0);
    expect(spec.timeOffset).toBeLessThan(4000);
    expect(spec.seed).toBeGreaterThanOrEqual(0);
  });

  it('still returns a spec for a non-address key', () => {
    const spec = agentOrbSpec('  Agent Label  ');
    expect(spec.agentKey).toBe('agent label');
    expect(spec.theme.id).toBe(spec.themeId);
  });

  it('paints the static fallback from that same theme', () => {
    const spec = agentOrbSpec(ADDRESS);
    const background = agentOrbFallbackBackground(spec.theme);
    expect(background).toContain('rgb(');
    expect(agentOrbFallbackBackground(spec.theme)).toBe(background);
  });
});
