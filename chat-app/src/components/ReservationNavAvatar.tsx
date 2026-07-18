import { useId, useMemo } from 'react';
import defaultAvatar from '../assets/default-avatar.png';

/** Compact nav presets matching mysocial-frontend `RESERVATION_MEDIA_AVATAR_PRESETS`. */
const PRESETS = {
  md: { size: 36, padding: 3.25, strokeWidth: 1.75 },
  navDropdown: { size: 48, padding: 4, strokeWidth: 2.35 },
} as const;

/** Chat bubble avatars — thicker ring, tighter gap to the photo. */
function ringLayoutForSize(size: number): {
  size: number;
  padding: number;
  strokeWidth: number;
} {
  return { size, padding: 1.5, strokeWidth: 3.25 };
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
};

/**
 * Nav avatar + SPT reservation ring (Vite-friendly port of
 * ProfileNavReservationAvatar / ReservationMediaAvatar).
 */
export function ReservationNavAvatar({
  imageSrc,
  size = 'md',
  showRing = false,
  ringPercent = 0,
  className = '',
}: Readonly<ReservationNavAvatarProps>) {
  const preset =
    typeof size === 'number' ? ringLayoutForSize(size) : PRESETS[size];
  const imageDiameter = preset.size;
  const padding = showRing ? preset.padding : 0;
  const strokeWidth = showRing ? preset.strokeWidth : 0;
  const shellSize = imageDiameter + padding * 2 + strokeWidth;
  const gradientId = useId().replace(/:/g, '');

  const radius = (shellSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, ringPercent));
  const dashOffset = circumference - (clamped / 100) * circumference;

  const media = useMemo(() => {
    const src = imageSrc?.trim() || defaultAvatar;
    return (
      <img
        src={src}
        alt=""
        width={imageDiameter}
        height={imageDiameter}
        className="rounded-full object-cover"
        style={{ width: imageDiameter, height: imageDiameter }}
        referrerPolicy="no-referrer"
      />
    );
  }, [imageSrc, imageDiameter]);

  if (!showRing) {
    return <span className={`inline-flex shrink-0 ${className}`}>{media}</span>;
  }

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: shellSize, height: shellSize }}
    >
      <span
        className="absolute rounded-full"
        style={{
          width: imageDiameter,
          height: imageDiameter,
          top: padding + strokeWidth / 2,
          left: padding + strokeWidth / 2,
        }}
      >
        {media}
      </span>
      <svg
        width={shellSize}
        height={shellSize}
        className="pointer-events-none absolute inset-0 -rotate-90"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#DFFFA8" />
            <stop offset="100%" stopColor="#a3e635" />
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
        {clamped > 0 && (
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
