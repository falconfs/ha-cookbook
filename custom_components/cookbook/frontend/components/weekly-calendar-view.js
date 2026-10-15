/**
 * WeeklyCalendarView — weekly meal-plan view/controller for the weekly recipe
 * calendar card (feature-10). Framework-free; the custom element registration
 * lives in cookbook-card.js. Talks to Home Assistant only through CookbookApi.
 *
 * Responsibilities:
 *   - load the plan document + recipe stubs through the API boundary
 *   - render a week (vertical list; optional desktop grid) with all active
 *     slots, empty-slot "+" actions, and planned recipe entries
 *   - week navigation (prev / next / today / date picker) using an injected
 *     HA-local "today" (never the browser clock)
 *   - add flow: a focused, searchable selection dialog that saves each pick
 *     immediately and stays open; the calendar refreshes after it closes
 *   - edit flow: a pencil action per entry opens a planning editor (date /
 *     slot / recipe) committed on save; delete requires confirmation
 *   - missing recipes render as "unavailable" and never open the recipe popup
 *   - optional background refresh timer, cleaned up on destroy
 *
 * The heavy pure logic lives in services/calendar-logic.js and services/
 * slot-logic.js so this file stays a thin,
 * DOM-focused controller.
 *
 * CSS classes (Shadow DOM styles live in cookbook-card.js):
 *   .cal, .cal-toolbar, .cal-nav, .cal-range, .cal-body, .cal-body--grid,
 *   .cal-day, .cal-day__head, .cal-day__title, .cal-day__toggle,
 *   .cal-day__body, .cal-slot, .cal-slot__label, .cal-slot__entries,
 *   .cal-entry, .cal-entry__img, .cal-entry__name, .cal-entry__edit,
 *   .cal-entry--missing, .cal-add, .cal-skeleton,
 *   .metro-toolbar, .metro-btn, .metro-btn--accent, .metro-btn--danger,
 *   .metro-dialog, .metro-dialog__body, .metro-error, .metro-empty
 */

import {
  addDays,
  classifyDay,
  formatWeekRange,
  getWeekDays,
  getWeekStart,
  groupEntriesByDaySlot,
  isValidPlanDate,
} from '../services/calendar-logic.js';
import {
  activeSlots,
  entryTileKind,
  nonEmptySlotsForDay,
  slotLabel,
} from '../services/slot-logic.js';
import { createI18n } from '../i18n/i18n.js';

/** Browser default one-shot scheduler used for the optional refresh timer. */
function scheduleTimeout(delayMs, callback) {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
}

