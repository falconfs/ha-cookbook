/**
 * Cookbook cards v6.0.0 — plain custom elements with Shadow DOM-safe styles.
 */

import { CookbookApi }  from './services/api.js';
import { RecipeCache }  from './services/cache.js';
import { GridView }     from './components/grid-view.js';
import { RecipePopup }  from './components/recipe-popup.js';
import { RecipeEditor } from './components/recipe-editor.js';
import { normalizeRecipeViewConfig } from './services/recipe-view.js';
import { RandomRecipeView } from './components/random-recipe-view.js';
import { parseRotationDuration } from './services/random-logic.js';
import { WeeklyCalendarView } from './components/weekly-calendar-view.js';
import { BUILTIN_SLOT_IDS, slotLabel, slugifySlotName, validateNewSlotName, reorderSlots } from './services/slot-logic.js';
import { createI18n, resolveLocale } from './i18n/i18n.js';

const CARD_BASE_URL   = new URL('.', import.meta.url).href;
const PLACEHOLDER_URL = `${CARD_BASE_URL}recipe_placeholder.png`;
const CARD_VERSION    = '6.0.0';

// URL query parameter used to deep-link an open recipe dialog, e.g.
// /lovelace/kochbuch?recipe=123 . The HA Lovelace router preserves unknown
// query params across view navigation, so this survives normal navigation.
const RECIPE_URL_PARAM  = 'recipe';
const DEFAULT_NEW_DAYS  = 30;
const GRID_COLUMNS_MIN = 1;
const GRID_COLUMNS_MAX = 12;
const GRID_COLUMNS_MOBILE_DEFAULT = 1;
const GRID_COLUMNS_TABLET_DEFAULT = 2;
const GRID_COLUMNS_DESKTOP_DEFAULT = 3;
const GRID_TABLET_MIN_WIDTH = 600;
const GRID_DESKTOP_MIN_WIDTH = 1024;

function createCardI18n(hass, config) {
  return createI18n({ locale: resolveLocale(hass, config?.language) });
}

function browserI18n() {
  return createCardI18n({ locale: { language: globalThis.navigator?.language } }, {});
}

// ─── LitElement bootstrap (same pattern as rssfeed-metro-tile) ──────────────
const _lit = window.LitElement;

