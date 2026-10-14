import {useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

interface HoverTipProps {
  /** What the popup says. */
  content: ReactNode;
  children: ReactNode;
  /** Wrapper classes; the wrapper is inline so it sits next to text. */
  className?: string;
}

const GAP_PX = 8;
const EDGE_PX = 8;

/**
 * A small popup that appears just above its trigger on hover or keyboard focus. It is rendered
 * into the document body so a scrolling or clipped parent can never cut it off, and it is kept
 * inside the viewport.
 */
export function HoverTip({content, children, className = ''}: Readonly<HoverTipProps>) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{left: number; top: number} | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(
      Math.max(EDGE_PX, a.left + a.width / 2 - t.width / 2),
      window.innerWidth - t.width - EDGE_PX,
    );
    // Prefer above; flip below when there is no room.
    const above = a.top - t.height - GAP_PX;
    const top = above >= EDGE_PX ? above : a.bottom + GAP_PX;
    setPos({left, top});
  }, []);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, content, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <span
      ref={anchorRef}
      className={`inline-flex ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              role="tooltip"
              style={{
                position: 'fixed',
                left: pos?.left ?? -9999,
                top: pos?.top ?? -9999,
                visibility: pos ? 'visible' : 'hidden',
              }}
              className="pointer-events-none z-[100] max-w-[17rem] rounded-xl border border-white/10 bg-secondary-900/95 px-3 py-2.5 text-[12px] leading-snug text-secondary-100 shadow-2xl backdrop-blur"
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
