/**
 * Tests for the meal-plan methods on CookbookApi (feature-10).
 *
 * The calendar card talks to Home Assistant only through CookbookApi. These
 * tests pin the exact WebSocket messages and the returned payload shapes.
 *
 * Run with: node --test www/cookbook-card/services/api-meal-plan.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CookbookApi } from '../../../custom_components/cookbook/frontend/services/api.js';

class FakeCache {
  constructor() { this.values = new Map(); }
  get(key) { return this.values.get(key) ?? null; }
  set(key, value) { this.values.set(key, value); }
  delete(key) { this.values.delete(key); }
}

function createApi(responses = []) {
  const calls = [];
  const hass = {
    callWS: async message => {
      calls.push(message);
      return responses.shift() ?? { response: null };
    },
  };
  return { api: new CookbookApi(hass, new FakeCache()), calls };
}

test('getMealPlan calls cookbook.get_meal_plan and returns the plan', async () => {
  const plan = { version: 1, slots: [], entries: [] };
  const { api, calls } = createApi([{ response: { plan } }]);

  assert.deepEqual(await api.getMealPlan(), plan);
  assert.deepEqual(calls[0], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'get_meal_plan',
    service_data: {},
    return_response: true,
  });
});

test('addMealPlanEntry sends date/slot/recipe and returns the entry', async () => {
  const entry = { id: 'x', date: '2026-09-07', slot_id: 'meal', recipe_id: '12' };
  const { api, calls } = createApi([{ response: { entry } }]);

  const result = await api.addMealPlanEntry({ date: '2026-09-07', slotId: 'meal', recipeId: '12' });

  assert.deepEqual(result, entry);
  assert.deepEqual(calls[0].service, 'add_meal_plan_entry');
  assert.deepEqual(calls[0].service_data, {
    date: '2026-09-07', slot_id: 'meal', recipe_id: '12',
  });
});

test('addMealPlanEntry sends a free-text entry without recipe', async () => {
  const entry = { id: 'x', date: '2026-09-07', slot_id: 'meal', recipe_id: '', text: 'Pizza' };
  const { api, calls } = createApi([{ response: { entry } }]);

  const result = await api.addMealPlanEntry({ date: '2026-09-07', slotId: 'meal', text: 'Pizza' });

  assert.deepEqual(result, entry);
  assert.deepEqual(calls[0].service_data, { date: '2026-09-07', slot_id: 'meal', text: 'Pizza' });
});

test('addMealPlanEntry sends recipe plus an optional note', async () => {
  const entry = { id: 'x', date: '2026-09-07', slot_id: 'meal', recipe_id: '12', text: 'Note' };
  const { api, calls } = createApi([{ response: { entry } }]);

  await api.addMealPlanEntry({ date: '2026-09-07', slotId: 'meal', recipeId: '12', text: 'Note' });

  assert.deepEqual(calls[0].service_data, {
    date: '2026-09-07', slot_id: 'meal', recipe_id: '12', text: 'Note',
  });
});

test('addMealPlanEntry throws the service error message', async () => {
  const { api } = createApi([{ response: { error: 'Invalid date' } }]);
  await assert.rejects(
    () => api.addMealPlanEntry({ date: 'bad', slotId: 'meal', recipeId: '12' }),
    /Invalid date/,
  );
});

test('updateMealPlanEntry sends entry_id and fields', async () => {
  const entry = { id: 'x', date: '2026-09-08', slot_id: 'dinner', recipe_id: '4' };
  const { api, calls } = createApi([{ response: { entry } }]);

  const result = await api.updateMealPlanEntry('x', {
    date: '2026-09-08', slotId: 'dinner', recipeId: '4',
  });

  assert.deepEqual(result, entry);
  assert.equal(calls[0].service, 'update_meal_plan_entry');
  assert.deepEqual(calls[0].service_data, {
    entry_id: 'x', date: '2026-09-08', slot_id: 'dinner', recipe_id: '4',
  });
});

test('deleteMealPlanEntry sends entry_id and resolves ok', async () => {
  const { api, calls } = createApi([{ response: { ok: true } }]);

  assert.equal(await api.deleteMealPlanEntry('x'), true);
  assert.equal(calls[0].service, 'delete_meal_plan_entry');
  assert.deepEqual(calls[0].service_data, { entry_id: 'x' });
});

test('saveMealPlanSlots sends slots and returns the plan', async () => {
  const plan = { version: 1, slots: [{ id: 'meal' }], entries: [] };
  const { api, calls } = createApi([{ response: { plan } }]);
  const slots = [{ id: 'meal', kind: 'builtin', enabled: true }];

  assert.deepEqual(await api.saveMealPlanSlots(slots), plan);
  assert.equal(calls[0].service, 'save_meal_plan_slots');
  assert.deepEqual(calls[0].service_data, { slots });
});

test('saveMealPlanSlots throws the service error message', async () => {
  const { api } = createApi([{ response: { error: 'Duplicate slot name: Snack' } }]);
  await assert.rejects(() => api.saveMealPlanSlots([]), /Duplicate slot name/);
});
