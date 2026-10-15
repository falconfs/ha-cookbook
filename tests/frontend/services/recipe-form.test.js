import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formStateFromRecipe,
  parseDurationToHms,
  recipeFromFormState,
  recipeToJson,
  jsonToRecipe,
  validateRecipeJson,
  serializeDuration,
  validateFormState,
  validateImageFile,
  moveIngredientBetweenSteps,
} from '../../../custom_components/cookbook/frontend/services/recipe-form.js';

const ingredient = { name: 'Salz', amount: '1', unit: 'Prise', note: '' };

const recipe = {
  id: '1852',
  name: 'Nudelsalat',
  description: 'Ein schneller Salat.',
  '@context': 'http://schema.org',
  '@type': 'Recipe',
  recipeCategory: 'Salat',
  keywords: 'schnell, Sommer',
  recipeYield: 4,
  recipeInstructions: [{ ingredients: [ingredient], instruction: 'Mischen.' }],
  nutrition: {
    '@type': 'NutritionInformation',
    servingSize: '1 Portion',
    calories: '420 kcal',
    fatContent: '12 g',
  },
  tool: ['Schüssel'],
  image: 'https://example.test/noodles.jpg',
  url: 'https://example.test/recipe',
  dateCreated: '2026-08-20T10:00:00+00:00',
  dateModified: '2026-08-20T10:00:00+00:00',
  datePublished: null,
  prepTime: 'PT1H30M',
  cookTime: 'PT0H20M',
  totalTime: null,
  author: { '@type': 'Person', name: 'Koch' },
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', ratingCount: '12' },
  recipeCuisine: 'Deutsch',
  publisher: { '@type': 'Organization', name: 'Kochbuch' },
  _ha_rating: 4,
  _ha_last_cooked: '2026-08-19',
  _cookbook_schema_version: 6,
};

function validFormState() {
  return {
    name: 'Nudelsalat',
    description: 'Ein schneller Salat.',
    recipeCategory: 'Salat',
    keywords: ['schnell', 'Sommer'],
    recipeYield: '4',
    prepHours: '1',
    prepMinutes: '30',
    cookHours: '0',
    cookMinutes: '20',
    totalHours: '',
    totalMinutes: '',
    tool: ['Schüssel'],
    nutrition: recipe.nutrition,
    image: recipe.image,
    author: recipe.author,
    authorName: 'Koch',
    aggregateRating: recipe.aggregateRating,
    recipeCuisine: recipe.recipeCuisine,
    publisher: recipe.publisher,
    dateCreated: recipe.dateCreated,
    steps: [{ instruction: 'Mischen.', ingredients: [ingredient] }],
  };
}

test('converts a v6 recipe to form state and back, refreshing only dateModified', () => {
  const state = formStateFromRecipe(recipe, 'edit');
  const result = recipeFromFormState(state, 'edit');

  // dateModified is intentionally refreshed to now on every save.
  assert.notEqual(result.dateModified, recipe.dateModified);
  // All other fields round-trip unchanged.
  assert.deepEqual({ ...result, dateModified: recipe.dateModified }, recipe);
});

test('keeps HA fields only when serializing edit state', () => {
  const state = formStateFromRecipe(recipe, 'edit');
  state.haRating = '3';
  state.haLastCooked = '2026-08-20';

  const result = recipeFromFormState(state, 'edit');
  assert.deepEqual({ ...result, dateModified: recipe.dateModified }, {
    ...recipe,
    _ha_rating: 3,
    _ha_last_cooked: '2026-08-20',
  });
  assert.equal('_ha_rating' in recipeFromFormState(state, 'add'), false);
  assert.equal('_ha_last_cooked' in recipeFromFormState(state, 'add'), false);
});

test('serializes and parses H+M durations, including empty input as null', () => {
  assert.equal(serializeDuration('1', '30'), 'PT1H30M');
  assert.equal(serializeDuration('0', '20'), 'PT0H20M');
  assert.equal(serializeDuration('', ''), null);
  assert.deepEqual(parseDurationToHms('PT1H30M'), { hours: '1', minutes: '30' });
  assert.deepEqual(parseDurationToHms('PT0H20M'), { hours: '0', minutes: '20' });
  assert.deepEqual(parseDurationToHms(null), { hours: '', minutes: '' });
});

