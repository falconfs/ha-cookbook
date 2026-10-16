/**
 * RecipePopup — full-detail recipe dialog with tabs and write-back support.
 *
 * Uses the native <dialog> element for accessible modal behaviour.
 * Tabs: Zutaten | Zubereitung | Info
 * Write-back: rating + last_cooked + notes via api.updateRecipe()
 *
 * CSS classes used (from metro.css):
 *   .metro-dialog, .metro-dialog__header, .metro-dialog__img,
 *   .metro-dialog__img--hidden, .metro-dialog__header-placeholder,
 *   .metro-dialog__close, .metro-dialog__body, .metro-dialog__title-bar,
 *   .metro-dialog__title, .metro-dialog__subtitle,
 *   .metro-dialog__source, .metro-info-section,
 *   .metro-info-section__heading, .metro-info-section__nutrition,
 *   .metro-meta, .metro-chip, .metro-chip--accent,
 *   .metro-tabs, .metro-tab, .metro-tab--active,
 *   .metro-tab-content, .metro-tab-panel, .metro-tab-panel--active,
 *   .metro-ingredient-list, .metro-ingredient-list__item,
 *   .metro-ingredient-list__bullet,
 *   .metro-step-list, .metro-step-list__item, .metro-step-list__number,
 *   .metro-description,
 *   .metro-actions, .metro-actions__last-cooked,
 *   .metro-btn, .metro-btn--success, .metro-btn--sm,
 *   .metro-rating (via StarRating)
 */

import { StarRating } from './star-rating.js';
import {
  createRecipeProgressStore,
  getInstructionView,
  normalizeRecipeViewConfig,
} from '../services/recipe-view.js';
import {
  getServingScaleFactor,
  isUsableRecipeYield,
  scaleGroupedIngredient,
  scaleQuantityText,
} from '../services/recipe-scaling.js';
import { createI18n } from '../i18n/i18n.js';

let dialogSequence = 0;

/** Format ISO 8601 duration → "1h 30min". */
function parseDuration(iso, i18n) {
  if (!iso) return null;
  const h = (iso.match(/(\d+)H/) || [])[1] | 0;
  const m = (iso.match(/(\d+)M/) || [])[1] | 0;
  if (h && m) return i18n.t('popup.duration_hours_minutes', { hours: h, minutes: m });
  if (h) return i18n.t('popup.duration_hours', { count: h });
  if (m) return i18n.t('popup.duration_minutes', { count: m });
  return null;
}

function isHttpUrl(value) {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Format ISO date string → "09.08.2026". */
function formatDate(iso, i18n) {
  if (!iso) return null;
  try {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(iso));
    const value = dateOnly ? new Date(`${iso}T12:00:00Z`) : iso;
    return i18n.formatDate(value, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(dateOnly ? { timeZone: 'UTC' } : {}),
    });
  } catch {
    return iso;
  }
}

export class RecipePopup {
  /**
   * @param {HTMLElement} mountEl  — element to append the <dialog> to
   * @param {import('../services/api.js').CookbookApi} api
   * @param {string} placeholderDataUri
   */
  /**
   * @param {HTMLElement} mountEl
   * @param {import('../services/api.js').CookbookApi} api
   * @param {string} placeholderDataUri
   * @param {'fullscreen'|'large'|'medium'} dialogSize
   */
  constructor(
    mountEl,
    api,
    placeholderDataUri = '',
    dialogSize = 'large',
    onClose = null,
    recipeViewConfig = {},
    actions = {}
  ) {
    this._mount = mountEl;
    this._api = api;
    this._placeholder = placeholderDataUri;
    this._dialogSize = dialogSize;
    const viewConfig = normalizeRecipeViewConfig(recipeViewConfig);
    this._defaultTab = viewConfig.recipe_default_tab;
    this._progress = createRecipeProgressStore();
    // Called whenever the dialog closes (backdrop, Escape, close button, or
    // programmatic close). Used by the card to sync the URL parameter.
    this._onClose = typeof onClose === 'function' ? onClose : () => {};
    // Edit/Delete actions operate on the currently open recipe.
    this._onEdit = typeof actions.onEdit === 'function' ? actions.onEdit : null;
    this._onDelete = typeof actions.onDelete === 'function' ? actions.onDelete : null;
    this._onSaved = typeof actions.onSaved === 'function' ? actions.onSaved : null;
    this._i18n = actions.i18n || createI18n();
    // Inline editor state (shares this dialog).
    this._editorFactory = null;
    this._editor = null;
    this._editorMode = false;
    this._dialog = null;
    this._starRating = null;
    this._currentRecipe = null;
    this._baseYield = null;
    this._targetYield = null;
    this._activeTab = 0;
    // Stale-open guard: only the newest open() request may populate or show
    // an error. close() and destroy() invalidate in-flight requests too.
    this._openGeneration = 0;
    this._destroyed = false;

    this._buildDialog();
  }

  setI18n(i18n) {
    const activeTab = this._activeTab;
    this._i18n = i18n;
    this._starRating?.setI18n(i18n);
    this._updateDialogTranslations();
    this._editor?.setI18n(i18n);
    if (this._currentRecipe && !this._editorMode) {
      this._populate(this._currentRecipe);
      this._switchTab(activeTab);
    } else if (this._dialog?.open && !this._editorMode) {
      this._showLoading();
    }
  }

