import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CookbookApi } from '../../../custom_components/cookbook/frontend/services/api.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

class FakeCache {
  constructor() {
    this.values = new Map();
  }

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

test('lists recipes through the cookbook service response', async () => {
  const { api, calls } = createApi([{ response: { recipes: [{ id: '1', name: 'Soup' }] } }]);

  const recipes = await api.getRecipes();

  assert.deepEqual(recipes, [{ id: '1', name: 'Soup' }]);
  assert.deepEqual(calls, [{
    type: 'call_service',
    domain: 'cookbook',
    service: 'list_recipes',
    service_data: {},
    return_response: true,
  }]);
});

test('derives categories from recipe stubs', async () => {
  const { api } = createApi([{ response: { recipes: [
    { id: '1', recipeCategory: 'Dinner' },
    { id: '2', recipeCategory: '' },
    { id: '3', recipeCategory: 'Dinner' },
  ] } }]);

  assert.deepEqual(await api.getCategories(), ['Dinner']);
});

test('gets and caches a full recipe through the cookbook service', async () => {
  const recipe = { id: '1', name: 'Soup' };
  const { api, calls } = createApi([{ response: { recipe } }]);

  assert.deepEqual(await api.getRecipe('1'), recipe);
  assert.deepEqual(await api.getRecipe('1'), recipe);
  assert.equal(calls.length, 1);
});

test('merges metadata and persists the full recipe through upsert', async () => {
  const recipe = { id: '1', name: 'Soup' };
  const { api, calls } = createApi([
    { response: { recipe } },
    { response: { recipe_id: '1' } },
  ]);

  await api.updateRecipeMeta('1', { rating: 4, lastCooked: '2026-08-17' });

  assert.deepEqual(calls[1], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'upsert_recipe',
    service_data: {
      recipe_id: '1',
      recipe: { ...recipe, _ha_rating: 4, _ha_last_cooked: '2026-08-17' },
    },
    return_response: true,
  });
});

test('returns the updated recipe from updateRecipeMeta', async () => {
  const recipe = { id: '1', name: 'Soup' };
  const updatedRecipe = { ...recipe, _ha_rating: 5 };
  const { api } = createApi([
    { response: { recipe } },
    { response: { recipe: updatedRecipe } },
  ]);

  assert.deepEqual(await api.updateRecipeMeta('1', { rating: 5 }), updatedRecipe);
});

test('creates a recipe and refreshes the recipe and category caches', async () => {
  const recipe = { name: 'Soup', recipeCategory: 'Dinner' };
  const { api, calls } = createApi([
    { response: { recipe_id: '7', recipe } },
    { response: { recipes: [{ id: '7', ...recipe }] } },
  ]);

  await api.createRecipe(recipe);

  assert.deepEqual(calls, [
    {
      type: 'call_service',
      domain: 'cookbook',
      service: 'upsert_recipe',
      service_data: { recipe },
      return_response: true,
    },
    {
      type: 'call_service',
      domain: 'cookbook',
      service: 'list_recipes',
      service_data: {},
      return_response: true,
    },
  ]);
  assert.deepEqual(await api.getRecipes(), [{ id: '7', ...recipe }]);
  assert.deepEqual(await api.getCategories(), ['Dinner']);
});

test('updates a recipe, invalidates its detail cache, and refreshes the list', async () => {
  const oldRecipe = { id: '7', name: 'Old Soup' };
  const updatedRecipe = { id: '7', name: 'New Soup' };
  const { api, calls } = createApi([
    { response: { recipe: oldRecipe } },
    { response: { recipe: updatedRecipe } },
    { response: { recipes: [updatedRecipe] } },
    { response: { recipe: updatedRecipe } },
  ]);

  await api.getRecipe('7');
  await api.updateRecipe('7', updatedRecipe);

  assert.deepEqual(calls.slice(1), [
    {
      type: 'call_service',
      domain: 'cookbook',
      service: 'upsert_recipe',
      service_data: { recipe_id: '7', recipe: updatedRecipe },
      return_response: true,
    },
    {
      type: 'call_service',
      domain: 'cookbook',
      service: 'list_recipes',
      service_data: {},
      return_response: true,
    },
  ]);
  assert.deepEqual(await api.getRecipe('7'), updatedRecipe);
  assert.equal(calls.length, 4);
});

test('deletes a recipe and refreshes the recipe and category caches', async () => {
  const { api, calls } = createApi([
    { response: { recipes: [{ id: '7', recipeCategory: 'Dinner' }] } },
    { response: {} },
    { response: { recipes: [] } },
  ]);

  await api.getRecipes();
  await api.deleteRecipe('7');

  assert.deepEqual(calls.slice(1), [
    {
      type: 'call_service',
      domain: 'cookbook',
      service: 'delete_recipe',
      service_data: { recipe_id: '7' },
      return_response: true,
    },
    {
      type: 'call_service',
      domain: 'cookbook',
      service: 'list_recipes',
      service_data: {},
      return_response: true,
    },
  ]);
  assert.deepEqual(await api.getRecipes(), []);
  assert.deepEqual(await api.getCategories(), []);
});

