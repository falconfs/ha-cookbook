import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RecipeEditor } from '../../../custom_components/cookbook/frontend/components/recipe-editor.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

class FakeClassList {
  constructor() { this._values = new Set(); }
  add(...values) { values.forEach(value => this._values.add(value)); }
  remove(...values) { values.forEach(value => this._values.delete(value)); }
  contains(value) { return this._values.has(value); }
  toggle(value, force) {
    const shouldHave = force === undefined ? !this._values.has(value) : force;
    if (shouldHave) this._values.add(value);
    else this._values.delete(value);
    return shouldHave;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this._listeners = new Map();
    this._textContent = '';
    this.className = '';
    this.classList = new FakeClassList();
    this.style = {};
    this.files = [];
    this.disabled = false;
    this.value = '';
  }

  set innerHTML(value) { this.children = []; this._textContent = String(value); }
  get innerHTML() { return this._textContent; }
  set textContent(value) { this.children = []; this._textContent = String(value); }
  get textContent() { return this._textContent; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  addEventListener(type, listener) { this._listeners.set(type, listener); }
  setAttribute() {}
  removeAttribute() {}
  showModal() {}
  close() {}
}

class FakeTextarea extends FakeElement {
  get type() { return 'textarea'; }
}

function createDocument() {
  return {
    createElement(tagName) {
      return tagName === 'textarea' ? new FakeTextarea(tagName) : new FakeElement(tagName);
    },
  };
}

function createApi(overrides = {}) {
  return {
    getSuggestions: async () => ({
      categories: ['Salat', 'Dessert'],
      keywords: ['Sommer', 'vegan'],
      units: ['g', 'ml'],
      tools: ['Schüssel', 'Sieb'],
    }),
    imageUrl: (id, v) => (v ? `/api/cookbook/recipes/${id}/image?v=${v}` : `/api/cookbook/recipes/${id}/image`),
    tmpImageUrl: (token) => `/api/cookbook/tmp/${token}`,
    fetchImageToTmp: async () => ({ ok: true, token: 'tok-url', image_ext: 'png' }),
    uploadImageToTmp: async () => ({ ok: true, token: 'tok-file', image_ext: 'png' }),
    createRecipe: async () => '900',
    updateRecipe: async () => {},
    ...overrides,
  };
}

async function withDocument(fn) {
  const originalDocument = globalThis.document;
  globalThis.document = createDocument();
  try {
    return await fn();
  } finally {
    globalThis.document = originalDocument;
  }
}

test('re-renders editor labels in the new language without losing recipe state', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {}, () => {}, {
      i18n: createI18n({ locale: 'en' }),
    });
    await editor.open();
    editor._state.name = 'Soup';
    assert.equal(editor._header().children[0].textContent, 'Add recipe');

    editor.setI18n(createI18n({ locale: 'de' }));

    assert.equal(editor._header().children[0].textContent, 'Rezept hinzufügen');
    assert.equal(editor._state.name, 'Soup');
  });
});

test('renders textarea fields without assigning the readonly textarea type property', async () => {
  await withDocument(() => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    assert.doesNotThrow(() => editor._field(new FakeElement('div'), 'description', 'Beschreibung', '', false, 'textarea'));
  });
});

test('opens with loaded suggestions for categories, keywords and units', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    assert.deepEqual(editor._suggestions.categories, ['Salat', 'Dessert']);
    assert.deepEqual(editor._suggestions.units, ['g', 'ml']);
  });
});

test('adds unique tags and removes tags via state', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();

    editor._addChip('keywords', 'Sommer');
    editor._addChip('keywords', 'Sommer');
    editor._addChip('keywords', '  vegan  ');
    editor._addChip('keywords', '');
    assert.deepEqual(editor._state.keywords, ['Sommer', 'vegan']);

    editor._state.keywords.splice(0, 1);
    assert.deepEqual(editor._state.keywords, ['vegan']);
  });
});

