import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../../custom_components/cookbook/frontend/cookbook-card.js', import.meta.url),
  'utf8',
);

// Source from the random card class to the end of the file. Nearly empty when
// the class is missing, so every random-card contract test below fails loudly
// until the implementation exists.
const randomCardSource = source.slice(source.indexOf('class CookbookRandomCard'));

// ---------------------------------------------------------------------------
// Legacy cleanup — the Nextcloud connection config was removed when the card
// moved to the cookbook custom integration.
// ---------------------------------------------------------------------------

test('does not retain the removed Nextcloud connection configuration', () => {
  [
    'nextcloud_base_url',
    'nc_username_entity',
    'nc_password_entity',
    'nc_url_entity',
    '_resolveNextcloudValue',
  ].forEach((removedIdentifier) => {
    assert.doesNotMatch(source, new RegExp(removedIdentifier), `removed identifier: ${removedIdentifier}`);
  });
});

test('writes editor input values through DOM properties', () => {
  assert.match(source, /input\.value = this\._config\[name\] == null \? '' : String\(this\._config\[name\]\);/);
});

// ---------------------------------------------------------------------------
// Random card (feature-09) — registration and config contract
// ---------------------------------------------------------------------------

test('registers cookbook-random-card idempotently and lists it in window.customCards', () => {
  assert.match(source, /class CookbookRandomCard extends HTMLElement/);
  assert.match(
    source,
    /if \(!customElements\.get\('cookbook-random-card'\)\) \{\s*customElements\.define\('cookbook-random-card', CookbookRandomCard\);\s*\}/,
  );
  assert.match(source, /window\.customCards\.find\(c => c\.type === 'cookbook-random-card'\)/);
});

test('keeps the grid card registration and customCards entry intact', () => {
  assert.match(source, /customElements\.define\('cookbook-card', CookbookCard\);/);
  assert.match(source, /window\.customCards\.find\(c => c\.type === 'cookbook-card'\)/);
});

test('random card stub config defaults the rotation duration and language', () => {
  assert.match(randomCardSource, /static getStubConfig\(\) \{\s*return \{ duration: '4h', language: 'auto' \};\s*\}/);
});

test('random card exposes a visual configuration editor', () => {
  assert.match(randomCardSource, /static getConfigElement\(\) \{\s*return document\.createElement\('cookbook-random-card-editor'\);\s*\}/);
  assert.match(source, /class CookbookRandomCardEditor extends CookbookCardEditor/);
  assert.match(source, /customElements\.define\('cookbook-random-card-editor', CookbookRandomCardEditor\)/);
});

test('random card parses the HA duration config at the card boundary', () => {
  assert.match(randomCardSource, /durationMs: parseRotationDuration\(this\._config\?\.duration\)/);
  assert.match(source, /import \{ parseRotationDuration \} from '\.\/services\/random-logic\.js';/);
  assert.match(source, /import \{ RandomRecipeView \} from '\.\/components\/random-recipe-view\.js';/);
});

test('random card passes category and tag filters to the view', () => {
  assert.match(randomCardSource, /category:\s+this\._config\?\.category \?\? '',/);
  assert.match(randomCardSource, /tags:\s+this\._config\?\.tags \?\? '',/);
});

