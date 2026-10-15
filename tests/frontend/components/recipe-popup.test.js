import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { RecipePopup } from '../../../custom_components/cookbook/frontend/components/recipe-popup.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

class FakeClassList {
  constructor(owner) {
    this._owner = owner;
    this._values = new Set();
  }

  add(...values) {
    values.forEach((value) => this._values.add(value));
    this._sync();
  }

  remove(...values) {
    values.forEach((value) => this._values.delete(value));
    this._sync();
  }

  toggle(value, force) {
    const shouldAdd = force === undefined ? !this._values.has(value) : force;
    if (shouldAdd) this._values.add(value);
    else this._values.delete(value);
    this._sync();
    return shouldAdd;
  }

  contains(value) {
    return this._values.has(value);
  }

  _sync() {
    this._owner._className = [...this._values].join(' ');
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { cssText: '', display: '' };
    this.classList = new FakeClassList(this);
    this._className = '';
    this._textContent = '';
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.value = '';
    this._listeners = new Map();
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = value;
    this.classList._values = new Set(value.split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._textContent || this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value);
  }

  set innerHTML(value) {
    this.children = [];
    this._textContent = String(value) === '' ? '' : String(value);
  }

  get innerHTML() {
    return this.textContent;
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set href(value) {
    this.setAttribute('href', value);
  }

  set target(value) {
    this.setAttribute('target', value);
  }

  set rel(value) {
    this.setAttribute('rel', value);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    (this._listeners.get(event.type) || []).forEach((listener) => listener(event));
  }
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      element.children.forEach((child) => {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      });
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function createDocument() {
  return { createElement: (tagName) => new FakeElement(tagName) };
}

function createApi() {
  return {
    imageUrl: (id) => `/local/recipe-${id}.jpg`,
    updateRecipeMeta: async () => ({}),
  };
}

function createFailingApi() {
  return {
    imageUrl: (id) => `/local/recipe-${id}.jpg`,
    updateRecipeMeta: async () => { throw new Error('Speichern fehlgeschlagen'); },
  };
}

function createRecipe(overrides = {}) {
  return {
    id: 42,
    name: 'Tomatensuppe',
    description: 'Eine schnelle Suppe.',
    recipeInstructions: [{
      ingredients: [{ name: 'Tomaten', amount: '', unit: '', note: '' }],
      instruction: 'Kochen.',
    }],
    keywords: 'Suppe, vegetarisch',
    url: 'https://example.test/recipe/42',
    nutrition: {
      calories: '180',
      proteinContent: '4',
      carbohydrateContent: '22',
      fatContent: '7',
    },
    ...overrides,
  };
}

function createScalableRecipe(overrides = {}) {
  return createRecipe({
    recipeYield: 4,
    recipeInstructions: [
      {
        ingredients: [{ name: 'Mehl', amount: '2', unit: 'g', note: 'gesiebt' }],
        instruction: 'Mehl einrühren.',
      },
    ],
    ...overrides,
  });
}

function createPopup(i18n = createI18n({ locale: 'de' })) {
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, createApi(), '', 'large', null, {}, { i18n });
  popup._populate(createRecipe());
  return { mount, popup };
}

test('updates recipe dialog labels when the UI language changes', () => {
  const { popup } = createPopup();
  assert.equal(popup._els.cookedBtn.textContent, 'Heute gekocht');

  popup.setI18n(createI18n({ locale: 'en' }));

  assert.equal(popup._els.cookedBtn.textContent, 'Cooked today');
  assert.equal(popup._els.tabs.children[0].textContent, 'Ingredients');
  assert.equal(popup._currentRecipe.name, 'Tomatensuppe');
});

test('last-cooked dates use the active locale without shifting calendar dates', () => {
  const { popup } = createPopup();
  popup._populate(createRecipe({ _ha_last_cooked: '2026-04-02' }));
  assert.match(popup._els.lastCookedEl.textContent, /^Zuletzt gekocht:/);

  popup.setI18n(createI18n({ locale: 'en' }));

  assert.match(popup._els.lastCookedEl.textContent, /^Last cooked:/);
  assert.match(popup._els.lastCookedEl.textContent, /2026/);
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let pending microtasks (async open/populate chains) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * API with controllable getRecipe responses: each recipe id maps to a
 * deferred that the test resolves (or rejects) in a chosen order.
 */
function createDeferredDetailApi() {
  const deferreds = new Map();
  return {
    api: {
      imageUrl: (id) => `/local/recipe-${id}.jpg`,
      updateRecipeMeta: async () => ({}),
      getRecipe: (id) => {
        if (!deferreds.has(id)) deferreds.set(id, createDeferred());
        return deferreds.get(id).promise;
      },
    },
    resolveDetail: (id, recipe) => deferreds.get(id).resolve(recipe),
    rejectDetail: (id, err) => deferreds.get(id).reject(err),
  };
}

beforeEach(() => {
  globalThis.document = createDocument();
});

afterEach(() => {
  delete globalThis.document;
});

test('renders the source link directly after the description with secure attributes', () => {
  const { popup } = createPopup();
  const { descEl } = popup._els;
  const source = descEl.parentElement.children[descEl.parentElement.children.indexOf(descEl) + 1];
  const link = source.querySelector('a');

  assert.equal(source.className, 'metro-dialog__source');
  assert.equal(link.getAttribute('href'), 'https://example.test/recipe/42');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('omits the source link for non-http(s) URL schemes', () => {
  const { popup } = createPopup();
  popup._populate(createRecipe({ url: 'javascript:alert(1)' }));
  assert.equal(popup._els.sourceEl.querySelectorAll('a').length, 0);

  popup._populate(createRecipe({ url: 'ftp://example.test/recipe/42' }));
  assert.equal(popup._els.sourceEl.querySelectorAll('a').length, 0);

  popup._populate(createRecipe({ url: 'not a URL' }));
  assert.equal(popup._els.sourceEl.querySelectorAll('a').length, 0);
});

test('shows a prominent source section plus labeled Tags and Nutrition sections', () => {
  const { popup } = createPopup();
  const sections = popup._els.infoPanel.querySelectorAll('section');
  const headings = sections.map((section) => section.querySelector('h3').textContent);

  assert.deepEqual(headings, ['Quelle', 'Tags', 'Nährwerte']);
  // Exactly one link in the Info tab: the source link in the first section.
  assert.equal(popup._els.infoPanel.querySelectorAll('a').length, 1);
  const sourceLink = sections[0].querySelector('a');
  assert.equal(sourceLink.getAttribute('href'), 'https://example.test/recipe/42');
  assert.equal(sourceLink.getAttribute('target'), '_blank');
  assert.equal(sourceLink.getAttribute('rel'), 'noopener noreferrer');
  // Tags and Nutrition follow the source section.
  assert.equal(sections[1].querySelectorAll('.metro-chip').length, 2);
  assert.equal(sections[2].querySelectorAll('dt').length, 4);
  assert.equal(sections[2].querySelectorAll('dd').length, 4);
});

test('omits empty Tags and Nutrition sections and the source link when data is absent', () => {
  const { popup } = createPopup();
  popup._populate(createRecipe({ keywords: '', nutrition: {}, url: '' }));

  assert.equal(popup._els.infoPanel.querySelectorAll('section').length, 0);
  assert.equal(popup._els.infoPanel.querySelectorAll('h3').length, 0);
  assert.equal(popup._els.infoPanel.querySelectorAll('a').length, 0);
  assert.equal(popup._els.descEl.parentElement.querySelectorAll('a').length, 0);
});

test('clears stale source content when a later recipe has no URL', () => {
  const { popup } = createPopup();
  popup._populate(createRecipe({ url: '' }));

  assert.equal(popup._els.descEl.parentElement.querySelectorAll('a').length, 0);
  assert.ok(popup._els.sourceEl);
  assert.equal(popup._els.sourceEl.children.length, 0);
});

test('clears source and Info content while loading the next recipe', () => {
  const { popup } = createPopup();
  popup._showLoading();

  assert.equal(popup._els.descEl.parentElement.querySelectorAll('a').length, 0);
  assert.ok(popup._els.sourceEl);
  assert.equal(popup._els.sourceEl.children.length, 0);
  assert.equal(popup._els.infoPanel.children.length, 0);
});

test('shows serving controls for a usable yield and changes target by one', () => {
  const { popup } = createPopup();
  popup._populate(createScalableRecipe());

  const { servingsCalculator, servingsMinus, servingsTarget, servingsPlus } = popup._els;
  assert.equal(servingsCalculator.hidden, false);
  assert.equal(servingsTarget.textContent, '4');
  assert.equal(servingsMinus.disabled, false);
  assert.equal(servingsPlus.disabled, false);

  servingsPlus.click();
  assert.equal(servingsTarget.textContent, '5');
  servingsMinus.click();
  assert.equal(servingsTarget.textContent, '4');
  popup._setTargetYield(1);
  servingsMinus.click();
  assert.equal(servingsTarget.textContent, '1');
  assert.equal(servingsMinus.disabled, true);
});

test('hides the calculator for fractional recipe yields', () => {
  const { popup } = createPopup();
  popup._populate(createScalableRecipe({ recipeYield: 2.5 }));

  assert.equal(popup._els.servingsCalculator.hidden, true);
  assert.equal(popup._els.servingsTarget.textContent, '');
});

test('clamps target servings to the minimum of one', () => {
  const { popup } = createPopup();
  popup._populate(createScalableRecipe());

  popup._setTargetYield(0);
  assert.equal(popup._els.servingsTarget.textContent, '1');
});

test('scales flat and grouped ingredient amounts without scaling instruction or nutrition text', () => {
  const { popup } = createPopup();
  popup._populate(createScalableRecipe());

  popup._els.servingsPlus.click();

  assert.match(popup._els.ingredientsPanel.textContent, /2.5 g Mehl/);
  assert.match(popup._els.instructionsPanel.textContent, /2.5 g Mehl \(gesiebt\)/);
  assert.match(popup._els.instructionsPanel.textContent, /Mehl einrühren\./);
  assert.match(popup._els.infoPanel.textContent, /180 kcal/);
});

test('hides and disables serving controls for an unusable yield', () => {
  const { popup } = createPopup();
  popup._populate(createScalableRecipe({ recipeYield: 0 }));

  const { servingsCalculator, servingsMinus, servingsTarget, servingsPlus } = popup._els;
  assert.equal(servingsCalculator.hidden, true);
  assert.equal(servingsMinus.disabled, true);
  assert.equal(servingsPlus.disabled, true);
});

test('resets target servings when another recipe is populated and loading clears the calculator', () => {
  const { popup } = createPopup();
  popup._populate(createScalableRecipe({ recipeYield: 6 }));
  popup._els.servingsPlus.click();
  assert.equal(popup._els.servingsTarget.textContent, '7');

  popup._populate(createScalableRecipe({ id: 43, recipeYield: 2 }));
  assert.equal(popup._els.servingsTarget.textContent, '2');

  popup._showLoading();
  assert.equal(popup._els.servingsCalculator.hidden, true);
});

test('serving calculator state is local to each popup instance', () => {
  const first = createPopup().popup;
  const second = createPopup().popup;
  first._populate(createScalableRecipe({ recipeYield: 3 }));
  first._els.servingsPlus.click();

  second._populate(createScalableRecipe({ recipeYield: 8 }));

  assert.equal(first._els.servingsTarget.textContent, '4');
  assert.equal(second._els.servingsTarget.textContent, '8');
});

test('shows rating write-back failures without discarding the recipe view', async () => {
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, createFailingApi());
  popup._populate(createRecipe());

  await popup._onRatingChange(4);

  const alert = popup._els.actionsError;
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent, /Speichern fehlgeschlagen/);
  assert.equal(popup._els.titleEl.textContent, 'Tomatensuppe');
});

test('shows cooked-date write-back failures without discarding the recipe view', async () => {
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, createFailingApi());
  popup._populate(createRecipe());

  await popup._onMarkCooked();

  assert.equal(popup._els.actionsError.getAttribute('role'), 'alert');
  assert.match(popup._els.actionsError.textContent, /Speichern fehlgeschlagen/);
  assert.equal(popup._els.titleEl.textContent, 'Tomatensuppe');
});

test('edit action switches the shared dialog into editor mode without closing it', async () => {
  const mount = new FakeElement('main');
  const opened = [];
  const popup = new RecipePopup(mount, createApi(), '', 'large', null, {}, {});
  popup.setEditorFactory((host) => ({
    open: async (recipe) => { opened.push(recipe); host.appendChild(new FakeElement('form')); },
    close: () => { host.innerHTML = ''; },
  }));
  popup._dialog.showModal();
  popup._populate(createRecipe());

  await popup._onEditClick();

  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, 42);
  assert.equal(popup.isOpen, true);
  assert.equal(popup._editorMode, true);
  assert.equal(popup._els.editorHost.hidden, false);
  assert.equal(popup._els.viewContainer.hidden, true);
});

test('saving exits editor mode, reloads the recipe and keeps the dialog open', async () => {
  const mount = new FakeElement('main');
  const fetched = [];
  const savedCalls = [];
  const api = {
    imageUrl: (id) => `/local/recipe-${id}.jpg`,
    updateRecipeMeta: async () => ({}),
    getRecipe: async (id) => { fetched.push(id); return createRecipe({ id, name: 'Aktualisiert' }); },
  };
  let savedCb;
  const popup = new RecipePopup(mount, api, '', 'large', null, {}, {
    onSaved: () => savedCalls.push('saved'),
  });
  popup.setEditorFactory((host, onSaved) => {
    savedCb = onSaved;
    return {
      open: async () => { host.appendChild(new FakeElement('form')); },
      close: () => { host.innerHTML = ''; },
    };
  });
  popup._dialog.showModal();
  popup._populate(createRecipe());
  await popup._onEditClick();

  // Simulate the editor finishing a save for recipe 42.
  await savedCb(42);

  assert.equal(popup._editorMode, false);
  assert.equal(popup.isOpen, true);
  assert.deepEqual(fetched, [42]);
  assert.deepEqual(savedCalls, ['saved']);
  assert.equal(popup._els.titleEl.textContent, 'Aktualisiert');
  assert.equal(popup._els.viewContainer.hidden, false);
  assert.equal(popup._els.editorHost.hidden, true);
});

test('delete requires the exact recipe name before it fires', async () => {
  const mount = new FakeElement('main');
  const calls = [];
  const popup = new RecipePopup(mount, createApi(), '', 'large', null, {}, {
    onDelete: recipe => calls.push(['delete', recipe.id]),
  });
  popup._dialog.showModal();
  popup._populate(createRecipe());

  popup._onDeleteClick();

  const confirmDialog = mount.querySelector('.metro-confirm');
  assert.ok(confirmDialog, 'confirm dialog is mounted');
  const input = confirmDialog.querySelector('.metro-confirm__input');
  const deleteButton = confirmDialog.querySelectorAll('.metro-btn--danger').at(-1);
  assert.equal(deleteButton.disabled, true);

  // Wrong name keeps the button disabled and does not delete.
  input.value = 'Falsch';
  input.dispatchEvent({ type: 'input', target: input });
  assert.equal(deleteButton.disabled, true);
  deleteButton.dispatchEvent({ type: 'click', target: deleteButton });
  assert.deepEqual(calls, []);

  // Exact name enables the button and deletes on click.
  input.value = 'Tomatensuppe';
  input.dispatchEvent({ type: 'input', target: input });
  assert.equal(deleteButton.disabled, false);
  deleteButton.dispatchEvent({ type: 'click', target: deleteButton });
  await Promise.resolve();

  assert.deepEqual(calls, [['delete', 42]]);
  assert.equal(popup.isOpen, false);
});

// ---------------------------------------------------------------------------
// open() — happy path and load error (pinned so the stale guards below can
// never swallow a legitimate response or error)
// ---------------------------------------------------------------------------

test('open() fetches, populates and shows the dialog for the requested recipe', async () => {
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, {
    imageUrl: (id) => `/local/recipe-${id}.jpg`,
    updateRecipeMeta: async () => ({}),
    getRecipe: async () => createRecipe({ id: 7, name: 'Gulasch' }),
  });

  await popup.open(7);

  assert.equal(popup.isOpen, true);
  assert.equal(popup._els.titleEl.textContent, 'Gulasch');
  assert.equal(popup._currentRecipe.id, 7);
});

