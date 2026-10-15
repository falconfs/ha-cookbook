/**
 * calendar-logic.js — pure, framework-free week/date helpers for the weekly
 * recipe calendar (feature-10).
 *
 * Timezone contract: the card resolves "today" in Home Assistant's configured
 * timezone and passes it in as a YYYY-MM-DD string. These helpers operate on
 * plain ISO date strings and never read the browser clock or construct a
 * timezone-dependent Date, so the plan's day boundaries are stable regardless
 * of where the browser runs.
 *
 * Dates are treated as UTC-noon internally purely for safe arithmetic; only the
 * date part is ever returned.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a YYYY-MM-DD string to a UTC Date at noon (arithmetic-safe). */
function toUtc(iso) {
  const match = ISO_RE.exec(iso);
  if (!match) throw new Error(`Invalid ISO date: ${iso}`);
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

/** Format a UTC Date back to YYYY-MM-DD. */
function toIso(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Validate a plan date: strict YYYY-MM-DD plus a real calendar day.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPlanDate(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth;
}

/**
 * Add (or subtract) whole days to an ISO date.
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
export function addDays(iso, days) {
  return toIso(new Date(toUtc(iso).getTime() + days * DAY_MS));
}

/**
 * Return the ISO date of the first day of the week containing `iso`.
 * @param {string} iso
 * @param {'monday'|'sunday'} weekStart
 * @returns {string}
 */
export function getWeekStart(iso, weekStart = 'monday') {
  const date = toUtc(iso);
  const dow = date.getUTCDay(); // 0=Sun .. 6=Sat
  const offset = weekStart === 'sunday' ? dow : (dow + 6) % 7;
  return toIso(new Date(date.getTime() - offset * DAY_MS));
}

/**
 * Return the seven consecutive ISO dates starting at `weekStartIso`.
 * @param {string} weekStartIso
 * @returns {string[]}
 */
export function getWeekDays(weekStartIso) {
  const start = toUtc(weekStartIso);
  return Array.from({ length: 7 }, (_, index) => toIso(new Date(start.getTime() + index * DAY_MS)));
}

/**
 * Classify a day relative to the HA-local today.
 * @param {string} iso
 * @param {string} todayIso
 * @returns {'past'|'today'|'future'}
 */
export function classifyDay(iso, todayIso) {
  if (iso === todayIso) return 'today';
  return toUtc(iso).getTime() < toUtc(todayIso).getTime() ? 'past' : 'future';
}

/**
 * Index plan entries as grouped[date][slot_id] = [entry, ...], preserving the
 * original add order. When `onlyDays` is given, entries outside that set are
 * skipped (used to render a single week without scanning the whole plan).
 * @param {Array<{id:string,date:string,slot_id:string,recipe_id:string}>} entries
 * @param {string[]} [onlyDays]
 * @returns {Record<string, Record<string, Array<object>>>}
 */
export function groupEntriesByDaySlot(entries, onlyDays) {
  const allowed = onlyDays ? new Set(onlyDays) : null;
  const grouped = {};
  for (const entry of entries) {
    if (allowed && !allowed.has(entry.date)) continue;
    const day = grouped[entry.date] ?? (grouped[entry.date] = {});
    const slot = day[entry.slot_id] ?? (day[entry.slot_id] = []);
    slot.push(entry);
  }
  return grouped;
}

/**
 * Build a localized week-range label from an injected per-day formatter.
 * The formatter receives an ISO date and returns a display string; keeping it
 * injectable makes this pure and testable without Intl locale assumptions.
 * @param {string} weekStartIso
 * @param {{formatDay: (iso: string) => string, separator?: string}} opts
 * @returns {string}
 */
export function formatWeekRange(weekStartIso, { formatDay, separator = ' – ' } = {}) {
  const days = getWeekDays(weekStartIso);
  return `${formatDay(days[0])}${separator}${formatDay(days[6])}`;
}
