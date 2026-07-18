import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns false during SSR / before mount
 * when `window` is unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Phone-width stack nav (`max-md` / below Tailwind `md`). */
export const MOBILE_NAV_MEDIA_QUERY = '(max-width: 767px)';

export function useIsMobileNav(): boolean {
  return useMediaQuery(MOBILE_NAV_MEDIA_QUERY);
}
