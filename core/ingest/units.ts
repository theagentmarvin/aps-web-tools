/**
 * Clash distance units and sign convention.
 *
 * research §3.2 / §8.7: the unit and the sign of `dist` are UNVERIFIED.
 * The documented assumption (legacy client, supported by the 0.5 mm / 0.0005 m
 * MC tolerance in H:faq) is METRES with NEGATIVE = PENETRATION. Both are
 * parameters so a single real-project check can flip them without code changes.
 *
 * TODO(research §3.2, open risk 1): validate `dist` unit and sign against the
 * ACC UI on a real clash, then pin the defaults and drop this TODO.
 */
import type { ClashKind } from "../types";

export type DistanceUnit = "m" | "mm" | "cm" | "ft" | "in";
export type DistSignConvention = "negative_is_penetration" | "positive_is_penetration";

/** Documented assumption (UNVERIFIED): metres. */
export const DEFAULT_DIST_UNIT: DistanceUnit = "m";
/** Documented assumption (UNVERIFIED): negative = penetration. */
export const DEFAULT_DIST_SIGN: DistSignConvention = "negative_is_penetration";

const MM_PER_UNIT: Record<DistanceUnit, number> = { m: 1000, mm: 1, cm: 10, ft: 304.8, in: 25.4 };

/** Multiply a value in `unit` by this to get millimetres. */
export function mmPerUnit(unit: DistanceUnit): number {
  return MM_PER_UNIT[unit];
}

export interface DistanceMm {
  /** Signed, normalised so that NEGATIVE always means penetration. */
  distanceMm: number;
  penetrationMm: number;
  kind: ClashKind;
}

/**
 * Convert a raw `dist` into signed millimetres (negative = penetration, always)
 * plus penetration depth and the hard/clearance flag.
 * Non-finite input gives `kind: "unknown"` and zeros.
 */
export function convertDist(
  raw: number | null | undefined,
  unit: DistanceUnit = DEFAULT_DIST_UNIT,
  sign: DistSignConvention = DEFAULT_DIST_SIGN,
): DistanceMm {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { distanceMm: 0, penetrationMm: 0, kind: "unknown" };
  }
  const mm = roundMm(raw * mmPerUnit(unit));
  const distanceMm = sign === "negative_is_penetration" ? mm : -mm;
  const penetrationMm = distanceMm < 0 ? -distanceMm : 0;
  return { distanceMm: distanceMm === 0 ? 0 : distanceMm, penetrationMm, kind: distanceMm < 0 ? "hard" : "clearance" };
}

/** Round to 0.001 mm to strip float noise from unit conversion. */
function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000;
}