// Shared Metro Shadow DOM stylesheet for both card elements: bridges HA
// theme variables into custom properties and appends the full Metro CSS
// (tokens, tiles, buttons, dialogs). Extracted from CookbookCard so the
// random card reuses it without duplicating the template.
function injectMetroShadowStyles(shadowRoot) {
    // Bridge HA theme CSS variables into the Shadow DOM
    // Shadow DOM does not inherit custom properties from document automatically
    // unless they are set on :host or the shadow root element.
    const docStyle = getComputedStyle(document.documentElement);
    const haVars = [
      '--primary-color', '--accent-color',
      '--primary-background-color', '--secondary-background-color',
      '--card-background-color', '--ha-card-background',
      '--primary-text-color', '--secondary-text-color', '--disabled-text-color',
      '--divider-color', '--sidebar-background-color',
      '--error-color', '--warning-color', '--success-color', '--info-color',
      '--dark-primary-color', '--light-primary-color',
      '--mdc-theme-primary', '--mdc-theme-surface',
    ];
    const inherited = haVars
      .map(v => { const val = docStyle.getPropertyValue(v).trim(); return val ? `  ${v}: ${val};` : ''; })
      .filter(Boolean)
      .join('\n');

    // Also derive metro vars directly on :host so dialog + other elements inherit them
    const surface = docStyle.getPropertyValue('--card-background-color').trim()
                 || docStyle.getPropertyValue('--ha-card-background').trim()
                 || '#16213e';
    const surfaceRaised = docStyle.getPropertyValue('--secondary-background-color').trim() || '#0f3460';
    const bg     = docStyle.getPropertyValue('--primary-background-color').trim() || '#1a1a2e';
    const text   = docStyle.getPropertyValue('--primary-text-color').trim() || '#ffffff';
    const muted  = docStyle.getPropertyValue('--secondary-text-color').trim() || '#8888aa';
    const accent = docStyle.getPropertyValue('--primary-color').trim() || '#0078d7';
    const border = docStyle.getPropertyValue('--divider-color').trim() || '#2a2a4a';
    const success = docStyle.getPropertyValue('--success-color').trim() || '#107c10';
    const danger  = docStyle.getPropertyValue('--error-color').trim() || '#e81123';
    const warning = docStyle.getPropertyValue('--warning-color').trim() || '#ffa600';

    const metroVars = [
      `  --metro-bg: ${bg}`,
      `  --metro-surface: ${surface}`,
      `  --metro-surface-raised: ${surfaceRaised}`,
      `  --metro-text: ${text}`,
      `  --metro-text-muted: ${muted}`,
      `  --metro-text-inverse: ${bg}`,
      `  --metro-accent: ${accent}`,
      `  --metro-accent-hover: ${docStyle.getPropertyValue('--light-primary-color').trim() || '#106ebe'}`,
      `  --metro-accent-active: ${docStyle.getPropertyValue('--dark-primary-color').trim() || '#005a9e'}`,
      `  --metro-border: ${border}`,
      `  --metro-success: ${success}`,
      `  --metro-success-hover: #0d6b0d`,
      `  --metro-danger: ${danger}`,
      `  --metro-warning: ${warning}`,
      `  --metro-overlay: rgba(0,0,0,0.75)`,
      `  --metro-tile-overlay: rgba(0,0,0,0.45)`,
      `  --metro-dialog-shadow: 0 8px 32px rgba(0,0,0,0.5)`,
    ].join(';\n');

    const varBridge = `:host {\n${inherited}\n${metroVars}\n}\n`;

    const style = document.createElement('style');
    style.textContent = varBridge + `/* =============================================================================
   Metro Design System — Cookbook Card
   Windows Metro / Fluent Design inspired
   No inline styles — all visual state via CSS classes
   ============================================================================= */

/* -----------------------------------------------------------------------------
   CSS Custom Properties (Theme Tokens)
   Applied via .metro-dark / .metro-light on the root element
   ----------------------------------------------------------------------------- */

/* Theme tokens set on :host via JS (_injectShadowStyles) — no static values here */

/* Metro category color palette — assigned by category hash */
.metro-tile--color-0  { --tile-color: #0078d7; } /* Blau       */
.metro-tile--color-1  { --tile-color: #107c10; } /* Grün       */
.metro-tile--color-2  { --tile-color: #5c2d91; } /* Lila       */
.metro-tile--color-3  { --tile-color: #ca5010; } /* Orange     */
.metro-tile--color-4  { --tile-color: #e81123; } /* Rot        */
.metro-tile--color-5  { --tile-color: #008299; } /* Türkis     */
.metro-tile--color-6  { --tile-color: #00b294; } /* Grün-Blau  */
.metro-tile--color-7  { --tile-color: #bad80a; } /* Lime       */
.metro-tile--color-8  { --tile-color: #ff8c00; } /* Amber      */
.metro-tile--color-9  { --tile-color: #ec008c; } /* Magenta    */

/* -----------------------------------------------------------------------------
   Base Layout
   ----------------------------------------------------------------------------- */

.cookbook-card {
  background: var(--metro-bg);
  color: var(--metro-text);
  padding: 16px;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-size: 14px;
  min-height: 200px;
}

/* -----------------------------------------------------------------------------
   Toolbar
   ----------------------------------------------------------------------------- */

.metro-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  align-items: center;
}

.metro-toolbar__title {
  font-size: 20px;
  font-weight: 300;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--metro-text);
  flex: 1;
  min-width: 120px;
}

/* -----------------------------------------------------------------------------
   Form Controls (Search, Select)
   ----------------------------------------------------------------------------- */

.metro-search,
.metro-select {
  background: var(--metro-surface);
  border: 2px solid var(--metro-border);
  color: var(--metro-text);
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
  /* Metro: no border-radius */
  border-radius: 0;
}

.metro-search {
  flex: 1;
  min-width: 140px;
}

.metro-select {
  min-width: 120px;
  cursor: pointer;
}

.metro-search:focus,
.metro-select:focus {
  border-color: var(--metro-accent);
}

.metro-search::placeholder {
  color: var(--metro-text-muted);
}

/* -----------------------------------------------------------------------------
   Buttons
   ----------------------------------------------------------------------------- */

.metro-btn {
  background: var(--metro-surface-raised);
  color: var(--metro-text);
  border: none;
  padding: 8px 16px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  border-radius: 0;
  transition: background 0.1s;
  white-space: nowrap;
}

.metro-btn:hover {
  background: var(--metro-border);
}

.metro-btn:active {
  background: var(--metro-accent-active);
  color: var(--metro-text-inverse);
}

.metro-btn--accent {
  background: var(--metro-accent);
  color: #ffffff;
}

.metro-btn--accent:hover {
  background: var(--metro-accent-hover);
}

.metro-btn--accent:active {
  background: var(--metro-accent-active);
}

.metro-btn--success {
  background: var(--metro-success);
  color: #ffffff;
}

.metro-btn--success:hover {
  background: var(--metro-success-hover);
}

.metro-btn--danger {
  background: var(--metro-danger);
  color: #ffffff;
}

.metro-btn--icon {
  padding: 8px;
  font-size: 16px;
  line-height: 1;
  background: transparent;
}

.metro-btn--icon:hover {
  background: var(--metro-surface-raised);
}

.metro-btn--sm {
  padding: 4px 10px;
  font-size: 11px;
}

/* -----------------------------------------------------------------------------
   Recipe Grid
   ----------------------------------------------------------------------------- */

.metro-grid {
  display: grid;
  /* Column count set via --metro-columns CSS variable (from card config) */
  grid-template-columns: repeat(var(--metro-columns, 4), 1fr);
  gap: 4px;
}

.metro-grid--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--metro-text-muted);
  font-size: 16px;
  font-weight: 300;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* -----------------------------------------------------------------------------
   Recipe Tile — Metro style
   Fixed 160×160px square, image as background, gradient overlay for title.
   ----------------------------------------------------------------------------- */

.metro-tile {
  position: relative;
  /* Width fills the grid column; height = width via aspect-ratio */
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--tile-color, var(--metro-surface-raised));
  cursor: pointer;
  overflow: hidden;
  /* Metro: sharp corners, no border-radius */
  transition: transform 0.12s ease, filter 0.12s ease;
}

.metro-tile:hover {
  transform: scale(1.04);
  z-index: 2;
  filter: brightness(1.12);
}

.metro-tile:active {
  transform: scale(0.97);
  filter: brightness(0.88);
}

/* Background image — fills the entire tile, cropped */
.metro-tile__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.metro-tile__img--loaded {
  opacity: 1;
}

/* Colour fallback while image loads (or if no image) */
.metro-tile__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 48px;
  color: rgba(255, 255, 255, 0.25);
  /* Hidden once image is loaded */
  transition: opacity 0.3s ease;
}

.metro-tile__placeholder--hidden {
  opacity: 0;
  pointer-events: none;
}

/* Gradient overlay — always visible, ensures title readability */
.metro-tile__overlay {
  position: absolute;
  inset: 0;
  /* Strong gradient from transparent at top to dark at bottom */
  background: linear-gradient(
    to bottom,
    transparent 35%,
    rgba(0, 0, 0, 0.45) 60%,
    rgba(0, 0, 0, 0.82) 100%
  );
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 8px;
}

/* Title — always white, always readable via gradient */
.metro-tile__name {
  font-size: 12px;
  font-weight: 700;
  color: #ffffff;
  line-height: 1.25;
  letter-spacing: 0.2px;
  /* Max 2 lines, then ellipsis */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}

.metro-tile__category {
  font-size: 9px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.75);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
}

.metro-tile__rating {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  margin-left: 8px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
}

.metro-tile__meta {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
}

.metro-tile__details {
  min-width: 0;
}

/* Inline editor host lives inside the shared, scrollable dialog body. */
.metro-dialog__editor {
  display: block;
}

.metro-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
}

/* --- Delete confirmation dialog --- */
.metro-confirm {
  width: min(440px, 92vw) !important;
  max-width: min(440px, 92vw) !important;
  height: auto !important;
  max-height: 90vh !important;
  overflow: hidden;
}

.metro-confirm__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
}

.metro-confirm__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--metro-text);
}

.metro-confirm__text {
  margin: 0;
  color: var(--metro-text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.metro-confirm__name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 2px solid var(--metro-border);
  background: var(--metro-surface-raised);
}

.metro-confirm__name {
  flex: 1;
  font-weight: 600;
  color: var(--metro-text);
  overflow-wrap: anywhere;
}

.metro-confirm__copy {
  flex: 0 0 auto;
}

.metro-confirm__input {
  box-sizing: border-box;
  width: 100%;
  min-height: 38px;
  padding: 8px;
  border: 2px solid var(--metro-border);
  border-radius: 0;
  background: var(--metro-surface-raised);
  color: var(--metro-text);
  font: inherit;
}

.metro-confirm__input:focus {
  outline: none;
  border-color: var(--metro-accent);
}

.metro-confirm__footer {
  position: static;
  padding-top: 4px;
}

.metro-form-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 2px solid var(--metro-border);
  background: var(--metro-surface);
}

.metro-form-section__heading {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--metro-text);
}

/* Form/JSON view switcher */
.metro-form-viewswitch {
  display: flex;
  gap: 6px;
}

.metro-form-viewswitch__tab--active {
  background: var(--metro-accent);
  color: #ffffff;
}

/* JSON editor */
.metro-form-json__editor {
  border: 2px solid var(--metro-border);
  background: var(--metro-surface-raised);
  max-height: 55vh;
  overflow: auto;
}

.metro-form-json__textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 320px;
  padding: 8px;
  border: 0;
  background: var(--metro-surface-raised);
  color: var(--metro-text);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.metro-form-json__actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* CodeMirror sizing inside the JSON editor host */
.metro-form-json__editor .cm-editor {
  max-height: 55vh;
}

.metro-form-json__editor .cm-scroller {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
}

/* Collapsible advanced (schema.org) section */
.metro-form-advanced > summary {
  cursor: pointer;
  list-style: revert;
}

/* Image preview inside the editor */
.metro-image-preview {
  gap: 6px;
}

.metro-image-preview__img {
  max-width: 220px;
  max-height: 160px;
  object-fit: cover;
  border: 2px solid var(--metro-border);
  background: var(--metro-surface-raised);
  display: none;
}

.metro-image-preview__hint {
  font-size: 11px;
  color: var(--metro-text-muted);
}

.metro-image-preview__remove {
  align-self: start;
  margin-top: 4px;
}

.metro-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  align-items: start;
}

.metro-form-field {
  display: grid;
  gap: 4px;
}

.metro-form-field--full {
  grid-column: 1 / -1;
}

.metro-form-field__label {
  color: var(--metro-text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metro-form-field input,
.metro-form-field textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  padding: 8px;
  border: 2px solid var(--metro-border);
  border-radius: 0;
  background: var(--metro-surface-raised);
  color: var(--metro-text);
  font: inherit;
}

.metro-form-field textarea {
  min-height: 72px;
  resize: vertical;
}

.metro-form-field input:focus,
.metro-form-field textarea:focus {
  outline: none;
  border-color: var(--metro-accent);
}

.metro-form-duration {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  border: 0;
  padding: 0;
  margin: 0;
}

.metro-form-duration legend {
  grid-column: 1 / -1;
  padding: 0;
  color: var(--metro-text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* --- Tags (chip multiselect) --- */

.metro-form-tags__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.metro-form-tags__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.metro-form-tags__remove {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 2px;
}

.metro-form-tags__remove:hover {
  color: var(--metro-danger);
}

/* --- Steps --- */

.metro-form-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.metro-form-step {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 2px solid var(--metro-border);
  padding: 12px;
  margin: 0;
  background: var(--metro-surface-raised);
}

.metro-form-step__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.metro-form-step__legend {
  padding: 0;
  color: var(--metro-text);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metro-form-step__controls {
  display: flex;
  gap: 6px;
}

/* Larger, easier-to-hit icon buttons inside the editor form (step move/delete,
   ingredient remove, copy). */
.metro-dialog__editor .metro-btn--icon,
.metro-form-step__controls .metro-btn,
.metro-form-ingredient__remove,
.metro-confirm__copy {
  font-size: 20px;
  line-height: 1;
  min-width: 40px;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
}

/* --- Ingredients (multiple rows per step) --- */

.metro-form-ingredients {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metro-form-ingredient {
  display: grid;
  grid-template-columns: 0.8fr 0.8fr 1.4fr 1.4fr auto;
  gap: 8px;
  align-items: end;
}

.metro-form-ingredient__remove {
  align-self: end;
}

/* Shared input styling so the URL import field + move-select match form fields. */
.metro-input {
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px;
  border: 2px solid var(--metro-border);
  border-radius: 0;
  background: var(--metro-surface-raised);
  color: var(--metro-text);
  font: inherit;
}

.metro-input:focus {
  outline: none;
  border-color: var(--metro-accent);
}

/* URL import row: the input fills the available width, button sits beside it. */
.metro-form-import__row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.metro-form-import__input {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}

.metro-form-import__row .metro-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.metro-form-import__status {
  margin-top: 6px;
  font-size: 12px;
  color: var(--metro-text-muted);
}

.metro-form-import__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--metro-text-muted);
  line-height: 1.35;
}

.metro-form-import__status--error {
  color: var(--metro-danger);
}

/* Compact move-select inside an ingredient row. */
.metro-form-ingredient__move {
  align-self: end;
  max-width: 130px;
}

.metro-form-errors {
  display: grid;
  gap: 4px;
}

.metro-form-errors .metro-error {
  align-items: flex-start;
  text-align: left;
}

.metro-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  position: sticky;
  bottom: 0;
  padding-top: 12px;
  background: var(--metro-surface);
}

@media (max-width: 640px) {
  .metro-form-ingredient {
    grid-template-columns: 1fr 1fr;
  }
  .metro-form-ingredient__remove {
    grid-column: 1 / -1;
    justify-self: end;
  }
}

/* "New" banner — diagonal-free corner ribbon on the newest recipe tiles */
.metro-tile__new-badge {
  position: absolute;
  top: 8px;
  left: 0;
  z-index: 3;
  background: var(--metro-accent);
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 3px 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

/* Loading skeleton tile */
.metro-tile--skeleton {
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--metro-surface-raised);
  animation: metro-pulse 1.4s ease-in-out infinite;
}

@keyframes metro-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}

/* -----------------------------------------------------------------------------
   Status Bar (count + loading indicator)
   ----------------------------------------------------------------------------- */

.metro-statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--metro-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metro-statusbar__count {
  font-weight: 600;
  color: var(--metro-text);
}

.metro-statusbar__message {
  flex: 1;
}

.metro-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--metro-border);
  border-top-color: var(--metro-accent);
  border-radius: 50%;
  animation: metro-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.metro-spinner--hidden {
  display: none;
}

@keyframes metro-spin {
  to { transform: rotate(360deg); }
}

/* Sync banner — shown while background sync is running */
.metro-sync-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--metro-accent);
  color: #ffffff;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 4px;
  /* Slide in from top */
  animation: metro-slide-down 0.2s ease;
}

.metro-sync-banner--hidden {
  display: none;
}

.metro-sync-banner__spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.4);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: metro-spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes metro-slide-down {
  from { transform: translateY(-100%); opacity: 0; }
  to   { transform: translateY(0);     opacity: 1; }
}

/* -----------------------------------------------------------------------------
   Dialog / Popup
   ----------------------------------------------------------------------------- */

.metro-dialog {
  border: none;
  padding: 0;
  background: var(--metro-surface);
  color: var(--metro-text);
  width:      var(--dialog-width,  90vw);
  max-width:  var(--dialog-width,  90vw);
  height:     var(--dialog-height, 90vh);
  max-height: var(--dialog-height, 90vh);
  overflow: hidden;
  box-shadow: var(--metro-dialog-shadow);
  border-radius: 0;
}

/* Column flex only while open. The body takes the remaining height and scrolls
   as one surface, including the image header. Applying flex unconditionally
   would override the browser default that hides a closed dialog. */
.metro-dialog[open] {
  display: flex;
  flex-direction: column;
}

/* Fullscreen — override all browser dialog positioning */
.metro-dialog--fullscreen {
  position: fixed !important;
  inset: 0 !important;
  margin: 0 !important;
  width:      100vw !important;
  max-width:  100vw !important;
  height:     100vh !important;
  max-height: 100vh !important;
  border-radius: 0 !important;
}

.metro-dialog::backdrop {
  background: var(--metro-overlay);
  backdrop-filter: blur(4px);
}

.metro-dialog__header {
  position: relative;
  background: var(--metro-surface-raised);
  padding: 0;
  height: 280px;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Blurred, cover-fitted copy fills the whole header behind the sharp image. */
.metro-dialog__img-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  filter: blur(24px) brightness(0.7);
  transform: scale(1.1); /* hide blurred edges */
  z-index: 0;
}

.metro-dialog__img {
  position: relative;
  z-index: 1;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  object-position: center;
  display: block;
}

.metro-dialog__img--hidden {
  display: none;
}

.metro-dialog__header-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 64px;
  color: rgba(255, 255, 255, 0.3);
}

.metro-dialog__close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  color: #ffffff;
  font-size: 18px;
  width: 32px;
  height: 32px;
  cursor: pointer;
  border-radius: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s;
}

.metro-dialog__close:hover {
  background: var(--metro-danger);
}

.metro-dialog__body {
  overflow-y: auto;
  /* Flex child of the column dialog: take the remaining height and allow the
     image and recipe content to scroll together. */
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.metro-dialog__title-bar {
  padding: 16px 20px 8px;
  border-left: 4px solid var(--metro-accent);
}

.metro-dialog__title {
  font-size: 22px;
  font-weight: 300;
  margin: 0;
  line-height: 1.2;
}

.metro-dialog__subtitle {
  font-size: 12px;
  color: var(--metro-text-muted);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metro-actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 20px 12px;
}

.metro-serving-calculator {
  align-items: center;
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.metro-serving-calculator__target {
  background: var(--metro-surface);
  border: 2px solid var(--metro-border);
  box-sizing: border-box;
  color: var(--metro-text);
  font: inherit;
  min-width: 52px;
  padding: 4px 6px;
  text-align: center;
}

.metro-serving-calculator__target:focus-visible,
.metro-serving-calculator__button:focus-visible {
  outline: 2px solid var(--metro-accent);
  outline-offset: 2px;
}

.metro-serving-calculator__button {
  min-width: 30px;
  padding-left: 6px;
  padding-right: 6px;
}

.metro-serving-calculator__button:disabled,
.metro-serving-calculator__target:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* -----------------------------------------------------------------------------
   Meta chips (Portionen, Zeit, Kategorie)
   ----------------------------------------------------------------------------- */

.metro-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 20px 12px;
}

.metro-chip {
  background: var(--metro-surface-raised);
  color: var(--metro-text);
  padding: 4px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-radius: 0;
  white-space: nowrap;
}

.metro-chip--accent {
  background: var(--metro-accent);
  color: #ffffff;
}

/* -----------------------------------------------------------------------------
   Tabs
   ----------------------------------------------------------------------------- */

.metro-tabs {
  display: flex;
  border-bottom: 2px solid var(--metro-border);
  margin: 0 20px;
  gap: 0;
}

.metro-tab {
  background: transparent;
  border: none;
  color: var(--metro-text-muted);
  padding: 10px 16px;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: color 0.15s, border-color 0.15s;
  border-radius: 0;
}

.metro-tab:hover {
  color: var(--metro-text);
}

.metro-tab--active {
  color: var(--metro-accent);
  border-bottom-color: var(--metro-accent);
}

.metro-tab-content {
  padding: 16px 20px;
  min-height: 120px;
}

.metro-tab-panel {
  display: none;
}

.metro-tab-panel--active {
  display: block;
}

/* -----------------------------------------------------------------------------
   Recipe Content (Ingredients / Instructions)
   ----------------------------------------------------------------------------- */

.metro-ingredient-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.metro-ingredient-list__item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--metro-border);
  font-size: 13px;
  line-height: 1.4;
}

.metro-ingredient-list__item:last-child {
  border-bottom: none;
}

.metro-ingredient-list__bullet {
  width: 8px;
  height: 8px;
  background: var(--metro-accent);
  flex-shrink: 0;
  margin-top: 5px;
}

.metro-step-list {
  list-style: none;
  padding: 0;
  margin: 0;
  counter-reset: step-counter;
}

.metro-step-list__item {
  display: flex;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--metro-border);
  font-size: 13px;
  line-height: 1.5;
  counter-increment: step-counter;
}

.metro-step-list__item:last-child {
  border-bottom: none;
}

.metro-step-list__content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
}

.metro-step-list__content label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  line-height: 1.5;
}

.metro-step-list__ingredients,
.metro-step-list__instruction {
  min-width: 0;
}

.metro-step-list__ingredients {
  background: var(--metro-surface);
  border-left: 3px solid var(--metro-accent);
  padding: 8px 10px;
}

.metro-step-list__instruction {
  border-top: 1px solid var(--metro-border);
  padding-top: 10px;
}

.metro-step-list__subheading {
  color: var(--metro-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  line-height: 1.2;
  margin: 0 0 6px;
  text-transform: uppercase;
}

.metro-step-list__ingredients .metro-step-list__subheading {
  color: var(--metro-accent);
}

.metro-step-list__instruction label {
  font-weight: 500;
}

.metro-step-list__content input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  background: var(--metro-surface);
  border: 2px solid var(--metro-border);
  border-radius: 0;
  box-sizing: border-box;
  cursor: pointer;
  flex-shrink: 0;
  height: 16px;
  margin: 3px 0 0;
  position: relative;
  transition: background-color 0.1s, border-color 0.1s;
  width: 16px;
}

.metro-step-list__content input[type="checkbox"]:hover {
  border-color: var(--metro-accent);
}

.metro-step-list__content input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--metro-accent);
  outline-offset: 2px;
}

.metro-step-list__content input[type="checkbox"]:checked {
  background: var(--metro-accent);
  border-color: var(--metro-accent);
}

.metro-step-list__content input[type="checkbox"]:checked::after {
  border-bottom: 2px solid var(--metro-surface);
  border-right: 2px solid var(--metro-surface);
  content: '';
  height: 8px;
  left: 4px;
  position: absolute;
  top: 1px;
  transform: rotate(45deg);
  width: 4px;
}

.metro-step-list__text {
  flex: 1;
}

.metro-step-list__number {
  font-size: 22px;
  font-weight: 300;
  color: var(--metro-accent);
  line-height: 1;
  min-width: 28px;
  flex-shrink: 0;
}

.metro-description {
  font-size: 13px;
  line-height: 1.6;
  color: var(--metro-text-muted);
  font-style: italic;
  margin: 0;
  padding: 12px 20px;
}

.metro-dialog__source {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 20px 12px;
}

.metro-dialog__source:empty {
  display: none;
}

.metro-dialog__source a {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.metro-dialog__source a:focus-visible {
  outline: 2px solid var(--metro-accent);
  outline-offset: 2px;
}

.metro-info-section {
  border-top: 1px solid var(--metro-border);
  margin-top: 16px;
  padding-top: 12px;
}

.metro-info-section:first-child {
  border-top: 0;
  margin-top: 0;
  padding-top: 0;
}

.metro-info-section__heading {
  color: var(--metro-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  line-height: 1.2;
  margin: 0 0 8px;
  text-transform: uppercase;
}

.metro-info-source__link {
  display: inline-block;
  text-decoration: none;
}

.metro-info-source__url {
  margin-top: 6px;
  color: var(--metro-text-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.metro-info-section__nutrition {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0;
  overflow-wrap: anywhere;
}

.metro-info-section__nutrition dt,
.metro-info-section__nutrition dd {
  min-width: 0;
  margin: 0;
}

.metro-info-section__nutrition dt {
  color: var(--metro-text-muted);
}

.metro-info-section__nutrition dd {
  text-align: right;
}

/* "Heute gekocht" button — neutral by default, green when cooked today */
.metro-btn--cooked {
  background: var(--metro-surface-raised);
  color: var(--metro-text-muted);
  border: 2px solid var(--metro-border);
}

.metro-btn--cooked:hover {
  background: var(--metro-border);
  color: var(--metro-text);
}

.metro-btn--cooked[data-cooked="true"] {
  background: var(--metro-success);
  color: #ffffff;
  border-color: var(--metro-success);
}

/* -----------------------------------------------------------------------------
   Star Rating
   ----------------------------------------------------------------------------- */

.metro-rating {
  display: flex;
  align-items: center;
  gap: 4px;
}

.metro-rating__star {
  font-size: 22px;
  cursor: pointer;
  color: var(--metro-border);
  transition: color 0.1s, transform 0.1s;
  line-height: 1;
  background: none;
  border: none;
  padding: 2px;
}

.metro-rating__star:hover,
.metro-rating__star--active {
  color: #ffd700;
}

.metro-rating__star:hover {
  transform: scale(1.2);
}

.metro-rating__label {
  font-size: 11px;
  color: var(--metro-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-left: 4px;
}

/* -----------------------------------------------------------------------------
   Actions Bar (bottom of dialog)
   ----------------------------------------------------------------------------- */

.metro-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 20px;
  border-top: 1px solid var(--metro-border);
  border-bottom: 1px solid var(--metro-border);
  background: var(--metro-surface);
}

.metro-actions__last-cooked {
  font-size: 11px;
  color: var(--metro-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  flex: 1;
  text-align: right;
}

.metro-actions__error {
  min-height: 0;
  flex-basis: 100%;
  align-items: flex-start;
  text-align: left;
}

.metro-serving-calculator {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.metro-serving-calculator > span {
  color: var(--metro-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.metro-serving-calculator__button {
  align-items: center;
  display: inline-flex;
  font-size: 16px;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  padding: 8px;
}

.metro-serving-calculator__target {
  background: var(--metro-surface);
  border: 2px solid var(--metro-border);
  border-radius: 0;
  box-sizing: border-box;
  color: var(--metro-text);
  font: inherit;
  font-size: 16px !important;
  min-height: 44px;
  min-width: 64px;
  padding: 8px;
  text-align: center;
  width: 64px;
}

.metro-serving-calculator__target:focus-visible,
.metro-serving-calculator__button:focus-visible {
  outline: 2px solid var(--metro-accent);
  outline-offset: 2px;
}

.metro-serving-calculator__target:disabled,
.metro-serving-calculator__button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* -----------------------------------------------------------------------------
   Error / Empty States
   ----------------------------------------------------------------------------- */

.metro-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--metro-danger);
  text-align: center;
  font-size: 13px;
}

.metro-error__icon {
  font-size: 40px;
}

.metro-error__message {
  max-width: 300px;
  line-height: 1.5;
}

.metro-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 160px;
  color: var(--metro-text-muted);
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* -----------------------------------------------------------------------------
   Utility Classes
   ----------------------------------------------------------------------------- */

.metro-hidden {
  display: none !important;
}

.metro-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* -----------------------------------------------------------------------------
   Random Recipe Card — custom:cookbook-random-card
   Compact single-tile card. Shares the Metro tokens and the tile language
   above; every rule below is scoped to the random card so the grid card
   styling is untouched.
   ----------------------------------------------------------------------------- */

.cookbook-random-card {
  background: transparent;
  color: var(--metro-text);
  padding: 0;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-size: 14px;
}

.cookbook-random-card__view {
  position: relative;
  max-width: 600px;
}

/* Next-recipe control, overlaid on the tile's top-right corner */
.cookbook-random-card__view .metro-btn--next {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  padding: 6px 10px;
  font-size: 15px;
  line-height: 1;
  background: var(--metro-surface-raised);
  color: var(--metro-text);
}

.cookbook-random-card__view .metro-btn--next:hover {
  background: var(--metro-accent);
  color: #ffffff;
}

.cookbook-random-card__view .metro-btn--next:active {
  background: var(--metro-accent-active);
  color: var(--metro-text-inverse);
}

.cookbook-random-card__view .metro-btn--next:focus-visible {
  outline: 2px solid var(--metro-accent);
  outline-offset: 2px;
}

/* ── Weekly recipe calendar (feature-10) ────────────────────────────────── */
.cal { display: flex; flex-direction: column; gap: 12px; }
.cal-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px; padding: 8px 10px; background: var(--metro-surface-raised);
  border: 1px solid var(--metro-border);
}
.cal-title {
  font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  color: var(--metro-text); font-size: 15px;
}
.cal-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.cal-range { min-width: 170px; text-align: center; font-weight: 600; }
.cal-nav__btn { min-width: 36px; font-size: 16px; line-height: 1; }
.cal-body { display: flex; flex-direction: column; gap: 8px; }
.cal-body--grid { display: block; }
@media (min-width: 900px) {
  .cal-body--grid {
    display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; align-items: start;
  }
}

/* Image-tile week ("Live-Tile") — feature-10 image-grid layout. Desktop and
   tablet use seven equal columns with horizontal scrolling; phones keep the
   vertical list. Each day is a Metro tile column; recipes are square image
   tiles with a dark name overlay, or plain text cards as fallback. */
/* Keep the host from stretching to the grid's content width so the week can
   scroll inside the card on narrow screens instead of widening the page. */
.cookbook-weekly-calendar { display: block; min-width: 0; max-width: 100%; }
.cookbook-weekly-calendar__view { min-width: 0; max-width: 100%; }
.cal { min-width: 0; max-width: 100%; }
.cal-body--image-grid { display: block; padding-bottom: 4px; min-width: 0; }
@media (min-width: 600px) {
  /* The grid itself scrolls: give it a bounded width (100% of the card) and let
     the fixed 160px day columns overflow into an internal horizontal scroll. */
  .cal-body--image-grid {
    display: grid;
    grid-template-columns: repeat(7, 160px);
    gap: 6px;
    align-items: start;
    /* Force the grid's width from its container, not its content, so
       overflow-x can actually engage. */
    width: 0;
    min-width: 100%;
    overflow-x: auto;
  }
}
.cal-body--image-grid .cal-day { background: var(--metro-surface); border: 1px solid var(--metro-border); }
.cal-body--image-grid .cal-day--today { border-color: var(--metro-accent); box-shadow: inset 0 2px 0 var(--metro-accent); }
.cal-body--image-grid .cal-day__head { background: var(--metro-surface-raised); padding: 6px 8px; }
.cal-body--image-grid .cal-day--today .cal-day__head { background: var(--metro-accent); }
.cal-body--image-grid .cal-day--today .cal-day__title { color: var(--metro-text-inverse); }
.cal-body--image-grid .cal-day__body { gap: 8px; padding: 8px; }
.cal-body--image-grid .cal-slot__label { margin-bottom: 2px; }
.cal-body--image-grid .cal-slot__entries { gap: 6px; }
.cal-tile { position: relative; display: block; width: 100%; aspect-ratio: 1/1; overflow: hidden; cursor: pointer; background: var(--metro-surface-raised); }
.cal-tile:focus-visible { outline: 2px solid var(--metro-accent); outline-offset: 2px; }
.cal-tile__img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cal-tile__overlay {
  position: absolute; inset: auto 0 0 0; padding: 4px 6px; background: rgba(0,0,0,.62);
  display: flex; flex-direction: column; gap: 2px;
}
.cal-tile__name { color: #fff; font-size: 12px; font-weight: 600; line-height: 1.2; }
.cal-tile__note { color: var(--metro-text-muted); font-size: 10px; line-height: 1.2; }
.cal-tile--text {
  aspect-ratio: auto; display: flex; flex-direction: column; justify-content: center;
  padding: 10px 8px; border: 1px solid var(--metro-border); cursor: default;
}
.cal-tile--text .cal-tile__name { color: var(--metro-text); font-weight: 500; }
.cal-tile__edit {
  position: absolute; top: 4px; right: 4px; min-width: 26px; padding: 2px 6px;
  background: var(--metro-surface-raised); border: 1px solid var(--metro-border); font-size: 12px;
}
.cal-tile--text .cal-tile__edit { position: static; align-self: flex-end; margin-top: 6px; }
.cal-body--image-grid .cal-add { width: 100%; padding: 8px; }
.cal-day { background: var(--metro-surface); border: 1px solid var(--metro-border); }
.cal-day--today { border-color: var(--metro-accent); }

/* Frameless mode: remove ONLY the outer borders (toolbar + day tiles) so the
   card stops drawing a second frame over the surrounding ha-card. Backgrounds,
   paddings, margins and the today accent are all left untouched. */
.cal--frameless .cal-toolbar { border: 0; }
.cal--frameless .cal-day { border: 0; }
.cal--frameless .cal-body--image-grid .cal-day { border: 0; }
.cal-day__head {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 8px 10px; background: transparent; border: 0; cursor: pointer;
  color: var(--metro-text); font: inherit; text-align: left;
}
.cal-day__head:hover { background: var(--metro-surface-raised); }
.cal-day__title { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; font-size: 13px; }
.cal-day--today .cal-day__title { color: var(--metro-accent); }
.cal-day__body { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 10px; }
.cal-day__body--collapsed { display: none; }
.cal-slot { display: flex; flex-direction: column; gap: 4px; }
.cal-slot__label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--metro-text-muted);
}
.cal-slot__entries { display: flex; flex-direction: column; gap: 4px; }
.cal-entry {
  display: flex; align-items: center; gap: 8px; padding: 4px 6px;
  background: var(--metro-surface-raised); border: 1px solid var(--metro-border);
}
.cal-entry__main {
  display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; cursor: pointer;
}
.cal-entry__main:focus-visible { outline: 2px solid var(--metro-accent); outline-offset: 2px; }
.cal-entry__img { width: 34px; height: 34px; object-fit: cover; flex: 0 0 auto; background: var(--metro-bg); }
.cal-entry__body { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.cal-entry__name {
  color: var(--metro-text); font-size: 13px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.cal-entry__note {
  color: var(--metro-text-muted); font-size: 11px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.cal-entry--missing .cal-entry__name { color: var(--metro-text-muted); font-style: italic; }
.cal-entry--text .cal-entry__name { color: var(--metro-text); }
.cal-entry__edit { flex: 0 0 auto; min-width: 30px; padding: 2px 6px; font-size: 13px; }
.cal-add {
  align-self: flex-start; min-width: 30px; padding: 2px 10px; font-size: 15px; line-height: 1.2;
  background: transparent; border: 1px dashed var(--metro-border); color: var(--metro-text-muted);
}
.cal-add:hover { color: var(--metro-text); border-color: var(--metro-accent); }
.cal-add--day { align-self: stretch; width: 100%; padding: 6px 10px; }
.cal--compact .cal-day__body { gap: 4px; padding: 4px 6px 8px; }
.cal--compact .cal-entry__img { width: 26px; height: 26px; }
.cal--compact .cal-entry__name { font-size: 12px; }
.cal-skeleton { display: flex; flex-direction: column; gap: 8px; }
.cal-day--skeleton {
  height: 48px; background: var(--metro-surface-raised);
  border: 1px solid var(--metro-border); opacity: .5;
}
.cal-add-dialog .metro-dialog__body { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.cal-add-dialog__header { font-weight: 700; font-size: 16px; margin: 0; }
.cal-add-dialog__search {
  width: 100%; box-sizing: border-box; padding: 8px; margin: 0;
  font-size: 13px; height: 36px; min-height: 36px; max-height: 36px;
  line-height: 1.2; flex: 0 0 auto;
}
.cal-add-dialog__slot-row { display: flex; align-items: center; gap: 8px; }
.cal-add-dialog__slot-label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--metro-text-muted); }
.cal-add-dialog__slot { flex: 1 1 auto; padding: 8px; }
.cal-add-dialog__results { display: flex; flex-direction: column; gap: 4px; max-height: 50vh; overflow: auto; }
.cal-add-dialog__item { display: flex; align-items: center; gap: 8px; text-align: left; }
.cal-add-dialog__img { width: 32px; height: 32px; object-fit: cover; flex: 0 0 auto; background: var(--metro-bg); }
.cal-add-dialog__item-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cal-add-dialog__text {
  margin: 0; text-align: left; border: 1px dashed var(--metro-border);
  background: transparent; color: var(--metro-text-muted);
}
.cal-add-dialog__text:hover:not(:disabled) { color: var(--metro-text); border-color: var(--metro-accent); }
.cal-add-dialog__text:disabled { opacity: .5; cursor: default; }
.cal-add-dialog__hint { font-size: 11px; color: var(--metro-text-muted); }
.cal-add-dialog__status { font-size: 11px; color: var(--metro-success); }
.cal-add-dialog__error { font-size: 11px; color: var(--metro-danger); }
.cal-editor-dialog .metro-dialog__body { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.cal-editor__heading { font-weight: 700; font-size: 16px; margin: 0 0 4px; }
.cal-editor-dialog input, .cal-editor-dialog select { box-sizing: border-box; width: 100%; padding: 10px; margin: 0; font: inherit; }
.cal-editor-dialog .metro-btn { margin-top: 4px; }
.cal-editor__confirm { margin-top: 8px; padding: 12px; border: 1px solid var(--metro-danger); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
/* Desktop, non-touch: use half the screen with a sensible minimum. */
@media (hover: hover) and (pointer: fine) and (min-width: 641px) {
  .cal-editor-dialog,
  .cal-add-dialog { width: 50vw; min-width: 420px; max-width: 720px; }
}
/* Touch / small screens: full-screen dialogs. */
@media (max-width: 640px), (pointer: coarse) {
  .cal-editor-dialog,
  .cal-add-dialog { width: 100vw; max-width: 100vw; height: 100vh; max-height: 100vh; }
}
`;
    shadowRoot.appendChild(style);
}

