/**
 * Color Scales — predefined palettes for property value coloring.
 *
 * Stage 2: categorical palette for distinct property values.
 * Stage 3: sequential/diverging gradients for numeric properties.
 */

// ── Palette Definitions ────────────────────────────────────────────

/** 12-color categorical palette — high contrast, colorblind-aware. */
const CATEGORICAL = [
  "#1f77b4", // blue
  "#ff7f0e", // orange
  "#2ca02c", // green
  "#d62728", // red
  "#9467bd", // purple
  "#8c564b", // brown
  "#e377c2", // pink
  "#7f7f7f", // gray
  "#bcbd22", // olive
  "#17becf", // cyan
  "#aec7e8", // light blue
  "#ffbb78", // light orange
];

/** Sequential blue gradient — for numeric properties (low→high). */
const SEQUENTIAL_BLUE = [
  "#f7fbff",
  "#deebf7",
  "#c6dbef",
  "#9ecae1",
  "#6baed6",
  "#4292c6",
  "#2171b5",
  "#08519c",
  "#08306b",
];

/** Diverging blue-white-red — for numeric properties with a meaningful midpoint. */
const DIVERGING_BLUE_RED = [
  "#053061",
  "#2166ac",
  "#4393c3",
  "#92c5de",
  "#d1e5f0",
  "#f7f7f7",
  "#fddbc7",
  "#f4a582",
  "#d6604d",
  "#b2182b",
  "#67001f",
];

// ── Color Conversion ───────────────────────────────────────────────

export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Hex string → { r, g, b } 0-255. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Convert hex color to THREE.Vector4 (r, g, b, alpha) 0-1. */
export function hexToVector4(hex: string, alpha = 1): Vec4 {
  const c = hexToRgb(hex);
  return { x: c.r / 255, y: c.g / 255, z: c.b / 255, w: alpha };
}

// ── Numeric Detection ──────────────────────────────────────────────

/**
 * Return true if ≥80% of values parse as numbers.
 * Filters out empty strings and unit-only strings (e.g. "mm", "°").
 */
export function isNumericProperty(values: string[]): boolean {
  if (values.length === 0) return false;
  let numeric = 0;
  const nonEmpty = values.filter((v) => v.trim() !== "");
  if (nonEmpty.length === 0) return false;

  for (const v of nonEmpty) {
    // Strip common unit suffixes, comma separators
    const cleaned = v.replace(/[,\s]/g, "").replace(/mm$|cm$|m$|°$|%$|kg$|kN$/i, "");
    if (cleaned !== "" && !isNaN(Number(cleaned))) numeric++;
  }
  return numeric / nonEmpty.length >= 0.8;
}

/** Extract numeric value from a property string, stripping units. */
export function toNumeric(value: string): number {
  const cleaned = value
    .replace(/[,\s]/g, "")
    .replace(/mm$|cm$|m$|°$|%$|kg$|kN$/i, "");
  return Number(cleaned);
}

// ── Gradient Interpolation ─────────────────────────────────────────

/**
 * Linearly interpolate between two colors, returning a hex string.
 */
function lerpColor(hexA: string, hexB: string, t: number): string {
  const ca = hexToRgb(hexA);
  const cb = hexToRgb(hexB);
  const rc = Math.round(ca.r + (cb.r - ca.r) * t);
  const gc = Math.round(ca.g + (cb.g - ca.g) * t);
  const bc = Math.round(ca.b + (cb.b - ca.b) * t);
  return `#${rc.toString(16).padStart(2, "0")}${gc.toString(16).padStart(2, "0")}${bc.toString(16).padStart(2, "0")}`;
}

/**
 * Map a numeric value within [min, max] to a color from a gradient array.
 */
function gradientColor(
  value: number,
  min: number,
  max: number,
  gradient: string[],
): string {
  if (min === max) return gradient[Math.floor(gradient.length / 2)];
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const idx = t * (gradient.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, gradient.length - 1);
  const frac = idx - lo;
  return lerpColor(gradient[lo], gradient[hi], frac);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Detect value type and return a color map.
 * - Numeric → continuous gradient (sequential blue by default)
 * - Categorical → discrete palette
 */
export function assignColors(
  values: string[],
  scale: "categorical" | "sequential" | "diverging" = "categorical",
): Map<string, string> {
  const map = new Map<string, string>();
  const unique = [...new Set(values)];

  if (scale === "sequential" || scale === "diverging") {
    const nums = unique.map(toNumeric).filter((n) => !isNaN(n));
    if (nums.length > 0) {
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const gradient = scale === "diverging" ? DIVERGING_BLUE_RED : SEQUENTIAL_BLUE;
      for (const val of unique) {
        const n = toNumeric(val);
        if (!isNaN(n)) {
          map.set(val, gradientColor(n, min, max, gradient));
        } else {
          map.set(val, "#7f7f7f"); // gray for non-numeric outliers
        }
      }
      return map;
    }
  }

  // Fallback: categorical
  unique.forEach((val, i) => {
    map.set(val, CATEGORICAL[i % CATEGORICAL.length]);
  });
  return map;
}

/** Get a specific color for a value index. */
export function getColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length];
}

/** Get gradient raw array — for legend rendering. */
export function getGradient(): string[] {
  return DIVERGING_BLUE_RED;
}

export { CATEGORICAL, SEQUENTIAL_BLUE, DIVERGING_BLUE_RED };
