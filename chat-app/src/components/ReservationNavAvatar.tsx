import { useEffect, useId, useRef } from 'react';
import defaultAvatar from '../assets/default-avatar.png';
import { useRingGradientFromImage } from '../hooks/useRingGradientFromImage';

/** Compact nav presets matching mysocial-frontend `RESERVATION_MEDIA_AVATAR_PRESETS`. */
const PRESETS = {
  md: { size: 36, padding: 3.25, strokeWidth: 1.75 },
  navDropdown: { size: 48, padding: 4, strokeWidth: 2.35 },
} as const;

/** Soft gray when image average-color sampling fails (never lime). */
const NEUTRAL_RING_GRADIENT = {
  from: '#C8CCD4',
  to: '#6B7280',
} as const;

/**
 * Size-aware ring layout aligned with mysocial compact presets
 * (governanceNominee / navTrigger / navDropdown).
 */
function ringLayoutForSize(size: number): {
  size: number;
  padding: number;
  strokeWidth: number;
} {
  if (size <= 30) {
    return { size, padding: 2, strokeWidth: 1.85 };
  }
  if (size <= 40) {
    return { size, padding: 3.25, strokeWidth: 1.75 };
  }
  if (size <= 46) {
    return { size, padding: 3.5, strokeWidth: 2 };
  }
  return { size, padding: 4, strokeWidth: 2.35 };
}

/** Outer box width for a bubble avatar (includes SPT ring when shown). */
export function reservationAvatarShellSize(
  size: number,
  showRing: boolean,
): number {
  if (!showRing) return size;
  const { padding, strokeWidth } = ringLayoutForSize(size);
  return size + padding * 2 + strokeWidth;
}

type ReservationNavAvatarProps = {
  address?: string;
  imageSrc?: string | null;
  size?: keyof typeof PRESETS | number;
  showRing?: boolean;
  ringPercent?: number;
  className?: string;
  /**
   * mysocial ProfileNavReservationAvatar hover/press size motion
   * (photo scale-105, ring 1.015). Use on the nav trigger only.
   */
  interactive?: boolean;
};

/**
 * Nav avatar + SPT reservation ring (Vite-friendly port of
 * ProfileNavReservationAvatar / ReservationMediaAvatar).
 * Progress starts at 6 o'clock and grows clockwise; ring color syncs from image average.
 */
export function ReservationNavAvatar({
  imageSrc,
  size = 'md',
  showRing = false,
  ringPercent = 0,
  className = '',
  interactive = false,
}: Readonly<ReservationNavAvatarProps>) {
  const preset =
    typeof size === 'number' ? ringLayoutForSize(size) : PRESETS[size];
  const imageDiameter = preset.size;
  const padding = showRing ? preset.padding : 0;
  const strokeWidth = showRing ? preset.strokeWidth : 0;
  const shellSize = imageDiameter + padding * 2 + strokeWidth;
  const gradientId = useId().replace(/:/g, '');
  const imageInset = padding + strokeWidth / 2;

  const resolvedSrc = imageSrc?.trim() || null;
  const imageKeyForHook = showRing && resolvedSrc ? resolvedSrc : null;
  const {
    ringGradient,
    imageGradientPending,
    onAvatarImageLoad,
    onAvatarImageError,
  } = useRingGradientFromImage(imageKeyForHook);
  const corsRetryRef = useRef(false);
  const src = resolvedSrc || defaultAvatar;

  useEffect(() => {
    corsRetryRef.current = false;
  }, [src]);

  const radius = (shellSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, ringPercent));
  const dashOffset = circumference - (clamped / 100) * circumference;

  const gradientFrom = ringGradient?.from ?? NEUTRAL_RING_GRADIENT.from;
  const gradientTo = ringGradient?.to ?? NEUTRAL_RING_GRADIENT.to;
  const revealProgressArc =
    clamped > 0 && !(imageGradientPending && !ringGradient);

  const media = (
    <img
      key={`${src}:${showRing ? 'ring' : 'plain'}`}
      src={src}
      alt=""
      width={imageDiameter}
      height={imageDiameter}
      className="h-full w-full rounded-full object-cover"
      style={{ width: imageDiameter, height: imageDiameter }}
      referrerPolicy="no-referrer"
      crossOrigin={showRing ? 'anonymous' : undefined}
      onLoad={
        showRing
          ? (e) => onAvatarImageLoad(e.currentTarget)
          : undefined
      }
      onError={
        showRing
          ? (e) => {
              onAvatarImageError();
              const img = e.currentTarget;
              // CORS-blocked remote photos often fail with crossOrigin set —
              // retry once without it so the face still shows (neutral ring).
              if (!corsRetryRef.current && img.crossOrigin) {
                corsRetryRef.current = true;
                img.crossOrigin = null;
                img.src = src;
              }
            }
          : undefined
      }
      draggable={false}
    />
  );

  if (!showRing) {
    return (
      <span
        className={`inline-flex shrink-0 overflow-hidden rounded-full ${
          interactive
            ? 'transition-transform duration-300 ease-out hover:scale-105 active:scale-95'
            : ''
        } ${className}`}
      >
        {media}
      </span>
    );
  }

  // Match mysocial ProfileNavReservationAvatar / explore table when interactive:
  // photo scales on hover; ring nudges slightly (CSS --ring-scale).
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${
        interactive
          ? 'group hover:[--ring-scale:1.015]'
          : ''
      } ${className}`}
      style={{ width: shellSize, height: shellSize }}
    >
      <span
        className={`absolute z-0 overflow-hidden rounded-full border border-secondary-300/50 bg-secondary-200 dark:border-secondary-700/80 dark:bg-secondary-800 ${
          interactive
            ? 'transition-transform duration-300 ease-out group-hover:scale-105'
            : ''
        }`}
        style={{
          width: imageDiameter,
          height: imageDiameter,
          top: imageInset,
          left: imageInset,
        }}
      >
        {media}
      </span>
      <svg
        width={shellSize}
        height={shellSize}
        className={`pointer-events-none absolute inset-0 z-[1] origin-center ${
          interactive ? 'transition-transform duration-300 ease-out' : ''
        }`}
        style={{
          transform: interactive
            ? 'rotate(90deg) scale(var(--ring-scale, 1))'
            : 'rotate(90deg)',
        }}
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor={gradientFrom} />
            <stop offset="100%" stopColor={gradientTo} />
          </linearGradient>
        </defs>
        <circle
          cx={shellSize / 2}
          cy={shellSize / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-secondary-300/40 dark:text-secondary-600/50"
        />
        {revealProgressArc && (
          <circle
            cx={shellSize / 2}
            cy={shellSize / 2}
            r={radius}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        )}
      </svg>
    </span>
  );
}
