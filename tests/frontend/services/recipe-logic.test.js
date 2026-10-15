/**
 * Tests for recipe-logic.js — pure sorting + "new" banner logic.
 * Run with: node --test www/cookbook-card/services/recipe-logic.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sortRecipes,
  computeNewRecipeIds,
  resolveDefaultSort,
  SORT_OPTIONS,
  DEFAULT_SORT,
} from '../../../custom_components/cookbook/frontend/services/recipe-logic.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const recipes = [
  { id: '1', name: 'Zucchini',  dateCreated: '2026-08-01T10:00:00+0000' },
  { id: '2', name: 'apfelmus',  dateCreated: '2026-08-10T10:00:00+0000' },
  { id: '3', name: 'Ärgerlich', dateCreated: '2026-07-01T10:00:00+0000' },
  { id: '4', name: 'Banane',    dateCreated: '2026-08-05T10:00:00+0000' },
];

// ---------------------------------------------------------------------------
// sortRecipes
// ---------------------------------------------------------------------------

test('sortRecipes does not mutate the input array', () => {
  const input = [...recipes];
  const snapshot = JSON.stringify(input);
  sortRecipes(input, 'name-asc');
  assert.equal(JSON.stringify(input), snapshot);
});

test('sortRecipes name-asc uses locale-aware, case-insensitive order', () => {
  const out = sortRecipes(recipes, 'name-asc').map(r => r.name);
  // German locale: apfelmus, Ärgerlich, Banane, Zucchini (case-insensitive, ä≈a)
  assert.deepEqual(out, ['apfelmus', 'Ärgerlich', 'Banane', 'Zucchini']);
});

test('sortRecipes name-desc reverses locale order', () => {
  const out = sortRecipes(recipes, 'name-desc').map(r => r.name);
  assert.deepEqual(out, ['Zucchini', 'Banane', 'Ärgerlich', 'apfelmus']);
});

test('sortRecipes date-desc puts newest dateCreated first', () => {
  const out = sortRecipes(recipes, 'date-desc').map(r => r.id);
  assert.deepEqual(out, ['2', '4', '1', '3']);
});

test('sortRecipes date-asc puts oldest dateCreated first', () => {
  const out = sortRecipes(recipes, 'date-asc').map(r => r.id);
  assert.deepEqual(out, ['3', '1', '4', '2']);
});

test('sortRecipes date sort places missing/invalid dates last (desc)', () => {
  const withMissing = [
    { id: 'a', name: 'A', dateCreated: '2026-08-10T10:00:00+0000' },
    { id: 'b', name: 'B', dateCreated: '' },
    { id: 'c', name: 'C' },
    { id: 'd', name: 'D', dateCreated: 'not-a-date' },
  ];
  const out = sortRecipes(withMissing, 'date-desc').map(r => r.id);
  assert.equal(out[0], 'a');
  assert.deepEqual(new Set(out.slice(1)), new Set(['b', 'c', 'd']));
});

test('sortRecipes falls back to DEFAULT_SORT for unknown key', () => {
  const out = sortRecipes(recipes, 'bogus').map(r => r.name);
  const def = sortRecipes(recipes, DEFAULT_SORT).map(r => r.name);
  assert.deepEqual(out, def);
});

test('SORT_OPTIONS contains the four expected keys', () => {
  const keys = SORT_OPTIONS.map(o => o.value);
  assert.deepEqual(keys, ['name-asc', 'name-desc', 'date-desc', 'date-asc']);
});

test('DEFAULT_SORT is date-desc (newest first)', () => {
  assert.equal(DEFAULT_SORT, 'date-desc');
});

// ---------------------------------------------------------------------------
// resolveDefaultSort — pick the configured default sort or fall back
// ---------------------------------------------------------------------------

test('resolveDefaultSort accepts every valid sort key', () => {
  for (const { value } of SORT_OPTIONS) {
    assert.equal(resolveDefaultSort(value), value);
  }
});

test('resolveDefaultSort falls back to DEFAULT_SORT for invalid input', () => {
  assert.equal(resolveDefaultSort('bogus'), DEFAULT_SORT);
  assert.equal(resolveDefaultSort(''), DEFAULT_SORT);
  assert.equal(resolveDefaultSort(undefined), DEFAULT_SORT);
  assert.equal(resolveDefaultSort(null), DEFAULT_SORT);
  assert.equal(resolveDefaultSort(123), DEFAULT_SORT);
});

test('resolveDefaultSort trims and lowercases forgiving input', () => {
  assert.equal(resolveDefaultSort('  DATE-DESC '), 'date-desc');
  assert.equal(resolveDefaultSort('Name-Asc'), 'name-asc');
});

// ---------------------------------------------------------------------------
// computeNewRecipeIds
// ---------------------------------------------------------------------------

test('computeNewRecipeIds returns all ids within the window when no count is given', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const six = [
    { id: '1', dateCreated: '2026-08-10T10:00:00+0000' },
    { id: '2', dateCreated: '2026-08-09T10:00:00+0000' },
    { id: '3', dateCreated: '2026-08-08T10:00:00+0000' },
    { id: '4', dateCreated: '2026-08-07T10:00:00+0000' },
    { id: '5', dateCreated: '2026-08-06T10:00:00+0000' },
    { id: '6', dateCreated: '2026-08-05T10:00:00+0000' },
  ];
  const ids = computeNewRecipeIds(six, { days: 30, now });
  assert.deepEqual(ids, new Set(['1', '2', '3', '4', '5', '6']));
});

test('computeNewRecipeIds respects an optional count cap when provided', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const six = [
    { id: '1', dateCreated: '2026-08-10T10:00:00+0000' },
    { id: '2', dateCreated: '2026-08-09T10:00:00+0000' },
    { id: '3', dateCreated: '2026-08-08T10:00:00+0000' },
    { id: '4', dateCreated: '2026-08-07T10:00:00+0000' },
    { id: '5', dateCreated: '2026-08-06T10:00:00+0000' },
    { id: '6', dateCreated: '2026-08-05T10:00:00+0000' },
  ];
  const ids = computeNewRecipeIds(six, { days: 30, count: 5, now });
  assert.deepEqual(ids, new Set(['1', '2', '3', '4', '5']));
});

test('computeNewRecipeIds excludes recipes older than the window', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const recs = [
    { id: '1', dateCreated: '2026-08-10T10:00:00+0000' }, // 1 day old
    { id: '2', dateCreated: '2026-06-01T10:00:00+0000' }, // >30 days old
  ];
  const ids = computeNewRecipeIds(recs, { days: 30, count: 5, now });
  assert.deepEqual(ids, new Set(['1']));
});

test('computeNewRecipeIds respects a custom day window', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const recs = [
    { id: '1', dateCreated: '2026-08-10T10:00:00+0000' }, // 1 day
    { id: '2', dateCreated: '2026-08-01T10:00:00+0000' }, // ~10 days
  ];
  assert.deepEqual(
    computeNewRecipeIds(recs, { days: 7, count: 5, now }),
    new Set(['1'])
  );
  assert.deepEqual(
    computeNewRecipeIds(recs, { days: 14, count: 5, now }),
    new Set(['1', '2'])
  );
});

test('computeNewRecipeIds ignores recipes without a valid dateCreated', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const recs = [
    { id: '1', dateCreated: '2026-08-10T10:00:00+0000' },
    { id: '2', dateCreated: '' },
    { id: '3' },
    { id: '4', dateCreated: 'garbage' },
  ];
  const ids = computeNewRecipeIds(recs, { days: 30, count: 5, now });
  assert.deepEqual(ids, new Set(['1']));
});

test('computeNewRecipeIds returns empty set for empty input', () => {
  const ids = computeNewRecipeIds([], { days: 30, count: 5, now: new Date() });
  assert.equal(ids.size, 0);
});

test('computeNewRecipeIds is global: independent of array order', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const recs = [
    { id: 'old', dateCreated: '2026-08-01T10:00:00+0000' },
    { id: 'new', dateCreated: '2026-08-10T10:00:00+0000' },
  ];
  const a = computeNewRecipeIds(recs, { days: 30, count: 1, now });
  const b = computeNewRecipeIds([...recs].reverse(), { days: 30, count: 1, now });
  assert.deepEqual(a, new Set(['new']));
  assert.deepEqual(b, new Set(['new']));
});