test('adds and de-duplicates tools as chips', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();

    editor._addChip('tool', 'Schüssel');
    editor._addChip('tool', 'Schüssel');
    editor._addChip('tool', '  Sieb  ');
    editor._addChip('tool', '');
    assert.deepEqual(editor._state.tool, ['Schüssel', 'Sieb']);
  });
});

test('moves steps up and down and clamps at the boundaries', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    editor._state.steps = [
      { instruction: 'A', ingredients: [] },
      { instruction: 'B', ingredients: [] },
      { instruction: 'C', ingredients: [] },
    ];

    editor._moveStep(0, -1);
    assert.deepEqual(editor._state.steps.map(step => step.instruction), ['A', 'B', 'C']);

    editor._moveStep(0, 1);
    assert.deepEqual(editor._state.steps.map(step => step.instruction), ['B', 'A', 'C']);

    editor._moveStep(2, 1);
    assert.deepEqual(editor._state.steps.map(step => step.instruction), ['B', 'A', 'C']);
  });
});

test('removes a step from the state', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    editor._state.steps = [
      { instruction: 'A', ingredients: [] },
      { instruction: 'B', ingredients: [] },
    ];

    editor._removeStep(0);
    assert.deepEqual(editor._state.steps.map(step => step.instruction), ['B']);
  });
});

test('supports multiple ingredients per step with add and remove', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    const step = { instruction: 'Mischen', ingredients: [{ name: 'Mehl', amount: '', unit: '', note: '' }] };

    step.ingredients.push({ name: 'Zucker', amount: '', unit: '', note: '' });
    assert.equal(step.ingredients.length, 2);

    step.ingredients.splice(0, 1);
    assert.deepEqual(step.ingredients.map(ingredient => ingredient.name), ['Zucker']);
  });
});

test('schema.org object fields build and clear nested state', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    const parent = new FakeElement('div');

    editor._objectField(parent, 'author', 'name', 'Autor', { '@type': 'Person' });
    const authorInput = parent.children.at(-1).children.at(-1);
    authorInput.value = 'Bianca';
    authorInput._listeners.get('input')();
    assert.deepEqual(editor._state.author, { '@type': 'Person', name: 'Bianca' });

    // Clearing removes the meaningful key and drops the (now type-only) object.
    authorInput.value = '';
    authorInput._listeners.get('input')();
    assert.equal(editor._state.author, undefined);
  });
});

test('cuisine field stores a string and clears to undefined', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    const parent = new FakeElement('div');
    editor._cuisineField(parent);
    const input = parent.children.at(-1).children.at(-1);

    input.value = 'Thailändisch';
    input._listeners.get('input')();
    assert.equal(editor._state.recipeCuisine, 'Thailändisch');

    input.value = '';
    input._listeners.get('input')();
    assert.equal(editor._state.recipeCuisine, undefined);
  });
});

test('image preview shows a source and hides when cleared', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    editor._previewImg = new FakeElement('img');
    editor._previewHint = new FakeElement('span');

    editor._setImagePreview('https://example.test/a.png', 'hint');
    assert.equal(editor._previewImg.src, 'https://example.test/a.png');
    // Must be an explicit visible value that overrides the CSS `display:none`
    // default — an empty string would let the stylesheet hide it again.
    assert.equal(editor._previewImg.style.display, 'block');

    editor._setImagePreview(null, '');
    assert.equal(editor._previewImg.style.display, 'none');
  });
});

test('loading an image URL stages a tmp token and previews same-origin', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    editor._previewImg = new FakeElement('img');
    editor._previewHint = new FakeElement('span');

    await editor._loadImageFromUrl('https://example.test/a.png');

    assert.equal(editor._tmpImageToken, 'tok-url');
    assert.equal(editor._previewImg.src, '/api/cookbook/tmp/tok-url');
  });
});

test('save forwards the staged tmp image token to createRecipe', async () => {
  await withDocument(async () => {
    const calls = [];
    const api = createApi({ createRecipe: async (recipe, token) => { calls.push(token); return '901'; } });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._state.name = 'Neu';
    editor._state.steps = [{ instruction: 'Kochen', ingredients: [] }];
    editor._tmpImageToken = 'tok-url';

    await editor._save();

    assert.deepEqual(calls, ['tok-url']);
  });
});

