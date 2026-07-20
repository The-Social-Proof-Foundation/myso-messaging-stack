import defaultAvatar from '../assets/default-avatar.png';
import type { WalletProfileBits } from '../hooks/useWalletAvatarMap';
import { ReservationNavAvatar } from './ReservationNavAvatar';

const STACK_SIZE = 48;
const FACE_SIZE = 26;
const SINGLE_SIZE = 44;

type ConversationAvatarProps = {
  /** Member wallets for the group (may include self). */
  memberAddresses: readonly string[];
  selfAddress: string | null | undefined;
  profiles: WalletProfileBits;
};

function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function Face({
  src,
  className,
}: Readonly<{
  src: string | null;
  className?: string;
}>) {
  return (
    <img
      src={src?.trim() || defaultAvatar}
      alt=""
      width={FACE_SIZE}
      height={FACE_SIZE}
      className={`rounded-full object-cover ring-2 ring-white dark:ring-secondary-900 ${className ?? ''}`}
      style={{ width: FACE_SIZE, height: FACE_SIZE }}
      referrerPolicy="no-referrer"
      draggable={false}
    />
  );
}

/**
 * Sidebar row avatar: 1:1 peer with SPT ring, or a stacked triangle for groups.
 */
export function ConversationAvatar({
  memberAddresses,
  selfAddress,
  profiles,
}: Readonly<ConversationAvatarProps>) {
  const others = memberAddresses.filter(
    (a) => !sameAddress(a, selfAddress),
  );

  // Unknown membership yet, or empty — default avatar.
  if (others.length === 0) {
    return (
      <ReservationNavAvatar
        imageSrc={null}
        size={SINGLE_SIZE}
        showRing={false}
        className="shrink-0"
      />
    );
  }

  // 1:1 DM — peer avatar + reservation ring (nav-style).
  if (others.length === 1) {
    const peer = others[0]!;
    const ring = profiles.ringFor(peer);
    return (
      <ReservationNavAvatar
        address={peer}
        imageSrc={profiles.photoFor(peer)}
        size={SINGLE_SIZE}
        showRing={ring.showRing}
        ringPercent={ring.ringPercent}
        className="shrink-0"
      />
    );
  }

  // Two peers — overlapping pair (no overflow chip).
  if (others.length === 2) {
    return (
      <span
        className="relative inline-block shrink-0"
        style={{ width: STACK_SIZE, height: STACK_SIZE }}
        aria-hidden
      >
        <span className="absolute left-0 top-1">
          <Face src={profiles.photoFor(others[0]!)} />
        </span>
        <span className="absolute bottom-0 right-0">
          <Face src={profiles.photoFor(others[1]!)} />
        </span>
      </span>
    );
  }

  // 3 peers — full triangle of faces. 4+ — two faces + bottom-right "+N".
  const faceA = others[0]!;
  const faceB = others[1]!;
  const showOverflow = others.length > 3;
  const extra = others.length - 2;

  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: STACK_SIZE, height: STACK_SIZE }}
      aria-hidden
    >
      <span className="absolute left-1/2 top-0 -translate-x-1/2">
        <Face src={profiles.photoFor(faceA)} />
      </span>
      <span className="absolute bottom-0 left-0">
        <Face src={profiles.photoFor(faceB)} />
      </span>
      <span className="absolute bottom-0 right-0">
        {showOverflow ? (
          <span
            className="inline-flex items-center justify-center rounded-full bg-secondary-200 text-[10px] font-semibold text-secondary-700 ring-2 ring-white dark:bg-secondary-600 dark:text-secondary-100 dark:ring-secondary-900"
            style={{ width: FACE_SIZE, height: FACE_SIZE }}
          >
            +{extra > 99 ? 99 : extra}
          </span>
        ) : (
          <Face src={profiles.photoFor(others[2]!)} />
        )}
      </span>
    </span>
  );
}
