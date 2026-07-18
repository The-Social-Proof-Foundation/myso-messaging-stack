import {
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { LogOut } from 'lucide-react';

type HoldSignOutButtonProps = {
  onConfirm: () => void;
  holdDuration?: number;
  text?: string;
  holdText?: string;
  icon?: ReactNode;
  className?: string;
};

/**
 * Hold-to-confirm control matching mysocial-frontend Sign Out UX
 * (CSS progress bar — no framer-motion dependency).
 */
export function HoldSignOutButton({
  onConfirm,
  holdDuration = 650,
  text = 'Sign Out',
  holdText = 'Keep holding...',
  icon = <LogOut className="mx-2 h-4 w-4 shrink-0" />,
  className = '',
}: Readonly<HoldSignOutButtonProps>) {
  const [isHolding, setIsHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const actionFiredRef = useRef(false);
  const startTimeRef = useRef(0);
  const rafRef = useRef(0);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const clearHold = () => {
    cancelAnimationFrame(rafRef.current);
    setIsHolding(false);
    setProgress(0);
    startTimeRef.current = 0;
  };

  const tick = () => {
    const elapsed = performance.now() - startTimeRef.current;
    const next = Math.min(100, (elapsed / holdDuration) * 100);
    setProgress(next);
    if (next >= 100) {
      if (!actionFiredRef.current) {
        actionFiredRef.current = true;
        clearHold();
        onConfirm();
      }
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleHoldStart = (
    e: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    actionFiredRef.current = false;
    setIsHolding(true);
    setProgress(0);
    startTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleHoldEnd = (
    e: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    if (isHolding && !actionFiredRef.current) {
      clearHold();
    }
    buttonRef.current?.blur();
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`relative w-full touch-none overflow-hidden ${className}`}
      onMouseDown={handleHoldStart}
      onMouseUp={handleHoldEnd}
      onMouseLeave={handleHoldEnd}
      onTouchStart={handleHoldStart}
      onTouchEnd={handleHoldEnd}
      onTouchCancel={handleHoldEnd}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 z-0 bg-danger-500/20 transition-[width] duration-75 dark:bg-danger-400/25"
        style={{ width: `${progress}%` }}
      />
      <span className="relative z-10 flex w-full select-none items-center gap-2">
        {icon}
        <span>{isHolding ? holdText : text}</span>
      </span>
    </button>
  );
}
