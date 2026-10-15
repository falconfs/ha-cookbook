/**
 * RED tests (TDD) for feature-09: Random Recipe Card — pure helpers.
 *
 * These tests define the contract for `services/random-logic.js`, which does
 * not exist yet. They must fail until the implementation phase creates it:
 *
 *   - DEFAULT_ROTATION_DURATION  documented config default (`4h`)
 *   - parseRotationDuration(value) -> milliseconds (HA duration format)
 *   - filterRecipePool(recipes, { category, tags }) -> filtered copy
 *   - pickRandomRecipe(pool, { previousId, random }) -> recipe | null
 *
 * Run with: node --test services/random-logic.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROTATION_DURATION,
  parseRotationDuration,
  filterRecipePool,
  pickRandomRecipe,
} from '../../../custom_components/cookbook/frontend/services/random-logic.js';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const FOUR_HOURS_MS = 4 * MS_PER_HOUR;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pool = [
  { id: 'a', name: 'Apfelsuppe', recipeCategory: 'Suppe',      keywords: 'schnell, vegetarisch' },
  { id: 'b', name: 'Bolognese',  recipeCategory: 'Hauptgericht', keywords: 'fleisch' },
  { id: 'c', name: 'Curry',      recipeCategory: 'Hauptgericht', keywords: 'schnell, vegan' },
  { id: 'd', name: 'Dessert',    recipeCategory: '',             keywords: '' },
];

const threeRecipes = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

// ---------------------------------------------------------------------------
// DEFAULT_ROTATION_DURATION
// ---------------------------------------------------------------------------

test('DEFAULT_ROTATION_DURATION is the documented 4h default', () => {
  assert.equal(DEFAULT_ROTATION_DURATION, '4h');
});

test('parseRotationDuration accepts the documented default value', () => {
  assert.equal(parseRotationDuration(DEFAULT_ROTATION_DURATION), FOUR_HOURS_MS);
});

// ---------------------------------------------------------------------------
// parseRotationDuration — default
// ---------------------------------------------------------------------------

test('parseRotationDuration falls back to 4h for missing duration config', () => {
  assert.equal(parseRotationDuration(undefined), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration(null), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration(''), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration('   '), FOUR_HOURS_MS);
});

// ---------------------------------------------------------------------------
// parseRotationDuration — valid HA duration formats
// ---------------------------------------------------------------------------

test('parseRotationDuration parses hour units', () => {
  assert.equal(parseRotationDuration('4h'), 4 * MS_PER_HOUR);
  assert.equal(parseRotationDuration('1h'), MS_PER_HOUR);
});

test('parseRotationDuration parses minute units in both notations', () => {
  assert.equal(parseRotationDuration('30min'), 30 * MS_PER_MINUTE);
  assert.equal(parseRotationDuration('45m'), 45 * MS_PER_MINUTE);
});

test('parseRotationDuration parses second units', () => {
  assert.equal(parseRotationDuration('30s'), 30 * MS_PER_SECOND);
});

test('parseRotationDuration parses day units', () => {
  assert.equal(parseRotationDuration('1d'), MS_PER_DAY);
});

test('parseRotationDuration parses combined unit strings', () => {
  assert.equal(parseRotationDuration('2h 30min'), 2 * MS_PER_HOUR + 30 * MS_PER_MINUTE);
});

test('parseRotationDuration parses clock format HH:MM:SS', () => {
  assert.equal(parseRotationDuration('01:30:00'), MS_PER_HOUR + 30 * MS_PER_MINUTE);
  assert.equal(parseRotationDuration('00:45:30'), 45 * MS_PER_MINUTE + 30 * MS_PER_SECOND);
});

test('parseRotationDuration parses HA duration dicts', () => {
  assert.equal(parseRotationDuration({ hours: 4 }), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration({ hours: 1, minutes: 30 }), MS_PER_HOUR + 30 * MS_PER_MINUTE);
  assert.equal(parseRotationDuration({ days: 1 }), MS_PER_DAY);
  assert.equal(parseRotationDuration({ seconds: 90 }), 90 * MS_PER_SECOND);
});

test('parseRotationDuration is forgiving about whitespace and case', () => {
  assert.equal(parseRotationDuration(' 4H '), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration(' 2H 30MIN '), 2 * MS_PER_HOUR + 30 * MS_PER_MINUTE);
});

// ---------------------------------------------------------------------------
// parseRotationDuration — invalid input
// ---------------------------------------------------------------------------

test('parseRotationDuration falls back to 4h for malformed input', () => {
  assert.equal(parseRotationDuration('bogus'), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration('4x'), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration('h4'), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration('12'), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration(123), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration({}), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration([]), FOUR_HOURS_MS);
});

test('parseRotationDuration falls back to 4h for zero and negative durations', () => {
  // Zero or negative would make the rotation fire in a tight loop, so the
  // parser treats them like any other invalid configuration.
  assert.equal(parseRotationDuration('0s'), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration('0h'), FOUR_HOURS_MS);
  assert.equal(parseRotationDuration('-5h'), FOUR_HOURS_MS);
});

// ---------------------------------------------------------------------------
// filterRecipePool
// ---------------------------------------------------------------------------

test('filterRecipePool returns the whole pool when no filters are configured', () => {
  assert.deepEqual(filterRecipePool(pool).map(r => r.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterRecipePool(pool, {}).map(r => r.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterRecipePool(pool, { category: '', tags: '' }).map(r => r.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterRecipePool(pool, { category: '', tags: [] }).map(r => r.id), ['a', 'b', 'c', 'd']);
});

test('filterRecipePool returns a new array and does not mutate the input', () => {
  const input = [...pool];
  const snapshot = JSON.stringify(input);
  const out = filterRecipePool(input, { category: 'Suppe' });
  assert.notEqual(out, input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('filterRecipePool restricts the pool to the configured category', () => {
  assert.deepEqual(filterRecipePool(pool, { category: 'Suppe' }).map(r => r.id), ['a']);
  assert.deepEqual(filterRecipePool(pool, { category: 'Hauptgericht' }).map(r => r.id), ['b', 'c']);
});

test('filterRecipePool excludes recipes without a category when a category filter is active', () => {
  const ids = filterRecipePool(pool, { category: 'Suppe' }).map(r => r.id);
  assert.ok(!ids.includes('d'));
});

test('filterRecipePool restricts the pool to recipes containing a single configured tag', () => {
  assert.deepEqual(filterRecipePool(pool, { tags: 'schnell' }).map(r => r.id), ['a', 'c']);
  assert.deepEqual(filterRecipePool(pool, { tags: 'vegetarisch' }).map(r => r.id), ['a']);
});

test('filterRecipePool requires ALL configured tags (AND semantics)', () => {
  assert.deepEqual(filterRecipePool(pool, { tags: ['schnell', 'vegan'] }).map(r => r.id), ['c']);
  assert.deepEqual(filterRecipePool(pool, { tags: ['schnell', 'fleisch'] }).map(r => r.id), []);
});

test('filterRecipePool matches whole tag tokens, not substrings', () => {
  assert.deepEqual(filterRecipePool(pool, { tags: 'vegetar' }).map(r => r.id), []);
  assert.deepEqual(filterRecipePool(pool, { tags: 'schnel' }).map(r => r.id), []);
});

test('filterRecipePool trims keywords before matching tags', () => {
  // 'a' has keywords 'schnell, vegetarisch' (space after the comma).
  assert.deepEqual(filterRecipePool(pool, { tags: 'vegetarisch' }).map(r => r.id), ['a']);
});

test('filterRecipePool excludes recipes without keywords when a tag filter is active', () => {
  const ids = filterRecipePool(pool, { tags: 'schnell' }).map(r => r.id);
  assert.ok(!ids.includes('d'));
});

test('filterRecipePool combines category and tags with AND semantics', () => {
  assert.deepEqual(
    filterRecipePool(pool, { category: 'Hauptgericht', tags: 'schnell' }).map(r => r.id),
    ['c'],
  );
  assert.deepEqual(
    filterRecipePool(pool, { category: 'Suppe', tags: 'vegan' }).map(r => r.id),
    [],
  );
});

test('filterRecipePool returns an empty array for an empty pool', () => {
  assert.deepEqual(filterRecipePool([], { category: 'Suppe', tags: 'schnell' }), []);
});

// ---------------------------------------------------------------------------
// pickRandomRecipe
// ---------------------------------------------------------------------------

test('pickRandomRecipe returns null for an empty pool', () => {
  assert.equal(pickRandomRecipe([]), null);
  assert.equal(pickRandomRecipe([], { previousId: 'a' }), null);
});

test('pickRandomRecipe maps an injected random source onto pool entries', () => {
  assert.equal(pickRandomRecipe(threeRecipes, { random: () => 0 }), threeRecipes[0]);
  assert.equal(pickRandomRecipe(threeRecipes, { random: () => 0.5 }), threeRecipes[1]);
  assert.equal(pickRandomRecipe(threeRecipes, { random: () => 0.9999 }), threeRecipes[2]);
});

test('pickRandomRecipe works without an injected random source', () => {
  for (let i = 0; i < 20; i++) {
    const picked = pickRandomRecipe(threeRecipes);
    assert.ok(threeRecipes.includes(picked));
  }
});

test('pickRandomRecipe avoids the previous recipe when the pool has at least two entries', () => {
  const twoRecipes = threeRecipes.slice(0, 2);
  assert.equal(pickRandomRecipe(twoRecipes, { previousId: 'a', random: () => 0 }), twoRecipes[1]);
  assert.equal(pickRandomRecipe(twoRecipes, { previousId: 'a', random: () => 0.999 }), twoRecipes[1]);
});

test('pickRandomRecipe never returns the previous recipe across a random sweep', () => {
  const values = [0, 0.2, 0.5, 0.7, 0.99];
  for (const value of values) {
    const picked = pickRandomRecipe(threeRecipes, { previousId: 'b', random: () => value });
    assert.notEqual(picked.id, 'b');
    assert.ok(['a', 'c'].includes(picked.id));
  }
});

test('pickRandomRecipe keeps the pool order when excluding the previous recipe', () => {
  // Candidates are the pool in its original order minus the previous recipe,
  // so a deterministic random source yields a deterministic selection.
  assert.equal(pickRandomRecipe(threeRecipes, { previousId: 'b', random: () => 0 }), threeRecipes[0]);
  assert.equal(pickRandomRecipe(threeRecipes, { previousId: 'b', random: () => 0.5 }), threeRecipes[2]);
});

test('pickRandomRecipe returns the only recipe of a single-entry pool even when it is the previous one', () => {
  const single = [threeRecipes[0]];
  assert.equal(pickRandomRecipe(single, { previousId: 'a', random: () => 0 }), threeRecipes[0]);
});

test('pickRandomRecipe applies no exclusion when the previous id is not in the pool', () => {
  assert.equal(pickRandomRecipe(threeRecipes, { previousId: 'zzz', random: () => 0 }), threeRecipes[0]);
  assert.equal(pickRandomRecipe(threeRecipes, { previousId: 'zzz', random: () => 0.9999 }), threeRecipes[2]);
});

test('pickRandomRecipe compares previous ids as strings', () => {
  const numericIds = [{ id: 42, name: 'Numeric' }, { id: 43, name: 'Other' }];
  assert.equal(pickRandomRecipe(numericIds, { previousId: 42, random: () => 0 }), numericIds[1]);
  assert.equal(pickRandomRecipe(numericIds, { previousId: '42', random: () => 0.999 }), numericIds[1]);
});

test('pickRandomRecipe does not mutate the pool', () => {
  const input = [...threeRecipes];
  const snapshot = JSON.stringify(input);
  pickRandomRecipe(input, { previousId: 'a', random: () => 0.999 });
  assert.equal(JSON.stringify(input), snapshot);
});