test('open() shows the accessible load error state when the detail fetch fails', async () => {
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, {
    imageUrl: (id) => `/local/recipe-${id}.jpg`,
    updateRecipeMeta: async () => ({}),
    getRecipe: async () => { throw new Error('Detail fehlgeschlagen'); },
  });

  await popup.open(9);

  assert.equal(popup.isOpen, true);
  assert.equal(popup._els.titleEl.textContent, 'Error');
  const alert = popup._els.ingredientsPanel.querySelector('.metro-error');
  assert.ok(alert, 'error state is rendered');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent, /Detail fehlgeschlagen/);
});

// ---------------------------------------------------------------------------
// open() — stale async protection: only the newest open request may populate
// or error; close and destroy invalidate in-flight requests
// ---------------------------------------------------------------------------

test('a slower earlier open() never overwrites the recipe of a newer open()', async () => {
  const { api, resolveDetail } = createDeferredDetailApi();
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, api);

  const openingA = popup.open('a');
  const openingB = popup.open('b');

  resolveDetail('b', createRecipe({ id: 'b', name: 'Neu' }));
  await openingB;
  await flush();
  assert.equal(popup._els.titleEl.textContent, 'Neu');

  resolveDetail('a', createRecipe({ id: 'a', name: 'Alt' }));
  await openingA;
  await flush();

  assert.equal(popup._els.titleEl.textContent, 'Neu');
  assert.equal(popup._currentRecipe.id, 'b');
});

