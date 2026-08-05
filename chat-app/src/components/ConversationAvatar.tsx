import type { WalletProfileBits } from '../hooks/useWalletAvatarMap';
import {
  ReservationNavAvatar,
  reservationAvatarShellSize,
} from './ReservationNavAvatar';
/** Outer cluster box; smaller = more face overlap (shell ≈ 30px with SPT ring). */
const STACK_SIZE = 46;
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

function StackedFace({
  address,
  profiles,
}: Readonly<{
  address: string;
  profiles: WalletProfileBits;
}>) {
  const ring = profiles.ringFor(address);
  return (
    <ReservationNavAvatar
      address={address}
      imageSrc={profiles.photoFor(address)}
      size={FACE_SIZE}
      showRing={ring.showRing}
      ringPercent={ring.ringPercent}
      className="shrink-0 shadow-sm dark:shadow-none"
    />
  );
}

/**
 * Sidebar row avatar: 1:1 peer with SPT ring, or a stacked cluster for groups
 * (each face keeps its own SPT identity ring).
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

  // Max shell for a stacked face (layout budget for the cluster box).
  const faceShell = reservationAvatarShellSize(FACE_SIZE, true);

  // Two peers — overlapping pair (no overflow chip).
  if (others.length === 2) {
    return (
      <span
        className="relative inline-block shrink-0"
        style={{ width: STACK_SIZE, height: STACK_SIZE }}
        aria-hidden
      >
        <span className="absolute left-0 top-0 z-0">
          <StackedFace address={others[0]!} profiles={profiles} />
        </span>
        <span className="absolute bottom-0 right-0 z-10">
          <StackedFace address={others[1]!} profiles={profiles} />
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
      <span className="absolute left-1/2 top-0 z-0 -translate-x-1/2">
        <StackedFace address={faceA} profiles={profiles} />
      </span>
      <span className="absolute bottom-0 left-0 z-10">
        <StackedFace address={faceB} profiles={profiles} />
      </span>
      <span className="absolute bottom-0 right-0 z-20">
        {showOverflow ? (
          <span
            className="inline-flex items-center justify-center rounded-full bg-secondary-200 text-[10px] font-semibold text-secondary-700 ring-2 ring-white dark:bg-secondary-600 dark:text-secondary-100 dark:ring-secondary-900"
            style={{ width: faceShell, height: faceShell }}
          >
            +{extra > 99 ? 99 : extra}
          </span>
        ) : (
          <StackedFace address={others[2]!} profiles={profiles} />
        )}
      </span>
    </span>
  );
}
