import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getServingScaleFactor,
  isUsableRecipeYield,
  scaleFlatIngredient,
  scaleGroupedIngredient,
  scaleQuantityText,
} from '../../../custom_components/cookbook/frontend/services/recipe-scaling.js';

test('isUsableRecipeYield accepts only positive integers', () => {
  assert.equal(isUsableRecipeYield(1), true);
  assert.equal(isUsableRecipeYield(2.5), false);
  assert.equal(isUsableRecipeYield(0), false);
  assert.equal(isUsableRecipeYield(-1), false);
  assert.equal(isUsableRecipeYield(Number.NaN), false);
  assert.equal(isUsableRecipeYield(Number.POSITIVE_INFINITY), false);
  assert.equal(isUsableRecipeYield('2'), false);
});

test('getServingScaleFactor uses the target yield with a minimum of one', () => {
  assert.equal(getServingScaleFactor(4, 8), 2);
  assert.equal(getServingScaleFactor(4, 2), 0.5);
  assert.equal(getServingScaleFactor(4, 0), 0.25);
  assert.equal(getServingScaleFactor(0, 8), 1);
  assert.equal(getServingScaleFactor(4, -2), 0.25);
});

test('scaleQuantityText scales integers and formats the result without decimals', () => {
  assert.equal(scaleQuantityText('2', 3), '6');
  assert.equal(scaleQuantityText('2.5', 2), '5');
});

test('scaleQuantityText preserves deterministic decimal formatting', () => {
  assert.equal(scaleQuantityText('1', 1.5), '1.5');
  assert.equal(scaleQuantityText('0.25', 2), '0.5');
  assert.equal(scaleQuantityText('0.1', 3), '0.3');
});

test('scaleQuantityText scales ca. quantities while preserving the prefix', () => {
  assert.equal(scaleQuantityText('ca. 2', 1.5), 'ca. 3');
  assert.equal(scaleQuantityText('ca. 1,5', 2), 'ca. 3');
});

test('scaleQuantityText scales ranges at both endpoints', () => {
  assert.equal(scaleQuantityText('2-3', 2), '4-6');
  assert.equal(scaleQuantityText('2 – 3', 1.5), '3-4.5');
  assert.equal(scaleQuantityText('ca. 1/2 – 1 1/2', 2), 'ca. 1-3');
});

test('scaleQuantityText scales simple and mixed fractions', () => {
  assert.equal(scaleQuantityText('1/2', 2), '1');
  assert.equal(scaleQuantityText('1 1/2', 2), '3');
  assert.equal(scaleQuantityText('1 1/2', 0.5), '0.75');
});

test('scaleQuantityText leaves unparseable text exactly unchanged', () => {
  assert.equal(scaleQuantityText('eine Handvoll', 2), 'eine Handvoll');
  assert.equal(scaleQuantityText('', 2), '');
  assert.equal(scaleQuantityText('  nach Geschmack  ', 2), '  nach Geschmack  ');
});

test('scaleFlatIngredient returns a new ingredient with a scaled amount', () => {
  const ingredient = { name: 'Mehl', amount: '200', unit: 'g', note: 'gesiebt' };

  assert.deepEqual(scaleFlatIngredient(ingredient, 1.5), {
    name: 'Mehl',
    amount: '300',
    unit: 'g',
    note: 'gesiebt',
  });
  assert.notEqual(scaleFlatIngredient(ingredient, 1), ingredient);
});

test('scaleFlatIngredient keeps unparseable amounts unchanged', () => {
  const ingredient = { name: 'Salz', amount: 'nach Geschmack', unit: '', note: '' };

  assert.deepEqual(scaleFlatIngredient(ingredient, 3), ingredient);
});

test('scaleGroupedIngredient returns a deep copy without mutating grouped input', () => {
  const grouped = [
    {
      ingredients: [{ name: 'Nudeln', amount: '200', unit: 'g', note: '' }],
      instruction: 'Kochen.',
    },
    {
      ingredients: [{ name: 'Salz', amount: 'nach Geschmack', unit: '', note: '' }],
      instruction: 'Würzen.',
    },
  ];
  const snapshot = structuredClone(grouped);

  const scaled = scaleGroupedIngredient(grouped, 2);

  assert.deepEqual(scaled, [
    {
      ingredients: [{ name: 'Nudeln', amount: '400', unit: 'g', note: '' }],
      instruction: 'Kochen.',
    },
    {
      ingredients: [{ name: 'Salz', amount: 'nach Geschmack', unit: '', note: '' }],
      instruction: 'Würzen.',
    },
  ]);
  assert.deepEqual(grouped, snapshot);
  assert.notEqual(scaled, grouped);
  assert.notEqual(scaled[0], grouped[0]);
  assert.notEqual(scaled[0].ingredients[0], grouped[0].ingredients[0]);
});

test('scaleGroupedIngredient preserves steps with missing or malformed ingredients', () => {
  const grouped = [
    { instruction: 'Mischen.' },
    { ingredients: null, instruction: 'Ruhen lassen.' },
    { ingredients: [{ name: 'Mehl', amount: '2', unit: 'EL', note: '' }], instruction: 'Einrühren.' },
  ];

  assert.deepEqual(scaleGroupedIngredient(grouped, 2), [
    { ingredients: [], instruction: 'Mischen.' },
    { ingredients: [], instruction: 'Ruhen lassen.' },
    { ingredients: [{ name: 'Mehl', amount: '4', unit: 'EL', note: '' }], instruction: 'Einrühren.' },
  ]);
});

test('scaleFlatIngredient factor one still returns an independent copy', () => {
  const ingredient = { name: 'Öl', amount: '1', unit: 'EL', note: '' };
  const scaled = scaleFlatIngredient(ingredient, 1);

  assert.deepEqual(scaled, ingredient);
  assert.notEqual(scaled, ingredient);
});