test('serializes yield as an integer and preserves keywords, tools, nutrition and schema.org fields', () => {
  const serialized = recipeFromFormState(validFormState(), 'add');

  assert.equal(serialized.recipeYield, 4);
  assert.deepEqual(serialized.keywords, 'schnell,Sommer');
  assert.deepEqual(serialized.tool, ['Schüssel']);
  assert.deepEqual(serialized.nutrition, recipe.nutrition);
  assert.deepEqual(serialized.author, recipe.author);
  assert.deepEqual(serialized.aggregateRating, recipe.aggregateRating);
  assert.equal(serialized.recipeCuisine, 'Deutsch');
  assert.deepEqual(serialized.publisher, recipe.publisher);
});

test('requires a name', () => {
  const state = validFormState();
  state.name = '';

  assert.deepEqual(validateFormState(state), ['recipe_name_required']);
});

test('requires at least one step', () => {
  const state = validFormState();
  state.steps = [];

  assert.deepEqual(validateFormState(state), ['recipe_step_required']);
});

test('allows steps without ingredients (e.g. finishing steps)', () => {
  const state = validFormState();
  state.steps = [
    { instruction: 'Mischen.', ingredients: [{ name: 'Salz', amount: '', unit: '', note: '' }] },
    { instruction: 'Servieren.', ingredients: [] },
  ];

  assert.deepEqual(validateFormState(state), []);
});

test('rejects non-image files with the exact inline error', () => {
  const file = new File(['plain text'], 'recipe.txt', { type: 'text/plain' });

  assert.equal(validateImageFile(file), 'image_invalid_file');
});

test('accepts image files', () => {
  const file = new File(['png bytes'], 'recipe.png', { type: 'image/png' });

  assert.equal(validateImageFile(file), null);
});

test('recipeToJson pretty-prints the full recipe object', () => {
  const json = recipeToJson({ name: 'X', recipeInstructions: [] });
  assert.equal(json, '{\n  "name": "X",\n  "recipeInstructions": []\n}');
});

test('jsonToRecipe parses valid JSON into an object', () => {
  const recipe = jsonToRecipe('{"name":"X","recipeInstructions":[]}');
  assert.deepEqual(recipe, { name: 'X', recipeInstructions: [] });
});

test('validateRecipeJson reports a syntax error for malformed JSON', () => {
  const result = validateRecipeJson('{ not json ');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /JSON/i);
  assert.equal(result.recipe, undefined);
});

test('validateRecipeJson requires an object at the top level', () => {
  const result = validateRecipeJson('[1,2,3]');
  assert.equal(result.ok, false);
  assert.equal(result.errors[0], 'json_object_required');
});

test('validateRecipeJson enforces name and at least one step', () => {
  // Empty recipe surfaces all content errors at once.
  assert.deepEqual(
    validateRecipeJson('{"name":"","recipeInstructions":[]}').errors,
    ['recipe_name_required', 'recipe_step_required'],
  );
  assert.deepEqual(
    validateRecipeJson('{"name":"X","recipeInstructions":[]}').errors,
    ['recipe_step_required'],
  );
});

test('validateRecipeJson checks the instruction/ingredient structure', () => {
  const result = validateRecipeJson('{"name":"X","recipeInstructions":[{"instruction":5,"ingredients":[]}]}');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => /instruction/i.test(error)));
});

test('validateRecipeJson accepts a well-formed recipe and returns the parsed object', () => {
  const json = '{"name":"X","recipeInstructions":[{"instruction":"Kochen","ingredients":[{"name":"Salz","amount":"1","unit":"Prise","note":""}]}]}';
  const result = validateRecipeJson(json);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.recipe.name, 'X');
});

const stepsFixture = () => [
  { instruction: 'Mehl mischen', ingredients: [{ name: 'Mehl', amount: '250', unit: 'g', note: '' }] },
  { instruction: 'Eier dazu', ingredients: [{ name: 'Eier', amount: '2', unit: '', note: '' }] },
];

test('moveIngredientBetweenSteps moves an ingredient to another step', () => {
  const steps = stepsFixture();
  const result = moveIngredientBetweenSteps(steps, 0, 0, 1);

  assert.deepEqual(result[0].ingredients, []);
  assert.deepEqual(result[1].ingredients.map(i => i.name), ['Eier', 'Mehl']);
});