class CookbookCard extends HTMLElement {
  constructor() {
    super();
    this._config   = null;
    this._hass     = null;
    this._i18n     = createCardI18n(null, {});
    this._api      = null;
    this._cache    = null;
    this._grid     = null;
    this._popup    = null;
    this._editor   = null;
    this._mounted  = false;
    this._syncing  = false;
    this._resizeObserver = null;
    this._legacyColumnsWarningShown = false;

    // URL deep-link state. _currentRecipeId is the recipe currently reflected in
    // the URL; _syncingUrl guards against feedback loops between our own URL
    // writes and the popstate handler.
    this._currentRecipeId = null;
    this._syncingUrl      = false;
    this._onPopState      = this._handlePopState.bind(this);

    // Attach Shadow DOM — this is the key: CSS injected here is scoped correctly
    this.attachShadow({ mode: 'open' });
    this._injectShadowStyles();
  }

  _injectShadowStyles() {
    injectMetroShadowStyles(this.shadowRoot);
  }

  setConfig(config) {
    const previousLocale = this._i18n.locale;
    this._config = config || {};
    this._i18n = createCardI18n(this._hass, this._config);
    if (this._mounted) {
      if (previousLocale !== this._i18n.locale) this._applyI18n();
      this._applyColumns();
    }
  }

