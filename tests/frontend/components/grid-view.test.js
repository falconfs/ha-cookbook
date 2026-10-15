import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GridView } from '../../../custom_components/cookbook/frontend/components/grid-view.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.classList = new FakeClassList();
    this._innerHTML = '';
    this._listeners = new Map();
    this._queryCache = new Map();
    this.style = { setProperty() {} };
  }

  set innerHTML(value) { this.children = []; this._innerHTML = String(value); }
  get innerHTML() {
    if (this.children.length === 0) return this._innerHTML;
    return this.children.map((child) => child.outerHTML ?? '').join('');
  }
  set textContent(value) { this._textContent = String(value); }
  get textContent() { return this._textContent ?? ''; }
  get outerHTML() {
    const className = this.className ? ` class="${this.className}"` : '';
    return `<${this.tagName}${className}>${this.textContent}${this.innerHTML}</${this.tagName}>`;
  }
  remove() {
    const index = this.parentNode?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parentNode.children.splice(index, 1);
  }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  addEventListener(type, listener) { this._listeners.set(type, listener); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    if (['.metro-search', '.metro-btn--add', '.metro-btn--refresh', '.metro-select--sort'].includes(selector)) {
      if (!this._queryCache.has(selector)) this._queryCache.set(selector, [new FakeElement('input')]);
      return this._queryCache.get(selector);
    }
    if (selector === '.metro-select') {
      if (!this._queryCache.has(selector)) this._queryCache.set(selector, [new FakeElement('select'), new FakeElement('select')]);
      return this._queryCache.get(selector);
    }
    const matches = [];
    const visit = element => {
      element.children.forEach(child => {
        if (selector.startsWith('.') && child.className?.split(' ').includes(selector.slice(1))) matches.push(child);
        visit(child);
      });
    };
    visit(this);
    return matches;
  }
}

function createApi(overrides = {}) {
  return {
    getRecipes: async () => [],
    getCategories: async () => [],
    refreshData: async () => ({ recipes: [], categories: [] }),
    imageUrl: id => `/local/${id}.jpg`,
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
});

afterEach(() => {
  delete globalThis.document;
});

test('renders toolbar labels and empty state in the selected language', () => {
  const container = new FakeElement('main');
  const view = new GridView(container, createApi(), () => {}, '', 30, undefined, {
    i18n: createI18n({ locale: 'en' }),
  });
  view._filtered = [];
  view._renderTiles();

  assert.match(view._toolbar.innerHTML, /Cookbook/);
  assert.match(view._toolbar.innerHTML, /Search recipes/);
  assert.match(view._toolbar.innerHTML, /Add recipe/);
  assert.equal(view._grid.children[0].textContent, 'No recipes found');
});

test('updates labels, counts and sort without refetching when the locale changes', () => {
  const container = new FakeElement('main');
  const api = createApi();
  const view = new GridView(container, api, () => {}, '', 30, undefined, {
    i18n: createI18n({ locale: 'en' }),
  });
  view._recipes = [{ id: '1', name: 'Soup' }];
  view._filtered = view._recipes;
  view._updateCount();

  view.setI18n(createI18n({ locale: 'de' }));

  assert.equal(view._countEl.textContent, '1 von 1 Rezepten');
  assert.match(view._toolbar.innerHTML, /Rezept suchen/);
  assert.equal(view._grid.children.length, 1);
});

test('shows a visible error when the initial list load fails', async () => {
  const container = new FakeElement('main');
  const view = new GridView(container, createApi({
    getRecipes: async () => { throw new Error('initial list unavailable'); },
  }), () => {});

  await view.loadFromCache();

  assert.equal(view._errorEl.getAttribute('role'), 'alert');
  assert.match(view._errorEl.textContent, /initial list unavailable/);
});

test('shows a visible error when background revalidation fails', async () => {
  const container = new FakeElement('main');
  const view = new GridView(container, createApi({
    refreshData: async () => { throw new Error('background sync unavailable'); },
  }), () => {});
  view._recipes = [{ id: '42', name: 'Suppe', recipeCategory: '', keywords: '' }];
  view._filtered = view._recipes;
  view._renderTiles();

  await view.revalidate();

  assert.equal(view._errorEl.getAttribute('role'), 'alert');
  assert.match(view._errorEl.textContent, /background sync unavailable/);
  assert.match(view._grid.innerHTML, /Suppe/);
});

test('shows manual refresh failure without throwing and keeps stale tiles', async () => {
  const container = new FakeElement('main');
  const view = new GridView(container, createApi({
    refreshData: async () => { throw new Error('manual refresh unavailable'); },
    triggerImageSync: async () => {},
  }), () => {});
  view._recipes = [{ id: '42', name: 'Suppe', recipeCategory: '', keywords: '' }];
  view._filtered = view._recipes;
  view._renderTiles();

  await view.refresh();

  assert.equal(view._errorEl.getAttribute('role'), 'alert');
  assert.match(view._errorEl.textContent, /manual refresh unavailable/);
  assert.match(view._grid.innerHTML, /Suppe/);
});

test('clears a visible error after a later revalidation succeeds', async () => {
  const container = new FakeElement('main');
  let recovered = false;
  const view = new GridView(container, createApi({
    refreshData: async () => {
      if (!recovered) throw new Error('temporary sync failure');
      return { recipes: [{ id: '42', name: 'Suppe', recipeCategory: '', keywords: '' }], categories: [] };
    },
  }), () => {});

  await view.revalidate();
  assert.equal(view._errorEl.getAttribute('role'), 'alert');
  recovered = true;
  await view.revalidate();

  assert.doesNotMatch(view._grid.innerHTML, /metro-error/);
  assert.equal(view._countEl.textContent, '1 of 1 recipes');
});

test('searches recipe ids as well as recipe metadata', () => {
  const container = new FakeElement('main');
  const view = new GridView(container, createApi(), () => {});
  view._recipes = [
    { id: '1852', name: 'Suppe', recipeCategory: 'Dinner', keywords: '' },
    { id: '224', name: 'Salat', recipeCategory: 'Lunch', keywords: '' },
  ];
  view._searchValue = '1852';

  view._applyFilter();

  assert.deepEqual(view._filtered.map(recipe => recipe.id), ['1852']);
});

test('add toolbar action fires and tiles only open the recipe (no tile-local edit/delete)', () => {
  const calls = [];
  const container = new FakeElement('main');
  const view = new GridView(container, createApi(),
    id => calls.push(['open', id]), '', 30, undefined, {
      onAdd: () => calls.push(['add']),
    });
  const add = view._toolbar.querySelector('.metro-btn--add');
  add._listeners.get('click')({ type: 'click' });
  view._recipes = [{ id: '42', name: 'Suppe', recipeCategory: '', keywords: '' }];
  view._filtered = view._recipes;
  view._renderTiles();
  const tile = view._grid.children[0];

  assert.equal(tile.querySelector('.metro-tile__edit'), null);
  assert.equal(tile.querySelector('.metro-tile__delete'), null);

  tile._listeners.get('click')({ type: 'click' });
  assert.deepEqual(calls, [['add'], ['open', '42']]);
});