test('moveIngredientBetweenSteps does not mutate the input', () => {
  const steps = stepsFixture();
  const snapshot = JSON.parse(JSON.stringify(steps));
  moveIngredientBetweenSteps(steps, 0, 0, 1);
  assert.deepEqual(steps, snapshot);
});

test('moveIngredientBetweenSteps keeps instructions intact', () => {
  const result = moveIngredientBetweenSteps(stepsFixture(), 0, 0, 1);
  assert.equal(result[0].instruction, 'Mehl mischen');
  assert.equal(result[1].instruction, 'Eier dazu');
});

test('moveIngredientBetweenSteps returns steps unchanged for an out-of-range source', () => {
  const steps = stepsFixture();
  const result = moveIngredientBetweenSteps(steps, 5, 0, 1);
  assert.deepEqual(result, steps);
});

test('moveIngredientBetweenSteps returns steps unchanged for an out-of-range target', () => {
  const steps = stepsFixture();
  const result = moveIngredientBetweenSteps(steps, 0, 0, 9);
  assert.deepEqual(result, steps);
});

test('moveIngredientBetweenSteps returns steps unchanged when moving to the same step', () => {
  const steps = stepsFixture();
  const result = moveIngredientBetweenSteps(steps, 0, 0, 0);
  assert.deepEqual(result[0].ingredients.map(i => i.name), ['Mehl']);
});

test('moveIngredientBetweenSteps preserves the total set of ingredients', () => {
  const result = moveIngredientBetweenSteps(stepsFixture(), 1, 0, 0);
  const all = result.flatMap(s => s.ingredients.map(i => i.name)).sort();
  assert.deepEqual(all, ['Eier', 'Mehl']);
});

test('formStateFromRecipe exposes dateCreated, dateModified and authorName', () => {
  const state = formStateFromRecipe(recipe, 'edit');
  assert.equal(state.dateCreated, '2026-08-20T10:00:00+00:00');
  assert.equal(state.dateModified, '2026-08-20T10:00:00+00:00');
  assert.equal(state.authorName, 'Koch');
});

test('formStateFromRecipe reads authorName from a plain string author', () => {
  const state = formStateFromRecipe({ ...recipe, author: 'EAT SMARTER' }, 'edit');
  assert.equal(state.authorName, 'EAT SMARTER');
});

test('formStateFromRecipe authorName is empty when author is absent', () => {
  const { author, ...noAuthor } = recipe;
  const state = formStateFromRecipe(noAuthor, 'edit');
  assert.equal(state.authorName, '');
});

test('recipeFromFormState keeps edited dateCreated but refreshes dateModified', () => {
  const state = formStateFromRecipe(recipe, 'edit');
  state.dateCreated = '2020-01-01T00:00:00+00:00';
  const before = new Date().toISOString();
  const result = recipeFromFormState(state, 'edit');
  assert.equal(result.dateCreated, '2020-01-01T00:00:00+00:00');
  // dateModified is auto-refreshed to ~now, not the old value.
  assert.notEqual(result.dateModified, '2026-08-20T10:00:00+00:00');
  assert.ok(new Date(result.dateModified).getTime() >= new Date(before).getTime() - 2000);
});

test('recipeFromFormState writes authorName back into the author object', () => {
  const state = formStateFromRecipe(recipe, 'edit');
  state.authorName = 'Neue Köchin';
  const result = recipeFromFormState(state, 'edit');
  assert.equal(result.author.name, 'Neue Köchin');
  assert.equal(result.author['@type'], 'Person');
});

test('recipeFromFormState creates a Person author when none existed', () => {
  const { author, ...noAuthor } = recipe;
  const state = formStateFromRecipe(noAuthor, 'edit');
  state.authorName = 'Frischer Autor';
  const result = recipeFromFormState(state, 'edit');
  assert.equal(result.author.name, 'Frischer Autor');
  assert.equal(result.author['@type'], 'Person');
});

test('recipeFromFormState removes author when authorName cleared', () => {
  const state = formStateFromRecipe(recipe, 'edit');
  state.authorName = '';
  const result = recipeFromFormState(state, 'edit');
  assert.equal(result.author, undefined);
});