test('a stale open() rejection never shows the error state over a newer open()', async () => {
  const { api, resolveDetail, rejectDetail } = createDeferredDetailApi();
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, api);

  const openingA = popup.open('a');
  const openingB = popup.open('b');

  resolveDetail('b', createRecipe({ id: 'b', name: 'Neu' }));
  await openingB;
  await flush();

  rejectDetail('a', new Error('zu langsam'));
  await openingA;
  await flush();

  assert.equal(popup._els.titleEl.textContent, 'Neu');
  assert.equal(popup._els.ingredientsPanel.querySelectorAll('.metro-error').length, 0);
});

test('close() invalidates in-flight open() requests', async () => {
  const { api, resolveDetail } = createDeferredDetailApi();
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, api);

  const openingA = popup.open('a');
  popup.close();
  resolveDetail('a', createRecipe({ id: 'a', name: 'Spät' }));
  await openingA;
  await flush();

  assert.equal(popup.isOpen, false);
  assert.equal(popup._els.titleEl.textContent, 'Loading recipe…');
  assert.equal(popup._currentRecipe, null);
});

test('destroy() invalidates in-flight open() requests without populating or throwing', async () => {
  const { api, resolveDetail } = createDeferredDetailApi();
  const mount = new FakeElement('main');
  const popup = new RecipePopup(mount, api);

  const openingA = popup.open('a');
  popup.destroy();
  resolveDetail('a', createRecipe({ id: 'a', name: 'Spät' }));
  await openingA;
  await flush();

  assert.equal(popup._els.titleEl.textContent, 'Loading recipe…');
  assert.equal(popup._currentRecipe, null);
  assert.equal(mount.querySelector('dialog'), null, 'dialog detached from the mount');
});