  _updateDialogTranslations() {
    if (!this._els) return;
    const t = this._i18n.t;
    this._els.headerPlaceholder.textContent = t('popup.header_placeholder');
    this._els.closeBtn.setAttribute('aria-label', t('popup.close_dialog'));
    this._els.cookedBtn.textContent = t('popup.today_cooked');
    this._els.editBtn.textContent = t('popup.edit_recipe');
    this._els.deleteBtn.textContent = t('popup.delete_recipe');
    this._els.servingsLabel.textContent = t('popup.servings');
    this._els.servingsTarget.setAttribute('aria-label', t('popup.target_servings'));
    this._els.servingsMinus.setAttribute('aria-label', t('popup.fewer_servings'));
    this._els.servingsPlus.setAttribute('aria-label', t('popup.more_servings'));
    this._els.tabs.setAttribute('aria-label', t('popup.recipe_sections'));
    [t('popup.ingredients'), t('popup.instructions'), t('popup.info')].forEach((label, index) => {
      const tab = this._els.tabs.querySelectorAll('.metro-tab')[index];
      if (tab) tab.textContent = label;
    });

    const confirmation = this._deleteDialogElements;
    if (confirmation) {
      confirmation.heading.textContent = t('popup.delete_title');
      confirmation.info.textContent = t('popup.delete_help');
      confirmation.copy.setAttribute('aria-label', t('popup.copy_recipe_name'));
      confirmation.copy.title = t('popup.copy_name');
      confirmation.input.setAttribute('aria-label', t('popup.recipe_name_confirmation'));
      confirmation.input.placeholder = t('popup.recipe_name');
      confirmation.cancel.textContent = t('common.cancel');
      confirmation.confirm.textContent = t('popup.confirm_delete');
    }
  }

  /** True while the dialog is open. */
  get isOpen() {
    return !!this._dialog && this._dialog.open;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Open the dialog for a given recipe ID.
   * Fetches the full recipe from the API.
   * @param {string|number} recipeId
   */
  async open(recipeId) {
    const generation = ++this._openGeneration;
    this._showLoading();
    this._dialog.showModal();

    try {
      const recipe = await this._api.getRecipe(recipeId);

      if (this._isStaleOpen(generation)) return;
      this._currentRecipe = recipe;
      this._populate(recipe);
    } catch (err) {
      if (this._isStaleOpen(generation)) return;
      this._showLoadError(err.message);
    }
  }

  close() {
    // Invalidate any in-flight open() so a late response cannot populate
    // (or error into) the closed dialog.
    ++this._openGeneration;
    if (this._dialog.open) this._dialog.close();
    this._currentRecipe = null;
    this._exitEditor();
  }

  /**
   * Open the shared dialog in editor mode. Reuses the same <dialog> (and thus
   * the same size + scrollable body) as the recipe view.
   * @param {object|null} recipe  recipe to edit, or null to create a new one
   */
  async openEditor(recipe = null) {
    if (!this._editorFactory) return;
    if (!this._dialog.open) this._dialog.showModal();
    this._enterEditorMode();
    if (!this._editor) {
      this._editor = this._editorFactory(
        this._els.editorHost,
        (id) => this._onEditorSaved(id),
        () => this._onEditorCancelled(),
      );
    }
    try {
      await this._editor.open(recipe);
    } catch (err) {
      this._exitEditor();
      this._showLoadError(err.message);
    }
  }

  /** Provide a factory that builds the editor bound to the given host. */
  setEditorFactory(factory) {
    this._editorFactory = typeof factory === 'function' ? factory : null;
  }

  _enterEditorMode() {
    this._editorMode = true;
    this._dialog?.classList.add('metro-dialog--editing');
    if (this._els.header) this._els.header.hidden = true;
    if (this._els.viewContainer) this._els.viewContainer.hidden = true;
    if (this._els.editorHost) this._els.editorHost.hidden = false;
    if (this._dialog?.scrollTo) this._dialog.scrollTo(0, 0);
  }

  _exitEditor() {
    if (!this._editorMode) return;
    this._editorMode = false;
    this._dialog?.classList.remove('metro-dialog--editing');
    this._editor?.close();
    if (this._els.header) this._els.header.hidden = false;
    if (this._els.viewContainer) this._els.viewContainer.hidden = false;
    if (this._els.editorHost) this._els.editorHost.hidden = true;
  }

  async _onEditorSaved(id) {
    // Leave editor mode but keep the shared dialog open, then reload and show
    // the freshly saved recipe so the user sees the result immediately.
    this._exitEditor();
    if (this._onSaved) await this._onSaved();
    if (id != null) {
      await this.open(id);
    } else {
      this.close();
    }
  }

  _onEditorCancelled() {
    // If we were editing an existing, open recipe, return to its view;
    // otherwise close the dialog entirely.
    if (this._currentRecipe) {
      this._exitEditor();
    } else {
      this.close();
    }
  }

  destroy() {
    // Invalidate in-flight open() requests: a late response must neither
    // populate nor throw into the torn-down dialog.
    this._destroyed = true;
    ++this._openGeneration;
    this._dialog.remove();
  }

  /**
   * True when the given open() request was superseded: a newer open(), a
   * close() (also covers the dialog-open check for Escape/backdrop closes
   * that bypass close()), or a destroy() retired it.
   */
  _isStaleOpen(generation) {
    return this._destroyed || generation !== this._openGeneration || !this._dialog.open;
  }

  // ---------------------------------------------------------------------------
  // Private — dialog construction
  // ---------------------------------------------------------------------------

  _buildDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'metro-dialog';
    const dialogId = `recipe-dialog-${++dialogSequence}`;

    // Apply size
    // Apply size directly via style (CSS vars unreliable in Shadow DOM)
    if (this._dialogSize === 'fullscreen') {
      dialog.classList.add('metro-dialog--fullscreen');
      dialog.style.cssText += `
        position: fixed !important;
        inset: 0 !important;
        margin: 0 !important;
        width: 100vw !important;
        max-width: 100vw !important;
        height: 100vh !important;
        max-height: 100vh !important;
      `;
    } else if (this._dialogSize === 'medium') {
      dialog.style.width     = '640px';
      dialog.style.maxWidth  = '640px';
      dialog.style.height    = '80vh';
      dialog.style.maxHeight = '80vh';
    } else {
      // large (default)
      dialog.style.width     = '90vw';
      dialog.style.maxWidth  = '90vw';
      dialog.style.height    = '90vh';
      dialog.style.maxHeight = '90vh';
    }

    // Scrollable body: the image header scrolls away with the recipe content.
    const body = document.createElement('div');
    body.className = 'metro-dialog__body';

    // Header (image area)
    const header = document.createElement('div');
    header.className = 'metro-dialog__header';

    // Blurred, cover-fitted copy of the same image fills the whole header so
    // there are no empty bars; the sharp image sits on top, fully visible.
    const imgBg = document.createElement('img');
    imgBg.className = 'metro-dialog__img-bg metro-dialog__img--hidden';
    imgBg.alt = '';
    imgBg.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'metro-dialog__img metro-dialog__img--hidden';
    img.alt = '';

    const headerPlaceholder = document.createElement('div');
    headerPlaceholder.className = 'metro-dialog__header-placeholder';
      headerPlaceholder.textContent = this._i18n.t('popup.header_placeholder');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'metro-dialog__close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', this._i18n.t('popup.close_dialog'));
    closeBtn.addEventListener('click', () => this.close());