test('removing the image marks it for deletion and forwards the flag on save', async () => {
  await withDocument(async () => {
    const calls = [];
    const api = createApi({
      updateRecipe: async (id, recipe, token, removeImage) => { calls.push({ token, removeImage }); },
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open({ id: '5', name: 'Alt', image: 'x', recipeInstructions: [{ instruction: 'A', ingredients: [] }] });
    editor._previewImg = new FakeElement('img');
    editor._previewHint = new FakeElement('span');
    editor._removeBtn = new FakeElement('button');

    editor._removeImagePreview();
    assert.equal(editor._removeImage, true);
    assert.equal(editor._tmpImageToken, null);

    await editor._save();
    assert.deepEqual(calls, [{ token: undefined, removeImage: true }]);
  });
});

test('imports a recipe from URL into the form state for review', async () => {
  await withDocument(async () => {
    const draft = {
      name: 'Imported Cake',
      recipeInstructions: [
        { instruction: 'Mix.', ingredients: [{ name: 'Flour', amount: '250', unit: 'g', note: '' }] },
      ],
      _cookbook_schema_version: 6,
    };
    const api = createApi({ importRecipeFromUrl: async () => draft });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();

    editor._importUrl = 'https://example.com/cake';
    await editor._importFromUrl();

    assert.equal(editor._state.name, 'Imported Cake');
    assert.equal(editor._importStatus.error, false);
    assert.equal(editor._state.steps[0].ingredients[0].name, 'Flour');
  });
});

test('shows an error status when URL import fails', async () => {
  await withDocument(async () => {
    const api = createApi({
      importRecipeFromUrl: async () => { throw new Error('No recipe was found on this page.'); },
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();

    editor._importUrl = 'https://example.com/blog';
    await editor._importFromUrl();

    assert.equal(editor._importStatus.error, true);
    assert.match(editor._importStatus.text, /No recipe was found/);
  });
});

test('requires a URL before importing', async () => {
  await withDocument(async () => {
    let called = false;
    const api = createApi({ importRecipeFromUrl: async () => { called = true; return {}; } });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();

    editor._importUrl = '   ';
    await editor._importFromUrl();

    assert.equal(called, false);
    assert.equal(editor._importStatus.error, true);
  });
});

test('moving an ingredient select re-groups it in the form state', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open();
    editor._state.steps = [
      { instruction: 'A', ingredients: [{ name: 'Salz', amount: '', unit: '', note: '' }] },
      { instruction: 'B', ingredients: [] },
    ];

    const select = editor._ingredientStepMover(0, 0);
    select.value = '1';
    select._listeners.get('change')({ target: { value: '1' } });

    assert.deepEqual(editor._state.steps[0].ingredients, []);
    assert.deepEqual(editor._state.steps[1].ingredients.map(i => i.name), ['Salz']);
  });
});

test('edit mode exposes author and dateCreated in form state', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open({
      id: '5',
      name: 'Alt',
      author: { '@type': 'Person', name: 'Nele' },
      dateCreated: '2020-01-01T00:00:00+00:00',
      dateModified: '2020-01-02T00:00:00+00:00',
      recipeInstructions: [{ instruction: 'A', ingredients: [] }],
    });
    assert.equal(editor._state.authorName, 'Nele');
    assert.equal(editor._state.dateCreated, '2020-01-01T00:00:00+00:00');
    assert.equal(editor._state.dateModified, '2020-01-02T00:00:00+00:00');
  });
});