  set hass(hass) {
    window.__hass = hass;
    const previousLocale = this._i18n.locale;
    this._hass    = hass;
    this._i18n = createCardI18n(hass, this._config);

    if (!this._mounted) {
      this._mount();
      return;
    }


    this._api?.setHass(hass);
    if (previousLocale !== this._i18n.locale) this._applyI18n();
  }

  _applyI18n() {
    this._api?.setI18n(this._i18n);
    this._grid?.setI18n(this._i18n);
    this._popup?.setI18n(this._i18n);
  }

  connectedCallback() {
    if (!this._mounted || !this._grid) return;
    // Re-register the popstate listener removed on disconnect (view switches).
    window.removeEventListener('popstate', this._onPopState);
    window.addEventListener('popstate', this._onPopState);
    this._observeColumnContainer();
    // Show stale data instantly, then revalidate in the background so new
    // recipes appear automatically. Re-open a deep-linked recipe afterwards.
    this._staleThenRevalidate().then(() => this._openFromUrl());
  }

  async _mount() {
    this._mounted = true;

    // Root container inside Shadow DOM
    this._root = document.createElement('div');
    this._root.className = 'cookbook-card';
    this.shadowRoot.appendChild(this._root);
    this._warnLegacyColumnsConfig();

    this._applyColumns();

    this._cache = new RecipeCache(600);
    this._api   = new CookbookApi(this._hass, this._cache, { i18n: this._i18n });

    const recipeViewConfig = normalizeRecipeViewConfig(this._config || {});
    const dialogSize = this._config?.dialog_size || 'large';
    const newBannerDays = this._newBannerDays();
    const defaultSort = this._config?.default_sort ?? '';

    this._grid = new GridView(
      this._root,
      this._api,
      (id) => this._openRecipe(id),
      PLACEHOLDER_URL,
      newBannerDays,
      defaultSort,
      {
        onAdd: () => this._openEditor(),
        i18n: this._i18n,
      },
    );

    this._popup = new RecipePopup(
      this._root,
      this._api,
      PLACEHOLDER_URL,
      dialogSize,
      () => this._onPopupClosed(),
      recipeViewConfig,
      {
        onDelete: recipe => this._deleteRecipe(recipe),
        onSaved: () => this._refreshAfterCrud(),
        i18n: this._i18n,
      }
    );
    // The editor lives inside the recipe dialog: it renders into a host element
    // the popup provides, so both share the same <dialog>, size and scrolling.
    this._popup.setEditorFactory((host, onSaved, onCancel) =>
      new RecipeEditor(host, this._api, onSaved, onCancel, {
        aiTaskEntity: this._config?.ai_task_entity,
        i18n: this._i18n,
      }));

    // React to browser back/forward so the dialog follows the URL.
    // Remove first to stay idempotent if connect/mount order varies.
    window.removeEventListener('popstate', this._onPopState);
    window.addEventListener('popstate', this._onPopState);

    this._applyColumns();
    this._observeColumnContainer();

    // Show stale data instantly, then revalidate from the API in the background.
    await this._staleThenRevalidate();

    // Deep-link: if the URL already names a recipe, open it now.
    this._openFromUrl();
  }

