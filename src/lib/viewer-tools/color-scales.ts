/**
 * Color Scales — predefined palettes for property value coloring.
 *
 * Stage 2: categorical palette for distinct property values.
 * Future: sequential/diverging gradients for numeric properties.
 */

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

/** Sequential blue gradient — for numeric properties (future). */
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

/** Convert hex color to THREE.Vector4 (r, g, b, alpha). */
export function hexToVector4(hex: string, alpha = 1): { x: number; y: number; z: number; w: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { x: r, y: g, z: b, w: alpha };
}

/**
 * Assign a color from the categorical palette to each unique value.
 * Returns a stable Map<string, hexColor> — same value always gets the same color.
 */
export function assignColors(values: string[]): Map<string, string> {
  const map = new Map<string, string>();
  // Sort by frequency (most common first) for better visual priority
  const unique = [...new Set(values)];
  unique.forEach((val, i) => {
    map.set(val, CATEGORICAL[i % CATEGORICAL.length]);
  });
  return map;
}

/** Get a specific color for a value index (used for lookups). */
export function getColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length];
}

export { CATEGORICAL, SEQUENTIAL_BLUE };