test('random card preserves the grid tile category color and compact desktop size', async () => {
  const randomViewSource = await readFile(
    new URL(
      '../../custom_components/cookbook/frontend/components/random-recipe-view.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(randomViewSource, /metro-tile--color-\$\{categoryColorIndex\(recipe\.recipeCategory\)\}/);
  assert.match(source, /\.cookbook-random-card__view\s*\{[^}]*max-width:\s*600px/s);
  assert.match(source, /\.cookbook-random-card__view \.metro-btn--next\s*\{[^}]*background:\s*var\(--metro-surface-raised\)/s);
});

// ---------------------------------------------------------------------------
// Random card — lifecycle and popup wiring
// ---------------------------------------------------------------------------

test('random card mounts through the existing cache, API, view and popup', () => {
  assert.match(randomCardSource, /new RecipeCache\(600\)/);
  assert.match(randomCardSource, /new CookbookApi\(this\._hass, this\._cache,/);
  assert.match(randomCardSource, /i18n: this\._i18n/);
  assert.match(randomCardSource, /new RandomRecipeView\(/);
  assert.match(randomCardSource, /new RecipePopup\(/);
  assert.match(randomCardSource, /PLACEHOLDER_URL/);
});

test('random card mounts from a hass push only while connected', () => {
  // The (?:\/\/[^\n]*\n\s*)* group tolerates the comment lines explaining
  // the guard; the pinned shape is the contract: mount only when connected.
  assert.match(
    randomCardSource,
    /set hass\(hass\) \{\s*const previousLocale = this\._i18n\.locale;\s*this\._hass = hass;\s*this\._i18n = createCardI18n\(hass, this\._config\);\s*if \(!this\._mounted\) \{[\s\S]*?if \(this\.isConnected\) this\._mount\(\);\s*return;\s*\}\s*this\._api\?\.setHass\(hass\);\s*if \(previousLocale !== this\._i18n\.locale\) this\._applyI18n\(\);\s*\}/,
  );
});

test('random card remounts on reconnect after a disconnect', () => {
  assert.match(
    randomCardSource,
    /connectedCallback\(\) \{\s*if \(!this\._mounted && this\._hass\) this\._mount\(\);\s*\}/,
  );
});

test('random card pauses rotation before opening the popup and resumes on close only while the view is alive', () => {
  assert.match(randomCardSource, /this\._view\?\.pause\(\);\s*this\._popup\?\.open\(id\);/);
  assert.match(randomCardSource, /if \(!this\._view\) return;\s*this\._view\.resume\(\);/);
});

test('random card destroys the view and popup on disconnect and stays idempotent', () => {
  assert.match(
    randomCardSource,
    /disconnectedCallback\(\) \{\s*if \(!this\._mounted\) return;\s*this\._mounted = false;\s*this\._view\?\.destroy\(\);\s*this\._view = null;\s*this\._popup\?\.destroy\(\);\s*this\._popup = null;/,
  );
});

// ---------------------------------------------------------------------------
// Shared Metro stylesheet — no CSS duplication between the two cards
// ---------------------------------------------------------------------------

test('grid card delegates to the shared Metro shadow style injection', () => {
  assert.match(source, /function injectMetroShadowStyles\(shadowRoot\) \{/);
  assert.match(source, /_injectShadowStyles\(\) \{\s*injectMetroShadowStyles\(this\.shadowRoot\);\s*\}/);
  assert.match(randomCardSource, /injectMetroShadowStyles\(this\.shadowRoot\)/);
});

test('random card CSS is card-scoped and does not restyle the grid card', () => {
  assert.match(source, /\.cookbook-random-card \{/);
  assert.match(source, /\.cookbook-random-card__view \.metro-btn--next \{/);
  assert.match(source, /\.cookbook-random-card__view \.metro-btn--next:hover \{/);
  const unscopedNextRules = source.match(/(?<!\.cookbook-random-card__view )\.metro-btn--next\s*\{/g);
  assert.equal(unscopedNextRules, null);
});

test('random card has no outer background or padding around the recipe tile', () => {
  assert.match(source, /\.cookbook-random-card\s*\{\s*background:\s*transparent;\s*color:/s);
  assert.match(source, /\.cookbook-random-card\s*\{[^}]*padding:\s*0;/s);
});

// ---------------------------------------------------------------------------
// Random card — runtime lifecycle and popup wiring
//
// The regex tests above cannot catch lifecycle or async races, so this
// section drives the REAL CookbookRandomCard element (imported with a fake
// browser environment) through its seams: hass pushes, connect/disconnect,
// tile activation and the shared RecipePopup. node --test runs every test
// file in its own process, so the module-level globals below cannot leak
// into the other test files.
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

class FakeStyle {
  constructor() {
    this.cssText = '';
    this.display = '';
    this._properties = new Map();
  }

  setProperty(name, value) {
    this._properties.set(name, String(value));
  }

  getPropertyValue(name) {
    return this._properties.get(name) ?? '';
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._className = '';
    this._textContent = '';
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.value = '';
    this._listeners = new Map();
  }

  get min() {
    return this.getAttribute('min') || '';
  }

  set min(value) {
    this.setAttribute('min', value);
  }

  get max() {
    return this.getAttribute('max') || '';
  }

  set max(value) {
    this.setAttribute('max', value);
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
    parseHtmlChildren(String(value)).forEach((child) => this.appendChild(child));
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

  focus() {}
  scrollTo() {}

  getBoundingClientRect() {
    const width = this._boundingClientRectWidth ?? 0;
    return { width, height: 0, top: 0, right: width, bottom: 0, left: 0 };
  }

  showModal() {
    this.open = true;
  }

  // The real <dialog> fires 'close' asynchronously after close(); this fake
  // fires it synchronously so the popup's close-event wiring (onClose ->
  // card resume) is reachable from node tests. Production never depends on
  // the ordering.
  close() {
    this.open = false;
    this.dispatchEvent({ type: 'close', target: this });
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

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }

  observe(element) {
    this.observed.push(element);
  }

  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }

  trigger(width) {
    this.observed.forEach((element) => {
      element._boundingClientRectWidth = width;
      this.callback([{ target: element, contentRect: { width } }]);
    });
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function parseHtmlChildren(html) {
  const elements = [];
  const tagPattern = /<(input|select|button|span|option|div)\b([^>]*)>/g;
  for (const match of html.matchAll(tagPattern)) {
    const element = new FakeElement(match[1]);
    const attributes = match[2];
    for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      const name = attribute[1];
      const value = attribute[2] ?? '';
      element.setAttribute(name, value);
      if (name === 'class') element.className = value;
      else element[name] = value;
    }
    elements.push(element);
  }
  return elements;
}

class FakeHTMLElement extends FakeElement {
  constructor() {
    super('element');
    this.isConnected = false;
    this.shadowRoot = null;
  }

  attachShadow() {
    this.shadowRoot = new FakeElement('#shadow-root');
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }
}

// sessionStorage backing store for RecipeCache (shared per process, cleared
// between tests so cached pools/details never leak across tests).
const sessionStorageMap = new Map();

const customElementsRegistry = new Map();

globalThis.window = {
  customCards: [],
  location: { search: '', pathname: '/lovelace/cookbook', hash: '' },
  history: { state: null, replaceState() {} },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.customElements = {
  get: (name) => customElementsRegistry.get(name),
  define: (name, ctor) => customElementsRegistry.set(name, ctor),
};
globalThis.HTMLElement = FakeHTMLElement;
globalThis.ResizeObserver = FakeResizeObserver;
globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
  documentElement: new FakeElement('html'),
  activeElement: null,
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.sessionStorage = {
  getItem: (key) => (sessionStorageMap.has(key) ? sessionStorageMap.get(key) : null),
  setItem: (key, value) => { sessionStorageMap.set(key, String(value)); },
  removeItem: (key) => { sessionStorageMap.delete(key); },
};

await import('../../custom_components/cookbook/frontend/cookbook-card.js');

const CookbookCard = customElementsRegistry.get('cookbook-card');
const CookbookCardEditor = customElementsRegistry.get('cookbook-card-editor');
const CookbookRandomCard = customElementsRegistry.get('cookbook-random-card');

// ---------------------------------------------------------------------------
// Runtime fixtures and helpers
// ---------------------------------------------------------------------------

const RUNTIME_STUBS = [
  { id: 'a', name: 'Apfelsuppe', recipeCategory: 'Suppe', keywords: 'schnell' },
  { id: 'b', name: 'Bolognese', recipeCategory: 'Hauptgericht', keywords: 'fleisch' },
  { id: 'c', name: 'Curry', recipeCategory: 'Hauptgericht', keywords: 'schnell' },
];

const RUNTIME_DETAIL = (id, name) => ({
  id,
  name,
  description: 'Beschreibung.',
  recipeInstructions: [{
    ingredients: [{ name: 'Zutat', amount: '', unit: '', note: '' }],
    instruction: 'Kochen.',
  }],
  keywords: '',
  url: '',
  nutrition: {},
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Fake hass whose callWS serves list_recipes from RUNTIME_STUBS and
 * get_recipe through an injectable (optionally deferred) provider.
 * `calls` records every service name for load-count assertions.
 */
function createHass({ recipes = RUNTIME_STUBS, getRecipe } = {}) {
  const calls = [];
  const hass = {
    callWS: async (message) => {
      calls.push(message.service);
      if (message.service === 'list_recipes') return { response: { recipes } };
      if (message.service === 'get_recipe') {
        const provider = getRecipe
          ?? ((id) => RUNTIME_DETAIL(id, RUNTIME_STUBS.find((stub) => stub.id === id)?.name ?? `Rezept ${id}`));
        return { response: { recipe: await provider(message.service_data.recipe_id) } };
      }
      return { response: {} };
    },
  };
  return { hass, calls };
}

const liveCards = new Set();

function newRandomCard(config = {}) {
  const card = new CookbookRandomCard();
  card.setConfig(config);
  liveCards.add(card);
  return card;
}

function newGridCard(config = {}) {
  const card = new CookbookCard();
  card.setConfig(config);
  liveCards.add(card);
  return card;
}

function connect(card) {
  card.isConnected = true;
  card.connectedCallback();
}

function disconnect(card) {
  card.isConnected = false;
  card.disconnectedCallback();
}

const rootCount = (card) => card.shadowRoot.querySelectorAll('.cookbook-random-card').length;

const displayedName = (card) => card.shadowRoot.querySelector('.metro-tile__name')?.textContent ?? null;

const gridColumns = (card) => card._grid.gridEl.style.getPropertyValue('--metro-columns');

/** Let pending microtasks (mount loads, popup opens) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function mountCard(hass) {
  const card = newRandomCard({ duration: '1h' });
  connect(card);
  card.hass = hass;
  await flush();
  return card;
}

async function mountGridCard(config = {}, width = 1024) {
  const { hass } = createHass();
  const card = newGridCard(config);
  const mountCalls = [];
  const originalMount = card._mount.bind(card);
  card._mount = async () => {
    mountCalls.push('mount');
    await originalMount();
  };
  card.hass = hass;
  await flush();
  card._root._boundingClientRectWidth = width;
  FakeResizeObserver.instances.at(-1)?.trigger(width);
  return { card, mountCalls };
}

beforeEach(() => {
  sessionStorageMap.clear();
  FakeResizeObserver.instances = [];
});

afterEach(() => {
  liveCards.forEach((card) => disconnect(card));
  liveCards.clear();
  sessionStorageMap.clear();
});

test('grid card defaults to one, two and three columns by container width', async () => {
  const { card } = await mountGridCard({}, 599);
  const observer = FakeResizeObserver.instances.at(-1);

  assert.equal(gridColumns(card), '1', 'mobile default below 600px');

  observer.trigger(600);
  assert.equal(gridColumns(card), '2', 'tablet default starts at 600px');

  observer.trigger(1024);
  assert.equal(gridColumns(card), '3', 'desktop default starts at 1024px');
});

test('grid card switches columns exactly at the tablet and desktop breakpoints', async () => {
  const { card } = await mountGridCard({ columns_mobile: 4, columns_tablet: 5, columns_desktop: 6 }, 599);
  const observer = FakeResizeObserver.instances.at(-1);

  assert.equal(gridColumns(card), '4', '599px uses mobile columns');

  observer.trigger(600);
  assert.equal(gridColumns(card), '5', '600px uses tablet columns');

  observer.trigger(1023);
  assert.equal(gridColumns(card), '5', '1023px still uses tablet columns');

  observer.trigger(1024);
  assert.equal(gridColumns(card), '6', '1024px uses desktop columns');
});

test('grid card resize observer updates columns without remounting', async () => {
  const { card, mountCalls } = await mountGridCard({ columns_mobile: 1, columns_tablet: 7 }, 599);
  const observer = FakeResizeObserver.instances.at(-1);

  assert.equal(gridColumns(card), '1');
  assert.equal(mountCalls.length, 1, 'initial mount happened once');

  observer.trigger(600);

  assert.equal(gridColumns(card), '7');
  assert.equal(mountCalls.length, 1, 'resize did not remount the card');
});

test('grid card reconnects the resize observer after disconnect', async () => {
  const { card } = await mountGridCard({ columns_mobile: 1, columns_tablet: 2 }, 599);
  const firstObserver = FakeResizeObserver.instances.at(-1);

  disconnect(card);
  connect(card);
  const secondObserver = FakeResizeObserver.instances.at(-1);
  secondObserver.trigger(600);

  assert.equal(firstObserver.disconnected, true);
  assert.equal(gridColumns(card), '2');
});

test('grid card clamps responsive column values into the supported range', async () => {
  const { card } = await mountGridCard({ columns_mobile: 0, columns_desktop: 20 }, 599);
  const observer = FakeResizeObserver.instances.at(-1);

  assert.equal(gridColumns(card), '1', 'mobile value 0 clamps to 1');

  observer.trigger(1024);
  assert.equal(gridColumns(card), '12', 'desktop value 20 clamps to 12');
});

test('grid card ignores legacy columns for layout', async () => {
  const { card } = await mountGridCard({ columns: 6 }, 1024);

  assert.equal(gridColumns(card), '3', 'desktop default wins over ignored legacy columns');
});

test('grid card warns exactly once per mount when legacy columns is configured', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    await mountGridCard({ columns: 6 }, 1024);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /columns_mobile.*columns_tablet.*columns_desktop/);

    warnings.length = 0;
    await mountGridCard({}, 1024);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('grid card stub config uses responsive column defaults', () => {
  const config = CookbookCard.getStubConfig();

  assert.equal(config.columns_mobile, 1);
  assert.equal(config.columns_tablet, 2);
  assert.equal(config.columns_desktop, 3);
  assert.equal(Object.hasOwn(config, 'columns'), false);
});

test('all cards default to automatic Home Assistant language selection', () => {
  assert.equal(CookbookCard.getStubConfig().language, 'auto');
  assert.equal(CookbookRandomCard.getStubConfig().language, 'auto');
  assert.equal(customElementsRegistry.get('cookbook-weekly-calendar').getStubConfig().language, 'auto');
});

test('grid card follows the HA language unless the card config overrides it', async () => {
  const { hass } = createHass();
  hass.locale = { language: 'en-US' };
  const card = newGridCard();
  card.hass = hass;
  await flush();
  assert.match(card._grid._toolbar.innerHTML, /Search recipes/);

  hass.locale = { language: 'de-DE' };
  card.hass = hass;
  assert.match(card._grid._toolbar.innerHTML, /Rezept suchen/);

  const overridden = newGridCard({ language: 'en' });
  overridden.hass = hass;
  await flush();
  assert.equal(overridden._i18n.locale, 'en');
  assert.match(overridden._grid._toolbar.innerHTML, /Search recipes/);
});

test('random and weekly calendar cards refresh their views when the HA language changes', async () => {
  const { hass } = createHass();
  hass.locale = { language: 'en' };

  const randomCard = newRandomCard({ language: 'auto' });
  connect(randomCard);
  randomCard.hass = hass;
  await flush();
  assert.equal(randomCard._view._i18n.locale, 'en');
  hass.locale = { language: 'de' };
  randomCard.hass = hass;
  assert.equal(randomCard._view._i18n.locale, 'de');

  const WeeklyCard = customElementsRegistry.get('cookbook-weekly-calendar');
  const weeklyCard = new WeeklyCard();
  weeklyCard.setConfig({ language: 'auto' });
  connect(weeklyCard);
  weeklyCard.hass = hass;
  await flush();
  assert.equal(weeklyCard._view._i18n.locale, 'de');
  hass.locale = { language: 'en' };
  weeklyCard.hass = hass;
  assert.equal(weeklyCard._view._i18n.locale, 'en');
});

test('grid card editor renders three responsive column number inputs', () => {
  const editor = new CookbookCardEditor();
  editor.hass = { locale: { language: 'en' }, states: {} };
  editor.setConfig({ columns_mobile: 4, columns_tablet: 5, columns_desktop: 6 });

  ['columns_mobile', 'columns_tablet', 'columns_desktop'].forEach((name) => {
    const input = editor._controls[name];
    assert.ok(input, `${name} input exists`);
    assert.equal(input.type, 'number');
    assert.equal(input.min, '1');
    assert.equal(input.max, '12');
  });
  assert.equal(editor._controls.columns_mobile.value, '4');
  assert.equal(editor._controls.columns_tablet.value, '5');
  assert.equal(editor._controls.columns_desktop.value, '6');
  assert.equal(editor._controls.columns, undefined);
});

test('grid card editor offers language overrides and uses the selected language', () => {
  const editor = new CookbookCardEditor();
  editor.hass = { locale: { language: 'en-US' }, states: {} };
  editor.setConfig({ language: 'de' });

  assert.equal(editor._i18n.locale, 'de');
  assert.ok(editor._controls.language);
  assert.deepEqual(
    editor._controls.language.children.map(option => option.value),
    ['auto', 'de', 'en'],
  );
  assert.match(editor.shadowRoot.innerHTML, /Spalten mobil/);
});

test('random and weekly calendar editors expose the same language override choices', () => {
  for (const editorType of ['cookbook-random-card-editor', 'cookbook-weekly-calendar-editor']) {
    const Editor = customElementsRegistry.get(editorType);
    const editor = new Editor();
    editor.setConfig({ language: 'en' });

    assert.equal(editor._i18n.locale, 'en', `${editorType} resolves its language override`);
    assert.deepEqual(
      editor._controls.language.children.map(option => option.value),
      ['auto', 'de', 'en'],
      `${editorType} exposes auto, German, and English choices`,
    );
  }
});

// ---------------------------------------------------------------------------
// Runtime — mount lifecycle
// ---------------------------------------------------------------------------

test('a hass push while detached does not mount; a later connect mounts exactly once', async () => {
  const { hass, calls } = createHass();
  const card = newRandomCard({ duration: '1h' });

  // Detached: HA may push hass to a card that is not in the DOM (view churn).
  card.hass = hass;
  await flush();

  assert.equal(rootCount(card), 0, 'no mount while detached');
  assert.deepEqual(calls, [], 'no pool load while detached');

  connect(card);
  await flush();

  assert.equal(rootCount(card), 1, 'connect mounts');
  assert.deepEqual(calls, ['list_recipes']);
  assert.ok(displayedName(card), 'tile rendered after connect');
});

test('reconnect after a disconnect mounts exactly once and ignores hass pushes while detached', async () => {
  const { hass, calls } = createHass();
  const card = newRandomCard({ duration: '1h' });

  connect(card);
  card.hass = hass;
  await flush();
  assert.equal(rootCount(card), 1);

  disconnect(card);
  assert.equal(rootCount(card), 0);

  // Drop the cached pool so a remount's load is observable in `calls`.
  sessionStorageMap.clear();

  card.hass = hass;
  await flush();
  assert.equal(rootCount(card), 0, 'hass push while detached does not remount');
  assert.deepEqual(calls, ['list_recipes'], 'no pool load while detached');

  connect(card);
  await flush();
  assert.equal(rootCount(card), 1, 'reconnect mounts exactly one card root');
  assert.deepEqual(calls, ['list_recipes', 'list_recipes'], 'reconnect reloads the pool');
  assert.ok(displayedName(card));
});

test('hass pushes after mount refresh the API without resetting the rotation timer', async () => {
  const { hass } = createHass();
  const card = await mountCard(hass);
  const cancelBefore = card._view._cancelRotation;
  assert.ok(cancelBefore, 'rotation armed after mount');

  card.hass = hass;

  assert.equal(card._view._cancelRotation, cancelBefore, 'timer untouched by hass push');
  assert.equal(rootCount(card), 1);
});

// ---------------------------------------------------------------------------
// Runtime — popup wiring (pause/open/close/resume through the card seams)
// ---------------------------------------------------------------------------

test('tile activation opens the popup, pauses rotation and resumes after close', async () => {
  const { hass } = createHass();
  const card = await mountCard(hass);
  const view = card._view;
  const tileName = displayedName(card);

  card.shadowRoot.querySelector('.metro-tile').click();
  await flush();

  const dialog = card.shadowRoot.querySelector('dialog');
  assert.equal(dialog.open, true, 'popup dialog opened');
  assert.equal(card._popup._els.titleEl.textContent, tileName, 'popup shows the tile recipe');
  assert.equal(view._cancelRotation, null, 'rotation paused while popup open');

  card._popup.close();
  await flush();

  assert.equal(dialog.open, false, 'popup closed');
  assert.ok(view._cancelRotation, 'rotation resumed after close');
});

test('next control rotates the recipe without opening the popup dialog', async () => {
  const { hass } = createHass();
  const card = await mountCard(hass);
  const nameBefore = displayedName(card);

  card.shadowRoot.querySelector('.metro-btn--next').click();
  await flush();

  assert.notEqual(displayedName(card), nameBefore, 'recipe rotated');
  assert.equal(card.shadowRoot.querySelector('dialog').open, false, 'popup stayed closed');
});

test('popup keeps the newest recipe when an older detail response arrives late', async () => {
  const slowDetail = createDeferred();
  const { hass } = createHass({
    getRecipe: (id) => (id === 'a' ? slowDetail.promise : RUNTIME_DETAIL('b', 'Bolognese')),
  });
  const card = await mountCard(hass);

  card._openRecipe('a');
  await flush();
  assert.equal(card._popup._els.titleEl.textContent, 'Loading recipe…', 'first open pending');

  card._openRecipe('b');
  await flush();
  assert.equal(card._popup._els.titleEl.textContent, 'Bolognese', 'newer open shown');

  slowDetail.resolve(RUNTIME_DETAIL('a', 'Apfelsuppe'));
  await flush();

  assert.equal(card._popup._els.titleEl.textContent, 'Bolognese', 'stale response discarded');
});

test('disconnect while the popup is open tears down the view and the popup', async () => {
  const { hass } = createHass();
  const card = await mountCard(hass);

  card.shadowRoot.querySelector('.metro-tile').click();
  await flush();
  assert.equal(card.shadowRoot.querySelector('dialog').open, true);

  disconnect(card);

  assert.equal(card._view, null);
  assert.equal(card._popup, null);
  assert.equal(rootCount(card), 0, 'card root removed from the shadow DOM');
});

// ---------------------------------------------------------------------------
// Weekly calendar editor: title must show even when hass arrives before
// setConfig (regression — HA pushes hass first, which built the form empty).
// ---------------------------------------------------------------------------

const CookbookWeeklyCalendarEditor = customElementsRegistry.get('cookbook-weekly-calendar-editor');

test('weekly-calendar editor shows the configured title when hass precedes setConfig', () => {
  const editor = new CookbookWeeklyCalendarEditor();
  editor.attachShadow({ mode: 'open' });
  // HA order: hass first (builds the form), then setConfig with the title.
  editor.hass = { locale: { language: 'de' }, states: {}, callWS: async () => ({ response: { plan: { slots: [] } } }) };
  editor.setConfig({ title: 'Mein Wochenplan' });
  const titleInput = editor._controls?.title;
  assert.ok(titleInput, 'title control exists');
  assert.equal(titleInput.value, 'Mein Wochenplan');
});

test('weekly-calendar editor syncs select values after a later setConfig', () => {
  const editor = new CookbookWeeklyCalendarEditor();
  editor.attachShadow({ mode: 'open' });
  editor.hass = { locale: { language: 'de' }, states: {}, callWS: async () => ({ response: { plan: { slots: [] } } }) };
  editor.setConfig({ week_start: 'sunday', layout: 'compact' });
  assert.equal(editor._controls.week_start.value, 'sunday');
  assert.equal(editor._controls.layout.value, 'compact');
});
