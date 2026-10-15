/**
 * Component tests for WeeklyCalendarView (feature-10).
 *
 * A lightweight FakeElement DOM (same approach as grid-view.test.js) drives the
 * view without a real browser. These tests cover the critical seams:
 *   - render a week from a plan document
 *   - week navigation (prev/next/today) via injected "today"
 *   - add-recipe dialog: immediate save per click, dialog stays open
 *   - pencil opens the planning editor (separate from the recipe click)
 *   - delete requires confirmation
 *   - missing recipe renders as "unavailable" and never opens the popup
 *
 * Run with: node --test www/cookbook-card/components/weekly-calendar-view.test.js
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { WeeklyCalendarView } from '../../../custom_components/cookbook/frontend/components/weekly-calendar-view.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...v) { v.forEach(x => this.values.add(x)); }
  remove(...v) { v.forEach(x => this.values.delete(x)); }
  contains(v) { return this.values.has(v); }
  toggle(v, force) {
    if (force === undefined ? !this.values.has(v) : force) this.values.add(v);
    else this.values.delete(v);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.classList = new FakeClassList();
    this._listeners = new Map();
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this._attrs = {};
    this._textContent = '';
  }
  set className(v) { this._className = String(v); }
  get className() { return this._className ?? ''; }
  set innerHTML(v) { this.children = []; this._innerHTML = String(v); }
  get innerHTML() {
    if (this.children.length === 0) return this._innerHTML ?? '';
    return this.children.map(c => c.outerHTML).join('');
  }
  set textContent(v) { this._textContent = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._textContent ?? '';
  }
  get outerHTML() {
    const cls = this.className ? ` class="${this.className}"` : '';
    return `<${this.tagName}${cls}>${this.textContent}${this.children.map(c => c.outerHTML).join('')}</${this.tagName}>`;
  }
  setAttribute(n, v) { this._attrs[n] = String(v); }
  getAttribute(n) { return this._attrs[n] ?? null; }
  removeAttribute(n) { delete this._attrs[n]; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  prepend(c) { this.children.unshift(c); c.parentNode = this; return c; }
  remove() {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children.splice(i, 1);
  }
  addEventListener(type, fn) { this._listeners.set(type, fn); }
  dispatch(type, event = {}) {
    const fn = this._listeners.get(type);
    if (fn) fn({ preventDefault() {}, stopPropagation() {}, ...event });
  }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  _walk(pred, out) {
    this.children.forEach(c => { if (pred(c)) out.push(c); c._walk(pred, out); });
    return out;
  }
  querySelectorAll(selector) {
    const cls = selector.replace(/^\./, '');
    return this._walk(c => (c.className || '').split(' ').includes(cls), []);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  findByText(text) {
    return this._walk(() => true, []).filter(c => c.textContent.includes(text));
  }
  findByAria(label) {
    return this._walk(c => c.getAttribute('aria-label') === label, []);
  }
}

function createApi(overrides = {}) {
  return {
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [],
    }),
    getRecipes: async () => [
      { id: '1', name: 'Tomatensuppe', recipeCategory: 'Suppe', keywords: '' },
      { id: '2', name: 'Lasagne', recipeCategory: 'Pasta', keywords: '' },
    ],
    addMealPlanEntry: async () => ({ id: 'e1', date: '2026-08-31', slot_id: 'meal', recipe_id: '1' }),
    updateMealPlanEntry: async () => ({ id: 'e1', date: '2026-09-01', slot_id: 'meal', recipe_id: '1' }),
    deleteMealPlanEntry: async () => true,
    saveMealPlanSlots: async (s) => ({ version: 1, slots: s, entries: [] }),
    imageUrl: id => `/local/${id}.jpg`,
    ...overrides,
  };
}

function createView(container, api, opts = {}) {
  return new WeeklyCalendarView(container, api, {
    onOpenRecipe: opts.onOpenRecipe ?? (() => {}),
    today: opts.today ?? '2026-09-02', // a Wednesday
    weekStart: opts.weekStart ?? 'monday',
    locale: opts.locale ?? 'de',
    i18n: opts.i18n ?? createI18n({ locale: opts.locale ?? 'de' }),
    placeholderUrl: '',
    ...opts,
  });
}

beforeEach(() => {
  globalThis.document = {
    createElement: t => new FakeElement(t),
    activeElement: null,
  };
});
afterEach(() => { delete globalThis.document; });

test('updates calendar labels and date formatting when the locale changes', async () => {
  const container = new FakeElement('main');
  const api = createApi();
  const view = createView(container, api, { i18n: createI18n({ locale: 'en' }) });
  await view.load();
  assert.match(container.innerHTML, /Weekly plan/);
  assert.equal(container.querySelector('.cal-today').textContent, 'Today');

  view.setI18n(createI18n({ locale: 'de' }));

  assert.match(container.innerHTML, /Wochenplan/);
  assert.equal(container.querySelector('.cal-today').textContent, 'Heute');
});

test('renders seven day sections for the current week', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi());
  await view.load();
  const days = container.querySelectorAll('cal-day');
  assert.equal(days.length, 7);
});

test('shows planned recipes grouped in their day and slot', async () => {
  const container = new FakeElement('main');
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '1' }],
    }),
  });
  const view = createView(container, api);
  await view.load();
  assert.ok(container.findByText('Tomatensuppe').length >= 1);
});

test('empty slots are not rendered; each day has exactly one add button', async () => {
  const container = new FakeElement('main');
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [
        { id: 'meal', kind: 'builtin', enabled: true },
        { id: 'breakfast', kind: 'builtin', enabled: true },
        { id: 'dinner', kind: 'builtin', enabled: true },
      ],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'dinner', recipe_id: '1' }],
    }),
  });
  const view = createView(container, api);
  await view.load();
  // Only the "dinner" slot (which has an entry) is rendered, once.
  const slotLabels = container.querySelectorAll('cal-slot__label').map(n => n.textContent);
  assert.deepEqual(slotLabels, ['Abendessen']);
  // Exactly 7 add buttons (one per day), all day-level.
  const adds = container.querySelectorAll('cal-add');
  assert.equal(adds.length, 7);
  assert.equal(container.querySelectorAll('cal-add--day').length, 7);
});

test('day-level add opens the dialog defaulting to the first active slot', async () => {
  const container = new FakeElement('main');
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [
        { id: 'meal', kind: 'builtin', enabled: true },
        { id: 'dinner', kind: 'builtin', enabled: true },
      ],
      entries: [],
    }),
  });
  const view = createView(container, api);
  await view.load();
  await view.openAddDialog('2026-08-31');
  assert.equal(view.isAddDialogOpen(), true);
  assert.equal(view.getAddSlot(), 'meal'); // first active slot
});

test('add dialog shows a slot dropdown only when more than one slot is active', async () => {
  const container = new FakeElement('main');
  const twoSlots = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [
        { id: 'meal', kind: 'builtin', enabled: true },
        { id: 'dinner', kind: 'builtin', enabled: true },
      ],
      entries: [],
    }),
  });
  const view = createView(container, twoSlots);
  await view.load();
  await view.openAddDialog('2026-08-31');
  assert.ok(container.querySelector('cal-add-dialog__slot'), 'dropdown shown with 2 active slots');
  view.setAddSlot('dinner');
  assert.equal(view.getAddSlot(), 'dinner');
});

test('add dialog hides the slot dropdown when only one slot is active', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi());
  await view.load();
  await view.openAddDialog('2026-08-31');
  assert.equal(container.querySelector('cal-add-dialog__slot'), null);
});

test('next/previous week navigation changes the visible range', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi());
  await view.load();
  const before = view.getWeekStart();
  await view.goToNextWeek();
  assert.notEqual(view.getWeekStart(), before);
  await view.goToPreviousWeek();
  assert.equal(view.getWeekStart(), before);
});

test('today control returns to the week containing HA today', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi(), { today: '2026-09-02' });
  await view.load();
  await view.goToNextWeek();
  await view.goToToday();
  assert.equal(view.getWeekStart(), '2026-08-31');
});

test('adding a recipe saves immediately and keeps the dialog open', async () => {
  const container = new FakeElement('main');
  let added = 0;
  const api = createApi({
    addMealPlanEntry: async ({ recipeId }) => {
      added += 1;
      return { id: `e${added}`, date: '2026-08-31', slot_id: 'meal', recipe_id: recipeId };
    },
  });
  const view = createView(container, api);
  await view.load();

  await view.openAddDialog('2026-08-31', 'meal');
  await view.selectRecipeForAdd('1');
  await view.selectRecipeForAdd('2');

  assert.equal(added, 2);
  assert.equal(view.isAddDialogOpen(), true);
});

test('the same recipe can be added twice to the same day and slot', async () => {
  const container = new FakeElement('main');
  const calls = [];
  const api = createApi({
    addMealPlanEntry: async (payload) => {
      calls.push(payload);
      return { id: `e${calls.length}`, ...payload };
    },
  });
  const view = createView(container, api);
  await view.load();
  await view.openAddDialog('2026-08-31', 'meal');
  await view.selectRecipeForAdd('1');
  await view.selectRecipeForAdd('1');
  assert.equal(calls.length, 2);
});

test('clicking a planned recipe opens the recipe popup', async () => {
  const container = new FakeElement('main');
  const opened = [];
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '1' }],
    }),
  });
  const view = createView(container, api, { onOpenRecipe: id => opened.push(id) });
  await view.load();
  view.activateEntryRecipe('e1');
  assert.deepEqual(opened, ['1']);
});

test('deleting an entry requires confirmation before calling the service', async () => {
  const container = new FakeElement('main');
  let deleted = 0;
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '1' }],
    }),
    deleteMealPlanEntry: async () => { deleted += 1; return true; },
  });
  const view = createView(container, api);
  await view.load();

  view.openPlanningEditor('e1');
  await view.requestDeleteEntry();      // shows confirm, does not delete yet
  assert.equal(deleted, 0);
  await view.confirmDeleteEntry();       // confirmed -> deletes
  assert.equal(deleted, 1);
});

test('a deleted recipe renders as unavailable and does not open the popup', async () => {
  const container = new FakeElement('main');
  const opened = [];
  const api = createApi({
    getRecipes: async () => [{ id: '2', name: 'Lasagne', recipeCategory: '', keywords: '' }],
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '999' }],
    }),
  });
  const view = createView(container, api, { onOpenRecipe: id => opened.push(id) });
  await view.load();
  assert.ok(container.findByText('Rezept nicht verfügbar').length >= 1);
  view.activateEntryRecipe('e1');
  assert.deepEqual(opened, []);
});

test('a free-text entry (no recipe) renders its text and does not open the popup', async () => {
  const container = new FakeElement('main');
  const opened = [];
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '', text: 'Pizza bestellen' }],
    }),
  });
  const view = createView(container, api, { onOpenRecipe: id => opened.push(id) });
  await view.load();
  assert.ok(container.findByText('Pizza bestellen').length >= 1);
  view.activateEntryRecipe('e1');
  assert.deepEqual(opened, []);
});

test('a recipe entry shows its optional note text', async () => {
  const container = new FakeElement('main');
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '1', text: 'Florian muss einkaufen' }],
    }),
  });
  const view = createView(container, api);
  await view.load();
  assert.ok(container.findByText('Florian muss einkaufen').length >= 1);
});

test('addTextForAdd saves a free-text entry to the current target', async () => {
  const container = new FakeElement('main');
  const calls = [];
  const api = createApi({
    addMealPlanEntry: async (payload) => { calls.push(payload); return { id: 'e1', ...payload }; },
  });
  const view = createView(container, api);
  await view.load();
  await view.openAddDialog('2026-08-31', 'meal');
  await view.addTextForAdd('Pizza bestellen');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'Pizza bestellen');
  assert.equal(calls[0].recipeId, undefined);
  assert.equal(view.isAddDialogOpen(), true);
});

test('the add dialog exposes an add-as-text control reflecting the query', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi());
  await view.load();
  await view.openAddDialog('2026-08-31', 'meal');
  const addText = container.querySelector('cal-add-dialog__text');
  assert.ok(addText, 'expected an add-as-text control in the dialog');
});

test('load failure renders an accessible error with retry', async () => {
  const container = new FakeElement('main');
  const api = createApi({ getMealPlan: async () => { throw new Error('plan down'); } });
  const view = createView(container, api);
  await view.load();
  const alert = container.querySelector('metro-error');
  assert.ok(alert);
  assert.equal(alert.getAttribute('role'), 'alert');
});

test('image-grid layout renders the body with the grid class', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi(), { desktopLayout: 'image-grid' });
  await view.load();
  assert.ok(container.querySelector('cal-body--image-grid'), 'expected image-grid body class');
});

test('image-grid renders a recipe entry as an image tile with an image', async () => {
  const container = new FakeElement('main');
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '1' }],
    }),
  });
  const view = createView(container, api, { desktopLayout: 'image-grid' });
  await view.load();
  const tile = container.querySelector('cal-tile--image');
  assert.ok(tile, 'expected an image tile');
  assert.ok(tile.querySelector('cal-tile__img'), 'image tile contains an image');
});

test('image-grid renders a free-text entry as a text card without an image', async () => {
  const container = new FakeElement('main');
  const api = createApi({
    getMealPlan: async () => ({
      version: 1,
      slots: [{ id: 'meal', kind: 'builtin', enabled: true }],
      entries: [{ id: 'e1', date: '2026-09-02', slot_id: 'meal', recipe_id: '', text: 'Order pizza' }],
    }),
  });
  const view = createView(container, api, { desktopLayout: 'image-grid' });
  await view.load();
  const card = container.querySelector('cal-tile--text');
  assert.ok(card, 'expected a text card');
  assert.equal(card.querySelector('cal-tile__img'), null, 'text card has no image');
  assert.ok(card.textContent.includes('Order pizza'));
});

test('vertical layout does not get the image-grid body class', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi(), { desktopLayout: 'vertical' });
  await view.load();
  assert.equal(container.querySelector('cal-body--image-grid'), null);
});

test('frameless option adds the cal--frameless class to the root', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi(), { frameless: true });
  await view.load();
  assert.ok(container.querySelector('cal--frameless'), 'expected cal--frameless root class');
});

test('default (framed) layout does not add the frameless class', async () => {
  const container = new FakeElement('main');
  const view = createView(container, createApi());
  await view.load();
  assert.equal(container.querySelector('cal--frameless'), null);
});

test('destroy clears any running refresh timer', async () => {
  const container = new FakeElement('main');
  let cleared = false;
  const view = createView(container, createApi(), {
    refreshMs: 1000,
    schedule: (ms, cb) => { void ms; void cb; return () => { cleared = true; }; },
  });
  await view.load();
  view.destroy();
  assert.equal(cleared, true);
});
