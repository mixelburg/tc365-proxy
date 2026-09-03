// src/time.ts — TimeClock 365 time handling.
// TC365 returns naive UTC datetime strings ("2026-09-03 05:42:30").
// All user-facing rendering converts them to Asia/Jerusalem.

const IL_TZ = 'Asia/Jerusalem';

/**
 * Parse a TC365 datetime string ("YYYY-MM-DD HH:mm[:ss]" or ISO-like) as UTC.
 * Returns null when the string doesn't look like a TC365 timestamp.
 */
export function parseTcTime(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

/** Format an instant as HH:MM:SS in Israel time. */
export function fmtIL(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour12: false, timeZone: IL_TZ });
}

/** Format a TC365 UTC string (or epoch ms) as HH:MM:SS Israel time. */
export function fmtTcIL(raw: string | number | undefined | null, fallback: string): string {
  let d: Date | null = null;
  if (typeof raw === 'number') d = new Date(raw);
  else d = parseTcTime(raw);
  if (!d || Number.isNaN(d.getTime())) return fallback;
  return fmtIL(d);
}
