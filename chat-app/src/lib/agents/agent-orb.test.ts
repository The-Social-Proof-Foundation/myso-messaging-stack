import {describe, expect, it} from 'vitest';

import {
  agentOrbFallbackBackground,
  agentOrbGridZoom,
  agentOrbSpec,
} from './agent-orb';

const ADDRESS = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;
const HEX = /^#[0-9a-f]{6}$/;

describe('agentOrbSpec', () => {
  it('collapses case, 0x, and bare metadata hex to one spec', () => {
    const canonical = agentOrbSpec(ADDRESS);

    expect(agentOrbSpec(ADDRESS.toUpperCase())).toEqual(canonical);
    expect(agentOrbSpec('ab'.repeat(32))).toEqual(canonical);
    expect(canonical.agentKey).toBe(ADDRESS);
  });

  it('is stable for one address and differs for another', () => {
    const first = agentOrbSpec(ADDRESS);
    const other = agentOrbSpec(OTHER);

    expect(agentOrbSpec(ADDRESS)).toEqual(first);
    expect(other.seed).not.toBe(first.seed);
    expect(other.colors).not.toEqual(first.colors);
  });

  it('gives every agent a distinct palette', () => {
    const palettes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const address = `0x${i.toString(16).padStart(64, '0')}`;
      palettes.add(JSON.stringify(agentOrbSpec(address).colors));
    }
    expect(palettes.size).toBe(200);
  });

  it('fills every orb-27 color slot with a valid hex', () => {
    const {colors, stateColors} = agentOrbSpec(ADDRESS);
    for (const key of ['paper', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
      expect(colors[key]).toMatch(HEX);
    }
    expect(stateColors.idle.paper).toMatch(HEX);
    expect(stateColors.thinking.paper).toMatch(HEX);
    expect(stateColors.thinking.paper).not.toBe(stateColors.idle.paper);
  });

  it('still returns a spec for a non-address key', () => {
    expect(agentOrbSpec('  Agent Label  ').agentKey).toBe('agent label');
  });

  it('paints the static fallback from the same palette', () => {
    const spec = agentOrbSpec(ADDRESS);
    const background = agentOrbFallbackBackground(spec);
    expect(background).toContain('rgb(');
    expect(agentOrbFallbackBackground(spec)).toBe(background);
  });
});

describe('agentOrbGridZoom', () => {
  it('zooms out for small orbs and stays within the shader range', () => {
    const sizes = [22, 26, 40, 48, 72, 280];
    const zooms = sizes.map(agentOrbGridZoom);
    for (const zoom of zooms) {
      expect(zoom).toBeGreaterThanOrEqual(0.3);
      expect(zoom).toBeLessThanOrEqual(8);
    }
    expect([...zooms].sort((a, b) => a - b)).toEqual(zooms);
  });
});