test('_datesSection renders created (editable) and modified (read-only) fields', async () => {
  await withDocument(async () => {
    const editor = new RecipeEditor(new FakeElement('main'), createApi(), () => {});
    await editor.open({
      id: '5',
      name: 'Alt',
      dateCreated: '2020-01-01T00:00:00+00:00',
      dateModified: '2020-01-02T00:00:00+00:00',
      recipeInstructions: [{ instruction: 'A', ingredients: [] }],
    });
    const section = editor._datesSection();
    // Collect all inputs rendered in the section.
    const inputs = [];
    const walk = (el) => { (el.children || []).forEach((c) => { if (c.tagName === 'INPUT') inputs.push(c); walk(c); }); };
    walk(section);
    const created = inputs.find((i) => i.name === 'dateCreated');
    const modified = inputs.find((i) => i.name === 'dateModified_display');
    assert.ok(created, 'dateCreated field present');
    assert.ok(modified, 'dateModified display field present');
    assert.equal(modified.disabled, true);
  });
});

test('URL import stages the recipe image so it is saved with the recipe', async () => {
  await withDocument(async () => {
    let fetchedUrl = null;
    const api = createApi({
      importRecipeFromUrl: async () => ({
        name: 'Imported',
        image: 'https://example.test/pic.jpg',
        recipeInstructions: [{ instruction: 'A', ingredients: [] }],
      }),
      fetchImageToTmp: async (url) => { fetchedUrl = url; return { ok: true, token: 'tok-img', image_ext: 'jpg' }; },
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();

    editor._importUrl = 'https://example.test/recipe';
    await editor._importFromUrl();

    assert.equal(fetchedUrl, 'https://example.test/pic.jpg');
    assert.equal(editor._tmpImageToken, 'tok-img');
    assert.equal(editor._importStatus.error, false);
  });
});

test('URL import without an image does not call fetchImageToTmp', async () => {
  await withDocument(async () => {
    let called = false;
    const api = createApi({
      importRecipeFromUrl: async () => ({
        name: 'Imported',
        image: '',
        recipeInstructions: [{ instruction: 'A', ingredients: [] }],
      }),
      fetchImageToTmp: async () => { called = true; return { ok: true, token: 'x' }; },
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._importUrl = 'https://example.test/recipe';
    await editor._importFromUrl();

    assert.equal(called, false);
    assert.equal(editor._tmpImageToken, null);
  });
});

test('URL import still succeeds when image staging fails', async () => {
  await withDocument(async () => {
    const api = createApi({
      importRecipeFromUrl: async () => ({
        name: 'Imported',
        image: 'https://example.test/pic.jpg',
        recipeInstructions: [{ instruction: 'A', ingredients: [] }],
      }),
      fetchImageToTmp: async () => ({ error: 'Image download failed (404)' }),
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._importUrl = 'https://example.test/recipe';
    await editor._importFromUrl();

    // Recipe draft imported; image just not staged.
    assert.equal(editor._state.name, 'Imported');
    assert.equal(editor._tmpImageToken, null);
    assert.equal(editor._importStatus.error, false);
  });
});

test('URL import shows the staged image as a preview', async () => {
  await withDocument(async () => {
    const api = createApi({
      importRecipeFromUrl: async () => ({
        name: 'Imported', image: 'https://example.test/pic.jpg',
        recipeInstructions: [{ instruction: 'A', ingredients: [] }],
      }),
      fetchImageToTmp: async () => ({ ok: true, token: 'tok-img', image_ext: 'jpg' }),
      tmpImageUrl: (t) => `/api/cookbook/tmp/${t}`,
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._importUrl = 'https://example.test/recipe';
    await editor._importFromUrl();

    assert.equal(editor._tmpImageToken, 'tok-img');
    // The preview image src points at the staged tmp image.
    assert.equal(editor._previewImg.src, '/api/cookbook/tmp/tok-img');
  });
});

test('URL import clears external image URL from state once staged', async () => {
  await withDocument(async () => {
    const api = createApi({
      importRecipeFromUrl: async () => ({
        name: 'Imported', image: 'https://example.test/pic.jpg',
        recipeInstructions: [{ instruction: 'A', ingredients: [] }],
      }),
      fetchImageToTmp: async () => ({ ok: true, token: 'tok-img', image_ext: 'jpg' }),
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._importUrl = 'https://example.test/recipe';
    await editor._importFromUrl();

    // The staged image is attached via token; the raw external URL must not be
    // persisted as the recipe image.
    assert.equal(editor._state.image, '');
  });
});

test('opening a fresh add editor after an import shows no image preview', async () => {
  await withDocument(async () => {
    const api = createApi({
      importRecipeFromUrl: async () => ({
        name: 'Imported', image: 'https://example.test/pic.jpg',
        recipeInstructions: [{ instruction: 'A', ingredients: [] }],
      }),
      fetchImageToTmp: async () => ({ ok: true, token: 'tok-img', image_ext: 'jpg' }),
      tmpImageUrl: (t) => `/api/cookbook/tmp/${t}`,
    });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._importUrl = 'https://example.test/recipe';
    await editor._importFromUrl();
    // Re-open for a brand-new recipe.
    await editor.open();

    assert.equal(editor._tmpImageToken, null);
    assert.equal(editor._state.image, '');
    // Preview must be cleared (no src) for the new recipe.
    assert.ok(!editor._previewImg.src);
  });
});

test('AI regroup replaces steps with the AI result', async () => {
  await withDocument(async () => {
    const regrouped = {
      name: 'P',
      recipeInstructions: [
        { instruction: 'Mehl mischen.', ingredients: [{ name: 'Mehl', amount: '250', unit: 'g', note: '' }] },
        { instruction: 'Eier dazu.', ingredients: [{ name: 'Eier', amount: '2', unit: '', note: '' }] },
      ],
    };
    const api = createApi({ aiRegroupRecipe: async () => regrouped });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open({
      id: '5', name: 'P',
      recipeInstructions: [
        { instruction: 'Mehl mischen.', ingredients: [
          { name: 'Mehl', amount: '250', unit: 'g', note: '' },
          { name: 'Eier', amount: '2', unit: '', note: '' }] },
        { instruction: 'Eier dazu.', ingredients: [] },
      ],
    });
    await editor._aiRegroup();
    assert.equal(editor._state.steps[1].ingredients.length, 1);
    assert.equal(editor._state.steps[1].ingredients[0].name, 'Eier');
    assert.equal(editor._aiStatus.error, false);
  });
});

test('AI regroup shows an error and keeps steps on failure', async () => {
  await withDocument(async () => {
    const api = createApi({ aiRegroupRecipe: async () => { throw new Error('The AI returned an invalid result.'); } });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open({
      id: '5', name: 'P',
      recipeInstructions: [{ instruction: 'A', ingredients: [{ name: 'X', amount: '', unit: '', note: '' }] }],
    });
    const before = JSON.stringify(editor._state.steps);
    await editor._aiRegroup();
    assert.equal(JSON.stringify(editor._state.steps), before);
    assert.equal(editor._aiStatus.error, true);
  });
});

test('AI fallback import fills the form from the AI draft', async () => {
  await withDocument(async () => {
    const draft = {
      name: 'KI Rezept',
      recipeInstructions: [{ instruction: 'Kochen.', ingredients: [] }],
    };
    const api = createApi({ aiImportFromUrl: async () => draft });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {});
    await editor.open();
    editor._importUrl = 'https://x.test/r';
    await editor._aiFallbackImport();
    assert.equal(editor._state.name, 'KI Rezept');
    assert.equal(editor._importStatus.error, false);
  });
});

test('AI fallback passes the configured ai_task entity', async () => {
  await withDocument(async () => {
    let seenEntity = null;
    const api = createApi({ aiImportFromUrl: async (url, entity) => { seenEntity = entity; return { name: 'X', recipeInstructions: [{ instruction: 'A', ingredients: [] }] }; } });
    const editor = new RecipeEditor(new FakeElement('main'), api, () => {}, () => {}, { aiTaskEntity: 'ai_task.openai_ai_task' });
    await editor.open();
    editor._importUrl = 'https://x.test/r';
    await editor._aiFallbackImport();
    assert.equal(seenEntity, 'ai_task.openai_ai_task');
  });
});