function weekdayLabel(iso, i18n) {
  return i18n.formatDate(new Date(`${iso}T12:00:00Z`), {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

/** Localized short day-of-month for range labels. */
function formatDayShort(iso, i18n) {
  return i18n.formatDate(new Date(`${iso}T12:00:00Z`), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export class WeeklyCalendarView {
  constructor(container, api, options = {}) {
    this._container = container;
    this._api = api;
    this._onOpenRecipe = options.onOpenRecipe ?? (() => {});
    this._today = options.today; // HA-local YYYY-MM-DD, resolved by the card
    this._weekStart = options.weekStart === 'sunday' ? 'sunday' : 'monday';
    this._i18n = options.i18n || createI18n({ locale: options.locale || 'en' });
    this._placeholder = options.placeholderUrl || '';
    this._title = options.title;
    this._showImages = options.showImages !== false;
    this._layout = options.layout === 'compact' ? 'compact' : 'normal';
    // 'grid' = plain seven-column raster; 'image-grid' = Metro image-tile week.
    this._desktopLayout = ['grid', 'image-grid'].includes(options.desktopLayout)
      ? options.desktopLayout
      : 'vertical';
    this._showDates = options.showDates !== false;
    this._collapsePast = Boolean(options.collapsePastDays);
    this._refreshMs = Number(options.refreshMs) || 0;
    this._frameless = Boolean(options.frameless);
    this._schedule = options.schedule ?? scheduleTimeout;

    this._weekStartIso = getWeekStart(this._today, this._weekStart);
    this._plan = { version: 1, slots: [], entries: [] };
    this._recipesById = new Map();
    this._grouped = {};
    this._openDays = new Set();
    this._cancelRefresh = null;
    this._destroyed = false;

    // dialog / editor state
    this._addTarget = null;      // { date, slotId } while the add dialog is open
    this._editorEntryId = null;  // entry id while the planning editor is open
    this._editorDraft = null;    // { date, slotId, recipeId }
    this._pendingDeleteId = null;
    this._loadError = null;
  }

  // --- lifecycle -----------------------------------------------------------

  async load() {
    if (this._destroyed) return;
    this._renderSkeleton();
    try {
      const [plan, recipes] = await Promise.all([
        this._api.getMealPlan(),
        this._api.getRecipes(),
      ]);
      if (this._destroyed) return;
      this._loadError = null;
      this._plan = this._normalizePlan(plan);
      this._recipesById = new Map(recipes.map(r => [String(r.id), r]));
      this._grouped = groupEntriesByDaySlot(this._plan.entries);
      this._initOpenDays();
      this._render();
      this._armRefresh();
    } catch (error) {
      if (this._destroyed) return;
      this._loadError = error;
      this._renderError(error);
    }
  }

  /** Reload the plan + recipes (used after the add dialog closes and on refresh). */
  async refresh() {
    if (this._destroyed) return;
    try {
      const [plan, recipes] = await Promise.all([
        this._api.getMealPlan(),
        this._api.getRecipes(),
      ]);
      if (this._destroyed) return;
      this._plan = this._normalizePlan(plan);
      this._recipesById = new Map(recipes.map(r => [String(r.id), r]));
      this._grouped = groupEntriesByDaySlot(this._plan.entries);
      this._render();
    } catch (error) {
      if (this._destroyed) return;
      this._loadError = error;
      this._renderError(error);
    }
  }

  setI18n(i18n) {
    this._i18n = i18n;
    if (this._loadError) this._renderError(this._loadError);
    else this._render();
  }

  _t(key, params) {
    return this._i18n.t(`calendar.${key}`, params);
  }

  destroy() {
    this._destroyed = true;
    this._cancelRefreshTimer();
    this._container.innerHTML = '';
  }

  // --- navigation (public, testable) ---------------------------------------

  getWeekStart() { return this._weekStartIso; }

  async goToNextWeek() { await this._setWeek(addDays(this._weekStartIso, 7)); }
  async goToPreviousWeek() { await this._setWeek(addDays(this._weekStartIso, -7)); }
  async goToToday() { await this._setWeek(getWeekStart(this._today, this._weekStart)); }

  /** Jump to the week containing an arbitrary ISO date (date picker). */
  async goToDate(iso) {
    if (!isValidPlanDate(iso)) return;
    await this._setWeek(getWeekStart(iso, this._weekStart));
  }

  async _setWeek(weekStartIso) {
    this._weekStartIso = weekStartIso;
    // On any week change, all days start open (decision 60).
    this._openDays = new Set(getWeekDays(this._weekStartIso));
    this._render();
  }

  // --- add flow (public, testable) -----------------------------------------

  /**
   * Open the add dialog for a whole day. The target slot defaults to the first
   * active slot; when more than one slot is active the dialog shows a slot
   * dropdown so the user picks where the recipe/text goes. A slotId may be
   * passed to preselect one.
   */
  async openAddDialog(date, slotId) {
    const active = activeSlots(this._plan.slots);
    const resolvedSlot = slotId || active[0]?.id || 'meal';
    this._addTarget = { date, slotId: resolvedSlot };
    this._renderAddDialog();
  }

  isAddDialogOpen() { return this._addTarget !== null; }

  /** Change the target slot for the currently open add dialog (dropdown). */
  setAddSlot(slotId) {
    if (this._addTarget) this._addTarget.slotId = slotId;
  }

  getAddSlot() { return this._addTarget?.slotId ?? null; }

  /** Immediately persist one recipe entry for the current add target; keep dialog open. */
  async selectRecipeForAdd(recipeId) {
    if (!this._addTarget) return;
    const { date, slotId } = this._addTarget;
    await this._api.addMealPlanEntry({ date, slotId, recipeId: String(recipeId) });
  }

  /** Immediately persist a free-text entry for the current add target; keep dialog open. */
  async addTextForAdd(text) {
    if (!this._addTarget) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    const { date, slotId } = this._addTarget;
    await this._api.addMealPlanEntry({ date, slotId, text: clean });
  }

  async closeAddDialog() {
    this._addTarget = null;
    if (this._addDialog) this._addDialog.close();
    await this.refresh();
  }

  // --- planning editor (public, testable) ----------------------------------

  openPlanningEditor(entryId) {
    const entry = this._plan.entries.find(e => e.id === entryId);
    if (!entry) return;
    this._editorEntryId = entryId;
    this._editorDraft = {
      date: entry.date,
      slotId: entry.slot_id,
      recipeId: entry.recipe_id,
      text: entry.text || '',
    };
    this._pendingDeleteId = null;
    this._renderPlanningEditor();
  }

  isPlanningEditorOpen() { return this._editorEntryId !== null; }

  setEditorDate(date) { if (this._editorDraft) this._editorDraft.date = date; }
  setEditorSlot(slotId) { if (this._editorDraft) this._editorDraft.slotId = slotId; }
  setEditorRecipe(recipeId) { if (this._editorDraft) this._editorDraft.recipeId = String(recipeId); }
  setEditorText(text) { if (this._editorDraft) this._editorDraft.text = String(text); }

  async savePlanningEditor() {
    if (!this._editorEntryId || !this._editorDraft) return;
    await this._api.updateMealPlanEntry(this._editorEntryId, {
      date: this._editorDraft.date,
      slotId: this._editorDraft.slotId,
      recipeId: this._editorDraft.recipeId,
      text: this._editorDraft.text,
    });
    this._closeEditor();
    await this.refresh();
  }

  closePlanningEditor() { this._closeEditor(); }

  _closeEditor() {
    this._editorEntryId = null;
    this._editorDraft = null;
    this._pendingDeleteId = null;
    if (this._editorDialog) this._editorDialog.close();
  }

  /** Step 1 of delete: arm the confirmation (does not call the service). */
  async requestDeleteEntry() {
    this._pendingDeleteId = this._editorEntryId;
  }

  /** Step 2 of delete: only after confirmation. */
  async confirmDeleteEntry() {
    const id = this._pendingDeleteId ?? this._editorEntryId;
    if (!id) return;
    await this._api.deleteMealPlanEntry(id);
    this._closeEditor();
    await this.refresh();
  }

  cancelDeleteEntry() { this._pendingDeleteId = null; }

  // --- entry activation (public, testable) ---------------------------------

  /** Open the recipe popup for an entry, unless its recipe is unavailable. */
  activateEntryRecipe(entryId) {
    const entry = this._plan.entries.find(e => e.id === entryId);
    if (!entry) return;
    if (!this._recipesById.has(String(entry.recipe_id))) return; // missing recipe
    this._onOpenRecipe(String(entry.recipe_id));
  }

  // --- rendering -----------------------------------------------------------

  _render() {
    if (this._destroyed) return;
    this._container.innerHTML = '';
    const root = document.createElement('div');
    root.className = `cal cal--${this._layout}${this._frameless ? ' cal--frameless' : ''}`;
    root.appendChild(this._buildToolbar());
    root.appendChild(this._buildBody());
    this._container.appendChild(root);
  }

  _renderSkeleton() {
    this._container.innerHTML = '';
    const skeleton = document.createElement('div');
    skeleton.className = 'cal cal-skeleton';
    skeleton.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 7; i += 1) {
      const day = document.createElement('div');
      day.className = 'cal-day cal-day--skeleton';
      skeleton.appendChild(day);
    }
    this._container.appendChild(skeleton);
  }

  _renderError(error) {
    this._cancelRefreshTimer();
    this._container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cal';
    const alert = document.createElement('div');
    alert.className = 'metro-error';
    alert.setAttribute('role', 'alert');
    const message = error instanceof Error ? error.message : String(error);
    alert.textContent = `${this._t('load_error')} ${message}`;
    const retry = document.createElement('button');
    retry.className = 'metro-btn metro-btn--accent';
    retry.setAttribute('type', 'button');
    retry.textContent = this._t('retry');
    retry.addEventListener('click', () => this.load());
    alert.appendChild(retry);
    wrap.appendChild(alert);
    this._container.appendChild(wrap);
  }

  _buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'metro-toolbar cal-toolbar';

    const heading = document.createElement('div');
    heading.className = 'cal-title';
    heading.textContent = this._resolvedTitle();
    toolbar.appendChild(heading);

    const nav = document.createElement('div');
    nav.className = 'cal-nav';

    const prev = this._navButton('‹', this._t('previous_week'), () => this.goToPreviousWeek());
    const range = document.createElement('button');
    range.className = 'metro-btn cal-range';
    range.setAttribute('type', 'button');
    range.textContent = formatWeekRange(this._weekStartIso, {
      formatDay: iso => formatDayShort(iso, this._i18n),
    });
    range.addEventListener('click', () => this._openDatePicker());
    const next = this._navButton('›', this._t('next_week'), () => this.goToNextWeek());
    const today = document.createElement('button');
    today.className = 'metro-btn cal-today';
    today.setAttribute('type', 'button');
    today.textContent = this._t('today');
    today.addEventListener('click', () => this.goToToday());
    const refresh = this._navButton('↻', this._t('refresh'), () => this.refresh());

    nav.append(prev, range, next, today, refresh);
    toolbar.appendChild(nav);
    return toolbar;
  }

  _navButton(glyph, label, handler) {
    const button = document.createElement('button');
    button.className = 'metro-btn cal-nav__btn';
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', label);
    button.textContent = glyph;
    button.addEventListener('click', handler);
    return button;
  }

  _buildBody() {
    const body = document.createElement('div');
    const modeClass = this._desktopLayout === 'image-grid'
      ? 'cal-body cal-body--image-grid'
      : this._desktopLayout === 'grid'
        ? 'cal-body cal-body--grid'
        : 'cal-body';
    body.className = modeClass;
    const days = getWeekDays(this._weekStartIso);
    days.forEach(iso => body.appendChild(this._buildDay(iso)));
    return body;
  }

  _buildDay(iso) {
    const day = document.createElement('section');
    const state = classifyDay(iso, this._today);
    const layoutMod = this._desktopLayout === 'image-grid' ? ' cal-day--tile' : '';
    day.className = `cal-day cal-day--${state}${layoutMod}`;
    day.dataset.date = iso;

    const head = document.createElement('button');
    head.className = 'cal-day__head';
    head.setAttribute('type', 'button');
    const open = this._openDays.has(iso);
    head.setAttribute('aria-expanded', String(open));

    const title = document.createElement('span');
    title.className = 'cal-day__title';
    title.textContent = this._showDates
      ? `${weekdayLabel(iso, this._i18n)}, ${formatDayShort(iso, this._i18n)}`
      : weekdayLabel(iso, this._i18n);
    head.appendChild(title);
    head.addEventListener('click', () => this._toggleDay(iso));
    day.appendChild(head);

    const dayBody = document.createElement('div');
    dayBody.className = 'cal-day__body';
    if (!open) dayBody.classList.add('cal-day__body--collapsed');

    const daySlotEntries = this._grouped[iso] ?? {};
    // Only slots that actually hold entries are rendered; empty slots are
    // omitted. Adding happens through a single day-level "+".
    const slots = nonEmptySlotsForDay(this._plan.slots, daySlotEntries);
    slots.forEach(slot => dayBody.appendChild(this._buildSlot(iso, slot, daySlotEntries[slot.id] ?? [])));

    const add = document.createElement('button');
    add.className = 'metro-btn cal-add cal-add--day';
    add.setAttribute('type', 'button');
    add.setAttribute('aria-label', this._t('add_recipe'));
    add.textContent = '+';
    add.addEventListener('click', () => this.openAddDialog(iso));
    dayBody.appendChild(add);

    day.appendChild(dayBody);
    return day;
  }

  _buildSlot(iso, slot, entries) {
    const slotEl = document.createElement('div');
    slotEl.className = 'cal-slot';
    slotEl.dataset.slot = slot.id;

    const label = document.createElement('div');
    label.className = 'cal-slot__label';
    label.textContent = slotLabel(slot, this._i18n);
    slotEl.appendChild(label);

    const list = document.createElement('div');
    list.className = 'cal-slot__entries';
    entries.forEach(entry => list.appendChild(this._buildEntry(entry)));
    slotEl.appendChild(list);
    return slotEl;
  }

  _buildEntry(entry) {
    if (this._desktopLayout === 'image-grid') return this._buildEntryTile(entry);
    const hasRecipeId = String(entry.recipe_id || '') !== '';
    const recipe = hasRecipeId ? this._recipesById.get(String(entry.recipe_id)) : null;
    const note = String(entry.text || '').trim();
    // Three kinds: recipe entry (optional note), free-text entry (no recipe_id),
    // and a recipe_id whose recipe no longer exists (unavailable).
    const isFreeText = !hasRecipeId;
    const isMissing = hasRecipeId && !recipe;

    const el = document.createElement('div');
    el.className = recipe || isFreeText ? 'cal-entry' : 'cal-entry cal-entry--missing';
    if (isFreeText) el.classList.add('cal-entry--text');
    el.dataset.entry = entry.id;

    const main = document.createElement('div');
    main.className = 'cal-entry__main';
    main.setAttribute('role', 'button');
    main.setAttribute('tabindex', '0');

    if (recipe && this._showImages) {
      const img = document.createElement('img');
      img.className = 'cal-entry__img';
      img.alt = recipe.name;
      img.onerror = () => {
        if (this._placeholder && img.src !== this._placeholder) img.src = this._placeholder;
      };
      img.src = this._api.imageUrl(recipe.id, recipe.image_mtime || recipe.dateModified || '');
      main.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'cal-entry__body';

    const name = document.createElement('span');
    name.className = 'cal-entry__name';
    if (recipe) name.textContent = recipe.name;
    else if (isFreeText) name.textContent = note;
    else name.textContent = this._t('recipe_unavailable');
    body.appendChild(name);

    // Optional note beside a recipe (free-text entries already show the text as
    // their name, so no duplicate note line there).
    if (note && !isFreeText) {
      const noteEl = document.createElement('span');
      noteEl.className = 'cal-entry__note';
      noteEl.textContent = note;
      body.appendChild(noteEl);
    }
    main.appendChild(body);
    void isMissing;

    const activate = () => this.activateEntryRecipe(entry.id);
    main.addEventListener('click', activate);
    main.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    });
    el.appendChild(main);

    const edit = document.createElement('button');
    edit.className = 'metro-btn cal-entry__edit';
    edit.setAttribute('type', 'button');
    edit.setAttribute('aria-label', this._t('edit_entry'));
    edit.textContent = '✎';
    edit.addEventListener('click', event => {
      event.stopPropagation();
      this.openPlanningEditor(entry.id);
    });
    el.appendChild(edit);
    return el;
  }

  /**
   * Image-grid tile (Metro "Live-Tile" week). A resolvable recipe becomes a
   * square image tile with a dark name overlay; free-text entries and missing
   * recipes fall back to a plain text card. The pencil stays a separate action.
   */
  _buildEntryTile(entry) {
    const recipeId = String(entry.recipe_id || '');
    const recipe = this._recipesById.get(recipeId);
    const note = String(entry.text || '').trim();
    const kind = entryTileKind(entry, this._recipesById, { showImages: this._showImages });

    const tile = document.createElement('div');
    tile.className = `cal-tile cal-tile--${kind}`;
    tile.dataset.entry = entry.id;
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');

    if (kind === 'image' && recipe) {
      const img = document.createElement('img');
      img.className = 'cal-tile__img';
      img.alt = recipe.name;
      img.onerror = () => {
        if (this._placeholder && img.src !== this._placeholder) img.src = this._placeholder;
      };
      img.src = this._api.imageUrl(recipe.id, recipe.image_mtime || recipe.dateModified || '');
      tile.appendChild(img);

      const overlay = document.createElement('div');
      overlay.className = 'cal-tile__overlay';
      const nameEl = document.createElement('span');
      nameEl.className = 'cal-tile__name';
      nameEl.textContent = recipe.name;
      overlay.appendChild(nameEl);
      if (note) {
        const noteEl = document.createElement('span');
        noteEl.className = 'cal-tile__note';
        noteEl.textContent = note;
        overlay.appendChild(noteEl);
      }
      tile.appendChild(overlay);
    } else {
      const body = document.createElement('div');
      body.className = 'cal-tile__text-body';
      const nameEl = document.createElement('span');
      nameEl.className = 'cal-tile__name';
      if (recipe) nameEl.textContent = recipe.name;
      else if (!recipeId) nameEl.textContent = note;
      else nameEl.textContent = this._t('recipe_unavailable');
      body.appendChild(nameEl);
      if (note && recipeId) {
        const noteEl = document.createElement('span');
        noteEl.className = 'cal-tile__note';
        noteEl.textContent = note;
        body.appendChild(noteEl);
      }
      tile.appendChild(body);
    }

    const activate = () => this.activateEntryRecipe(entry.id);
    tile.addEventListener('click', activate);
    tile.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    });

    const edit = document.createElement('button');
    edit.className = 'metro-btn cal-tile__edit';
    edit.setAttribute('type', 'button');
    edit.setAttribute('aria-label', this._t('edit_entry'));
    edit.textContent = '✎';
    edit.addEventListener('click', event => {
      event.stopPropagation();
      this.openPlanningEditor(entry.id);
    });
    tile.appendChild(edit);
    return tile;
  }

  // --- dialogs (rendered; interaction seams are the public methods) --------

  _renderAddDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'metro-dialog cal-add-dialog';
    const body = document.createElement('div');
    body.className = 'metro-dialog__body';

    const header = document.createElement('div');
    header.className = 'cal-add-dialog__header';
    header.textContent = this._t('add_recipe_to', { target: this._addTargetLabel() });
    body.appendChild(header);

    // Slot picker: only shown when more than one slot is active. With a single
    // active slot everything goes there automatically (no redundant dropdown).
    const active = activeSlots(this._plan.slots);
    if (active.length > 1) {
      const slotRow = document.createElement('label');
      slotRow.className = 'cal-add-dialog__slot-row';
      const slotLabelEl = document.createElement('span');
      slotLabelEl.className = 'cal-add-dialog__slot-label';
      slotLabelEl.textContent = this._t('slot');
      const slotSelect = document.createElement('select');
      slotSelect.className = 'metro-select cal-add-dialog__slot';
      active.forEach(slot => {
        const option = document.createElement('option');
        option.setAttribute('value', slot.id);
        option.textContent = slotLabel(slot, this._i18n);
        if (slot.id === this._addTarget.slotId) option.setAttribute('selected', 'selected');
        slotSelect.appendChild(option);
      });
      slotSelect.addEventListener('change', () => this.setAddSlot(slotSelect.value));
      slotRow.append(slotLabelEl, slotSelect);
      body.appendChild(slotRow);
    }

    const search = document.createElement('input');
    search.className = 'metro-search cal-add-dialog__search';
    search.setAttribute('type', 'search');
    search.setAttribute('placeholder', this._t('search_recipes'));
    body.appendChild(search);

    const results = document.createElement('div');
    results.className = 'cal-add-dialog__results';
    body.appendChild(results);

    // "Add as text" control: reuses the same search field so a free-text entry
    // (e.g. "Pizza bestellen") is one click away when nothing needs a recipe.
    const addText = document.createElement('button');
    addText.className = 'metro-btn cal-add-dialog__text';
    addText.setAttribute('type', 'button');
    const syncAddText = () => {
      const query = search.value || '';
      this._renderRecipeResults(results, query);
      const clean = query.trim();
      addText.textContent = clean
        ? this._t('add_as_text_value', { text: clean })
        : this._t('add_as_text');
      addText.disabled = clean === '';
    };
    addText.addEventListener('click', () => this._onAddText(addText, search));
    body.appendChild(addText);
    search.addEventListener('input', syncAddText);
    syncAddText();

    const done = document.createElement('button');
    done.className = 'metro-btn metro-btn--accent';
    done.setAttribute('type', 'button');
    done.textContent = this._t('done');
    done.addEventListener('click', () => this.closeAddDialog());
    body.appendChild(done);

    dialog.appendChild(body);
    this._container.appendChild(dialog);
    this._addDialog = dialog;
    if (dialog.showModal) dialog.showModal();
    if (search.focus) search.focus();
  }

  _renderRecipeResults(container, query) {
    container.innerHTML = '';
    const matches = this._searchRecipes(query);
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'metro-empty';
      empty.textContent = this._t('no_recipes');
      container.appendChild(empty);
      return;
    }
    matches.forEach(recipe => {
      const item = document.createElement('button');
      item.className = 'metro-btn cal-add-dialog__item';
      item.setAttribute('type', 'button');
      item.dataset.recipe = String(recipe.id);

      if (this._showImages) {
        const img = document.createElement('img');
        img.className = 'cal-add-dialog__img';
        img.alt = recipe.name;
        img.onerror = () => {
          if (this._placeholder && img.src !== this._placeholder) img.src = this._placeholder;
        };
        img.src = this._api.imageUrl(recipe.id, recipe.image_mtime || recipe.dateModified || '');
        item.appendChild(img);
      }

      const label = document.createElement('span');
      label.className = 'cal-add-dialog__item-name';
      label.textContent = recipe.name;
      item.appendChild(label);

      const count = this._plannedCount(recipe.id);
      if (count > 0) {
        const hint = document.createElement('span');
        hint.className = 'cal-add-dialog__hint';
        hint.textContent = this._t('planned_count', { count });
        item.appendChild(hint);
      }
      item.addEventListener('click', () => this._onPickRecipe(item, recipe.id));
      container.appendChild(item);
    });
  }

  async _onAddText(button, search) {
    const clean = String(search.value || '').trim();
    if (!clean) return;
    try {
      await this.addTextForAdd(clean);
      const status = document.createElement('span');
      status.className = 'cal-add-dialog__status';
      status.textContent = this._t('added');
      button.appendChild(status);
    } catch (error) {
      const status = document.createElement('span');
      status.className = 'cal-add-dialog__error';
      status.setAttribute('role', 'alert');
      status.textContent = `${this._t('save_error')} ${error instanceof Error ? error.message : ''}`;
      button.appendChild(status);
    }
  }

  async _onPickRecipe(item, recipeId) {
    try {
      await this.selectRecipeForAdd(recipeId);
      const status = document.createElement('span');
      status.className = 'cal-add-dialog__status';
      status.textContent = this._t('added');
      item.appendChild(status);
    } catch (error) {
      const status = document.createElement('span');
      status.className = 'cal-add-dialog__error';
      status.setAttribute('role', 'alert');
      status.textContent = `${this._t('save_error')} ${error instanceof Error ? error.message : ''}`;
      item.appendChild(status);
    }
  }

  _renderPlanningEditor() {
    const dialog = document.createElement('dialog');
    dialog.className = 'metro-dialog cal-editor-dialog';
    const body = document.createElement('div');
    body.className = 'metro-dialog__body';

    const heading = document.createElement('div');
    heading.className = 'cal-editor__heading';
    heading.textContent = this._t('edit_entry');
    body.appendChild(heading);

    // Date field
    const dateInput = document.createElement('input');
    dateInput.className = 'cal-editor__date';
    dateInput.setAttribute('type', 'date');
    dateInput.setAttribute('aria-label', this._t('date'));
    dateInput.value = this._editorDraft.date;
    dateInput.addEventListener('change', () => this.setEditorDate(dateInput.value));
    body.appendChild(dateInput);

    // Slot select
    const slotSelect = document.createElement('select');
    slotSelect.className = 'cal-editor__slot metro-select';
    slotSelect.setAttribute('aria-label', this._t('slot'));
    activeSlots(this._plan.slots).forEach(slot => {
      const option = document.createElement('option');
      option.setAttribute('value', slot.id);
      option.textContent = slotLabel(slot, this._i18n);
      if (slot.id === this._editorDraft.slotId) option.setAttribute('selected', 'selected');
      slotSelect.appendChild(option);
    });
    slotSelect.addEventListener('change', () => this.setEditorSlot(slotSelect.value));
    body.appendChild(slotSelect);

    // Note / free text: for a recipe entry this is an optional note; for a
    // free-text entry it holds the text itself.
    const noteInput = document.createElement('input');
    noteInput.className = 'cal-editor__note';
    noteInput.setAttribute('type', 'text');
    noteInput.setAttribute('aria-label', this._t('note'));
    noteInput.setAttribute('placeholder', this._t('note_placeholder'));
    noteInput.value = this._editorDraft.text || '';
    noteInput.addEventListener('input', () => this.setEditorText(noteInput.value));
    body.appendChild(noteInput);

    const save = document.createElement('button');
    save.className = 'metro-btn metro-btn--accent';
    save.setAttribute('type', 'button');
    save.textContent = this._t('save');
    save.addEventListener('click', () => this.savePlanningEditor());

    const del = document.createElement('button');
    del.className = 'metro-btn metro-btn--danger';
    del.setAttribute('type', 'button');
    del.textContent = this._t('delete');
    del.addEventListener('click', () => this._renderDeleteConfirm(body));

    const cancel = document.createElement('button');
    cancel.className = 'metro-btn';
    cancel.setAttribute('type', 'button');
    cancel.textContent = this._t('cancel');
    cancel.addEventListener('click', () => this.closePlanningEditor());

    body.append(save, del, cancel);
    dialog.appendChild(body);
    this._container.appendChild(dialog);
    this._editorDialog = dialog;
    if (dialog.showModal) dialog.showModal();
  }

  _renderDeleteConfirm(body) {
    this.requestDeleteEntry();
    const confirm = document.createElement('div');
    confirm.className = 'cal-editor__confirm';
    confirm.setAttribute('role', 'alertdialog');
    const text = document.createElement('div');
    text.textContent = this._t('confirm_delete_entry');
    const yes = document.createElement('button');
    yes.className = 'metro-btn metro-btn--danger';
    yes.setAttribute('type', 'button');
    yes.textContent = this._t('delete');
    yes.addEventListener('click', () => this.confirmDeleteEntry());
    const no = document.createElement('button');
    no.className = 'metro-btn';
    no.setAttribute('type', 'button');
    no.textContent = this._t('cancel');
    no.addEventListener('click', () => { this.cancelDeleteEntry(); confirm.remove(); });
    confirm.append(text, yes, no);
    body.appendChild(confirm);
  }

  _openDatePicker() {
    const dialog = document.createElement('dialog');
    dialog.className = 'metro-dialog cal-datepicker';
    const input = document.createElement('input');
    input.setAttribute('type', 'date');
    input.value = this._weekStartIso;
    input.addEventListener('change', () => { this.goToDate(input.value); dialog.close?.(); });
    dialog.appendChild(input);
    this._container.appendChild(dialog);
    if (dialog.showModal) dialog.showModal();
    if (input.focus) input.focus();
  }

  // --- helpers -------------------------------------------------------------

  _searchRecipes(query) {
    const needle = String(query).trim().toLowerCase();
    const all = [...this._recipesById.values()];
    if (!needle) return all;
    return all.filter(recipe =>
      `${recipe.name} ${recipe.recipeCategory || ''} ${recipe.keywords || ''}`
        .toLowerCase().includes(needle));
  }

  _plannedCount(recipeId) {
    return this._plan.entries.filter(e => String(e.recipe_id) === String(recipeId)).length;
  }

  _addTargetLabel() {
    if (!this._addTarget) return '';
    // The slot is chosen inside the dialog now, so the header only names the day.
    return `${weekdayLabel(this._addTarget.date, this._i18n)}, ${formatDayShort(this._addTarget.date, this._i18n)}`;
  }

  _resolvedTitle() {
    const explicit = typeof this._title === 'string' ? this._title.trim() : '';
    return explicit || this._t('default_title');
  }

  _normalizePlan(plan) {
    const safe = plan && typeof plan === 'object' ? plan : {};
    return {
      version: safe.version ?? 1,
      slots: Array.isArray(safe.slots) ? safe.slots : [],
      entries: Array.isArray(safe.entries) ? safe.entries : [],
    };
  }

  _initOpenDays() {
    const days = getWeekDays(this._weekStartIso);
    if (!this._collapsePast) {
      this._openDays = new Set(days);
      return;
    }
    this._openDays = new Set(days.filter(iso => classifyDay(iso, this._today) !== 'past'));
  }

  _toggleDay(iso) {
    if (this._openDays.has(iso)) this._openDays.delete(iso);
    else this._openDays.add(iso);
    this._render();
  }

  _armRefresh() {
    this._cancelRefreshTimer();
    if (!this._refreshMs) return;
    const cancel = this._schedule(this._refreshMs, () => {
      if (this._destroyed || cancel !== this._cancelRefresh) return;
      this.refresh().then(() => this._armRefresh());
    });
    this._cancelRefresh = cancel;
  }

  _cancelRefreshTimer() {
    this._cancelRefresh?.();
    this._cancelRefresh = null;
  }
}
