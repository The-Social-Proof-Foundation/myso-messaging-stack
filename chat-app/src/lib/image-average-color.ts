/**
 * Sample average color from profile / icon images for UI accents (e.g. progress rings).
 * Requires CORS-enabled images (`crossOrigin="anonymous"` on `<img>`) or same-origin URLs;
 * otherwise canvas is tainted and these APIs return null.
 *
 * Ported from mysocial-frontend/lib/image-average-color.ts.
 */

export type Rgb = { r: number; g: number; b: number };

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToCssHex(rgb: Rgb): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function blendRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: clamp255(a.r + (b.r - a.r) * t),
    g: clamp255(a.g + (b.g - a.g) * t),
    b: clamp255(a.b + (b.b - a.b) * t),
  };
}

/**
 * Builds two hex stops for a linear gradient: lighter mix (typical ring “highlight” side)
 * and darker mix (depth), both anchored to the image average.
 */
export function gradientStopsFromAverageRgb(
  rgb: Rgb,
  options?: {
    /** 0–1 mix toward white for the lighter stop */
    lighten?: number;
    /** 0–1 mix toward near-black for the darker stop */
    darken?: number;
  },
): { from: string; to: string } {
  const lighten = options?.lighten ?? 0.4;
  const darken = options?.darken ?? 0.35;
  const light = blendRgb(rgb, { r: 255, g: 255, b: 255 }, lighten);
  const dark = blendRgb(rgb, { r: 18, g: 18, b: 22 }, darken);
  return { from: rgbToCssHex(light), to: rgbToCssHex(dark) };
}

function linearizeSrgbChannel(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance for sRGB (0 = black, 1 = white). */
export function relativeLuminance(rgb: Rgb): number {
  const r = linearizeSrgbChannel(rgb.r);
  const g = linearizeSrgbChannel(rgb.g);
  const b = linearizeSrgbChannel(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Near-black anchor aligned with `gradientStopsFromAverageRgb` dark stop. */
const RING_LUMINANCE_POP_DARK: Rgb = { r: 18, g: 18, b: 22 };

/**
 * Subtle lightness nudge for ring gradients: darker averages lift a hair toward white,
 * lighter averages dip a hair toward charcoal so the stroke separates from the photo without
 * changing hue family (still the same sampled color, slightly “turned up” for the stage).
 */
export function ringAccentRgbFromAverage(rgb: Rgb, strength = 0.065): Rgb {
  const L = relativeLuminance(rgb);
  if (L <= 0.52) {
    return blendRgb(rgb, { r: 255, g: 255, b: 255 }, strength);
  }
  return blendRgb(rgb, RING_LUMINANCE_POP_DARK, strength);
}

/** Black or white text for solid fills on `rgb` (readable contrast on medium saturation colors). */
export function contrastTextForRgb(rgb: Rgb): '#000000' | '#ffffff' {
  return relativeLuminance(rgb) > 0.55 ? '#000000' : '#ffffff';
}

export type ImageAccentFromSample = {
  gradient: { from: string; to: string };
  averageHex: string;
  labelColor: '#000000' | '#ffffff';
};

/** Ring gradient + label colors from a sampled average RGB. */
export function buildAccentFromRgb(
  rgb: Rgb,
  gradient?: Parameters<typeof gradientStopsFromAverageRgb>[1],
): ImageAccentFromSample {
  const ringRgb = ringAccentRgbFromAverage(rgb);
  return {
    gradient: gradientStopsFromAverageRgb(ringRgb, gradient),
    averageHex: rgbToCssHex(rgb),
    labelColor: contrastTextForRgb(rgb),
  };
}

/** Average color, ring gradient stops, and accessible label text color from a loaded `<img>`. */
export function accentFromImageElement(
  img: HTMLImageElement,
  options?: {
    sample?: { maxDimension?: number };
    gradient?: Parameters<typeof gradientStopsFromAverageRgb>[1];
  },
): ImageAccentFromSample | null {
  const rgb = getAverageColorFromImageElement(img, options?.sample);
  if (!rgb) return null;
  return buildAccentFromRgb(rgb, options?.gradient);
}

const RING_ACCENT_STORAGE_PREFIX = 'myso-chat:ring-accent:';
const ringAccentMemoryCache = new Map<string, ImageAccentFromSample>();

function ringAccentStorageKey(url: string): string {
  return `${RING_ACCENT_STORAGE_PREFIX}${url}`;
}

function isValidImageAccent(value: unknown): value is ImageAccentFromSample {
  if (!value || typeof value !== 'object') return false;
  const v = value as ImageAccentFromSample;
  return Boolean(
    v.gradient?.from && v.gradient?.to && v.averageHex && v.labelColor,
  );
}

/** Restores last sampled ring accent for an image URL (memory, then sessionStorage). */
export function getCachedRingImageAccent(
  url: string | null | undefined,
): ImageAccentFromSample | null {
  const key = url?.trim();
  if (!key) return null;

  const hit = ringAccentMemoryCache.get(key);
  if (hit) return hit;

  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ringAccentStorageKey(key));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isValidImageAccent(parsed)) {
      ringAccentMemoryCache.set(key, parsed);
      return parsed;
    }
  } catch {
    // ignore quota / private mode
  }
  return null;
}

export function setCachedRingImageAccent(
  url: string,
  accent: ImageAccentFromSample,
): void {
  const key = url.trim();
  if (!key) return;
  ringAccentMemoryCache.set(key, accent);
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(ringAccentStorageKey(key), JSON.stringify(accent));
  } catch {
    // ignore quota / private mode
  }
}

/**
 * Downscale-draw onto a canvas and average opaque pixels.
 */
export function getAverageColorFromImageElement(
  img: HTMLImageElement,
  options?: { maxDimension?: number },
): Rgb | null {
  if (typeof document === 'undefined') return null;
  if (!img.complete || img.naturalWidth === 0) return null;

  const maxD = options?.maxDimension ?? 56;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const scale = Math.min(1, maxD / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!;
      if (a < 12) continue;
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      n++;
    }
    if (n === 0) return null;
    return {
      r: Math.round(r / n),
      g: Math.round(g / n),
      b: Math.round(b / n),
    };
  } catch {
    return null;
  }
}

/** One-call helper: average RGB from a loaded `<img>`, then gradient stops for SVG/CSS. */
export function ringGradientFromImageElement(
  img: HTMLImageElement,
  options?: {
    sample?: { maxDimension?: number };
    gradient?: Parameters<typeof gradientStopsFromAverageRgb>[1];
  },
): { from: string; to: string } | null {
  return accentFromImageElement(img, options)?.gradient ?? null;
}

/**
 * Fetches an image with CORS and returns the average RGB, or null on failure / tainted canvas.
 */
export function getAverageColorFromImageUrl(
  url: string,
  options?: { maxDimension?: number; signal?: AbortSignal },
): Promise<Rgb | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!url.trim()) return Promise.resolve(null);

  return new Promise((resolve) => {
    const done = (value: Rgb | null) => resolve(value);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const onAbort = () => done(null);

    if (options?.signal) {
      if (options.signal.aborted) {
        done(null);
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    img.onload = () => {
      options?.signal?.removeEventListener('abort', onAbort);
      done(getAverageColorFromImageElement(img, options));
    };
    img.onerror = () => {
      options?.signal?.removeEventListener('abort', onAbort);
      done(null);
    };
    img.src = url;
  });
}
