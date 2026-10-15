/** Pure helpers for random recipe rotation and filtering. */

export const DEFAULT_ROTATION_DURATION = '4h';

const MILLISECONDS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

const DURATION_UNITS = new Map([
  ['d', MILLISECONDS.day],
  ['h', MILLISECONDS.hour],
  ['m', MILLISECONDS.minute],
  ['min', MILLISECONDS.minute],
  ['s', MILLISECONDS.second],
]);

function validDuration(milliseconds) {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 4 * MILLISECONDS.hour;
}

function parseDurationString(value) {
  const trimmed = value.trim();
  const clock = trimmed.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (clock && Number(clock[2]) < 60 && Number(clock[3]) < 60) {
    return validDuration(
      Number(clock[1]) * MILLISECONDS.hour
        + Number(clock[2]) * MILLISECONDS.minute
        + Number(clock[3]) * MILLISECONDS.second,
    );
  }

  let total = 0;
  let position = 0;
  const unitPattern = /(\d+(?:\.\d+)?)\s*(d|min|h|m|s)/gi;
  let match;
  while ((match = unitPattern.exec(trimmed)) !== null) {
    if (trimmed.slice(position, match.index).trim() !== '') return 4 * MILLISECONDS.hour;
    total += Number(match[1]) * DURATION_UNITS.get(match[2].toLowerCase());
    position = unitPattern.lastIndex;
  }
  if (position === 0 || trimmed.slice(position).trim() !== '') return 4 * MILLISECONDS.hour;
  return validDuration(total);
}

function parseDurationObject(value) {
  const units = [
    ['days', MILLISECONDS.day],
    ['hours', MILLISECONDS.hour],
    ['minutes', MILLISECONDS.minute],
    ['seconds', MILLISECONDS.second],
  ];
  let total = 0;
  let hasUnit = false;
  for (const [name, milliseconds] of units) {
    if (value[name] === undefined) continue;
    if (typeof value[name] !== 'number' || !Number.isFinite(value[name]) || value[name] < 0) {
      return 4 * MILLISECONDS.hour;
    }
    hasUnit = true;
    total += value[name] * milliseconds;
  }
  return hasUnit ? validDuration(total) : 4 * MILLISECONDS.hour;
}

/** Parse a Home Assistant duration value to milliseconds. */
export function parseRotationDuration(value) {
  if (typeof value === 'string') return parseDurationString(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return parseDurationObject(value);
  }
  return 4 * MILLISECONDS.hour;
}

function configuredTags(tags) {
  const values = Array.isArray(tags) ? tags : [tags];
  return values.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean);
}

/** Return recipes matching all configured category and tag filters. */
export function filterRecipePool(recipes, { category = '', tags = '' } = {}) {
  const requiredTags = configuredTags(tags);
  return recipes.filter((recipe) => {
    const recipeCategory = typeof recipe.recipeCategory === 'string' ? recipe.recipeCategory : '';
    const matchesCategory = !category
      || (category === '*' ? !recipeCategory : recipeCategory === category);
    const recipeTags = typeof recipe.keywords === 'string'
      ? recipe.keywords.split(',').map(tag => tag.trim())
      : [];
    return matchesCategory && requiredTags.every(tag => recipeTags.includes(tag));
  });
}

/** Pick a recipe using an injectable random source, avoiding the previous id where possible. */
export function pickRandomRecipe(pool, { previousId, random = Math.random } = {}) {
  if (pool.length === 0) return null;
  const candidates = previousId === undefined || previousId === null
    ? pool
    : pool.filter(recipe => String(recipe.id) !== String(previousId));
  const available = candidates.length > 0 ? candidates : pool;
  const value = Number(random());
  const normalized = Number.isFinite(value) ? value : 0;
  const index = Math.min(available.length - 1, Math.max(0, Math.floor(normalized * available.length)));
  return available[index];
}
