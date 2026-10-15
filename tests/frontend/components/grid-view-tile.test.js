/**
 * Characterization baseline for feature-09: Random Recipe Card.
 *
 * Feature-09 will extract/reuse the GridView tile rendering for the random
 * card ("existing cookbook visual language", R7). These tests pin the CURRENT
 * GridView tile behavior so the extraction cannot silently change it. They
 * are a baseline: they pass against today's grid-view.js and must stay green
 * through the feature-09 implementation.
 *
 * Run with: node --test components/grid-view-tile.test.js
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GridView } from '../../../custom_components/cookbook/frontend/components/grid-view.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

// Fake DOM matching the conventions of grid-view.test.js (toolbar selectors
// are served from a cache because toolbar markup is set via innerHTML).
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

const STUBS = [
  { id: '1', name: 'Suppe',     recipeCategory: 'Suppe',       keywords: 'schnell', image_mtime: 'mtime1' },
  { id: '2', name: 'Curry',     recipeCategory: 'Hauptgericht', keywords: 'vegan', dateModified: 'mod2' },
  { id: '3', name: 'Nachtisch', recipeCategory: '',             keywords: '' },
  { id: '4', name: 'Kuchen',    recipeCategory: 'Dessert',      keywords: 'süß', image_mtime: 'mtime4', dateModified: 'mod4' },
];

function createApi() {
  const imageCalls = [];
  const api = {
    getRecipes: async () => [],
    getCategories: async () => [],
    refreshData: async () => ({ recipes: [], categories: [] }),
    imageUrl: (id, version) => {
      imageCalls.push([String(id), version]);
      return `/img/${id}?v=${version}`;
    },
  };
  return { api, imageCalls };
}

function createView() {
  const { api, imageCalls } = createApi();
  const container = new FakeElement('main');
  const view = new GridView(container, api, () => {}, '', 30, undefined, {
    i18n: createI18n({ locale: 'de' }),
  });
  return { container, view, imageCalls };
}

function renderTiles(view, stubs) {
  view._recipes = stubs;
  view._filtered = stubs;
  view._renderTiles();
}

beforeEach(() => {
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
});

afterEach(() => {
  delete globalThis.document;
});

test('tile structure: role, tabindex, aria-label, image, placeholder, overlay', () => {
  const { container, view } = createView();
  renderTiles(view, [STUBS[0]]);
  const tile = view._grid.children[0];

  assert.equal(tile.className, 'metro-tile metro-tile--color-1');
  assert.equal(tile.getAttribute('role'), 'button');
  assert.equal(tile.getAttribute('tabindex'), '0');
  assert.equal(tile.getAttribute('aria-label'), 'Suppe');

  const [img, placeholder, overlay] = tile.children;
  assert.equal(img.className, 'metro-tile__img');
  assert.equal(img.alt, 'Suppe');
  assert.equal(img.src, '/img/1?v=mtime1');
  assert.equal(placeholder.className, 'metro-tile__placeholder');
  assert.equal(placeholder.textContent, '🍽️');
  assert.equal(overlay.className, 'metro-tile__overlay');
  assert.equal(overlay.children[0].className, 'metro-tile__name');
  assert.equal(overlay.children[0].textContent, 'Suppe');
  assert.equal(overlay.children[1].className, 'metro-tile__category');
  assert.equal(overlay.children[1].textContent, 'Suppe');
});

test('tile image src prefers image_mtime over dateModified and falls back to empty', () => {
  const { view, imageCalls } = createView();
  renderTiles(view, STUBS);

  assert.deepEqual(imageCalls, [
    ['1', 'mtime1'],
    ['2', 'mod2'],
    ['3', ''],
    ['4', 'mtime4'],
  ]);
  assert.equal(view._grid.children[0].children[0].src, '/img/1?v=mtime1');
  assert.equal(view._grid.children[1].children[0].src, '/img/2?v=mod2');
  assert.equal(view._grid.children[2].children[0].src, '/img/3?v=');
  assert.equal(view._grid.children[3].children[0].src, '/img/4?v=mtime4');
});

test('tile category color classes are deterministic per category', () => {
  const { view } = createView();
  renderTiles(view, STUBS);

  assert.equal(view._grid.children[0].className, 'metro-tile metro-tile--color-1');
  assert.equal(view._grid.children[1].className, 'metro-tile metro-tile--color-2');
  assert.equal(view._grid.children[2].className, 'metro-tile metro-tile--color-0');
  assert.equal(view._grid.children[3].className, 'metro-tile metro-tile--color-8');
});

test('tile activation fires on click and on Enter/Space keys, not on other keys', () => {
  const opened = [];
  const { api } = createApi();
  const container = new FakeElement('main');
  const view = new GridView(container, api, (id) => opened.push(id), '', 30, undefined, {
    i18n: createI18n({ locale: 'de' }),
  });
  renderTiles(view, [STUBS[0]]);
  const tile = view._grid.children[0];

  tile._listeners.get('click')({ type: 'click' });
  let prevented = false;
  tile._listeners.get('keydown')({ key: 'Enter', preventDefault: () => { prevented = true; } });
  tile._listeners.get('keydown')({ key: ' ', preventDefault: () => {} });
  tile._listeners.get('keydown')({ key: 'Tab', preventDefault: () => {} });

  assert.deepEqual(opened, ['1', '1', '1']);
  assert.equal(prevented, true);
});

test('tile shows the NEU badge only for recipes in the new-id set', () => {
  const { view } = createView();
  renderTiles(view, STUBS);
  view._newIds = new Set(['1']);
  view._renderTiles();

  const badge = view._grid.children[0].querySelector('.metro-tile__new-badge');
  assert.ok(badge);
  assert.equal(badge.textContent, 'NEU');
  assert.equal(view._grid.children[1].querySelector('.metro-tile__new-badge'), null);
});

test('empty filtered view renders the metro empty state', () => {
  const { view } = createView();
  view._recipes = STUBS;
  view._filtered = [];
  view._renderTiles();

  const empty = view._grid.children[0];
  assert.equal(empty.className, 'metro-empty');
  assert.equal(empty.textContent, 'Keine Rezepte gefunden');
});
