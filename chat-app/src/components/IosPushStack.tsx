import { useEffect, useRef, useState, type ReactNode } from 'react';

type Phase = 'idle' | 'push' | 'pop';

/**
 * Horizontal push, the way iOS opens a screen.
 * A deeper view slides in from the right. Back slides that screen off to the right.
 */
export function IosPushStack<T extends string>({
  view,
  level,
  render,
}: Readonly<{
  view: T;
  /** Higher means further down the stack. An increase pushes; a decrease pops. */
  level: number;
  render: (view: T) => ReactNode;
}>) {
  const shown = useRef({ view, level });
  const [current, setCurrent] = useState(view);
  const [previous, setPrevious] = useState<T | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    if (view === shown.current.view) return;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nextPhase: Phase = reduce ? 'idle' : level > shown.current.level ? 'push' : 'pop';
    const leaving = shown.current.view;
    shown.current = { view, level };
    setCurrent(view);
    setPrevious(nextPhase === 'idle' ? null : leaving);
    setPhase(nextPhase);
  }, [view, level]);

  function finish(event: React.AnimationEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.animationName !== 'ios-push-in' && event.animationName !== 'ios-pop-out') return;
    setPrevious(null);
    setPhase('idle');
  }

  const idle = phase === 'idle' || !previous;

  return (
    <div className="relative h-full min-h-0 flex-1 overflow-hidden">
      {!idle && phase === 'push' ? (
        <div className="ios-push-under pointer-events-none absolute inset-0 z-0">
          {render(previous)}
          <div className="ios-dim-in pointer-events-none absolute inset-0 bg-black/25" />
        </div>
      ) : null}

      {!idle && phase === 'pop' ? (
        <div
          className="ios-pop-over pointer-events-none absolute inset-0 z-10"
          onAnimationEnd={finish}
        >
          {render(previous)}
        </div>
      ) : null}

      <div
        className={
          idle
            ? 'relative h-full min-h-0'
            : phase === 'push'
              ? 'ios-push-over absolute inset-0 z-10'
              : 'ios-pop-under absolute inset-0 z-0'
        }
        onAnimationEnd={phase === 'push' ? finish : undefined}
      >
        {render(current)}
        {!idle && phase === 'pop' ? (
          <div className="ios-dim-out pointer-events-none absolute inset-0 bg-black/25" />
        ) : null}
      </div>
    </div>
  );
}
