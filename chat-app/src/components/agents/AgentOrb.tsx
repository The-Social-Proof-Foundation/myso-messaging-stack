import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {createOrb, type OrbController, type OrbState} from 'orbloom';
import 'orbloom/styles.css';

import {cn} from '@/lib/utils';
import {agentOrbFallbackBackground, agentOrbSpec} from '@/lib/agents/agent-orb';
import {acquireAgentOrb} from './agent-orb-pool';

/** Orbs under this diameter (px) animate at SMALL_ORB_SPEED. */
const SMALL_ORB_SIZE = 40;
const SMALL_ORB_SPEED = 0.3;

interface AgentOrbProps {
  /** Agent derived address. The same address always renders the same orb. */
  agentKey: string;
  size: number;
  label?: string;
  state?: Extract<OrbState, 'idle' | 'listening'>;
  className?: string;
}

export function AgentOrb({
  agentKey,
  size,
  label,
  state = 'idle',
  className,
}: Readonly<AgentOrbProps>) {
  const spec = agentOrbSpec(agentKey);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<OrbController | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [live, setLive] = useState(false);
  const [failureKey, setFailureKey] = useState<string | null>(null);
  const failed = failureKey === agentKey;
  const showFallback = !live || failed;

  useEffect(() => {
    if (failed) return;
    const root = rootRef.current;
    let disposed = false;
    const slot = acquireAgentOrb({
      onGrant: () => {
        if (!disposed) setLive(true);
      },
      onRevoke: () => {
        if (!disposed) setLive(false);
      },
    });
    releaseRef.current = () => slot.release();

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      slot.setVisible(visible);
      if (visible) slot.request();
    });
    if (root) observer.observe(root);

    return () => {
      disposed = true;
      observer.disconnect();
      slot.release();
      releaseRef.current = null;
      setLive(false);
    };
  }, [agentKey, failed]);

  useEffect(() => {
    if (!live || failed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const next = agentOrbSpec(agentKey);
    // Tiny orbs read as jittery at full speed, so slow the drift down.
    const theme =
      size < SMALL_ORB_SIZE
        ? {...next.theme, motion: {...next.theme.motion, speed: SMALL_ORB_SPEED}}
        : next.theme;
    const orb = createOrb(canvas, {
      theme,
      timeOffset: next.timeOffset,
      quality: 'low',
      state: stateRef.current,
      reducedMotion: 'user',
      onError: () => setFailureKey(agentKey),
    });
    controllerRef.current = orb;
    return () => {
      controllerRef.current = null;
      orb.destroy();
    };
  }, [live, failed, agentKey, size]);

  useEffect(() => {
    controllerRef.current?.setState(state);
  }, [state, live]);

  useEffect(() => {
    if (!failed) return;
    releaseRef.current?.();
  }, [failed]);

  const accessibleName = label?.trim() || 'Agent';

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={accessibleName}
      className={cn(
        'agent-orb orb-motion shrink-0 overflow-hidden rounded-full',
        showFallback && 'orb-no-webgl',
        className,
      )}
      data-ambient-motion="false"
      style={
        {
          width: size,
          height: size,
          '--orb-diameter': `${size}px`,
          '--orb-motion-distance': '0px',
          '--orb-motion-scale': '1',
        } as CSSProperties
      }
    >
      <div className="orb-shell">
        <div className="orb-clip">
          <canvas ref={canvasRef} className="orb-canvas" aria-hidden />
          <div
            className="orb-fallback"
            aria-hidden
            style={{background: agentOrbFallbackBackground(spec.theme)}}
          />
        </div>
      </div>
    </div>
  );
}
