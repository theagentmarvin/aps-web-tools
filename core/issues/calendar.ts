/**
 * Business-day arithmetic on ISO dates (YYYY-MM-DD), UTC-based so results do
 * not depend on the host time zone. Weekdays: 0 = Sunday … 6 = Saturday.
 */

const DAY = 86_400_000;

export function parseIsoDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad ISO date '${s}' (expected YYYY-MM-DD)`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (formatIsoDate(t) !== s) throw new Error(`invalid date '${s}'`);
  return t;
}

export function formatIsoDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** dd-mm-aaaa (Chilean format used in issue text). */
export function formatEs(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

/** dd-mm (short form, e.g. "ajustado a reunión del 18-11"). */
export function formatEsShort(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}-${m}`;
}

export function weekday(iso: string): number {
  return new Date(parseIsoDate(iso)).getUTCDay();
}

export function addDays(iso: string, n: number): string {
  return formatIsoDate(parseIsoDate(iso) + n * DAY);
}

export function isBusinessDay(iso: string, holidays: ReadonlySet<string>): boolean {
  const wd = weekday(iso);
  return wd !== 0 && wd !== 6 && !holidays.has(iso);
}

/** bd(date, n): add n business days (Mon–Fri, skipping holidays). n = 0 returns the date. */
export function addBusinessDays(iso: string, n: number, holidays: ReadonlySet<string>): string {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d, holidays)) left--;
  }
  return d;
}

/** First date >= iso falling on `wd`. */
export function nextWeekdayOnOrAfter(iso: string, wd: number): string {
  const delta = (wd - weekday(iso) + 7) % 7;
  return addDays(iso, delta);
}

/** Last business day strictly before iso. */
export function lastBusinessDayBefore(iso: string, holidays: ReadonlySet<string>): string {
  let d = addDays(iso, -1);
  while (!isBusinessDay(d, holidays)) d = addDays(d, -1);
  return d;
}

export const maxIso = (a: string, b: string) => (a >= b ? a : b);
