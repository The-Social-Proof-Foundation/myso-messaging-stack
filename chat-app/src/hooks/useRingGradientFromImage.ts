import { useState, useCallback, useEffect, useRef } from 'react';
import {
  accentFromImageElement,
  buildAccentFromRgb,
  getAverageColorFromImageUrl,
  getCachedRingImageAccent,
  setCachedRingImageAccent,
  type ImageAccentFromSample,
} from '../lib/image-average-color';

/** Pill style derived from sampled image (average fill + WCAG luminance text). */
export type RingImageLabelStyle = {
  backgroundColor: string;
  color: string;
};

function resolveInitialAccent(
  imageKey: string | null | undefined,
): ImageAccentFromSample | null {
  return getCachedRingImageAccent(imageKey);
}

function resolveInitialPending(imageKey: string | null | undefined): boolean {
  const key = imageKey?.trim();
  if (!key) return false;
  return getCachedRingImageAccent(key) == null;
}

/**
 * SVG ring gradient from a loaded avatar `<img>`.
 * Restores last sampled accent per URL synchronously; prefetches when uncached.
 * Ported from mysocial-frontend/hooks/useRingGradientFromImage.ts.
 */
export function useRingGradientFromImage(imageKey: string | null | undefined) {
  const [accent, setAccent] = useState<ImageAccentFromSample | null>(() =>
    resolveInitialAccent(imageKey),
  );
  const [imageGradientPending, setImageGradientPending] = useState(() =>
    resolveInitialPending(imageKey),
  );
  const prefetchGenRef = useRef(0);

  useEffect(() => {
    const key = imageKey?.trim();
    const gen = ++prefetchGenRef.current;

    if (!key) {
      setAccent(null);
      setImageGradientPending(false);
      return;
    }

    const cached = getCachedRingImageAccent(key);
    if (cached) {
      setAccent(cached);
      setImageGradientPending(false);
      return;
    }

    setAccent(null);
    setImageGradientPending(true);

    const controller = new AbortController();
    void getAverageColorFromImageUrl(key, { signal: controller.signal }).then(
      (rgb) => {
        if (controller.signal.aborted || prefetchGenRef.current !== gen) return;
        if (!rgb) {
          // CORS / sample failure — clear pending so callers can use neutral fallback.
          setImageGradientPending(false);
          return;
        }
        const sampled = buildAccentFromRgb(rgb);
        setCachedRingImageAccent(key, sampled);
        setAccent(sampled);
        setImageGradientPending(false);
      },
    );

    return () => controller.abort();
  }, [imageKey]);

  const applyAccent = useCallback(
    (next: ImageAccentFromSample | null, url?: string) => {
      setAccent(next);
      setImageGradientPending(false);
      const key = url?.trim();
      if (next && key) setCachedRingImageAccent(key, next);
    },
    [],
  );

  const onAvatarImageLoad = useCallback(
    (img: HTMLImageElement) => {
      const sampled = accentFromImageElement(img);
      applyAccent(sampled, imageKey ?? undefined);
    },
    [applyAccent, imageKey],
  );

  const onAvatarImageError = useCallback(() => {
    applyAccent(null);
  }, [applyAccent]);

  const labelAccent: RingImageLabelStyle | null = accent
    ? { backgroundColor: accent.averageHex, color: accent.labelColor }
    : null;

  return {
    ringGradient: accent?.gradient ?? null,
    labelAccent,
    imageGradientPending,
    onAvatarImageLoad,
    onAvatarImageError,
  };
}