  /** Read new_banner_days from config, clamped to a sane range (default 30). */
  _newBannerDays() {
    const raw = parseInt(this._config?.new_banner_days ?? DEFAULT_NEW_DAYS, 10);
    if (Number.isNaN(raw)) return DEFAULT_NEW_DAYS;
    return Math.max(1, Math.min(365, raw));
  }

  /**
   * Stale-while-revalidate: render the current (possibly stale) data
   * immediately, then fetch fresh data from the API in the background and
   * re-render. New recipes appear automatically; existing tiles stay visible
   * with a small loading indicator while revalidating.
   */
  async _staleThenRevalidate() {
    // 1. Instant: show whatever we already have (cache or local file).
    await this._grid.loadFromCache();

    // 2. Background: revalidate from the API and re-render on fresh data.
    if (this._syncing || !this._api || !this._hass) return;
    this._syncing = true;
    try {
      this._grid?.showSyncIndicator(true);
      await this._grid?.revalidate();
    } finally {
      this._grid?.showSyncIndicator(false);
      this._syncing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // URL deep-linking — ?recipe=<id> reflects the open dialog
  // ---------------------------------------------------------------------------

  /**
   * Open a recipe and reflect it in the URL. Called on tile click.
   * @param {string|number} id
   */
  _openRecipe(id) {
    this._writeRecipeParam(String(id));
    this._currentRecipeId = String(id);
    this._popup.open(id);
  }

  async _openEditor(id = null) {
    try {
      const recipe = id ? await this._api.getRecipe(id) : null;
      await this._popup.openEditor(recipe);
    } catch (error) {
      this._grid._showError(error instanceof Error ? error.message : String(error), true);
    }
  }

  async _deleteRecipe(recipe) {
    try {
      await this._api.deleteRecipe(recipe.id);
      await this._refreshAfterCrud();
    } catch (error) {
      this._grid._showError(error instanceof Error ? error.message : String(error), true);
    }
  }

  async _refreshAfterCrud() {
    await this._grid.revalidate();
  }

  /** Popup closed (any path): drop the URL parameter. */
  _onPopupClosed() {
    this._currentRecipeId = null;
    this._writeRecipeParam(null);
  }

  /** On mount: open the recipe named in the URL, if any (silently skip if invalid). */
  async _openFromUrl() {
    const id = this._readRecipeParam();
    if (!id) return;
    // Only open if the recipe actually exists in the current list; otherwise
    // strip the parameter silently and show the normal grid.
    const exists = (this._grid?._recipes || []).some(r => String(r.id) === id);
    if (!exists) {
      this._writeRecipeParam(null);
      return;
    }
    this._currentRecipeId = id;
    this._popup.open(id);
  }

  /** Browser back/forward: sync the dialog to the (possibly changed) URL. */
  _handlePopState() {
    if (this._syncingUrl) return;
    const id = this._readRecipeParam();
    if (id && id !== this._currentRecipeId) {
      const exists = (this._grid?._recipes || []).some(r => String(r.id) === id);
      if (!exists) return;
      this._currentRecipeId = id;
      this._popup.open(id);
    } else if (!id && this._popup?.isOpen) {
      this._currentRecipeId = null;
      this._popup.close();
    }
  }

  /** Read the recipe id from the current URL query string, or null. */
  _readRecipeParam() {
    try {
      const v = new URLSearchParams(window.location.search).get(RECIPE_URL_PARAM);
      return v ? String(v) : null;
    } catch {
      return null;
    }
  }

  /**
   * Write (or clear when id is null) the recipe query parameter using
   * history.replaceState — no new history entry, so it does not collide with
   * HA's own dialog history handling.
   * @param {string|null} id
   */
  _writeRecipeParam(id) {
    try {
      const params = new URLSearchParams(window.location.search);
      if (id) params.set(RECIPE_URL_PARAM, id);
      else    params.delete(RECIPE_URL_PARAM);
      const qs  = params.toString();
      const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
      this._syncingUrl = true;
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* URL API unavailable — ignore, dialog still works */
    } finally {
      this._syncingUrl = false;
    }
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this._onPopState);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }

  _warnLegacyColumnsConfig() {
    if (!Object.hasOwn(this._config || {}, 'columns') || this._legacyColumnsWarningShown) return;
    console.warn('cookbook-card: config key "columns" is ignored. Use columns_mobile, columns_tablet and columns_desktop instead.');
    this._legacyColumnsWarningShown = true;
  }

  _observeColumnContainer() {
    if (!this._root || typeof ResizeObserver !== 'function') return;
    this._resizeObserver?.disconnect();
    this._resizeObserver = new ResizeObserver(() => this._applyColumns());
    this._resizeObserver.observe(this._root);
  }

  _applyColumns() {
    const width = this._root?.getBoundingClientRect?.().width ?? 0;
    const val = String(this._effectiveColumns(width));
    if (this._root)       this._root.style.setProperty('--metro-columns', val);
    if (this._grid?.gridEl) this._grid.gridEl.style.setProperty('--metro-columns', val);
  }

  _effectiveColumns(containerWidth) {
    if (containerWidth >= GRID_DESKTOP_MIN_WIDTH) {
      return this._columnsValue('columns_desktop', GRID_COLUMNS_DESKTOP_DEFAULT);
    }
    if (containerWidth >= GRID_TABLET_MIN_WIDTH) {
      return this._columnsValue('columns_tablet', GRID_COLUMNS_TABLET_DEFAULT);
    }
    return this._columnsValue('columns_mobile', GRID_COLUMNS_MOBILE_DEFAULT);
  }

  _columnsValue(configKey, fallback) {
    const columns = parseInt(this._config?.[configKey] ?? fallback, 10);
    if (Number.isNaN(columns)) return fallback;
    return Math.max(GRID_COLUMNS_MIN, Math.min(GRID_COLUMNS_MAX, columns));
  }

  static getStubConfig() {
    return {
      language: 'auto',
      columns_mobile: GRID_COLUMNS_MOBILE_DEFAULT,
      columns_tablet: GRID_COLUMNS_TABLET_DEFAULT,
      columns_desktop: GRID_COLUMNS_DESKTOP_DEFAULT,
      dialog_size: 'large',
      default_sort: 'date-desc',
      new_banner_days: 30,
      recipe_default_tab: 'ingredients',
    };
  }

  static getConfigElement() {
    return document.createElement('cookbook-card-editor');
  }
}

class CookbookCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._i18n = createCardI18n(null, this._config);
    this._built = false;
    this._controls = {};
    this.attachShadow({ mode: 'open' });
  }

  set hass(value) {
    const previousLocale = this._i18n.locale;
    this._hass = value;
    this._i18n = createCardI18n(value, this._config);
    if (!this._built) this._render();
    else if (previousLocale !== this._i18n.locale) this._renderPreservingFocus();
    else this._refreshAiOptions();
  }

  setConfig(config) {
    const previousLocale = this._i18n.locale;
    this._config = { ...CookbookCard.getStubConfig(), ...(config || {}) };
    this._i18n = createCardI18n(this._hass, this._config);
    // Build once; afterwards only sync values so typing never loses focus.
    if (!this._built) this._render();
    else if (previousLocale !== this._i18n.locale) this._renderPreservingFocus();
    else this._syncValues();
  }

  _activeControl() {
    return this.shadowRoot?.activeElement ?? document.activeElement ?? null;
  }

  _renderPreservingFocus() {
    const activeName = this._activeControl()?.name;
    this._render();
    if (activeName) this._controls[activeName]?.focus?.();
  }

  /** Available ai_task.* entity ids from hass, for the datalist. */
  _aiTaskEntities() {
    const states = this._hass?.states || {};
    return Object.keys(states).filter((id) => id.startsWith('ai_task.')).sort();
  }

  _refreshAiOptions() {
    if (!this._built || !this._controls.aiDatalist) return;
    const datalist = this._controls.aiDatalist;
    datalist.innerHTML = '';
    this._aiTaskEntities().forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      datalist.appendChild(opt);
    });
  }

  /** Update control values from config without rebuilding the DOM. */
  _syncValues() {
    Object.entries(this._controls).forEach(([name, el]) => {
      if (!el || name === 'aiDatalist') return;
      const value = this._config[name] == null ? '' : String(this._config[name]);
      if (el.value !== value && document.activeElement !== el && el.shadowRoot?.activeElement !== el) {
        el.value = value;
      }
    });
  }

  _render() {
    if (!this.shadowRoot) return;
    this._built = true;
    this._controls = {};
    const t = this._i18n.t;
    const labels = {
      columnsMobile: t('card_editor.columns_mobile'),
      columnsTablet: t('card_editor.columns_tablet'),
      columnsDesktop: t('card_editor.columns_desktop'),
      size: t('card_editor.dialog_size'),
      sort: t('card_editor.default_sort'),
      days: t('card_editor.new_banner_days'),
      tab: t('card_editor.default_tab'),
      language: t('card_editor.language'),
    };
    const options = {
      size: [
        ['fullscreen', t('card_editor.size_fullscreen')],
        ['large', t('card_editor.size_large')],
        ['medium', t('card_editor.size_medium')],
      ],
      sort: [
        ['date-desc', t('grid.sort_date_desc')],
        ['date-asc', t('grid.sort_date_asc')],
        ['name-asc', t('grid.sort_name_asc')],
        ['name-desc', t('grid.sort_name_desc')],
      ],
      tab: [
        ['ingredients', t('card_editor.tab_ingredients')],
        ['instructions', t('card_editor.tab_instructions')],
        ['info', t('card_editor.tab_info')],
      ],
      language: [
        ['auto', t('card_editor.language_auto')],
        ['de', t('card_editor.language_de')],
        ['en', t('card_editor.language_en')],
      ],
    };
    const hints = {
      columnsMobile: t('card_editor.hint_columns_mobile'),
      columnsTablet: t('card_editor.hint_columns_tablet'),
      columnsDesktop: t('card_editor.hint_columns_desktop'),
      days: t('card_editor.hint_new_banner_days'),
      size: t('card_editor.hint_dialog_size'),
      sort: t('card_editor.hint_default_sort'),
      tab: t('card_editor.hint_default_tab'),
      ai: t('card_editor.hint_ai_task'),
    };

    this.shadowRoot.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
      .row { display: grid; gap: 6px; margin: 12px 0; }
      label { font-size: 14px; font-weight: 500; }
      input, select { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; }
      .row__hint { font-size: 12px; color: var(--secondary-text-color, #6b7280); line-height: 1.35; }
    `;
    this.shadowRoot.appendChild(style);

    const form = document.createElement('div');
    form.appendChild(this._input('columns_mobile', labels.columnsMobile, 'number', GRID_COLUMNS_MIN, GRID_COLUMNS_MAX, hints.columnsMobile));
    form.appendChild(this._input('columns_tablet', labels.columnsTablet, 'number', GRID_COLUMNS_MIN, GRID_COLUMNS_MAX, hints.columnsTablet));
    form.appendChild(this._input('columns_desktop', labels.columnsDesktop, 'number', GRID_COLUMNS_MIN, GRID_COLUMNS_MAX, hints.columnsDesktop));
    form.appendChild(this._input('new_banner_days', labels.days, 'number', 1, 365, hints.days));
    form.appendChild(this._select('dialog_size', labels.size, options.size, hints.size));
    form.appendChild(this._select('default_sort', labels.sort, options.sort, hints.sort));
    form.appendChild(this._select('recipe_default_tab', labels.tab, options.tab, hints.tab));
    form.appendChild(this._select('language', labels.language, options.language));
    form.appendChild(this._aiEntityField('ai_task_entity', t('editor.ai_task_entity'), hints.ai));
    this.shadowRoot.appendChild(form);
    this._refreshAiOptions();
  }

  /** AI entity field: a text input with a datalist of available ai_task.*
   *  entities (native autocomplete). Free text is still allowed. */
  _aiEntityField(name, label, hint) {
    const row = document.createElement('div');
    row.className = 'row';
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    const input = document.createElement('input');
    input.name = name;
    input.type = 'text';
    input.setAttribute('placeholder', 'ai_task.…');
    const listId = 'cookbook-ai-tasks';
    input.setAttribute('list', listId);
    input.value = this._config[name] == null ? '' : String(this._config[name]);
    input.addEventListener('input', () => this._onControlChange(name, input.value, false));
    input.addEventListener('change', () => this._onControlChange(name, input.value, false));
    const datalist = document.createElement('datalist');
    datalist.id = listId;
    labelElement.appendChild(input);
    row.appendChild(labelElement);
    row.appendChild(datalist);
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'row__hint';
      hintEl.textContent = hint;
      row.appendChild(hintEl);
    }
    this._controls[name] = input;
    this._controls.aiDatalist = datalist;
    return row;
  }

  /** Emit config-changed, coercing empty number/text to a removed key. */
  _onControlChange(name, rawValue, isNumber) {
    const next = { ...this._config };
    if (isNumber) {
      const num = Number(rawValue);
      if (rawValue === '' || Number.isNaN(num)) delete next[name];
      else next[name] = num;
    } else if (rawValue === '') {
      delete next[name];
    } else {
      next[name] = rawValue;
    }
    this._config = next;
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } }, bubbles: true, composed: true,
    }));
  }

  _input(name, label, type, min, max, hint) {
    const row = document.createElement('div');
    row.className = 'row';
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    if (min !== undefined && max !== undefined) {
      input.min = String(min);
      input.max = String(max);
    }
    // Set as a real DOM property so the value actually shows (no innerHTML
    // round-trip that would drop it).
    input.value = this._config[name] == null ? '' : String(this._config[name]);
    const isNumber = type === 'number';
    input.addEventListener('input', () => this._onControlChange(name, input.value, isNumber));
    input.addEventListener('change', () => this._onControlChange(name, input.value, isNumber));
    labelElement.appendChild(input);
    row.appendChild(labelElement);
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'row__hint';
      hintEl.textContent = hint;
      row.appendChild(hintEl);
    }
    this._controls[name] = input;
    return row;
  }

  _select(name, label, values, hint) {
    const row = document.createElement('div');
    row.className = 'row';
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    const select = document.createElement('select');
    select.name = name;
    values.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (this._config[name] === value) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', () => this._onControlChange(name, select.value, false));
    labelElement.appendChild(select);
    row.appendChild(labelElement);
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'row__hint';
      hintEl.textContent = hint;
      row.appendChild(hintEl);
    }
    this._controls[name] = select;
    return row;
  }
}

if (!customElements.get('cookbook-card-editor')) customElements.define('cookbook-card-editor', CookbookCardEditor);

class CookbookRandomCardEditor extends CookbookCardEditor {
  static getStubConfig() {
    return {
      language: 'auto',
      duration: '4h',
      category: '',
      tags: '',
      new_banner_days: 30,
      dialog_size: 'large',
      recipe_default_tab: 'ingredients',
    };
  }

  setConfig(config) {
    const previousLocale = this._i18n.locale;
    this._config = { ...CookbookRandomCardEditor.getStubConfig(), ...(config || {}) };
    this._i18n = createCardI18n(this._hass, this._config);
    if (!this._built) this._render();
    else if (previousLocale !== this._i18n.locale) this._renderPreservingFocus();
    else this._syncValues();
  }

  _render() {
    if (!this.shadowRoot) return;
    this._built = true;
    this._controls = {};
    const t = this._i18n.t;
    const labels = {
      duration: t('random_editor.duration'),
      category: t('random_editor.category'),
      tags: t('random_editor.tags'),
      days: t('random_editor.new_banner_days'),
      size: t('random_editor.dialog_size'),
      tab: t('random_editor.default_tab'),
      language: t('random_editor.language'),
    };
    const hints = {
      duration: t('random_editor.hint_duration'),
      category: t('random_editor.hint_category'),
      tags: t('random_editor.hint_tags'),
      days: t('random_editor.hint_new_banner_days'),
    };
    const options = {
      size: [
        ['fullscreen', t('card_editor.size_fullscreen')],
        ['large', t('card_editor.size_large')],
        ['medium', t('card_editor.size_medium')],
      ],
      tab: [
        ['ingredients', t('card_editor.tab_ingredients')],
        ['instructions', t('card_editor.tab_instructions')],
        ['info', t('card_editor.tab_info')],
      ],
      language: [
        ['auto', t('card_editor.language_auto')],
        ['de', t('card_editor.language_de')],
        ['en', t('card_editor.language_en')],
      ],
    };

    this.shadowRoot.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `:host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); } .row { display: grid; gap: 6px; margin: 12px 0; } label { font-size: 14px; font-weight: 500; } input, select { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; } .row__hint { font-size: 12px; color: var(--secondary-text-color, #6b7280); line-height: 1.35; }`;
    this.shadowRoot.appendChild(style);

    const form = document.createElement('div');
    form.appendChild(this._input('duration', labels.duration, 'text', undefined, undefined, hints.duration));
    form.appendChild(this._input('category', labels.category, 'text', undefined, undefined, hints.category));
    form.appendChild(this._input('tags', labels.tags, 'text', undefined, undefined, hints.tags));
    form.appendChild(this._input('new_banner_days', labels.days, 'number', 1, 365, hints.days));
    form.appendChild(this._select('dialog_size', labels.size, options.size, ''));
    form.appendChild(this._select('recipe_default_tab', labels.tab, options.tab, ''));
    form.appendChild(this._select('language', labels.language, options.language));
    this.shadowRoot.appendChild(form);
  }
}

if (!customElements.get('cookbook-random-card-editor')) customElements.define('cookbook-random-card-editor', CookbookRandomCardEditor);

// ─────────────────────────────────────────────────────────────────────────────
// Random Recipe Card (custom:cookbook-random-card) — feature-09
//
// Compact dashboard card: shows one random recipe in the shared Metro tile
// language, rotates it after a configurable duration (HA duration format,
// parsed at this boundary via services/random-logic.js) and opens the existing
// RecipePopup when the tile is activated. Rotation pauses while the popup is
// open and resumes when it closes. Config is YAML-only by design: the config
// surface is a handful of flat values (duration, category, tags, dialog_size,
// recipe_default_tab and new_banner_days).
// ─────────────────────────────────────────────────────────────────────────────

class CookbookRandomCard extends HTMLElement {
  constructor() {
    super();
    this._config  = null;
    this._hass    = null;
    this._i18n    = createCardI18n(null, {});
    this._api     = null;
    this._cache   = null;
    this._view    = null;
    this._popup   = null;
    this._root    = null;
    this._mounted = false;

    this.attachShadow({ mode: 'open' });
    injectMetroShadowStyles(this.shadowRoot);
  }

  setConfig(config) {
    const previousLocale = this._i18n.locale;
    this._config = config || {};
    this._i18n = createCardI18n(this._hass, this._config);
    if (this._mounted && previousLocale !== this._i18n.locale) this._applyI18n();
  }

  static getStubConfig() {
    return { duration: '4h', language: 'auto' };
  }

  static getConfigElement() {
    return document.createElement('cookbook-random-card-editor');
  }

  // Frequent hass pushes after mount only refresh the API connection — the
  // rotation timer must never be reset here.
  set hass(hass) {
    const previousLocale = this._i18n.locale;
    this._hass = hass;
    this._i18n = createCardI18n(hass, this._config);
    if (!this._mounted) {
      // Never mount from a hass push while detached: HA keeps pushing hass
      // to detached cards (view churn), and a detached mount would arm the
      // rotation timer and load the pool outside the DOM. connectedCallback
      // owns the mount for the hass-before-insert order.
      if (this.isConnected) this._mount();
      return;
    }
    this._api?.setHass(hass);
    if (previousLocale !== this._i18n.locale) this._applyI18n();
  }

  _applyI18n() {
    this._api?.setI18n(this._i18n);
    this._view?.setI18n(this._i18n);
    this._popup?.setI18n(this._i18n);
  }

  // Covers the hass-then-insert order: hass may arrive before the element is
  // connected, so a later connect must still mount.
  connectedCallback() {
    if (!this._mounted && this._hass) this._mount();
  }

  async _mount() {
    if (this._mounted) return;
    this._mounted = true;

    this._root = document.createElement('div');
    this._root.className = 'cookbook-random-card';
    this.shadowRoot.appendChild(this._root);

    this._cache = new RecipeCache(600);
    this._api   = new CookbookApi(this._hass, this._cache, { i18n: this._i18n });

    const viewContainer = document.createElement('div');
    viewContainer.className = 'cookbook-random-card__view';
    this._root.appendChild(viewContainer);

    // Duration parsing stays at the card boundary: the view receives plain
    // milliseconds and services/random-logic.js owns the HA duration format.
    this._view = new RandomRecipeView(
      viewContainer,
      this._api,
      (id) => this._openRecipe(id),
      PLACEHOLDER_URL,
      {
        durationMs: parseRotationDuration(this._config?.duration),
        category:   this._config?.category ?? '',
        tags:       this._config?.tags ?? '',
        newBannerDays: this._config?.new_banner_days ?? 30,
        i18n: this._i18n,
      },
    );

    this._popup = new RecipePopup(
      this._root,
      this._api,
      PLACEHOLDER_URL,
      this._config?.dialog_size || 'large',
      () => this._onPopupClosed(),
      normalizeRecipeViewConfig(this._config || {}),
      { i18n: this._i18n },
    );

    await this._view.load();
  }

  _openRecipe(id) {
    // Pause before opening so no rotation fires while the popup is up.
    this._view?.pause();
    this._popup?.open(id);
  }

  _onPopupClosed() {
    // Late-close guard: a disconnect after the popup opened destroyed the
    // view; only a live view resumes the rotation.
    if (!this._view) return;
    this._view.resume();
  }

  disconnectedCallback() {
    if (!this._mounted) return;
    this._mounted = false;
    this._view?.destroy();
    this._view = null;
    this._popup?.destroy();
    this._popup = null;
    this._api = null;
    this._cache = null;
    this._root?.remove();
    this._root = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Recipe Calendar (custom:cookbook-weekly-calendar) — feature-10
//
// Separate dashboard card: shows a week of planned recipes grouped by day and
// configurable, globally-shared meal slots. Recipes are added with a focused
// searchable dialog (immediate save, dialog stays open), edited/moved via a
// per-entry pencil planning editor, and opened in the shared RecipePopup.
// Persistence lives in the integration at /config/cookbook/meal_plan.json via
// the cookbook.*_meal_plan_* services. Day boundaries use the HA timezone.
// ─────────────────────────────────────────────────────────────────────────────

/** Refresh-interval choices for the editor (label keys resolved per-locale). */
const CALENDAR_REFRESH_CHOICES = [
  ['0', 'off'],
  ['900000', '15m'],
  ['1800000', '30m'],
  ['3600000', '1h'],
  ['7200000', '2h'],
  ['21600000', '6h'],
  ['43200000', '12h'],
  ['86400000', '24h'],
];

/** Resolve the HA-local "today" (YYYY-MM-DD) from hass config timezone. */
function resolveHaToday(hass) {
  const timeZone = hass?.config?.time_zone;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

class CookbookWeeklyCalendarCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._i18n = createCardI18n(null, {});
    this._api = null;
    this._cache = null;
    this._view = null;
    this._popup = null;
    this._root = null;
    this._mounted = false;

    this.attachShadow({ mode: 'open' });
    injectMetroShadowStyles(this.shadowRoot);
  }

  setConfig(config) {
    const previousLocale = this._i18n.locale;
    this._config = config || {};
    this._i18n = createCardI18n(this._hass, this._config);
    if (this._mounted && previousLocale !== this._i18n.locale) this._applyI18n();
  }

  static getStubConfig() {
    return {
      week_start: 'monday',
      show_images: true,
      layout: 'normal',
      desktop_layout: 'vertical',
      show_dates: true,
      collapse_past_days: false,
      initial_week: 'current',
      refresh_ms: 3600000,
      frameless: false,
      language: 'auto',
    };
  }

  static getConfigElement() {
    return document.createElement('cookbook-weekly-calendar-editor');
  }

  set hass(hass) {
    const previousLocale = this._i18n.locale;
    this._hass = hass;
    this._i18n = createCardI18n(hass, this._config);
    if (!this._mounted) {
      if (this.isConnected) this._mount();
      return;
    }
    this._api?.setHass(hass);
    if (previousLocale !== this._i18n.locale) this._applyI18n();
  }

  _applyI18n() {
    this._api?.setI18n(this._i18n);
    this._view?.setI18n(this._i18n);
    this._popup?.setI18n(this._i18n);
  }

  connectedCallback() {
    if (!this._mounted && this._hass) this._mount();
  }

  async _mount() {
    if (this._mounted) return;
    this._mounted = true;

    this._root = document.createElement('div');
    this._root.className = 'cookbook-weekly-calendar';
    this.shadowRoot.appendChild(this._root);

    this._cache = new RecipeCache(600);
    this._api = new CookbookApi(this._hass, this._cache, { i18n: this._i18n });

    const viewContainer = document.createElement('div');
    viewContainer.className = 'cookbook-weekly-calendar__view';
    this._root.appendChild(viewContainer);

    this._view = new WeeklyCalendarView(viewContainer, this._api, {
      onOpenRecipe: id => this._openRecipe(id),
      today: resolveHaToday(this._hass),
      weekStart: this._config?.week_start === 'sunday' ? 'sunday' : 'monday',
      i18n: this._i18n,
      placeholderUrl: PLACEHOLDER_URL,
      title: this._config?.title,
      showImages: this._config?.show_images !== false,
      layout: this._config?.layout === 'compact' ? 'compact' : 'normal',
      desktopLayout: ['grid', 'image-grid'].includes(this._config?.desktop_layout)
        ? this._config.desktop_layout
        : 'vertical',
      showDates: this._config?.show_dates !== false,
      collapsePastDays: Boolean(this._config?.collapse_past_days),
      refreshMs: Number(this._config?.refresh_ms) || 0,
      frameless: Boolean(this._config?.frameless),
    });

    this._popup = new RecipePopup(
      this._root,
      this._api,
      PLACEHOLDER_URL,
      this._config?.dialog_size || 'large',
      () => {},
      normalizeRecipeViewConfig(this._config || {}),
      { i18n: this._i18n },
    );

    await this._view.load();
  }

  _openRecipe(id) {
    this._popup?.open(id);
  }

  disconnectedCallback() {
    if (!this._mounted) return;
    this._mounted = false;
    this._view?.destroy();
    this._view = null;
    this._popup?.destroy();
    this._popup = null;
    this._api = null;
    this._cache = null;
    this._root?.remove();
    this._root = null;
  }
}

/**
 * Config editor for the weekly calendar. Follows the build-once / sync-values
 * rule so HA's frequent hass/setConfig pushes never steal input focus. Slots
 * are global (persisted in meal_plan.json via cookbook.save_meal_plan_slots);
 * the rest are per-card Lovelace values emitted through config-changed.
 */
class CookbookWeeklyCalendarEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._i18n = createCardI18n(null, this._config);
    this._built = false;
    this._api = null;
    this._slots = null;      // loaded global slot config
    this._slotError = '';
    this.attachShadow({ mode: 'open' });
  }

  set hass(value) {
    const first = !this._hass;
    const previousLocale = this._i18n.locale;
    this._hass = value;
    this._i18n = createCardI18n(value, this._config);
    this._api?.setI18n(this._i18n);
    if (!this._built) this._render();
    else if (previousLocale !== this._i18n.locale) this._renderPreservingFocus();
    if (first) this._loadSlots();
  }

  setConfig(config) {
    const previousLocale = this._i18n.locale;
    this._config = { ...CookbookWeeklyCalendarCard.getStubConfig(), ...(config || {}) };
    this._i18n = createCardI18n(this._hass, this._config);
    this._api?.setI18n(this._i18n);
    // HA often pushes hass before setConfig, so the form may already be built
    // with empty values. Build once; afterwards only sync values into the
    // existing controls so typing never loses focus (same rule as the grid
    // card editor).
    if (!this._built) this._render();
    else if (previousLocale !== this._i18n.locale) this._renderPreservingFocus();
    else this._syncValues();
  }

  _renderPreservingFocus() {
    const activeName = this._activeControl()?.name;
    this._render();
    if (activeName) this._controls[activeName]?.focus?.();
  }

  /** Update built controls from config without rebuilding (keeps focus). */
  _syncValues() {
    if (!this._controls) return;
    Object.entries(this._controls).forEach(([name, el]) => {
      if (!el) return;
      if (el.type === 'checkbox') {
        const next = Boolean(this._config[name]);
        if (el.checked !== next && this._activeControl() !== el) el.checked = next;
        return;
      }
      const value = this._config[name] == null ? '' : String(this._config[name]);
      if (el.value !== value && this._activeControl() !== el) el.value = value;
    });
  }

  /** The focused control inside this editor's shadow root, if any. */
  _activeControl() {
    return this.shadowRoot?.activeElement ?? document.activeElement ?? null;
  }

  _t(key, params) {
    return this._i18n.t(`calendar.${key}`, params);
  }

  async _loadSlots() {
    if (!this._hass) return;
    try {
      this._api = this._api || new CookbookApi(this._hass, new RecipeCache(600), { i18n: this._i18n });
      const plan = await this._api.getMealPlan();
      this._slots = Array.isArray(plan?.slots) ? plan.slots : [];
      this._renderSlots();
    } catch {
      this._slots = [];
    }
  }

  _render() {
    if (!this.shadowRoot) return;
    this._built = true;
    this._controls = {};
    const t = this._i18n.t;
    const labels = {
      title: this._t('title'),
      weekStart: this._t('week_start'),
      images: this._t('show_images'),
      layout: this._t('layout'),
      desktop: this._t('desktop_layout'),
      dates: this._t('show_dates'),
      collapse: this._t('collapse_past_days'),
      frameless: this._t('frameless'),
      initial: this._t('initial_week'),
      refresh: this._t('refresh_interval'),
      slots: this._t('slots_label'),
      language: t('card_editor.language'),
    };

    this.shadowRoot.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
      .row { display: grid; gap: 6px; margin: 12px 0; }
      label { font-size: 14px; font-weight: 500; }
      input, select { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; }
      .check { display: flex; align-items: center; gap: 8px; }
      .check input { width: auto; }
      .slots { border: 1px solid var(--divider-color, #444); padding: 8px; }
      .slot { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
      .slot__name { flex: 1 1 auto; }
      .slot button { width: auto; padding: 4px 8px; }
      .slot__add { display: flex; gap: 6px; margin-top: 8px; }
      .slot__error { color: var(--error-color, #e81123); font-size: 12px; }
    `;
    this.shadowRoot.appendChild(style);

    const form = document.createElement('div');
    form.appendChild(this._text('title', labels.title));
    form.appendChild(this._select('week_start', labels.weekStart, [['monday', this._t('monday')], ['sunday', this._t('sunday')]]));
    form.appendChild(this._checkbox('show_images', labels.images));
    form.appendChild(this._select('layout', labels.layout, [['normal', this._t('normal')], ['compact', this._t('compact')]]));
    form.appendChild(this._select('desktop_layout', labels.desktop, [['vertical', this._t('vertical')], ['grid', this._t('week_grid')], ['image-grid', this._t('image_grid')]]));
    form.appendChild(this._checkbox('show_dates', labels.dates));
    form.appendChild(this._checkbox('collapse_past_days', labels.collapse));
    form.appendChild(this._checkbox('frameless', labels.frameless));
    form.appendChild(this._select('initial_week', labels.initial, [['current', this._t('current_week')], ['last', this._t('last_viewed')]]));
    form.appendChild(this._select('refresh_ms', labels.refresh, CALENDAR_REFRESH_CHOICES.map(([v, key]) => [v, this._refreshLabel(key)])));
    form.appendChild(this._select('language', labels.language, [
      ['auto', t('card_editor.language_auto')],
      ['de', t('card_editor.language_de')],
      ['en', t('card_editor.language_en')],
    ]));

    const slotsRow = document.createElement('div');
    slotsRow.className = 'row';
    const slotsLabel = document.createElement('label');
    slotsLabel.textContent = labels.slots;
    slotsRow.appendChild(slotsLabel);
    this._slotsContainer = document.createElement('div');
    this._slotsContainer.className = 'slots';
    slotsRow.appendChild(this._slotsContainer);
    form.appendChild(slotsRow);

    this.shadowRoot.appendChild(form);
    this._renderSlots();
  }

  _refreshLabel(key) {
    const hours = { '2h': 2, '6h': 6, '12h': 12, '24h': 24 };
    if (key === 'off') return this._t('off');
    if (key === '1h') return this._t('hour');
    if (hours[key]) return this._t('hours', { count: hours[key] });
    const minutes = { '15m': 15, '30m': 30 };
    return minutes[key] ? this._t('minutes', { count: minutes[key] }) : key;
  }

  _renderSlots() {
    if (!this._slotsContainer) return;
    this._slotsContainer.innerHTML = '';
    if (!this._slots) {
      const loading = document.createElement('div');
      loading.textContent = this._t('loading_slots');
      this._slotsContainer.appendChild(loading);
      return;
    }
    this._slots.forEach(slot => {
      const row = document.createElement('div');
      row.className = 'slot';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = Boolean(slot.enabled);
      check.addEventListener('change', () => { slot.enabled = check.checked; this._persistSlots(); });
      const name = document.createElement('span');
      name.className = 'slot__name';
      name.textContent = slotLabel(slot, this._i18n);
      row.append(check, name);

      const up = document.createElement('button');
      up.type = 'button'; up.textContent = '↑'; up.setAttribute('aria-label', this._t('move_up'));
      up.addEventListener('click', () => { this._slots = reorderSlots(this._slots, slot.id, -1); this._persistSlots(); });
      const down = document.createElement('button');
      down.type = 'button'; down.textContent = '↓'; down.setAttribute('aria-label', this._t('move_down'));
      down.addEventListener('click', () => { this._slots = reorderSlots(this._slots, slot.id, 1); this._persistSlots(); });
      row.append(up, down);

      if (slot.kind === 'custom') {
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = '🗑';
        del.setAttribute('aria-label', this._t('delete'));
        del.addEventListener('click', () => { this._slots = this._slots.filter(s => s.id !== slot.id); this._persistSlots(); });
        row.appendChild(del);
      }
      this._slotsContainer.appendChild(row);
    });

    const addRow = document.createElement('div');
    addRow.className = 'slot__add';
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('placeholder', this._t('new_slot_name'));
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = this._t('add_slot');
    add.addEventListener('click', () => this._addSlot(input.value, input));
    addRow.append(input, add);
    this._slotsContainer.appendChild(addRow);

    if (this._slotError) {
      const err = document.createElement('div');
      err.className = 'slot__error';
      err.textContent = this._slotError;
      this._slotsContainer.appendChild(err);
    }
  }

  _addSlot(name, input) {
    const result = validateNewSlotName(name, this._slots, this._i18n);
    if (!result.ok) {
      this._slotError = result.reason === 'empty'
        ? this._t('slot_name_empty_error')
        : this._t('slot_name_duplicate_error');
      this._renderSlots();
      return;
    }
    this._slotError = '';
    this._slots = [...this._slots, { id: slugifySlotName(name), kind: 'custom', name: name.trim(), enabled: true }];
    if (input) input.value = '';
    this._persistSlots();
  }

  async _persistSlots() {
    this._renderSlots();
    try {
      this._api = this._api || new CookbookApi(this._hass, new RecipeCache(600), { i18n: this._i18n });
      const plan = await this._api.saveMealPlanSlots(this._slots);
      this._slots = Array.isArray(plan?.slots) ? plan.slots : this._slots;
      this._slotError = '';
    } catch (error) {
      this._slotError = error instanceof Error ? error.message : String(error);
    }
    this._renderSlots();
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } }, bubbles: true, composed: true,
    }));
  }

  _text(name, label) {
    const row = document.createElement('div');
    row.className = 'row';
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = this._config[name] == null ? '' : String(this._config[name]);
    input.addEventListener('input', () => {
      if (input.value === '') delete this._config[name];
      else this._config[name] = input.value;
      this._emit();
    });
    labelEl.appendChild(input);
    row.appendChild(labelEl);
    if (this._controls) this._controls[name] = input;
    return row;
  }

  _checkbox(name, label) {
    const row = document.createElement('div');
    row.className = 'row check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this._config[name]);
    input.addEventListener('change', () => { this._config[name] = input.checked; this._emit(); });
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    row.append(input, labelEl);
    if (this._controls) this._controls[name] = input;
    return row;
  }

  _select(name, label, values) {
    const row = document.createElement('div');
    row.className = 'row';
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    const select = document.createElement('select');
    values.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (String(this._config[name]) === String(value)) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      this._config[name] = name === 'refresh_ms' ? Number(select.value) : select.value;
      this._emit();
    });
    labelEl.appendChild(select);
    row.appendChild(labelEl);
    if (this._controls) this._controls[name] = select;
    return row;
  }
}

if (!customElements.get('cookbook-weekly-calendar-editor')) {
  customElements.define('cookbook-weekly-calendar-editor', CookbookWeeklyCalendarEditor);
}

if (!customElements.get('cookbook-weekly-calendar')) {
  customElements.define('cookbook-weekly-calendar', CookbookWeeklyCalendarCard);
}

if (!customElements.get('cookbook-card')) {
  customElements.define('cookbook-card', CookbookCard);
  console.info(
    `%c cookbook-card %c v${CARD_VERSION} `,
    'background:#0078d7;color:#fff;font-weight:700;padding:2px 4px',
    'background:#16213e;color:#0078d7;font-weight:700;padding:2px 4px'
  );
}

if (!customElements.get('cookbook-random-card')) {
  customElements.define('cookbook-random-card', CookbookRandomCard);
}

window.customCards = window.customCards || [];
const cardPickerI18n = browserI18n();
if (!window.customCards.find(c => c.type === 'cookbook-card')) {
  window.customCards.push({
    type:        'cookbook-card',
    name:        cardPickerI18n.t('grid.card_name'),
    description: cardPickerI18n.t('grid.card_description'),
    preview:     false,
  });
}

if (!window.customCards.find(c => c.type === 'cookbook-random-card')) {
  window.customCards.push({
    type:        'cookbook-random-card',
    name:        cardPickerI18n.t('random.card_name'),
    description: cardPickerI18n.t('random.card_description'),
    preview:     false,
  });
}

if (!window.customCards.find(c => c.type === 'cookbook-weekly-calendar')) {
  window.customCards.push({
    type:        'cookbook-weekly-calendar',
    name:        cardPickerI18n.t('calendar.card_name'),
    description: cardPickerI18n.t('calendar.card_description'),
    preview:     false,
  });
}