test('refreshData refreshes recipes and derived categories', async () => {
  const recipes = [{ id: '7', recipeCategory: 'Dinner' }];
  const { api, calls } = createApi([{ response: { recipes } }]);

  assert.deepEqual(await api.refreshData(), { recipes, categories: ['Dinner'] });
  assert.deepEqual(calls[0], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'list_recipes',
    service_data: {},
    return_response: true,
  });
});

test('fetches a recipe image from a URL through the cookbook service', async () => {
  const { api, calls } = createApi([{ response: { image_ext: 'jpg' } }]);

  assert.deepEqual(
    await api.fetchImageFromUrl('7', 'https://example.test/soup.jpg'),
    { image_ext: 'jpg' },
  );
  assert.deepEqual(calls[0], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'fetch_image_from_url',
    service_data: { recipe_id: '7', image_url: 'https://example.test/soup.jpg' },
    return_response: true,
  });
});

test('uploads a recipe image as multipart form data', async () => {
  const file = new Blob(['image-bytes'], { type: 'image/png' });
  const { api } = createApi();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response('{}', { status: 200 });
  };

  try {
    await api.uploadRecipeImage('7', file);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/cookbook/recipes/7/image');
  assert.equal(requests[0].options.method, 'POST');
  assert.ok(requests[0].options.body instanceof FormData);
  const uploaded = requests[0].options.body.get('file');
  assert.equal(uploaded.type, file.type);
  assert.deepEqual(await uploaded.arrayBuffer(), await file.arrayBuffer());
});

test('aggregates category, keyword and unit suggestions from loaded recipes', async () => {
  const recipes = [
    { id: '1', recipeCategory: 'Salat', keywords: 'schnell, Sommer' },
    { id: '2', recipeCategory: 'Dessert', keywords: 'Sommer,vegan' },
    { id: '3', recipeCategory: '', keywords: '' },
  ];
  const { api } = createApi([
    { response: { recipes } },
    { response: { recipe: { id: '1', tool: ['Schüssel', 'Sieb'], recipeInstructions: [
      { ingredients: [{ name: 'Mehl', unit: 'g' }, { name: 'Milch', unit: 'ml' }] },
    ] } } },
    { response: { recipe: { id: '2', tool: ['Schüssel'], recipeInstructions: [
      { ingredients: [{ name: 'Zucker', unit: 'g' }, { name: 'Ei', unit: '' }] },
    ] } } },
  ]);

  const suggestions = await api.getSuggestions();

  assert.deepEqual(suggestions.categories, ['Dessert', 'Salat']);
  assert.deepEqual(suggestions.keywords, ['schnell', 'Sommer', 'vegan']);
  assert.deepEqual(suggestions.units, ['g', 'ml']);
  assert.deepEqual(suggestions.tools, ['Schüssel', 'Sieb']);
});

test('returns the local image endpoint URL', () => {
  const { api } = createApi();
  assert.equal(api.imageUrl('42'), '/api/cookbook/recipes/42/image');
});

test('appends a cache-buster to the image URL when a version is given', () => {
  const { api } = createApi();
  assert.equal(api.imageUrl('42', 1730000000), '/api/cookbook/recipes/42/image?v=1730000000');
  assert.equal(api.imageUrl('42', ''), '/api/cookbook/recipes/42/image');
});

test('returns the tmp image URL for a token', () => {
  const { api } = createApi();
  assert.equal(api.tmpImageUrl('abc123'), '/api/cookbook/tmp/abc123');
});

test('fetches an image URL into tmp via the cookbook service', async () => {
  const { api, calls } = createApi([{ response: { ok: true, token: 'tok1', image_ext: 'png' } }]);

  assert.deepEqual(
    await api.fetchImageToTmp('https://example.test/a.png'),
    { ok: true, token: 'tok1', image_ext: 'png' },
  );
  assert.deepEqual(calls[0], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'fetch_image_to_tmp',
    service_data: { image_url: 'https://example.test/a.png' },
    return_response: true,
  });
});

test('uploads a file into tmp as multipart form data', async () => {
  const file = new Blob(['bytes'], { type: 'image/png' });
  const { api } = createApi();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true, token: 'tok2', image_ext: 'png' }), { status: 200 });
  };
  try {
    const result = await api.uploadImageToTmp(file);
    assert.deepEqual(result, { ok: true, token: 'tok2', image_ext: 'png' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0].url, '/api/cookbook/tmp');
  assert.equal(requests[0].options.method, 'POST');
  assert.ok(requests[0].options.body instanceof FormData);
});

test('createRecipe forwards a tmp image token when provided', async () => {
  const { api, calls } = createApi([
    { response: { recipe_id: '7' } },
    { response: { recipes: [] } },
  ]);

  await api.createRecipe({ name: 'X' }, 'tok9');

  assert.deepEqual(calls[0].service_data, { recipe: { name: 'X' }, tmp_image_token: 'tok9' });
});

