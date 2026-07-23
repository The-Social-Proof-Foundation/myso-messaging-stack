/** Desktop conversation list (`md:w-72`). */
export const CHAT_LIST_WIDTH_PX = 288;
/** Desktop AdminPanel / group info (`md:w-80`). */
export const CHAT_INFO_WIDTH_PX = 320;
/** Chat column feels unusable below this. */
export const CHAT_MIN_COMFORT_PX = 360;

/**
 * Auto-open group info when the chat+info shell is at least this wide.
 * Tuned for wide desktop (screenshot ~ shell ≫ 1000px); mid band stays manual.
 */
export const CHAT_SHELL_WIDE_PX = 900;

export type ChatInfoWidthBand = 'narrow' | 'mid' | 'wide';

export function chatInfoWidthBand(
  shellWidth: number,
  chatWidth: number,
  infoOpen: boolean,
): ChatInfoWidthBand {
  const effectiveChat = infoOpen
    ? chatWidth
    : shellWidth - CHAT_INFO_WIDTH_PX;
  if (
    effectiveChat < CHAT_MIN_COMFORT_PX ||
    shellWidth < CHAT_MIN_COMFORT_PX + CHAT_INFO_WIDTH_PX
  ) {
    return 'narrow';
  }
  if (shellWidth >= CHAT_SHELL_WIDE_PX) {
    return 'wide';
  }
  return 'mid';
}

/** Snappy panel width tween (list + info sidebars). */
export const CHAT_SIDEBAR_MOTION =
  'transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]';
