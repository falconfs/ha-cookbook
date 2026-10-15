/**
 * recipe-logic.js — pure, framework-free helpers for the cookbook card.
 *
 * Extracted so the sorting and "new" banner rules can be unit-tested with
 * node:test without a DOM. No imports, no side effects.
 */

/** Available sort options for the toolbar dropdown (order = display order). */
export const SORT_OPTIONS = [
  { value: 'name-asc' },
  { value: 'name-desc' },
  { value: 'date-desc' },
  { value: 'date-asc' },
];

/** Default sort applied when the card config does not specify one. */
export const DEFAULT_SORT = 'date-desc';

const VALID_SORTS = new Set(SORT_OPTIONS.map(o => o.value));

/**
 * Resolve a configured default-sort value to a valid sort key.
 * Forgiving: trims + lowercases; falls back to DEFAULT_SORT on anything invalid.
 * @param {unknown} value
 * @returns {string}
 */
export function resolveDefaultSort(value) {
  if (typeof value !== 'string') return DEFAULT_SORT;
  const key = value.trim().toLowerCase();
  return VALID_SORTS.has(key) ? key : DEFAULT_SORT;
}

/**
 * Parse a recipe's creation timestamp to epoch millis.
 * Returns NaN for missing/invalid values so callers can push them last.
 * @param {{dateCreated?: string}} recipe
 * @returns {number}
 */
function createdMillis(recipe) {
  const raw = recipe && recipe.dateCreated;
  if (!raw) return NaN;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Return a new array of recipes sorted by the given key. Does not mutate input.
 * Name sorts are locale-aware (de) and case-insensitive. Date sorts place
 * recipes with a missing/invalid dateCreated last, regardless of direction.
 *
 * @param {Array<object>} recipes
 * @param {string} sortKey  one of SORT_OPTIONS[].value
 * @returns {Array<object>}
 */
export function sortRecipes(recipes, sortKey) {
  const key = VALID_SORTS.has(sortKey) ? sortKey : DEFAULT_SORT;
  const list = [...recipes];

  if (key === 'name-asc' || key === 'name-desc') {
    const dir = key === 'name-asc' ? 1 : -1;
    list.sort((a, b) =>
      dir * (a.name || '').localeCompare(b.name || '', 'de', { sensitivity: 'base' })
    );
    return list;
  }

  // date-desc / date-asc
  const dir = key === 'date-asc' ? 1 : -1;
  list.sort((a, b) => {
    const ta = createdMillis(a);
    const tb = createdMillis(b);
    const aBad = Number.isNaN(ta);
    const bBad = Number.isNaN(tb);
    if (aBad && bBad) return 0;
    if (aBad) return 1;   // invalid dates always last
    if (bBad) return -1;
    return dir * (ta - tb);
  });
  return list;
}

/**
 * Compute the set of recipe ids that should show the "new" banner:
 * every recipe whose creation is within the last `days` days. Global across all
 * recipes (independent of any active filter). An optional `count` caps the
 * result to the N newest recipes; when omitted, all recipes inside the time
 * window qualify.
 *
 * @param {Array<{id: string, dateCreated?: string}>} recipes
 * @param {{days: number, count?: number, now?: Date}} opts
 * @returns {Set<string>}
 */
export function computeNewRecipeIds(recipes, { days, count, now = new Date() } = {}) {
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - windowMs;

  const eligible = recipes
    .map(r => ({ id: String(r.id), t: createdMillis(r) }))
    .filter(r => !Number.isNaN(r.t) && r.t >= cutoff)
    .sort((a, b) => b.t - a.t);

  const capped = Number.isFinite(count) ? eligible.slice(0, count) : eligible;

  return new Set(capped.map(r => r.id));
}
