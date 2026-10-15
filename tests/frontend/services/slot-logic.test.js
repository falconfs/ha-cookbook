/**
 * Tests for slot-logic.js — pure slot-model + localization helpers for the
 * weekly recipe calendar (feature-10).
 *
 * Run with: node --test www/cookbook-card/services/slot-logic.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SLOT_IDS,
  UNASSIGNED_SLOT_ID,
  slotLabel,
  activeSlots,
  displaySlotsForDay,
  validateNewSlotName,
  slugifySlotName,
  reorderSlots,
  entryTileKind,
  nonEmptySlotsForDay,
} from '../../../custom_components/cookbook/frontend/services/slot-logic.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

// ---------------------------------------------------------------------------
// slotLabel — localization with English fallback
// ---------------------------------------------------------------------------

test('slotLabel returns the German label for a builtin slot', () => {
  assert.equal(slotLabel({ id: 'breakfast', kind: 'builtin' }, 'de'), 'Frühstück');
});

test('slotLabel returns the English label for a builtin slot', () => {
  assert.equal(slotLabel({ id: 'breakfast', kind: 'builtin' }, 'en'), 'Breakfast');
});

test('slotLabel falls back to English for an unknown locale', () => {
  assert.equal(slotLabel({ id: 'dinner', kind: 'builtin' }, 'fr'), 'Dinner');
});

test('slotLabel returns the custom name verbatim regardless of locale', () => {
  const slot = { id: 'family-dinner', kind: 'custom', name: 'Familienessen' };
  assert.equal(slotLabel(slot, 'de'), 'Familienessen');
  assert.equal(slotLabel(slot, 'en'), 'Familienessen');
});

test('slotLabel localizes the special unassigned slot', () => {
  const slot = { id: UNASSIGNED_SLOT_ID, kind: 'system' };
  assert.equal(slotLabel(slot, 'de'), 'Nicht zugeordnet');
  assert.equal(slotLabel(slot, 'en'), 'Unassigned');
});

test('slotLabel accepts the shared translator for built-in labels', () => {
  const breakfast = { id: 'breakfast', kind: 'builtin' };

  assert.equal(slotLabel(breakfast, createI18n({ locale: 'de' })), 'Frühstück');
  assert.equal(slotLabel(breakfast, createI18n({ locale: 'en' })), 'Breakfast');
});

// ---------------------------------------------------------------------------
// activeSlots
// ---------------------------------------------------------------------------

test('activeSlots keeps only enabled slots in configured order', () => {
  const slots = [
    { id: 'meal', kind: 'builtin', enabled: true },
    { id: 'breakfast', kind: 'builtin', enabled: false },
    { id: 'dinner', kind: 'builtin', enabled: true },
  ];
  assert.deepEqual(activeSlots(slots).map(s => s.id), ['meal', 'dinner']);
});

// ---------------------------------------------------------------------------
// displaySlotsForDay — active slots plus unassigned when it has entries
// ---------------------------------------------------------------------------

test('displaySlotsForDay appends unassigned only when it holds entries that day', () => {
  const slots = [{ id: 'meal', kind: 'builtin', enabled: true }];
  const withUnassigned = { meal: [{ id: 'a' }], unassigned: [{ id: 'b' }] };
  const withoutUnassigned = { meal: [{ id: 'a' }] };
  assert.deepEqual(displaySlotsForDay(slots, withUnassigned).map(s => s.id), ['meal', 'unassigned']);
  assert.deepEqual(displaySlotsForDay(slots, withoutUnassigned).map(s => s.id), ['meal']);
});

// ---------------------------------------------------------------------------
// validateNewSlotName
// ---------------------------------------------------------------------------

test('validateNewSlotName rejects empty and whitespace names', () => {
  const slots = [];
  assert.equal(validateNewSlotName('', slots, 'de').ok, false);
  assert.equal(validateNewSlotName('   ', slots, 'de').ok, false);
});

test('validateNewSlotName rejects a name equal to a builtin label (case-insensitive)', () => {
  const slots = [{ id: 'breakfast', kind: 'builtin', enabled: true }];
  assert.equal(validateNewSlotName('frühstück', slots, 'de').ok, false);
});

test('validateNewSlotName rejects a duplicate custom name (case-insensitive)', () => {
  const slots = [{ id: 'snack-time', kind: 'custom', name: 'Snack Time', enabled: true }];
  assert.equal(validateNewSlotName('snack time', slots, 'de').ok, false);
});

test('validateNewSlotName accepts a fresh unique name', () => {
  const slots = [{ id: 'meal', kind: 'builtin', enabled: true }];
  assert.equal(validateNewSlotName('Meal Prep', slots, 'de').ok, true);
});

// ---------------------------------------------------------------------------
// slugifySlotName
// ---------------------------------------------------------------------------

test('slugifySlotName produces a url-safe stable id', () => {
  assert.equal(slugifySlotName('Familienessen'), 'familienessen');
  assert.equal(slugifySlotName('Snack-Zeit!'), 'snack-zeit');
  assert.equal(slugifySlotName('  Meal   Prep  '), 'meal-prep');
});

// ---------------------------------------------------------------------------
// reorderSlots
// ---------------------------------------------------------------------------

test('reorderSlots moves a slot up and down by id, clamped at the ends', () => {
  const slots = [
    { id: 'meal' }, { id: 'dinner' }, { id: 'snack' },
  ];
  assert.deepEqual(reorderSlots(slots, 'dinner', -1).map(s => s.id), ['dinner', 'meal', 'snack']);
  assert.deepEqual(reorderSlots(slots, 'dinner', 1).map(s => s.id), ['meal', 'snack', 'dinner']);
  assert.deepEqual(reorderSlots(slots, 'meal', -1).map(s => s.id), ['meal', 'dinner', 'snack']);
});

test('BUILTIN_SLOT_IDS matches the agreed built-in set and order', () => {
  assert.deepEqual(BUILTIN_SLOT_IDS, ['meal', 'breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'side']);
});

// ---------------------------------------------------------------------------
// entryTileKind — image-grid tile classification (feature-10, image layout)
// ---------------------------------------------------------------------------

test('entryTileKind is "image" only when a resolvable recipe exists', () => {
  const byId = new Map([['1', { id: '1', name: 'Soup' }]]);
  assert.equal(entryTileKind({ recipe_id: '1', text: '' }, byId), 'image');
});

test('entryTileKind is "text" for free-text entries (no recipe)', () => {
  const byId = new Map();
  assert.equal(entryTileKind({ recipe_id: '', text: 'Order pizza' }, byId), 'text');
});

test('entryTileKind is "text" when the recipe is missing from the store', () => {
  const byId = new Map();
  assert.equal(entryTileKind({ recipe_id: '999', text: '' }, byId), 'text');
});

test('entryTileKind is "text" when images are disabled', () => {
  const byId = new Map([['1', { id: '1', name: 'Soup' }]]);
  assert.equal(entryTileKind({ recipe_id: '1', text: '' }, byId, { showImages: false }), 'text');
});

// ---------------------------------------------------------------------------
// nonEmptySlotsForDay — only slots that actually have entries are rendered
// ---------------------------------------------------------------------------

const daySlots = [
  { id: 'meal', kind: 'builtin', enabled: true },
  { id: 'breakfast', kind: 'builtin', enabled: true },
  { id: 'dinner', kind: 'builtin', enabled: true },
];

test('nonEmptySlotsForDay returns only slots with entries, in global order', () => {
  const entries = { dinner: [{ id: 'a' }], meal: [{ id: 'b' }] };
  const out = nonEmptySlotsForDay(daySlots, entries).map(s => s.id);
  assert.deepEqual(out, ['meal', 'dinner']); // global order preserved, breakfast dropped
});

test('nonEmptySlotsForDay returns an empty list when the day has no entries', () => {
  assert.deepEqual(nonEmptySlotsForDay(daySlots, {}), []);
});

test('nonEmptySlotsForDay includes the unassigned system slot when it has entries', () => {
  const entries = { unassigned: [{ id: 'x' }] };
  const out = nonEmptySlotsForDay(daySlots, entries).map(s => s.id);
  assert.deepEqual(out, ['unassigned']);
});

test('nonEmptySlotsForDay ignores entries for a disabled slot only if it has none', () => {
  const slots = [
    { id: 'meal', kind: 'builtin', enabled: false },
    { id: 'dinner', kind: 'builtin', enabled: true },
  ];
  // meal is disabled but still holds entries -> it must still be shown
  const entries = { meal: [{ id: 'a' }] };
  const out = nonEmptySlotsForDay(slots, entries).map(s => s.id);
  assert.deepEqual(out, ['meal']);
});
