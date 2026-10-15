import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRecipeViewConfig,
  getInstructionView,
  createRecipeProgressStore,
} from '../../../custom_components/cookbook/frontend/services/recipe-view.js';

const grouped = [
  {
    ingredients: [{ name: 'Nudeln', amount: '200', unit: 'g', note: 'kurz' }],
    instruction: 'Nudeln kochen.',
  },
  {
    ingredients: [],
    instruction: 'Sauce unterheben.',
  },
];

const recipe = {
  id: 42,
  recipeInstructions: grouped,
};

test('normalizeRecipeViewConfig defaults to the ingredients tab', () => {
  assert.deepEqual(normalizeRecipeViewConfig({}), {
    recipe_default_tab: 'ingredients',
  });
});

test('normalizeRecipeViewConfig accepts valid tabs', () => {
  assert.deepEqual(normalizeRecipeViewConfig({ recipe_default_tab: 'info' }), {
    recipe_default_tab: 'info',
  });
});

test('normalizeRecipeViewConfig ignores the removed view setting', () => {
  const warnings = [];
  const config = normalizeRecipeViewConfig(
    { recipe_instructions_view: 'legacy' },
    { warn: message => warnings.push(message) }
  );

  assert.equal(config.recipe_default_tab, 'ingredients');
  assert.equal(warnings.length, 0);
});

test('getInstructionView preserves grouped step order and structured data', () => {
  const view = getInstructionView(recipe, 'grouped');

  assert.deepEqual(view, grouped);
  assert.notEqual(view, grouped);
  assert.notEqual(view[0], grouped[0]);
});

test('getInstructionView returns structured recipeInstructions directly', () => {
  const view = getInstructionView(recipe);

  assert.deepEqual(view, grouped);
  assert.notEqual(view, grouped);
  assert.notEqual(view[0], grouped[0]);
  assert.equal(view.fallback, false);
});

test('progress store tracks ingredient and instruction progress independently', () => {
  const store = createRecipeProgressStore();

  assert.deepEqual(store.get(42), { ingredients: [], instructions: [] });
  store.setIngredientDone(42, 1, true);
  store.setInstructionDone(42, 0, true);

  assert.deepEqual(store.get(42), {
    ingredients: [1],
    instructions: [0],
  });
});

test('progress store persists state across store instances under the recipe key', () => {
  const state = new Map();
  const first = createRecipeProgressStore(state);
  first.setIngredientDone('42', 1, true);
  first.setInstructionDone('42', 2, true);

  const second = createRecipeProgressStore(state);
  assert.deepEqual(second.get(42), {
    ingredients: [1],
    instructions: [2],
  });
});

test('progress store isolates recipes', () => {
  const store = createRecipeProgressStore();
  store.setIngredientDone(42, 1, true);
  store.setInstructionDone(43, 0, true);

  assert.deepEqual(store.get(42), { ingredients: [1], instructions: [] });
  assert.deepEqual(store.get(43), { ingredients: [], instructions: [0] });
});

test('progress store selectively clears one progress category', () => {
  const store = createRecipeProgressStore();
  store.setIngredientDone(42, 1, true);
  store.setInstructionDone(42, 0, true);

  store.clear(42);
  assert.deepEqual(store.get(42), { ingredients: [], instructions: [] });
});

test('progress store clears only the cooked recipe', () => {
  const store = createRecipeProgressStore();
  store.setIngredientDone(42, 0, true);
  store.setInstructionDone(43, 1, true);

  store.clear(42);

  assert.deepEqual(store.get(42), { ingredients: [], instructions: [] });
  assert.deepEqual(store.get(43), { ingredients: [], instructions: [1] });
});
