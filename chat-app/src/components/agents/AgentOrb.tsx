import {useEffect, useMemo, useRef, useState} from 'react';

import {ShaderOrb, type OrbState} from '@/components/orbs/canvas';
import {orb27Orb} from '@/components/orbs/orb-27/meta';
import {cn} from '@/lib/utils';
import {
  agentOrbFallbackBackground,
  agentOrbGridZoom,
  agentOrbSpec,
  type AgentOrbState,
} from '@/lib/agents/agent-orb';
import {acquireAgentOrb} from './agent-orb-pool';

/** Orbs under this diameter (px) drift at SMALL_ORB_SPEED_FACTOR of full speed. */
const SMALL_ORB_SIZE = 40;
const SMALL_ORB_SPEED_FACTOR = 0.4;

const SUPPORTS_WEBGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

interface AgentOrbProps {
  /** Agent derived address. The same address always renders the same orb. */
  agentKey: string;
  size: number;
  label?: string;
  /** `thinking` while the agent is working or typing; `idle` otherwise. */
  state?: AgentOrbState;
  className?: string;
}

/** orb-27's own state presets, with the drift slowed for tiny orbs. */
function presetsForSize(size: number) {
  const presets = orb27Orb.statePresets ?? {};
  if (size >= SMALL_ORB_SIZE) return presets;
  const slowed: Partial<Record<OrbState, Record<string, number>>> = {};
  for (const [state, preset] of Object.entries(presets)) {
    slowed[state as OrbState] = {
      ...preset,
      speed: (preset.speed ?? 1) * SMALL_ORB_SPEED_FACTOR,
    };
  }
  return slowed;
}

export function AgentOrb({
  agentKey,
  size,
  label,
  state = 'idle',
  className,
}: Readonly<AgentOrbProps>) {
  const spec = useMemo(() => agentOrbSpec(agentKey), [agentKey]);
  const params = useMemo(() => ({scale: agentOrbGridZoom(size)}), [size]);
  const statePresets = useMemo(() => presetsForSize(size), [size]);
  const fallback = useMemo(() => agentOrbFallbackBackground(spec), [spec]);

  const rootRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!SUPPORTS_WEBGPU) return;
    let disposed = false;
    const slot = acquireAgentOrb({
      onGrant: () => {
        if (!disposed) setLive(true);
      },
      onRevoke: () => {
        if (!disposed) setLive(false);
      },
    });

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      slot.setVisible(visible);
      if (visible) slot.request();
    });
    if (rootRef.current) observer.observe(rootRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      slot.release();
      setLive(false);
    };
  }, [agentKey]);

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={label?.trim() || 'Agent'}
      className={cn('agent-orb shrink-0 overflow-hidden rounded-full', className)}
      style={{width: size, height: size, background: fallback}}
    >
      {live ? (
        <ShaderOrb
          variant={orb27Orb}
          size={size}
          state={state}
          seed={spec.seed}
          params={params}
          colors={spec.colors}
          stateColors={spec.stateColors}
          statePresets={statePresets}
          maxDpr={2}
        />
      ) : null}
    </div>
  );
}
