/**
 * RED tests (TDD) for feature-09: Random Recipe Card — component/lifecycle
 * seams.
 *
 * These tests define the contract for `components/random-recipe-view.js`,
 * which does not exist yet. They must fail until the implementation phase
 * creates it. Pinned contract:
 *
 *   new RandomRecipeView(container, api, onOpenRecipe, placeholderUrl, options)
 *
 *     options.durationMs  rotation duration in milliseconds (the card parses
 *                         the HA duration config via services/random-logic.js)
 *     options.category    optional category filter for the random pool
 *     options.tags        optional tag filter (string or array) for the pool
 *     options.random      injectable random source, () => [0, 1) like
 *                         Math.random, so selections are deterministic in tests
 *     options.schedule    injectable one-shot scheduler:
 *                         schedule(delayMs, callback) => cancel function
 *
 *   await view.load()     fetch stubs via api.getRecipes(), filter the pool,
 *                         render one random recipe immediately, arm rotation
 *   view.pause()          stop the rotation timer (popup opened)
 *   view.resume()         re-arm the rotation with the full duration
 *   view.destroy()        stop the timer, tear down the rendered DOM,
 *                         ignore late callbacks; idempotent
 *
 * The displayed recipe reuses the existing tile language: a `.metro-tile`
 * with `.metro-tile__name`, `.metro-tile__category`, `.metro-tile__img`
 * (src from `api.imageUrl(id, ...)`), role="button" and an aria-label; a
 * `.metro-btn--next` button triggers the manual next selection; empty pools
 * render a `.metro-empty` state with role="status"; load failures render a
 * `.metro-error` state with role="alert".
 *
 * Run with: node --test components/random-recipe-view.test.js
 *
 * ---------------------------------------------------------------------------
 * E2E guiding scenario (documented here, NOT runnable as a test)
 * ---------------------------------------------------------------------------
 * The repo has no Playwright test runner (devDependencies are tsx, typescript,
 * zod, @types/node only) and this task must not add dependencies, so the
 * failing E2E guiding test for the critical display/rotation flow is recorded
 * here as an exact scenario for the implementation phase / Playwright MCP:
 *
 * 1. Implementation phase: extend `local-preview.html` with a second mount:
 *      <cookbook-random-card duration="2s"></cookbook-random-card>
 *    (preview-harness change; the card element registers itself as
 *    `custom:cookbook-random-card`.)
 * 2. Start the preview server: `PORT=4173 node local-preview-server.mjs`
 *    (serves real recipe stubs from ../../cookbook_v6 via list_recipes /
 *    get_recipe, images via /api/cookbook/recipes/<id>/image).
 * 3. Navigate to http://localhost:4173 and wait for the random card's shadow
 *    root to contain `.metro-tile .metro-tile__name` with non-empty text.
 *    Assert the FIRST recipe renders without waiting for the interval (R3).
 * 4. Record the title, wait ~2.5s, assert the title changed (R8) and that
 *    across several rotations no title equals the immediately previous one
 *    (R9).
 * 5. Click `.metro-btn--next`; assert the title changes immediately (R11) and
 *    keeps rotating afterwards.
 * 6. Click the `.metro-tile`; assert the recipe popup dialog opens (R12);
 *    wait ~3s and assert the title did NOT change while open (R13); close the
 *    popup, wait ~2.5s, assert the title changed again (rotation resumed).
 * 7. Reload the page; assert a recipe renders and the card wrote no
 *    localStorage/sessionStorage keys (R15, no persisted selection).
 * 8. Assert zero console errors throughout (R17: must not break the
 *    dashboard).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { RandomRecipeView } from '../../../custom_components/cookbook/frontend/components/random-recipe-view.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

// ---------------------------------------------------------------------------
// Fake DOM (same conventions as recipe-popup.test.js)
// ---------------------------------------------------------------------------

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
    this.style = { cssText: '', setProperty() {} };
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

  // Real-DOM model: listeners fire on the target first, then the event
  // bubbles up the parentElement chain unless stopPropagation() is called.
  dispatchEvent(event) {
    const enrichedEvent = {
      ...event,
      target: event.target ?? this,
      _propagationStopped: false,
      stopPropagation() { this._propagationStopped = true; },
    };
    let node = this;
    while (node) {
      (node._listeners.get(enrichedEvent.type) || []).forEach((listener) => listener(enrichedEvent));
      if (enrichedEvent._propagationStopped) break;
      node = node.parentElement;
    }
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }

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

// ---------------------------------------------------------------------------
// Injectable one-shot scheduler (controlled clock for timer tests)
// ---------------------------------------------------------------------------

function createFakeScheduler() {
  const calls = [];
  const live = new Set();

  const schedule = (delayMs, callback) => {
    const entry = { delayMs, callback, cancelled: false };
    calls.push(entry);
    live.add(entry);
    return () => {
      entry.cancelled = true;
      live.delete(entry);
    };
  };

  return {
    schedule,
    calls,
    activeCount: () => live.size,
    activeEntries: () => [...live],
    fire(entry) {
      live.delete(entry);
      entry.callback();
    },
    fireNext() {
      const [entry] = [...live];
      if (!entry) throw new Error('test harness: no active scheduled callback to fire');
      this.fire(entry);
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const RECENT_DATE = new Date().toISOString();

const STUBS = [
  { id: 'a', name: 'Apfelsuppe', recipeCategory: 'Suppe', keywords: 'schnell, vegetarisch', dateCreated: RECENT_DATE, _ha_rating: 4 },
  { id: 'b', name: 'Bolognese', recipeCategory: 'Hauptgericht', keywords: 'fleisch' },
  { id: 'c', name: 'Curry', recipeCategory: 'Hauptgericht', keywords: 'schnell, vegan' },
];

function createApi(overrides = {}) {
  return {
    getRecipes: async () => STUBS,
    imageUrl: (id) => `/img/${id}.jpg`,
    ...overrides,
  };
}

function createView({ api = createApi(), options = {} } = {}) {
  const container = new FakeElement('div');
  const scheduler = createFakeScheduler();
  const opened = [];
  const view = new RandomRecipeView(container, api, (id) => opened.push(id), '', {
    durationMs: 1000,
    random: () => 0,
    schedule: scheduler.schedule,
    i18n: createI18n({ locale: 'de' }),
    ...options,
  });
  return { container, scheduler, opened, view };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let pending microtasks (async selections, re-arming) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const displayedName = (container) => container.querySelector('.metro-tile__name')?.textContent ?? null;

const imageSrc = (img) => img?.src ?? img?.getAttribute('src') ?? null;

beforeEach(() => {
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
});

afterEach(() => {
  delete globalThis.document;
});

// ---------------------------------------------------------------------------
// Initial render (R2, R3, R7)
// ---------------------------------------------------------------------------

test('renders one randomly selected recipe immediately once the pool is available', async () => {
  const { container, scheduler, view } = createView();

  await view.load();
  await flush();

  assert.equal(container.querySelectorAll('.metro-tile__name').length, 1);
  const tile = container.querySelector('.metro-tile');
  assert.equal(tile.getAttribute('role'), 'button');
  assert.equal(tile.getAttribute('aria-label'), 'Apfelsuppe');
  assert.equal(displayedName(container), 'Apfelsuppe');
  assert.equal(tile.querySelector('.metro-tile__category').textContent, 'Suppe');
  assert.equal(tile.querySelector('.metro-tile__rating').textContent, 'Bewertung: 4');
  assert.ok(tile.querySelector('.metro-tile__new-badge'), 'new recipes show the NEU badge');
  assert.equal(imageSrc(tile.querySelector('.metro-tile__img')), '/img/a.jpg');

  assert.equal(scheduler.activeCount(), 1);
  assert.equal(scheduler.calls[0].delayMs, 1000);
});

test('updates random-card labels and badge when the UI language changes', async () => {
  const { container, view } = createView({ options: { i18n: createI18n({ locale: 'en' }) } });
  await view.load();
  await flush();

  assert.equal(container.querySelector('.metro-tile__new-badge').textContent, 'NEW');
  assert.equal(container.querySelector('.metro-btn--next').getAttribute('aria-label'), 'Next recipe');

  view.setI18n(createI18n({ locale: 'de' }));

  assert.equal(container.querySelector('.metro-tile__new-badge').textContent, 'NEU');
  assert.equal(container.querySelector('.metro-btn--next').getAttribute('aria-label'), 'Nächstes Rezept');
});

test('renders no recipe and arms no timer while the initial pool load is pending', async () => {
  const recipes = createDeferred();
  const api = createApi({ getRecipes: () => recipes.promise });
  const { container, scheduler, view } = createView({ api });

  const loading = view.load();
  await flush();

  assert.equal(container.querySelector('.metro-tile__name'), null);
  assert.equal(scheduler.activeCount(), 0);

  recipes.resolve(STUBS);
  await loading;
  await flush();

  assert.ok(displayedName(container));
  assert.equal(scheduler.activeCount(), 1);
});

test('applies configured category and tag filters to the random pool', async () => {
  const { container, view } = createView({
    options: { category: 'Hauptgericht', tags: 'schnell' },
  });

  await view.load();
  await flush();

  // Only 'Curry' is a Hauptgericht with the 'schnell' tag.
  assert.equal(displayedName(container), 'Curry');
});

// ---------------------------------------------------------------------------
// Manual next control (R11)
// ---------------------------------------------------------------------------

test('next control selects another recipe immediately and restarts the rotation duration', async () => {
  const { container, scheduler, view } = createView();
  await view.load();
  await flush();
  assert.equal(displayedName(container), 'Apfelsuppe');

  const nextButton = container.querySelector('.metro-btn--next');
  assert.ok(nextButton, 'next control is rendered');
  assert.equal(nextButton.tagName, 'BUTTON');
  assert.ok(nextButton.getAttribute('aria-label'), 'next control has an accessible name');

  nextButton.click();
  await flush();

  // Deterministic random () => 0 with previous 'a' leaves [b, c] -> 'b'.
  assert.equal(displayedName(container), 'Bolognese');
  assert.equal(scheduler.calls.length, 2);
  assert.equal(scheduler.calls[0].cancelled, true);
  assert.equal(scheduler.activeCount(), 1);
  assert.equal(scheduler.calls[1].delayMs, 1000);
});

test('next control click stays private to the button and never opens the recipe popup', async () => {
  // The button overlays the tile and the click bubbles through the view
  // container up to the card. Any delegated ancestor handler (a future
  // tile-delegation or card-level click handler) would open the recipe
  // popup for the CURRENT recipe on every next click. Model that ancestor
  // here: if the click escapes the button, this listener fires.
  const { container, opened, view } = createView();
  container.addEventListener('click', () => opened.push('ancestor-open'));

  await view.load();
  await flush();
  assert.equal(displayedName(container), 'Apfelsuppe');

  container.querySelector('.metro-btn--next').click();
  await flush();

  // Rotation happened …
  assert.equal(displayedName(container), 'Bolognese');
  // … but no open request was triggered, neither directly nor via an ancestor.
  assert.deepEqual(opened, []);
});

// ---------------------------------------------------------------------------
// Timer-driven rotation (R8, R9) without overlapping schedules
// ---------------------------------------------------------------------------

test('timer fire rotates to another recipe and re-arms exactly one rotation', async () => {
  const { container, scheduler, view } = createView();
  await view.load();
  await flush();
  assert.equal(displayedName(container), 'Apfelsuppe');

  scheduler.fireNext();
  await flush();
  assert.equal(displayedName(container), 'Bolognese');
  assert.equal(scheduler.activeCount(), 1);
  assert.equal(scheduler.calls[1].delayMs, 1000);

  scheduler.fireNext();
  await flush();
  // Previous 'b' leaves [a, c]; deterministic random picks 'a'.
  assert.equal(displayedName(container), 'Apfelsuppe');
  assert.equal(scheduler.activeCount(), 1);
});

test('rotation never shows the same recipe twice in a row across many fires', async () => {
  const values = [0, 0.999, 0.5, 0.34, 0.75, 0.1];
  let index = 0;
  const { container, scheduler, view } = createView({
    options: { random: () => values[index++ % values.length] },
  });
  await view.load();
  await flush();

  let previous = displayedName(container);
  for (let fire = 0; fire < 5; fire++) {
    assert.equal(scheduler.activeCount(), 1);
    scheduler.fireNext();
    await flush();
    const current = displayedName(container);
    assert.notEqual(current, previous);
    previous = current;
  }
});

test('reloading the pool does not stack rotation timers', async () => {
  const { scheduler, view } = createView();
  await view.load();
  await view.load();
  await flush();

  assert.equal(scheduler.activeCount(), 1);
});

// ---------------------------------------------------------------------------
// Popup pause/resume (R13)
// ---------------------------------------------------------------------------

test('pause stops the rotation timer and resume re-arms it with the full duration', async () => {
  const { container, scheduler, view } = createView({
    options: { durationMs: 5000 },
  });
  await view.load();
  await flush();
  const nameBefore = displayedName(container);

  view.pause();
  assert.equal(scheduler.activeCount(), 0);
  assert.equal(scheduler.calls[0].cancelled, true);

  view.resume();
  assert.equal(scheduler.activeCount(), 1);
  assert.equal(scheduler.calls[1].delayMs, 5000);
  assert.equal(displayedName(container), nameBefore);
});

test('a late timer callback while paused does not rotate or re-arm', async () => {
  const { container, scheduler, view } = createView();
  await view.load();
  await flush();
  const nameBefore = displayedName(container);
  const entry = scheduler.activeEntries()[0];

  view.pause();
  scheduler.fire(entry);
  await flush();

  assert.equal(displayedName(container), nameBefore);
  assert.equal(scheduler.activeCount(), 0);
});

// ---------------------------------------------------------------------------
// Stale async protection (technical note: no stale updates on API refresh)
// ---------------------------------------------------------------------------

test('a slower earlier load does not overwrite the result of a newer load', async () => {
  const first = createDeferred();
  const second = createDeferred();
  let call = 0;
  const api = createApi({ getRecipes: () => (call++ === 0 ? first.promise : second.promise) });
  const { container, scheduler, view } = createView({ api });

  const loadingOne = view.load();
  const loadingTwo = view.load();

  second.resolve([{ id: 'n', name: 'Neu', recipeCategory: 'X', keywords: '' }]);
  await loadingTwo;
  await flush();
  assert.equal(displayedName(container), 'Neu');

  first.resolve([{ id: 'o', name: 'Alt', recipeCategory: 'X', keywords: '' }]);
  await loadingOne;
  await flush();

  assert.equal(displayedName(container), 'Neu');
  assert.equal(scheduler.activeCount(), 1);
});

// ---------------------------------------------------------------------------
// Empty and error states (R16, R17)
// ---------------------------------------------------------------------------

test('shows an accessible empty state and starts no rotation when the filtered pool is empty', async () => {
  const { container, scheduler, view } = createView({
    options: { category: 'Dessert' },
  });
  await view.load();
  await flush();

  const empty = container.querySelector('.metro-empty');
  assert.ok(empty, 'empty state is rendered');
  assert.equal(empty.getAttribute('role'), 'status');
  assert.equal(scheduler.calls.length, 0);
});

test('shows an accessible empty state when the API returns no recipes', async () => {
  const api = createApi({ getRecipes: async () => [] });
  const { container, scheduler, view } = createView({ api });
  await view.load();
  await flush();

  const empty = container.querySelector('.metro-empty');
  assert.ok(empty, 'empty state is rendered');
  assert.equal(empty.getAttribute('role'), 'status');
  assert.equal(scheduler.calls.length, 0);
});

test('shows an accessible error state when loading the pool fails', async () => {
  const api = createApi({
    getRecipes: async () => { throw new Error('list unavailable'); },
  });
  const { container, scheduler, view } = createView({ api });

  await view.load();
  await flush();

  const error = container.querySelector('.metro-error');
  assert.ok(error, 'error state is rendered');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(error.textContent, /list unavailable/);
  assert.equal(scheduler.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Popup open seam (R12)
// ---------------------------------------------------------------------------

test('activating the displayed recipe opens the full popup for that recipe', async () => {
  const { container, opened, view } = createView();
  await view.load();
  await flush();

  const tile = container.querySelector('.metro-tile');
  tile.click();
  assert.deepEqual(opened, ['a']);

  tile.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['a', 'a']);
});

// ---------------------------------------------------------------------------
// Disconnect cleanup (R14)
// ---------------------------------------------------------------------------

test('destroy stops the rotation timer, tears down the DOM and ignores late callbacks', async () => {
  const { container, scheduler, view } = createView();
  await view.load();
  await flush();
  const entry = scheduler.activeEntries()[0];

  view.destroy();
  assert.equal(scheduler.activeCount(), 0);
  assert.equal(entry.cancelled, true);
  assert.equal(container.children.length, 0);

  scheduler.fire(entry);
  await flush();
  assert.equal(scheduler.activeCount(), 0);
  assert.equal(container.children.length, 0);

  // Idempotent: HA may call disconnectedCallback more than once.
  view.destroy();
  assert.equal(scheduler.activeCount(), 0);
});