    header.appendChild(imgBg);
    header.appendChild(img);
    header.appendChild(headerPlaceholder);
    header.appendChild(closeBtn);
    body.appendChild(header);

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'metro-dialog__title-bar';
    const titleEl = document.createElement('h2');
    titleEl.className = 'metro-dialog__title';
    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'metro-dialog__subtitle';
    titleBar.appendChild(titleEl);
    titleBar.appendChild(subtitleEl);
    body.appendChild(titleBar);

    // Meta chips row
    const metaRow = document.createElement('div');
    metaRow.className = 'metro-meta';
    body.appendChild(metaRow);

    // Description
    const descEl = document.createElement('p');
    descEl.className = 'metro-description';
    body.appendChild(descEl);

    const sourceEl = document.createElement('div');
    sourceEl.className = 'metro-dialog__source';
    body.appendChild(sourceEl);

    // Actions bar — directly under description, above tabs
    const actions = document.createElement('div');
    actions.className = 'metro-actions';

    const ratingContainer = document.createElement('div');
    this._starRating = new StarRating(ratingContainer, 0, n => this._onRatingChange(n), this._i18n);
    actions.appendChild(ratingContainer);

    const cookedBtn = document.createElement('button');
    cookedBtn.type = 'button';
    cookedBtn.className = 'metro-btn metro-btn--sm metro-btn--cooked';
    cookedBtn.dataset.cooked = 'false';
    cookedBtn.textContent = this._i18n.t('popup.today_cooked');
    cookedBtn.addEventListener('click', () => this._onMarkCooked());
    actions.appendChild(cookedBtn);

    const lastCookedEl = document.createElement('span');
    lastCookedEl.className = 'metro-actions__last-cooked';
    actions.appendChild(lastCookedEl);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'metro-btn metro-btn--sm metro-actions__edit';
    editBtn.textContent = this._i18n.t('popup.edit_recipe');
    editBtn.addEventListener('click', () => this._onEditClick());
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'metro-btn metro-btn--sm metro-btn--danger metro-actions__delete';
    deleteBtn.textContent = this._i18n.t('popup.delete_recipe');
    deleteBtn.addEventListener('click', () => this._onDeleteClick());
    actions.appendChild(deleteBtn);

    const servingsCalculator = document.createElement('div');
    servingsCalculator.className = 'metro-serving-calculator';
    servingsCalculator.hidden = true;
    const servingsLabel = document.createElement('span');
    servingsLabel.textContent = this._i18n.t('popup.servings');
    const servingsMinus = this._servingsButton('−', this._i18n.t('popup.fewer_servings'));
    const servingsTarget = document.createElement('span');
    servingsTarget.setAttribute('role', 'status');
    servingsTarget.className = 'metro-serving-calculator__target';
    servingsTarget.setAttribute('aria-label', this._i18n.t('popup.target_servings'));
    const servingsPlus = this._servingsButton('+', this._i18n.t('popup.more_servings'));
    servingsMinus.addEventListener('click', () => this._changeTargetYield(-1));
    servingsPlus.addEventListener('click', () => this._changeTargetYield(1));
    servingsCalculator.append(servingsLabel, servingsMinus, servingsTarget, servingsPlus);
    actions.appendChild(servingsCalculator);

