import {
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
  type TransitionEvent,
} from 'react';
import { LogOut } from 'lucide-react';

type HoldSignOutButtonProps = {
  onConfirm: () => void;
  holdDuration?: number;
  text?: string;
  holdText?: string;
  icon?: ReactNode;
  className?: string;
  /** Fill color for the hold progress bar (mysocial: `bg-[var(--destructive-foreground)]`). */
  progressBarClassName?: string;
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
  progressBarClassName = 'bg-[var(--destructive-foreground)]',
}: Readonly<HoldSignOutButtonProps>) {
  const [isHolding, setIsHolding] = useState(false);
  const actionFiredRef = useRef(false);
  const holdingRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const cancelHold = () => {
    holdingRef.current = false;
    setIsHolding(false);
  };

  const handleHoldStart = (
    e: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    actionFiredRef.current = false;
    holdingRef.current = true;
    setIsHolding(true);
  };

  const handleHoldEnd = (
    e: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    if (holdingRef.current && !actionFiredRef.current) {
      cancelHold();
    }
    buttonRef.current?.blur();
  };

  const handleFillComplete = (event: TransitionEvent<HTMLSpanElement>) => {
    if (event.propertyName !== 'width') return;
    if (!holdingRef.current || actionFiredRef.current) return;
    actionFiredRef.current = true;
    cancelHold();
    onConfirm();
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`relative w-full touch-none overflow-hidden ${className}`}
      style={isHolding ? { backgroundColor: 'var(--accent)' } : undefined}
      onMouseDown={handleHoldStart}
      onMouseUp={handleHoldEnd}
      onMouseLeave={handleHoldEnd}
      onTouchStart={handleHoldStart}
      onTouchEnd={handleHoldEnd}
      onTouchCancel={handleHoldEnd}
    >
      <span
        aria-hidden
        onTransitionEnd={handleFillComplete}
        className={`pointer-events-none absolute top-0 left-0 z-0 h-full ${progressBarClassName}`}
        style={{
          width: isHolding ? '100%' : '0%',
          transitionProperty: 'width',
          transitionTimingFunction: 'linear',
          transitionDuration: isHolding ? `${holdDuration}ms` : '100ms',
        }}
      />
      <span className="relative z-10 flex w-full select-none items-center gap-2">
        {icon}
        <span>{isHolding ? holdText : text}</span>
      </span>
    </button>
  );
}