test('updateRecipe forwards a remove_image flag when requested', async () => {
  const { api, calls } = createApi([
    { response: { recipe_id: '7' } },
    { response: { recipes: [] } },
  ]);

  await api.updateRecipe('7', { name: 'X' }, undefined, true);

  assert.deepEqual(calls[0].service_data, {
    recipe_id: '7',
    recipe: { name: 'X' },
    remove_image: true,
  });
});

test('createRecipe throws when the service response lacks a recipe_id', async () => {
  const { api } = createApi([{ response: {} }, { response: { recipes: [] } }]);
  await assert.rejects(api.createRecipe({ name: 'X' }), /recipe ID is missing/);
});

test('wraps service failures with the cookbook service name', async () => {
  const hass = { callWS: async () => { throw new Error('unavailable'); } };
  const api = new CookbookApi(hass, new FakeCache());

  await assert.rejects(api.getRecipes(), /Home Assistant service cookbook\.list_recipes failed: unavailable/);
});

test('importRecipeFromUrl returns the draft recipe from the service', async () => {
  const draft = { name: 'Imported Cake', _cookbook_schema_version: 6 };
  const { api, calls } = createApi([{ response: { recipe: draft } }]);

  const result = await api.importRecipeFromUrl('https://example.com/cake');

  assert.deepEqual(result, { recipe: draft, import_method: 'native' });
  assert.deepEqual(calls[0], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'import_recipe_from_url',
    service_data: { url: 'https://example.com/cake' },
    return_response: true,
  });
});

test('importRecipeFromUrl returns the import method and passes the configured AI Task entity', async () => {
  const draft = { name: 'Imported with AI', _cookbook_schema_version: 6 };
  const { api, calls } = createApi([{ response: { recipe: draft, import_method: 'ai' } }]);

  const result = await api.importRecipeFromUrl('https://example.com/cake', 'ai_task.test');

  assert.deepEqual(result, { recipe: draft, import_method: 'ai' });
  assert.deepEqual(calls[0].service_data, {
    url: 'https://example.com/cake',
    ai_task_entity: 'ai_task.test',
  });
});

test('importRecipeFromUrl throws the service error message', async () => {
  const { api } = createApi([{ response: { error: 'No recipe was found on this page.' } }]);

  await assert.rejects(
    api.importRecipeFromUrl('https://example.com/blog'),
    /No recipe was found on this page\./,
  );
});

test('translates backend error codes using the selected UI locale', async () => {
  const api = new CookbookApi(
    { callWS: async () => ({ response: { error: 'This URL cannot be imported.', error_code: 'import_url_invalid' } }) },
    new FakeCache(),
    { i18n: createI18n({ locale: 'de' }) },
  );

  await assert.rejects(api.importRecipeFromUrl('https://example.com/x'), /Diese URL kann nicht importiert werden\./);
});

test('importRecipeFromUrl throws when the response has neither recipe nor error', async () => {
  const { api } = createApi([{ response: {} }]);

  await assert.rejects(api.importRecipeFromUrl('https://example.com/x'), /import response did not contain a recipe/);
});

test('aiImportFromUrl returns the draft and passes url + entity', async () => {
  const draft = { name: 'KI Rezept', _cookbook_schema_version: 6 };
  const { api, calls } = createApi([{ response: { recipe: draft } }]);

  const result = await api.aiImportFromUrl('https://x.test/r', 'ai_task.openai_ai_task');

  assert.deepEqual(result, draft);
  assert.deepEqual(calls[0], {
    type: 'call_service',
    domain: 'cookbook',
    service: 'ai_import_recipe_from_url',
    service_data: { url: 'https://x.test/r', ai_task_entity: 'ai_task.openai_ai_task' },
    return_response: true,
  });
});

test('aiImportFromUrl omits entity when not given', async () => {
  const { api, calls } = createApi([{ response: { recipe: { name: 'X' } } }]);
  await api.aiImportFromUrl('https://x.test/r');
  assert.deepEqual(calls[0].service_data, { url: 'https://x.test/r' });
});

test('aiImportFromUrl throws the service error', async () => {
  const { api } = createApi([{ response: { error: 'The AI could not extract a valid recipe.' } }]);
  await assert.rejects(api.aiImportFromUrl('https://x.test/r'), /AI could not extract/);
});

test('aiRegroupRecipe returns the regrouped draft', async () => {
  const recipe = { name: 'P', recipeInstructions: [] };
  const draft = { name: 'P', _cookbook_schema_version: 6, recipeInstructions: [] };
  const { api, calls } = createApi([{ response: { recipe: draft } }]);

  const result = await api.aiRegroupRecipe(recipe);

  assert.deepEqual(result, draft);
  assert.equal(calls[0].service, 'ai_regroup_recipe');
  assert.deepEqual(calls[0].service_data.recipe, recipe);
});

test('aiRegroupRecipe throws the service error', async () => {
  const { api } = createApi([{ response: { error: 'The AI returned an invalid result.' } }]);
  await assert.rejects(api.aiRegroupRecipe({ name: 'X' }), /invalid result/);
});