    const actionsError = document.createElement('div');
    actionsError.className = 'metro-error metro-actions__error';
    actionsError.setAttribute('role', 'alert');
    actionsError.hidden = true;
    actions.appendChild(actionsError);

    body.appendChild(actions);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'metro-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', this._i18n.t('popup.recipe_sections'));
    [
      this._i18n.t('popup.ingredients'),
      this._i18n.t('popup.instructions'),
      this._i18n.t('popup.info'),
    ].forEach((label, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const tabId = `${dialogId}-tab-${idx}`;
      const panelId = `${dialogId}-panel-${idx}`;
      btn.id = tabId;
      btn.className = 'metro-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', panelId);
      btn.setAttribute('aria-selected', 'false');
      btn.tabIndex = idx === 0 ? 0 : -1;
      btn.textContent = label;
      btn.addEventListener('click', () => this._switchTab(idx));
      btn.addEventListener('keydown', (event) => this._onTabKeydown(event, idx));
      tabs.appendChild(btn);
    });
    body.appendChild(tabs);

    // Tab panels
    const tabContent = document.createElement('div');
    tabContent.className = 'metro-tab-content';

    const ingredientsPanel = document.createElement('div');
    ingredientsPanel.className = 'metro-tab-panel';
    const instructionsPanel = document.createElement('div');
    instructionsPanel.className = 'metro-tab-panel';
    const infoPanel = document.createElement('div');
    infoPanel.className = 'metro-tab-panel';

    [ingredientsPanel, instructionsPanel, infoPanel].forEach((panel, idx) => {
      panel.id = `${dialogId}-panel-${idx}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `${dialogId}-tab-${idx}`);
      panel.hidden = true;
    });

    tabContent.appendChild(ingredientsPanel);
    tabContent.appendChild(instructionsPanel);
    tabContent.appendChild(infoPanel);
    body.appendChild(tabContent);

    // Wrap the recipe-view content so we can swap it for the inline editor
    // without leaving the shared, scrollable dialog body.
    const viewContainer = document.createElement('div');
    viewContainer.className = 'metro-dialog__view';
    while (body.firstChild) viewContainer.appendChild(body.firstChild);
    body.appendChild(viewContainer);

    // Host for the inline editor (same dialog body → same scroll behaviour).
    const editorHost = document.createElement('div');
    editorHost.className = 'metro-dialog__editor';
    editorHost.hidden = true;
    body.appendChild(editorHost);

    dialog.appendChild(body);

    // Close on backdrop click
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) this.close();
    });

    // Close on Escape (native <dialog> handles this, but we need cleanup).
    // This fires for every close path (backdrop, Escape, button, programmatic),
    // so it is the single place to notify the card for URL syncing.
    dialog.addEventListener('close', () => {
      this._currentRecipe = null;
      this._onClose();
    });

    this._mount.appendChild(dialog);
    this._dialog = dialog;

    // Store refs for population
    this._els = {
      img, imgBg, headerPlaceholder, closeBtn, titleEl, subtitleEl, metaRow, descEl, sourceEl,
      tabs, ingredientsPanel, instructionsPanel, infoPanel, lastCookedEl, cookedBtn,
      servingsCalculator, servingsLabel, servingsMinus, servingsTarget, servingsPlus, actionsError,
      editBtn, deleteBtn, header, viewContainer, editorHost,
    };
    this._switchTab(this._tabIndex(this._defaultTab));
  }

  // ---------------------------------------------------------------------------
  // Private — populate with recipe data
  // ---------------------------------------------------------------------------

  /**
   * Reveal the blurred background copy once the foreground image has loaded.
   * The foreground uses `contain` (whole image, sharp, centered); the blurred
   * `cover` background fills the header so there are never empty side bars.
   * @param {HTMLImageElement} img
   */
  _applyImageFit(img) {
    const bg = this._els?.imgBg;
    if (bg && img?.src) {
      if (bg.src !== img.src) bg.src = img.src;
      bg.classList.remove('metro-dialog__img--hidden');
    }
  }

  /** @param {import('../services/api.js').Recipe} recipe */
  _populate(recipe) {
    this._currentRecipe = recipe;
    const {
      img, headerPlaceholder, titleEl, subtitleEl, metaRow,
      descEl, ingredientsPanel, instructionsPanel, infoPanel, lastCookedEl,
      sourceEl,
    } = this._els;
    this._clearActionError();

    this._baseYield = isUsableRecipeYield(recipe.recipeYield) ? recipe.recipeYield : null;
    this._targetYield = this._baseYield;
    this._updateServingControls();

    // Image — static /local/ file (see CookbookApi.imageUrl)
    const imgBg = this._els.imgBg;
    imgBg.classList.add('metro-dialog__img--hidden');
    const imgUrl = this._api.imageUrl(recipe.id, recipe.image_mtime || recipe.dateModified || recipe._ha_last_cooked || '');
    img.src = imgUrl;
    img.onload = () => {
      img.classList.remove('metro-dialog__img--hidden');
      headerPlaceholder.style.display = 'none';
      this._applyImageFit(img);
    };
    img.onerror = () => {
      // No real image: hide the blurred background and fall back to placeholder.
      imgBg.classList.add('metro-dialog__img--hidden');
      if (this._placeholder) {
        img.src = this._placeholder;
        img.onload = () => {
          img.classList.remove('metro-dialog__img--hidden');
          headerPlaceholder.style.display = 'none';
        };
      } else {
        img.classList.add('metro-dialog__img--hidden');
        headerPlaceholder.style.display = '';
      }
    };

    // Title
    titleEl.textContent = recipe.name || '—';
    subtitleEl.textContent = recipe.recipeCategory || '';

    // Meta chips
    metaRow.innerHTML = '';
    if (recipe.recipeYield) {
      metaRow.appendChild(this._chip(this._i18n.t('popup.serving_count', { count: recipe.recipeYield }), true));
    }
    const total = parseDuration(recipe.totalTime, this._i18n);
    if (total) metaRow.appendChild(this._chip(`⏱ ${total}`));
    const prep = parseDuration(recipe.prepTime, this._i18n);
    if (prep) metaRow.appendChild(this._chip(`${this._i18n.t('popup.preparation')} ${prep}`));
    const cook = parseDuration(recipe.cookTime, this._i18n);
    if (cook) metaRow.appendChild(this._chip(`${this._i18n.t('popup.cooking')} ${cook}`));

    // Description
    if (recipe.description) {
      descEl.textContent = recipe.description;
      descEl.classList.remove('metro-hidden');
    } else {
      descEl.textContent = '';
      descEl.classList.add('metro-hidden');
    }

    sourceEl.innerHTML = '';
    if (isHttpUrl(recipe.url)) {
      const link = document.createElement('a');
      link.href = recipe.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'metro-btn metro-btn--sm';
      link.textContent = this._i18n.t('popup.open_source');
      link.style.textDecoration = 'none';
      sourceEl.appendChild(link);
    }

    // Ingredients tab
    this._renderStructuredIngredients(recipe);

    // Instructions tab
    instructionsPanel.innerHTML = '';
    const instructionView = getInstructionView(recipe);
    this._renderGroupedInstructions(instructionsPanel, instructionView, recipe.id);

    // Info tab
    infoPanel.innerHTML = '';

    // Source URL — prominent at the top so the user can jump to the original.
    if (isHttpUrl(recipe.url)) {
      const section = document.createElement('section');
      section.className = 'metro-info-section';
      const heading = document.createElement('h3');
      heading.id = `${this._dialog.id}-info-source`;
      heading.className = 'metro-info-section__heading';
      heading.textContent = this._i18n.t('popup.source');
      section.setAttribute('aria-labelledby', heading.id);
      section.appendChild(heading);

      const link = document.createElement('a');
      link.href = recipe.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'metro-btn metro-btn--accent metro-info-source__link';
      link.textContent = this._i18n.t('popup.open_original');
      link.style.textDecoration = 'none';
      section.appendChild(link);

      const urlText = document.createElement('div');
      urlText.className = 'metro-info-source__url';
      urlText.textContent = recipe.url;
      section.appendChild(urlText);

      infoPanel.appendChild(section);
    }

    const tags = recipe.keywords
      ? recipe.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean)
      : [];
    if (tags.length > 0) {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.id = `${this._dialog.id}-info-tags`;
      heading.className = 'metro-info-section__heading';
      heading.textContent = this._i18n.t('popup.tags');
      section.setAttribute('aria-labelledby', heading.id);
      section.className = 'metro-info-section';
      section.appendChild(heading);
      const tagList = document.createElement('div');
      tagList.className = 'metro-meta';
      tags.forEach((tag) => tagList.appendChild(this._chip(tag)));
      section.appendChild(tagList);
      infoPanel.appendChild(section);
    }

    const nutritionEntries = [
      ['calories', this._i18n.t('popup.calories'), 'kcal'],
      ['proteinContent', this._i18n.t('popup.protein'), 'g'],
      ['carbohydrateContent', this._i18n.t('popup.carbohydrates'), 'g'],
      ['fatContent', this._i18n.t('popup.fat'), 'g'],
    ];
    const nutrition = recipe.nutrition || {};
    const availableNutrition = nutritionEntries.filter(([key]) => nutrition[key]);
    if (availableNutrition.length > 0) {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.id = `${this._dialog.id}-info-nutrition`;
      heading.className = 'metro-info-section__heading';
      heading.textContent = this._i18n.t('popup.nutrition');
      section.setAttribute('aria-labelledby', heading.id);
      section.className = 'metro-info-section';
      section.appendChild(heading);
      const list = document.createElement('dl');
      list.className = 'metro-info-section__nutrition';
      availableNutrition.forEach(([key, label, unit]) => {
        const term = document.createElement('dt');
        term.textContent = label;
        const value = document.createElement('dd');
        value.textContent = `${nutrition[key]} ${unit}`;
        list.append(term, value);
      });
      section.appendChild(list);
      infoPanel.appendChild(section);
    }
    if (recipe._ha_notes) {
      const notes = document.createElement('p');
      notes.className = 'metro-description';
      notes.textContent = this._i18n.t('popup.recipe_note', { note: recipe._ha_notes });
      infoPanel.appendChild(notes);
    }

    // Rating
    this._starRating.setValue(recipe._ha_rating || 0);

    // Last cooked
    const lc = formatDate(recipe._ha_last_cooked, this._i18n);
    lastCookedEl.textContent = lc ? this._i18n.t('popup.last_cooked', { date: lc }) : '';

    // Cooked button state — use local date (not UTC) to match Nextcloud's stored date
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const lastCooked = (recipe._ha_last_cooked || '').substring(0, 10);
    this._setCookedState(lastCooked === today);

    this._switchTab(this._tabIndex(this._defaultTab));
  }

  _renderStructuredIngredients(recipe) {
    const { ingredientsPanel } = this._els;
    ingredientsPanel.innerHTML = '';
    const ingredients = (recipe.recipeInstructions || []).flatMap(step => step.ingredients || []);
    if (ingredients.length === 0) {
      ingredientsPanel.textContent = this._i18n.t('popup.no_ingredients');
      return;
    }
    const factor = this._servingScaleFactor();
    const list = document.createElement('ul');
    list.className = 'metro-ingredient-list';
    ingredients.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'metro-ingredient-list__item';
      const bullet = document.createElement('span');
      bullet.className = 'metro-ingredient-list__bullet';
      const text = document.createElement('span');
      text.textContent = this._formatScaledIngredient(item, factor);
      li.append(bullet, text);
      list.appendChild(li);
    });
    ingredientsPanel.appendChild(list);
  }

  _formatScaledIngredient(ingredient, factor) {
    const scaled = scaleGroupedIngredient([{ ingredients: [ingredient], instruction: '' }], factor)[0].ingredients[0];
    return [scaled.amount, scaled.unit, scaled.name, scaled.note ? `(${scaled.note})` : '']
      .filter(Boolean)
      .join(' ');
  }

  // ---------------------------------------------------------------------------
  // Private — tabs
  // ---------------------------------------------------------------------------

  _switchTab(idx) {
    this._activeTab = idx;
    const panels = [
      this._els.ingredientsPanel,
      this._els.instructionsPanel,
      this._els.infoPanel,
    ];
    const tabBtns = this._els.tabs.querySelectorAll('.metro-tab');

    panels.forEach((p, i) => {
      p.classList.toggle('metro-tab-panel--active', i === idx);
      p.hidden = i !== idx;
    });
    tabBtns.forEach((btn, i) => {
      btn.classList.toggle('metro-tab--active', i === idx);
      btn.setAttribute('aria-selected', String(i === idx));
      btn.tabIndex = i === idx ? 0 : -1;
    });
  }

  _tabIndex(tab) {
    return { ingredients: 0, instructions: 1, info: 2 }[tab] ?? 0;
  }

  _onTabKeydown(event, idx) {
    const tabCount = 3;
    let next = idx;
    if (event.key === 'ArrowRight') next = (idx + 1) % tabCount;
    if (event.key === 'ArrowLeft') next = (idx + tabCount - 1) % tabCount;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabCount - 1;
    if (next === idx) return;
    event.preventDefault();
    this._switchTab(next);
    this._els.tabs.querySelectorAll('.metro-tab')[next].focus();
  }

  _showInstructionWarning(panel, message) {
    const warning = document.createElement('p');
    warning.className = 'metro-error';
    warning.setAttribute('role', 'status');
    warning.textContent = message;
    panel.appendChild(warning);
  }

  _renderGroupedInstructions(panel, steps, recipeId) {
    steps = scaleGroupedIngredient(steps, this._servingScaleFactor());
    const progress = this._progress.get(recipeId);
    let ingredientIndex = 0;
    steps.forEach((step, stepIndex) => {
      const section = document.createElement('section');
      section.className = 'metro-step-list__item';
      const heading = document.createElement('h3');
      heading.className = 'metro-step-list__number';
      heading.textContent = String(stepIndex + 1).padStart(2, '0');
      section.appendChild(heading);
      const content = document.createElement('div');
      content.className = 'metro-step-list__content';
      const ingredients = Array.isArray(step.ingredients) ? step.ingredients : [];
      if (ingredients.length > 0) {
        const ingredientGroup = document.createElement('div');
        ingredientGroup.className = 'metro-step-list__ingredients';
        ingredientGroup.dataset.section = 'ingredients';
        const ingredientHeading = document.createElement('h4');
        ingredientHeading.className = 'metro-step-list__subheading';
        ingredientHeading.textContent = this._i18n.t('popup.ingredients');
        ingredientGroup.appendChild(ingredientHeading);
        ingredients.forEach((ingredient) => {
          const index = ingredientIndex++;
          const label = document.createElement('label');
          const checkbox = this._progressCheckbox(
            'ingredient', index, progress.ingredients.includes(index), recipeId
          );
          const text = document.createElement('span');
          text.className = 'metro-step-list__text';
          text.textContent = [ingredient.amount, ingredient.unit, ingredient.name]
            .filter(Boolean).join(' ');
          if (ingredient.note) text.textContent += ` (${ingredient.note})`;
          label.append(checkbox, text);
          ingredientGroup.appendChild(label);
        });
        content.appendChild(ingredientGroup);
      }
      const instructionGroup = document.createElement('div');
      instructionGroup.className = 'metro-step-list__instruction';
      instructionGroup.dataset.section = 'instruction';
      const instructionHeading = document.createElement('h4');
      instructionHeading.className = 'metro-step-list__subheading';
      instructionHeading.textContent = this._i18n.t('popup.instructions');
      instructionGroup.appendChild(instructionHeading);
      const instructionLabel = document.createElement('label');
      const instructionCheckbox = this._progressCheckbox(
        'instruction', stepIndex, progress.instructions.includes(stepIndex), recipeId
      );
      const instructionText = document.createElement('span');
      instructionText.className = 'metro-step-list__text';
      instructionText.textContent = step.instruction || '';
      instructionLabel.append(instructionCheckbox, instructionText);
      instructionGroup.appendChild(instructionLabel);
      content.appendChild(instructionGroup);
      section.appendChild(content);
      panel.appendChild(section);
    });
  }

  _servingScaleFactor() {
    return this._baseYield === null
      ? 1
      : getServingScaleFactor(this._baseYield, this._targetYield);
  }

  _scaleFlatIngredientText(text, factor) {
    if (factor === 1 || typeof text !== 'string') return text;
    const quantity = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?)';
    const match = text.match(new RegExp(`^(\\s*(?:ca\\.\\s*)?${quantity}(?:\\s*[-–]\\s*${quantity})?)(.*)$`, 'i'));
    return match ? `${scaleQuantityText(match[1], factor)}${match[2]}` : text;
  }

  _servingsButton(text, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'metro-btn metro-btn--sm metro-serving-calculator__button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    return button;
  }

  _changeTargetYield(delta) {
    this._setTargetYield((this._targetYield || 1) + delta);
  }

  _setTargetYield(value) {
    if (this._baseYield === null) return;
    const parsed = /^[-+]?\d+$/.test(String(value).trim()) ? Number(value) : Number.NaN;
    this._targetYield = Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
    this._els.servingsTarget.textContent = String(this._targetYield);
    this._updateServingControls();
    this._renderStructuredIngredients(this._currentRecipe);
    const instructionView = getInstructionView(this._currentRecipe);
    this._els.instructionsPanel.innerHTML = '';
    this._renderGroupedInstructions(this._els.instructionsPanel, instructionView, this._currentRecipe.id);
  }

  _updateServingControls() {
    const usable = this._baseYield !== null;
    const { servingsCalculator, servingsMinus, servingsTarget, servingsPlus } = this._els;
    servingsCalculator.hidden = !usable;
    servingsMinus.disabled = !usable || this._targetYield <= 1;
    servingsTarget.textContent = usable ? String(this._targetYield) : '';
    servingsTarget.setAttribute('aria-label', usable
      ? this._i18n.t('popup.target_servings_value', { count: this._targetYield })
      : this._i18n.t('popup.target_servings_unavailable'));
    servingsPlus.disabled = !usable;
  }

  _progressCheckbox(category, index, checked, recipeId) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.setAttribute('aria-label', this._i18n.t(
      category === 'ingredient' ? 'popup.ingredient_done' : 'popup.step_done',
    ));
    checkbox.addEventListener('change', () => {
      if (category === 'ingredient') {
        this._progress.setIngredientDone(recipeId, index, checkbox.checked);
      } else {
        this._progress.setInstructionDone(recipeId, index, checkbox.checked);
      }
    });
    return checkbox;
  }

  // ---------------------------------------------------------------------------
  // Private — write-back handlers
  // ---------------------------------------------------------------------------

  async _onEditClick() {
    if (!this._currentRecipe) return;
    await this.openEditor(this._currentRecipe);
  }

  _onDeleteClick() {
    if (!this._currentRecipe || !this._onDelete) return;
    this._openDeleteConfirm(this._currentRecipe);
  }

  /**
   * Confirmation dialog that requires the user to type the exact recipe name
   * before the delete button becomes active. The name can be copied to the
   * clipboard via a copy icon next to it.
   */
  _openDeleteConfirm(recipe) {
    const name = recipe.name || '';
    const dialog = document.createElement('dialog');
    dialog.className = 'metro-dialog metro-confirm';

    const body = document.createElement('div');
    body.className = 'metro-confirm__body';

    const heading = document.createElement('h2');
    heading.className = 'metro-confirm__title';
    heading.textContent = this._i18n.t('popup.delete_title');
    body.appendChild(heading);

    const info = document.createElement('p');
    info.className = 'metro-confirm__text';
    info.textContent = this._i18n.t('popup.delete_help');
    body.appendChild(info);

    const nameRow = document.createElement('div');
    nameRow.className = 'metro-confirm__name-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'metro-confirm__name';
    nameEl.textContent = name;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'metro-btn metro-btn--sm metro-btn--icon metro-confirm__copy';
    copyBtn.textContent = '⧉';
    copyBtn.setAttribute('aria-label', this._i18n.t('popup.copy_recipe_name'));
    copyBtn.title = this._i18n.t('popup.copy_name');
    copyBtn.addEventListener('click', () => this._copyToClipboard(name, copyBtn));
    nameRow.append(nameEl, copyBtn);
    body.appendChild(nameRow);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'metro-confirm__input';
    input.setAttribute('aria-label', this._i18n.t('popup.recipe_name_confirmation'));
    input.placeholder = this._i18n.t('popup.recipe_name');
    body.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'metro-dialog__footer metro-confirm__footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'metro-btn';
    cancel.textContent = this._i18n.t('common.cancel');
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'metro-btn metro-btn--danger';
    confirm.textContent = this._i18n.t('popup.confirm_delete');
    confirm.disabled = true;
    footer.append(cancel, confirm);
    body.appendChild(footer);
    dialog.appendChild(body);

    const cleanup = () => { if (dialog.open) dialog.close(); dialog.remove(); };
    this._deleteDialogElements = { heading, info, copy: copyBtn, input, cancel, confirm };
    input.addEventListener('input', () => {
      confirm.disabled = input.value.trim() !== name.trim();
    });
    cancel.addEventListener('click', cleanup);
    dialog.addEventListener('click', event => { if (event.target === dialog) cleanup(); });
    confirm.addEventListener('click', async () => {
      if (input.value.trim() !== name.trim()) return;
      cleanup();
      this.close();
      await this._onDelete(recipe);
    });

    this._mount.appendChild(dialog);
    dialog.showModal();
    input.focus();
  }

  async _copyToClipboard(text, button) {
    const ok = await this._writeClipboard(text);
    const previous = button.dataset.label || button.textContent;
    button.dataset.label = previous;
    button.textContent = ok ? '✓' : '✕';
    button.title = ok
      ? this._i18n.t('popup.copy_success')
      : this._i18n.t('popup.copy_failed');
    setTimeout(() => {
      button.textContent = button.dataset.label;
      button.title = this._i18n.t('popup.copy_name');
    }, 1200);
  }

  /**
   * Copy text to the clipboard with a Shadow-DOM-safe fallback.
   * The async Clipboard API only works in secure contexts (HTTPS/localhost)
   * and often fails inside HA over plain HTTP, so we fall back to a temporary
   * textarea + execCommand('copy'), which must live in the same (shadow) tree
   * to be selectable.
   */
  async _writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* fall through to execCommand */
      }
    }
    try {
      const host = this._dialog || this._mount;
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.opacity = '0';
      host.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async _onRatingChange(stars) {
    if (!this._currentRecipe) return;
    try {
      const updated = await this._api.updateRecipeMeta(this._currentRecipe.id, { rating: stars });
      this._currentRecipe = updated;
    } catch (err) {
      console.error('[cookbook-card] Rating speichern fehlgeschlagen:', err);
      this._showActionError(err);
    }
  }

  async _onMarkCooked() {
    if (!this._currentRecipe) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    try {
      await this._api.updateRecipeMeta(this._currentRecipe.id, { lastCooked: today });
      // Update in-memory recipe so button stays green without reload
      this._currentRecipe._ha_last_cooked = today;
      this._els.lastCookedEl.textContent = this._i18n.t('popup.last_cooked', {
        date: formatDate(today, this._i18n),
      });
      this._setCookedState(true);
      this._progress.clear(this._currentRecipe.id);
      this._resetProgressControls();
      this._api._cache.delete(`recipe:${this._currentRecipe.id}`);
    } catch (err) {
      console.error('[cookbook-card] Datum speichern fehlgeschlagen:', err);
      this._showActionError(err);
    }
  }

  _resetProgressControls() {
    this._els.instructionsPanel.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = false;
    });
  }

  _setCookedState(cooked) {
    const btn = this._els?.cookedBtn;
    if (!btn) return;
    btn.dataset.cooked = cooked ? 'true' : 'false';
    btn.textContent = cooked
      ? this._i18n.t('popup.today_cooked_done')
      : this._i18n.t('popup.today_cooked');
  }

  // ---------------------------------------------------------------------------
  // Private — loading / error states
  // ---------------------------------------------------------------------------

  _showLoading() {
    const { titleEl, subtitleEl, metaRow, descEl, sourceEl,
            ingredientsPanel, instructionsPanel, infoPanel } = this._els;

    titleEl.textContent = this._i18n.t('popup.loading_recipe');
    subtitleEl.textContent = '';
    metaRow.innerHTML = '';
    descEl.textContent = '';
    sourceEl.innerHTML = '';
    ingredientsPanel.innerHTML = '';
    instructionsPanel.innerHTML = '';
    infoPanel.innerHTML = '';

    this._els.img.classList.add('metro-dialog__img--hidden');
    this._clearActionError();
    this._els.headerPlaceholder.style.display = '';
    this._starRating.setValue(0);
    this._els.lastCookedEl.textContent = '';
    this._baseYield = null;
    this._targetYield = null;
    this._updateServingControls();
  }

  _showLoadError(message) {
    this._els.titleEl.textContent = this._i18n.t('popup.error_title');
    this._els.ingredientsPanel.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'metro-error';
    error.setAttribute('role', 'alert');
    error.textContent = message || this._i18n.t('popup.load_error');
    this._els.ingredientsPanel.appendChild(error);
  }

  _showActionError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this._els.actionsError.textContent = this._i18n.t('popup.action_error', { message });
    this._els.actionsError.hidden = false;
  }

  _clearActionError() {
    if (!this._els?.actionsError) return;
    this._els.actionsError.textContent = '';
    this._els.actionsError.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Private — helpers
  // ---------------------------------------------------------------------------

  /**
   * @param {string} text
   * @param {boolean} accent
   * @returns {HTMLElement}
   */
  _chip(text, accent = false) {
    const el = document.createElement('span');
    el.className = 'metro-chip' + (accent ? ' metro-chip--accent' : '');
    el.textContent = text;
    return el;
  }
}
