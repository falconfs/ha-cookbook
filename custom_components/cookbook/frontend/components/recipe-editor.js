import {
  formStateFromRecipe,
  recipeFromFormState,
  validateFormState,
  validateImageFile,
  recipeToJson,
  validateRecipeJson,
  moveIngredientBetweenSteps,
} from '../services/recipe-form.js';
import { createI18n } from '../i18n/i18n.js';

/** Lazily-loaded vendored CodeMirror module (shared across editor instances). */
let codemirrorPromise = null;
function loadCodeMirror() {
  if (!codemirrorPromise) {
    codemirrorPromise = import('../vendor/codemirror.js').catch(() => null);
  }
  return codemirrorPromise;
}

const EMPTY_INGREDIENT = () => ({ name: '', amount: '', unit: '', note: '' });
const EMPTY_STEP = () => ({ instruction: '', ingredients: [EMPTY_INGREDIENT()] });

/** Coerce any value to a display string ("" for null/undefined). */
function textValue(value) {
  return value == null ? '' : String(value);
}

let datalistSequence = 0;

/** German labels for the four structured ingredient fields. */
const INGREDIENT_FIELDS = [
  { key: 'amount', label: 'amount' },
  { key: 'unit', label: 'unit' },
  { key: 'name', label: 'ingredient' },
  { key: 'note', label: 'ingredient_note' },
];

export class RecipeEditor {
  /**
   * @param {HTMLElement} host       container the editor renders its form into
   * @param {import('../services/api.js').CookbookApi} api
   * @param {(id?: string) => void} onSaved   called after a successful save
   * @param {() => void} [onCancel]           called when the user cancels
   */
  constructor(host, api, onSaved = () => {}, onCancel = () => {}, options = {}) {
    this._host = host;
    this._api = api;
    this._onSaved = onSaved;
    this._onCancel = typeof onCancel === 'function' ? onCancel : () => {};
    this._aiTaskEntity = options?.aiTaskEntity || undefined;
    this._i18n = options?.i18n || createI18n();
    this._mode = 'add';
    this._recipe = {};
    this._state = null;
    this._suggestions = { categories: [], keywords: [], units: [], tools: [] };
    this._tmpImageToken = null;
    this._removeImage = false;
    this._view = 'form'; // 'form' | 'json'
    this._cm = null;     // active CodeMirror EditorView (JSON mode)
    this._importUrl = '';
    this._importStatus = null;
    this._pendingPreviewSrc = null;
    this._aiStatus = null;
  }

  setI18n(i18n) {
    this._i18n = i18n;
    if (!this._state) return;
    const activeName = this._host?.getRootNode?.().activeElement?.name;
    if (this._view === 'json') this._json = this._currentJsonText();
    this._importStatus = null;
    this._aiStatus = null;
    this._cm?.destroy();
    this._cm = null;
    this._render();
    if (activeName) this._host.querySelector?.(`[name="${activeName}"]`)?.focus?.();
  }

  _t(key, params) {
    return this._i18n.t(`editor.${key}`, params);
  }

  async open(recipe = null) {
    this._mode = recipe ? 'edit' : 'add';
    this._recipe = recipe || {};
    this._state = recipe
      ? formStateFromRecipe(recipe, 'edit')
      : formStateFromRecipe({ recipeInstructions: [EMPTY_STEP()] }, 'add');
    this._suggestions = await this._loadSuggestions();
    this._tmpImageToken = null;
    this._removeImage = false;
    this._view = 'form';
    this._importUrl = '';
    this._importStatus = null;
    this._pendingPreviewSrc = null;
    this._aiStatus = null;
    this._render();
  }

  close() {
    this._state = null;
    if (this._host) this._host.innerHTML = '';
  }

  async _loadSuggestions() {
    try {
      const suggestions = await this._api.getSuggestions?.();
      return {
        categories: suggestions?.categories || [],
        keywords: suggestions?.keywords || [],
        units: suggestions?.units || [],
        tools: suggestions?.tools || [],
      };
    } catch {
      return { categories: [], keywords: [], units: [], tools: [] };
    }
  }

  _render() {
    this._cm?.destroy();
    this._cm = null;
    this._host.innerHTML = '';
    const body = document.createElement('form');
    body.className = 'metro-dialog__form';
    body.addEventListener('submit', event => {
      event.preventDefault();
      this._save();
    });

    body.appendChild(this._header());
    body.appendChild(this._viewSwitcher());

    if (this._view === 'json') {
      body.appendChild(this._jsonSection());
    } else {
      if (this._mode === 'add') body.appendChild(this._urlImportSection());
      body.appendChild(this._metaSection());
      body.appendChild(this._timeSection());
      body.appendChild(this._imageSection());
      if (this._mode === 'edit') body.appendChild(this._haSection());
      if (this._mode === 'edit') body.appendChild(this._datesSection());
      body.appendChild(this._stepsSection());
      body.appendChild(this._advancedSection());
    }

    const errors = document.createElement('div');
    errors.className = 'metro-form-errors';
    errors.setAttribute('role', 'alert');
    body.appendChild(errors);

    body.appendChild(this._footer());
    this._host.appendChild(body);

    this._els = { body, errors, save: this._saveButton, file: this._fileInput };
    this._updateValidation();
    if (this._view === 'json') this._mountCodeMirror();
  }

  _viewSwitcher() {
    const bar = document.createElement('div');
    bar.className = 'metro-form-viewswitch';
    const makeTab = (view, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'metro-btn metro-btn--sm metro-form-viewswitch__tab'
        + (this._view === view ? ' metro-form-viewswitch__tab--active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => this._switchView(view));
      return btn;
    };
    bar.append(makeTab('form', this._t('form_view')), makeTab('json', this._t('json')));
    return bar;
  }

  _switchView(view) {
    if (view === this._view) return;
    if (view === 'json') {
      // Form → JSON: serialize the current form state.
      this._json = recipeToJson(recipeFromFormState(this._state, this._mode));
      this._view = 'json';
      this._render();
      return;
    }
    // JSON → Form: validate + parse; block the switch on errors.
    const text = this._cm ? this._cm.state.doc.toString() : (this._json || '');
    const result = validateRecipeJson(text);
    if (!result.ok) {
      this._showErrors(result.errors);
      return;
    }
    this._state = formStateFromRecipe(result.recipe, this._mode);
    this._json = null;
    this._view = 'form';
    this._render();
  }

  _jsonSection() {
    const section = document.createElement('section');
    section.className = 'metro-form-section metro-form-json';
    const heading = document.createElement('h3');
    heading.className = 'metro-form-section__heading';
    heading.textContent = this._t('json');
    section.appendChild(heading);

    const editorHost = document.createElement('div');
    editorHost.className = 'metro-form-json__editor';
    section.appendChild(editorHost);
    this._jsonEditorHost = editorHost;

    // Fallback textarea (used if CodeMirror fails to load).
    const textarea = document.createElement('textarea');
    textarea.className = 'metro-form-json__textarea';
    textarea.value = this._json ?? recipeToJson(recipeFromFormState(this._state, this._mode));
    textarea.spellcheck = false;
    editorHost.appendChild(textarea);
    this._jsonTextarea = textarea;

    const actions = document.createElement('div');
    actions.className = 'metro-form-json__actions';
    const formatBtn = document.createElement('button');
    formatBtn.type = 'button';
    formatBtn.className = 'metro-btn metro-btn--sm';
    formatBtn.textContent = this._t('format');
    formatBtn.addEventListener('click', () => this._formatJson());
    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'metro-btn metro-btn--sm';
    checkBtn.textContent = this._t('validate');
    checkBtn.addEventListener('click', () => this._checkJson());
    actions.append(formatBtn, checkBtn);
    section.appendChild(actions);
    return section;
  }

  async _mountCodeMirror() {
    const cm = await loadCodeMirror();
    if (!cm || this._view !== 'json' || !this._jsonEditorHost) return;
    const initial = this._jsonTextarea ? this._jsonTextarea.value : '';
    // Replace the fallback textarea with a CodeMirror editor.
    this._jsonTextarea?.remove();
    this._jsonTextarea = null;
    const view = new cm.EditorView({
      parent: this._jsonEditorHost,
      state: cm.EditorState.create({
        doc: initial,
        extensions: [
          cm.lineNumbers(),
          cm.highlightActiveLine(),
          cm.history(),
          cm.bracketMatching(),
          cm.foldGutter(),
          cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
          cm.json(),
          cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]),
        ],
      }),
    });
    this._cm = view;
  }

  _currentJsonText() {
    if (this._cm) return this._cm.state.doc.toString();
    if (this._jsonTextarea) return this._jsonTextarea.value;
    return this._json ?? '';
  }

  _setJsonText(text) {
    this._json = text;
    if (this._cm) {
      this._cm.dispatch({ changes: { from: 0, to: this._cm.state.doc.length, insert: text } });
    } else if (this._jsonTextarea) {
      this._jsonTextarea.value = text;
    }
  }

  _formatJson() {
    const result = validateRecipeJson(this._currentJsonText());
    if (!result.ok) { this._showErrors(result.errors); return; }
    this._setJsonText(recipeToJson(result.recipe));
    this._showErrors([]);
  }

  _checkJson() {
    const result = validateRecipeJson(this._currentJsonText());
    if (!result.ok) {
      this._showErrors(result.errors);
      return false;
    }
    this._showErrors(['json_valid']);
    return true;
  }

  _showErrors(errors) {
    if (!this._els?.errors) return;
    this._els.errors.innerHTML = '';
    (errors || []).forEach(error => {
      const message = typeof error === 'string'
        ? this._t(error)
        : this._t(error.key, error.params);
      const element = document.createElement('div');
      element.className = 'metro-error';
      element.textContent = message;
      this._els.errors.appendChild(element);
    });
  }

  _header() {
    const header = document.createElement('div');
    header.className = 'metro-dialog__title-bar';
    const title = document.createElement('h2');
    title.className = 'metro-dialog__title';
    title.textContent = this._mode === 'edit'
      ? this._t('edit_title_named', { name: this._recipe.name || '' })
      : this._t('add_title');
    header.appendChild(title);
    return header;
  }

  _section(titleText) {
    const section = document.createElement('section');
    section.className = 'metro-form-section';
    const heading = document.createElement('h3');
    heading.className = 'metro-form-section__heading';
    heading.textContent = titleText;
    section.appendChild(heading);
    const grid = document.createElement('div');
    grid.className = 'metro-form-grid';
    section.appendChild(grid);
    return { section, grid };
  }

  _metaSection() {
    const { section, grid } = this._section(this._t('general'));
    this._field(grid, 'name', this._t('name'), this._state.name, true);
    this._field(grid, 'recipeCategory', this._t('category'), this._state.recipeCategory, false, 'input', {
      suggestions: this._suggestions.categories,
    });
    this._field(grid, 'recipeYield', this._t('yield'), this._state.recipeYield, false, 'number');
    this._field(grid, 'authorName', this._t('author'), this._state.authorName, false, 'input');
    this._field(grid, 'description', this._t('description'), this._state.description, false, 'textarea', {
      full: true,
    });
    this._chipField(grid, 'keywords', this._t('keywords'), this._suggestions.keywords, this._t('add_tag_placeholder'));
    this._chipField(grid, 'tool', this._t('tools'), this._suggestions.tools, this._t('add_tool_placeholder'));
    return section;
  }

  _datesSection() {
    const { section, grid } = this._section(this._t('dates'));
    // dateCreated is editable; dateModified is shown read-only because it is
    // refreshed automatically on every save.
    this._field(grid, 'dateCreated', this._t('date_created'), this._state.dateCreated, false, 'input')
      .placeholder = this._t('date_placeholder');
    const modified = this._field(
      grid, 'dateModified_display', this._t('date_modified'), this._state.dateModified, false, 'input',
    );
    modified.readOnly = true;
    modified.disabled = true;
    return section;
  }

  _timeSection() {
    const { section, grid } = this._section(this._t('times'));
    this._duration(grid, 'prep', this._t('prep_time'));
    this._duration(grid, 'cook', this._t('cook_time'));
    this._duration(grid, 'total', this._t('total_time'));
    return section;
  }

  _imageSection() {
    const { section, grid } = this._section(this._t('image'));

    // The server downloads the URL into a
    // tmp area and we preview it same-origin (avoids CSP / mixed-content /
    // hotlink issues that block direct <img src=external>). The staged image is
    // attached to the recipe on save via a token.
    const urlWrap = document.createElement('div');
    urlWrap.className = 'metro-form-field metro-form-field--full metro-image-url';
    const urlLabel = document.createElement('span');
    urlLabel.className = 'metro-form-field__label';
    urlLabel.textContent = this._t('image_url');
    const urlRow = document.createElement('div');
    urlRow.className = 'metro-image-url__row';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.name = 'image';
    urlInput.value = this._state.image || '';
    urlInput.addEventListener('input', () => { this._state.image = urlInput.value; });
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'metro-btn metro-btn--sm';
    loadBtn.textContent = this._t('load_image');
    loadBtn.addEventListener('click', () => this._loadImageFromUrl(urlInput.value));
    urlRow.append(urlInput, loadBtn);
    urlWrap.append(urlLabel, urlRow);
    grid.appendChild(urlWrap);
    this._urlInput = urlInput;

    const file = this._field(grid, 'imageFile', this._t('image_file'), '', false, 'file', { full: true });
    file.accept = 'image/*,.jpg,.jpeg,.png,.webp';
    file.addEventListener('change', () => this._onImageFileChange());
    this._fileInput = file;

    // Same-origin preview element.
    const previewWrap = document.createElement('div');
    previewWrap.className = 'metro-form-field metro-form-field--full metro-image-preview';
    const previewLabel = document.createElement('span');
    previewLabel.className = 'metro-form-field__label';
    previewLabel.textContent = this._t('preview');
    const previewImg = document.createElement('img');
    previewImg.className = 'metro-image-preview__img';
    previewImg.alt = this._t('image_preview');
    const previewHint = document.createElement('span');
    previewHint.className = 'metro-image-preview__hint';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'metro-btn metro-btn--sm metro-btn--danger metro-image-preview__remove';
    removeBtn.textContent = this._t('remove_image');
    removeBtn.hidden = true;
    removeBtn.addEventListener('click', () => this._removeImagePreview());
    previewWrap.append(previewLabel, previewImg, previewHint, removeBtn);
    section.appendChild(previewWrap);
    this._previewImg = previewImg;
    this._previewHint = previewHint;
    this._removeBtn = removeBtn;

    // A freshly staged image (e.g. from URL import) takes precedence: show it.
    if (this._pendingPreviewSrc) {
      this._setImagePreview(this._pendingPreviewSrc, this._t('image_loaded'));
    } else if (this._mode === 'edit' && this._recipe?.id && this._hasExistingImage()) {
      // Otherwise, if the recipe already has an image, preview it.
      this._setImagePreview(
        this._api.imageUrl(this._recipe.id, this._recipe.image_mtime || this._recipe.dateModified || Date.now()),
        '',
      );
    }
    return section;
  }

  /** Heuristic: an edited recipe likely has a stored image if it carries an image url/field. */
  _hasExistingImage() {
    return Boolean(this._recipe?.image);
  }

  _removeImagePreview() {
    // Discard any staged upload and mark the existing image for removal on save.
    this._tmpImageToken = null;
    this._removeImage = true;
    this._state.image = '';
    if (this._urlInput) this._urlInput.value = '';
    if (this._fileInput) this._fileInput.value = '';
    this._setImagePreview(null, this._t('image_removed_on_save'));
  }

  async _loadImageFromUrl(url) {
    const trimmed = (url || '').trim();
    this._state.image = trimmed;
    if (!trimmed) { this._setImagePreview(null, ''); return; }
    this._setImagePreview(null, this._t('image_loading'));
    try {
      const result = await this._api.fetchImageToTmp(trimmed);
      if (result?.error || !result?.token) {
        this._setImagePreview(null, result?.error || this._t('image_load_error'));
        return;
      }
      // A staged tmp image replaces any previously chosen file and any pending
      // removal.
      if (this._fileInput) this._fileInput.value = '';
      this._removeImage = false;
      this._tmpImageToken = result.token;
      this._setImagePreview(this._api.tmpImageUrl(result.token), this._t('image_loaded'));
    } catch (error) {
      this._setImagePreview(null, this._t('image_error', { message: error.message }));
    }
  }

  async _onImageFileChange() {
    const file = this._fileInput?.files?.[0];
    if (!file) return;
    const error = validateImageFile(file);
    if (error) {
      this._tmpImageToken = null;
      this._setImagePreview(null, this._t(error));
      return;
    }
    // Upload to tmp immediately for a same-origin preview + save-time token.
    this._setImagePreview(null, this._t('image_loading'));
    try {
      const result = await this._api.uploadImageToTmp(file);
      if (result?.error || !result?.token) {
        this._setImagePreview(null, result?.error || this._t('image_invalid_file'));
        return;
      }
      this._state.image = '';
      if (this._urlInput) this._urlInput.value = '';
      this._removeImage = false;
      this._tmpImageToken = result.token;
      this._setImagePreview(this._api.tmpImageUrl(result.token), file.name);
    } catch (uploadError) {
      this._setImagePreview(null, this._t('image_error', { message: uploadError.message }));
    }
  }

  _setImagePreview(src, hint) {
    if (!this._previewImg) return;
    if (this._removeBtn) this._removeBtn.hidden = !src;
    if (src) {
      // Use an explicit visible value: the stylesheet defaults this element to
      // `display:none`, so `style.display = ''` would let CSS hide it again.
      this._previewImg.style.display = 'block';
      this._previewImg.onerror = () => {
        this._previewImg.style.display = 'none';
        this._previewHint.textContent = this._t('image_load_error');
      };
      this._previewImg.onload = () => { this._previewHint.textContent = hint || ''; };
      this._previewImg.src = src;
    } else {
      this._previewImg.removeAttribute('src');
      this._previewImg.style.display = 'none';
      this._previewHint.textContent = hint || '';
    }
  }

  _haSection() {
    const { section, grid } = this._section(this._t('home_assistant'));
    this._field(grid, 'haRating', this._t('rating'), this._state.haRating, false, 'number');
    this._field(grid, 'haLastCooked', this._t('last_cooked'), this._state.haLastCooked, false, 'date');
    return section;
  }

  _advancedSection() {
    const wrapper = document.createElement('details');
    wrapper.className = 'metro-form-section metro-form-advanced';
    // Open by default in edit mode when any advanced value already exists.
    const hasValues = this._state.author?.name || this._state.publisher?.name
      || this._state.aggregateRating?.ratingValue || this._state.recipeCuisine;
    wrapper.open = this._mode === 'edit' && Boolean(hasValues);
    const summary = document.createElement('summary');
    summary.className = 'metro-form-section__heading';
    summary.textContent = this._t('advanced_schema');
    wrapper.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'metro-form-grid';
    wrapper.appendChild(grid);

    this._objectField(grid, 'author', 'name', this._t('author'), { '@type': 'Person' });
    this._objectField(grid, 'publisher', 'name', this._t('publisher'), { '@type': 'Organization' });
    this._objectField(grid, 'aggregateRating', 'ratingValue', this._t('rating_value'), { '@type': 'AggregateRating' });
    this._objectField(grid, 'aggregateRating', 'ratingCount', this._t('rating_count'), { '@type': 'AggregateRating' });
    this._cuisineField(grid);
    return wrapper;
  }

  /**
   * Text field bound to `this._state[objectKey][prop]`. Missing objects are
   * created lazily with the given defaults; emptying the value removes the key,
   * and an object left with only its `@type` is dropped entirely.
   */
  _objectField(parent, objectKey, prop, label, defaults = {}) {
    const current = this._state[objectKey];
    const value = current && typeof current === 'object' ? textValue(current[prop]) : '';
    const input = this._field(parent, `${objectKey}.${prop}`, label, value);
    input.addEventListener('input', () => {
      const raw = input.value.trim();
      let obj = this._state[objectKey];
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = { ...defaults };
      if (raw === '') delete obj[prop];
      else obj[prop] = raw;
      const meaningfulKeys = Object.keys(obj).filter(key => key !== '@type');
      this._state[objectKey] = meaningfulKeys.length > 0 ? obj : undefined;
      this._updateValidation();
    });
  }

  _cuisineField(parent) {
    const value = Array.isArray(this._state.recipeCuisine)
      ? this._state.recipeCuisine.join(', ')
      : textValue(this._state.recipeCuisine);
    const input = this._field(parent, 'recipeCuisine', this._t('cuisine'), value);
    input.addEventListener('input', () => {
      const raw = input.value.trim();
      this._state.recipeCuisine = raw === '' ? undefined : raw;
      this._updateValidation();
    });
  }

  _footer() {
    const footer = document.createElement('div');
    footer.className = 'metro-dialog__footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'metro-btn';
    cancel.textContent = this._t('cancel');
    cancel.addEventListener('click', () => { this.close(); this._onCancel(); });
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'metro-btn metro-btn--accent';
    save.textContent = this._t('save');
    this._saveButton = save;
    footer.append(cancel, save);
    return footer;
  }

  /**
   * @param {object} [options]
   * @param {string[]} [options.suggestions] datalist entries for combobox behaviour
   * @param {boolean} [options.full] span the full grid width
   */
  _field(parent, name, label, value, required = false, type = 'input', options = {}) {
    const wrapper = document.createElement('label');
    wrapper.className = 'metro-form-field';
    if (options.full) wrapper.classList.add('metro-form-field--full');
    const caption = document.createElement('span');
    caption.className = 'metro-form-field__label';
    caption.textContent = label;
    wrapper.appendChild(caption);

    const isTextarea = type === 'textarea';
    const input = document.createElement(isTextarea ? 'textarea' : 'input');
    input.name = name;
    if (!isTextarea) input.type = type;
    input.value = Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value);
    if (required) input.required = true;

    if (Array.isArray(options.suggestions) && options.suggestions.length > 0) {
      const listId = `metro-datalist-${++datalistSequence}`;
      const datalist = document.createElement('datalist');
      datalist.id = listId;
      options.suggestions.forEach(entry => {
        const option = document.createElement('option');
        option.value = entry;
        datalist.appendChild(option);
      });
      input.setAttribute('list', listId);
      wrapper.appendChild(datalist);
    }

    input.addEventListener('input', () => {
      if (name.includes('.')) {
        // Nested fields (e.g. "author.name", "recipeCuisine") manage their own
        // state via dedicated handlers; skip the generic flat assignment.
        return;
      }
      if (name === 'tool') {
        this._state.tool = input.value.split(',').map(item => item.trim()).filter(Boolean);
      } else {
        this._state[name] = input.value;
      }
      this._updateValidation();
    });
    if (type === 'file') input.addEventListener('change', () => this._updateValidation());

    wrapper.appendChild(input);
    parent.appendChild(wrapper);
    return input;
  }

  /**
   * Chip-based multiselect field backed by a string array in `this._state[field]`.
   * Existing suggestions appear in a datalist; new values can be typed freely.
   */
  _chipField(parent, field, label, suggestions, placeholder) {
    const values = Array.isArray(this._state[field]) ? this._state[field] : [];
    const wrapper = document.createElement('div');
    wrapper.className = 'metro-form-field metro-form-field--full metro-form-tags';
    const caption = document.createElement('span');
    caption.className = 'metro-form-field__label';
    caption.textContent = label;
    wrapper.appendChild(caption);

    const chips = document.createElement('div');
    chips.className = 'metro-form-tags__chips';
    values.forEach((value, index) => {
      chips.appendChild(this._chipEntry(field, value, index));
    });
    wrapper.appendChild(chips);

    const listId = `metro-datalist-${++datalistSequence}`;
    const datalist = document.createElement('datalist');
    datalist.id = listId;
    (suggestions || [])
      .filter(entry => !values.includes(entry))
      .forEach(entry => {
        const option = document.createElement('option');
        option.value = entry;
        datalist.appendChild(option);
      });
    wrapper.appendChild(datalist);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'metro-form-tags__input';
    input.placeholder = placeholder;
    input.setAttribute('list', listId);
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this._addChip(field, input.value);
      input.value = '';
    });
    input.addEventListener('change', () => {
      if (!input.value.trim()) return;
      this._addChip(field, input.value);
      input.value = '';
    });
    wrapper.appendChild(input);
    parent.appendChild(wrapper);
  }

  _chipEntry(field, value, index) {
    const chip = document.createElement('span');
    chip.className = 'metro-chip metro-form-tags__chip';
    const text = document.createElement('span');
    text.textContent = value;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'metro-form-tags__remove';
    remove.setAttribute('aria-label', this._t('remove_item', { item: value }));
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      this._state[field].splice(index, 1);
      this._render();
    });
    chip.append(text, remove);
    return chip;
  }

  _addChip(field, rawValue) {
    const value = String(rawValue || '').trim();
    if (!Array.isArray(this._state[field])) this._state[field] = [];
    if (!value || this._state[field].includes(value)) return;
    this._state[field].push(value);
    this._render();
  }

  _duration(parent, prefix, label) {
    const wrapper = document.createElement('fieldset');
    wrapper.className = 'metro-form-field metro-form-duration';
    const legend = document.createElement('legend');
    legend.textContent = label;
    wrapper.appendChild(legend);
    this._field(wrapper, `${prefix}Hours`, this._t('hours'), this._state[`${prefix}Hours`], false, 'number');
    this._field(wrapper, `${prefix}Minutes`, this._t('minutes'), this._state[`${prefix}Minutes`], false, 'number');
    parent.appendChild(wrapper);
  }

  _urlImportSection() {
    const section = document.createElement('section');
    section.className = 'metro-form-section metro-form-import';

    const heading = document.createElement('h3');
    heading.className = 'metro-form-section__heading';
    heading.textContent = this._t('url_heading');
    section.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'metro-form-import__row';

    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'metro-input metro-form-import__input';
    input.placeholder = this._t('image_placeholder');
    input.setAttribute('aria-label', this._t('url_label'));
    input.value = this._importUrl || '';
    input.addEventListener('input', event => {
      this._importUrl = event.target.value;
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'metro-btn metro-btn--sm metro-btn--accent';
    button.textContent = this._t('import');
    button.addEventListener('click', () => this._importFromUrl());

    const aiButton = document.createElement('button');
    aiButton.type = 'button';
    aiButton.className = 'metro-btn metro-btn--sm';
    aiButton.textContent = this._t('ai_import');
    aiButton.title = this._t('ai_import_title');
    aiButton.addEventListener('click', () => this._aiFallbackImport());

    row.append(input, button, aiButton);
    section.appendChild(row);

    const status = document.createElement('div');
    status.className = 'metro-form-import__status';
    status.setAttribute('role', 'status');
    if (this._importStatus) {
      status.textContent = this._importStatus.text;
      status.classList.toggle('metro-form-import__status--error', this._importStatus.error === true);
    }
    section.appendChild(status);

    return section;
  }

  async _importFromUrl() {
    const url = (this._importUrl || '').trim();
    if (!url) {
      this._importStatus = { text: this._t('url_required'), error: true };
      this._render();
      return;
    }
    this._importStatus = { text: this._t('importing'), error: false };
    this._render();
    try {
      const draft = await this._api.importRecipeFromUrl(url);
      // Merge the imported draft into the form for review; nothing is saved yet.
      this._state = formStateFromRecipe(draft, 'add');
      // Stage the recipe image into the tmp area so it is attached on save.
      // Best-effort: a failed image download must not fail the whole import.
      this._tmpImageToken = null;
      const imageUrl = String(draft.image || '').trim();
      if (/^https?:\/\//i.test(imageUrl)) {
        try {
          const result = await this._api.fetchImageToTmp(imageUrl);
          if (result?.token) {
            this._tmpImageToken = result.token;
            // The image is attached via the token; do not persist the raw
            // external URL as the recipe image.
            this._state.image = '';
            this._pendingPreviewSrc = this._api.tmpImageUrl?.(result.token) || null;
          }
        } catch {
          // Ignore: recipe is still importable without the image.
        }
      }
      this._importStatus = { text: this._t('import_success'), error: false };
    } catch (error) {
      this._importStatus = {
        text: error instanceof Error ? error.message : this._t('import_error'),
        error: true,
      };
    }
    this._render();
  }

  /** AI fallback: extract the recipe from the URL via ai_task when the native
   *  parser found nothing. Stages the image like the native import. */
  async _aiFallbackImport() {
    const url = (this._importUrl || '').trim();
    if (!url) {
      this._importStatus = { text: this._t('url_required'), error: true };
      this._render();
      return;
    }
    this._importStatus = { text: this._t('ai_importing'), error: false };
    this._render();
    try {
      const draft = await this._api.aiImportFromUrl(url, this._aiTaskEntity);
      this._state = formStateFromRecipe(draft, 'add');
      this._tmpImageToken = null;
      this._pendingPreviewSrc = null;
      const imageUrl = String(draft.image || '').trim();
      if (/^https?:\/\//i.test(imageUrl)) {
        try {
          const result = await this._api.fetchImageToTmp(imageUrl);
          if (result?.token) {
            this._tmpImageToken = result.token;
            this._state.image = '';
            this._pendingPreviewSrc = this._api.tmpImageUrl?.(result.token) || null;
          }
        } catch {
          // best-effort image
        }
      }
      this._importStatus = { text: this._t('ai_import_success'), error: false };
    } catch (error) {
      this._importStatus = {
        text: error instanceof Error ? error.message : this._t('ai_import_error'),
        error: true,
      };
    }
    this._render();
  }

  /** AI improvement: ask the AI to re-group ingredients to the right steps. */
  async _aiRegroup() {
    this._aiStatus = { text: this._t('ai_regrouping'), error: false };
    this._render();
    try {
      const current = recipeFromFormState(this._state, this._mode);
      const draft = await this._api.aiRegroupRecipe(current, this._aiTaskEntity);
      const steps = Array.isArray(draft?.recipeInstructions) ? draft.recipeInstructions : null;
      if (!steps || steps.length === 0) throw new Error(this._t('ai_regroup_error'));
      this._state.steps = steps.map(step => ({
        instruction: step.instruction || '',
        ingredients: Array.isArray(step.ingredients) ? step.ingredients : [],
      }));
      this._aiStatus = { text: this._t('ai_regroup_success'), error: false };
    } catch (error) {
      this._aiStatus = {
        text: error instanceof Error ? error.message : this._t('ai_regroup_error'),
        error: true,
      };
    }
    this._render();
  }

  _stepsSection() {
    const section = document.createElement('section');
    section.className = 'metro-form-section';
    const heading = document.createElement('h3');
    heading.className = 'metro-form-section__heading';
    heading.textContent = this._t('steps');
    section.appendChild(heading);

    const steps = document.createElement('div');
    steps.className = 'metro-form-steps';
    this._state.steps.forEach((step, index) => this._renderStep(steps, step, index));
    section.appendChild(steps);

    const addStep = document.createElement('button');
    addStep.type = 'button';
    addStep.className = 'metro-btn metro-btn--sm metro-btn--accent';
    addStep.textContent = `+ ${this._t('add_step')}`;
    addStep.addEventListener('click', () => {
      this._state.steps.push(EMPTY_STEP());
      this._render();
    });
    section.appendChild(addStep);

    // AI improvement: reassign ingredients to the steps where they are used.
    const aiRegroup = document.createElement('button');
    aiRegroup.type = 'button';
    aiRegroup.className = 'metro-btn metro-btn--sm';
    aiRegroup.textContent = this._t('ai_regroup');
    aiRegroup.title = this._t('ai_regroup_title');
    aiRegroup.addEventListener('click', () => this._aiRegroup());
    section.appendChild(aiRegroup);

    const aiStatus = document.createElement('div');
    aiStatus.className = 'metro-form-import__status';
    aiStatus.setAttribute('role', 'status');
    if (this._aiStatus) {
      aiStatus.textContent = this._aiStatus.text;
      aiStatus.classList.toggle('metro-form-import__status--error', this._aiStatus.error === true);
    }
    section.appendChild(aiStatus);

    return section;
  }

  _renderStep(parent, step, index) {
    const section = document.createElement('fieldset');
    section.className = 'metro-form-step';

    const bar = document.createElement('div');
    bar.className = 'metro-form-step__bar';
    const legend = document.createElement('legend');
    legend.className = 'metro-form-step__legend';
    legend.textContent = this._t('step_number', { count: index + 1 });
    bar.appendChild(legend);

    const controls = document.createElement('div');
    controls.className = 'metro-form-step__controls';
    controls.append(
      this._stepControl('↑', this._t('move_step_up'), index === 0, () => this._moveStep(index, -1)),
      this._stepControl('↓', this._t('move_step_down'), index === this._state.steps.length - 1, () => this._moveStep(index, 1)),
      this._stepControl('🗑', this._t('remove_step'), false, () => this._removeStep(index)),
    );
    bar.appendChild(controls);
    section.appendChild(bar);

    this._field(section, `step-${index}-instruction`, this._t('instructions'), step.instruction, true, 'textarea', { full: true })
      .addEventListener('input', event => {
        step.instruction = event.target.value;
        this._updateValidation();
      });

    const ingredients = document.createElement('div');
    ingredients.className = 'metro-form-ingredients';
    step.ingredients.forEach((ingredient, ingredientIndex) => {
      ingredients.appendChild(this._renderIngredient(step, ingredient, index, ingredientIndex));
    });
    section.appendChild(ingredients);

    const addIngredient = document.createElement('button');
    addIngredient.type = 'button';
    addIngredient.className = 'metro-btn metro-btn--sm';
    addIngredient.textContent = `+ ${this._t('add_ingredient')}`;
    addIngredient.addEventListener('click', () => {
      step.ingredients.push(EMPTY_INGREDIENT());
      this._render();
    });
    section.appendChild(addIngredient);

    parent.appendChild(section);
  }

  _renderIngredient(step, ingredient, stepIndex, ingredientIndex) {
    const row = document.createElement('div');
    row.className = 'metro-form-ingredient';
    INGREDIENT_FIELDS.forEach(({ key, label }) => {
      const options = key === 'unit' ? { suggestions: this._suggestions.units } : {};
      const input = this._field(
        row,
        `ingredient-${stepIndex}-${ingredientIndex}-${key}`,
        this._t(label),
        ingredient[key],
        key === 'name',
        'input',
        options,
      );
      input.addEventListener('input', event => {
        ingredient[key] = event.target.value;
        this._updateValidation();
      });
    });
    if (this._state.steps.length > 1) {
      row.appendChild(this._ingredientStepMover(stepIndex, ingredientIndex));
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'metro-btn metro-btn--sm metro-btn--danger metro-form-ingredient__remove';
    remove.setAttribute('aria-label', this._t('remove_ingredient'));
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      step.ingredients.splice(ingredientIndex, 1);
      this._render();
    });
    row.appendChild(remove);
    return row;
  }

  /** A "move to step" select so the user can re-group an imported ingredient. */
  _ingredientStepMover(stepIndex, ingredientIndex) {
    const select = document.createElement('select');
    select.className = 'metro-input metro-form-ingredient__move';
    select.setAttribute('aria-label', this._t('move_ingredient'));

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = this._t('move_to_step');
    select.appendChild(placeholder);

    this._state.steps.forEach((_step, target) => {
      if (target === stepIndex) return;
      const option = document.createElement('option');
      option.value = String(target);
      option.textContent = this._t('step_number', { count: target + 1 });
      select.appendChild(option);
    });

    select.addEventListener('change', event => {
      const target = Number(event.target.value);
      if (Number.isNaN(target)) return;
      this._state.steps = moveIngredientBetweenSteps(
        this._state.steps,
        stepIndex,
        ingredientIndex,
        target,
      );
      this._render();
    });
    return select;
  }

  _stepControl(symbol, label, disabled, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'metro-btn metro-btn--sm metro-btn--icon';
    button.textContent = symbol;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  _moveStep(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= this._state.steps.length) return;
    const [step] = this._state.steps.splice(index, 1);
    this._state.steps.splice(target, 0, step);
    this._render();
  }

  _removeStep(index) {
    this._state.steps.splice(index, 1);
    this._render();
  }

  _updateValidation() {
    if (!this._els) return;
    if (this._view === 'json') {
      // In JSON mode the form rules don't apply live; validation happens on
      // "Prüfen" and before save. Keep Save enabled.
      this._els.save.disabled = false;
      return;
    }
    const errors = validateFormState(this._state);
    this._showErrors(errors);
    this._els.save.disabled = errors.length > 0;
  }

  async _save() {
    let recipe;
    if (this._view === 'json') {
      // Always lint + validate the JSON before saving; block on any error.
      const result = validateRecipeJson(this._currentJsonText());
      if (!result.ok) { this._showErrors(result.errors); return; }
      recipe = result.recipe;
    } else {
      const errors = validateFormState(this._state);
      if (errors.length) return;
      recipe = recipeFromFormState(this._state, this._mode);
    }
    // A staged temporary image (from URL import or file upload) is attached to
    // the recipe atomically on save via its token — no separate image round-trip.
    const token = this._tmpImageToken || undefined;
    const removeImage = this._removeImage || undefined;
    let saved;
    try {
      saved = this._mode === 'edit'
        ? await this._api.updateRecipe(this._recipe.id, recipe, token, removeImage)
        : await this._api.createRecipe(recipe, token, removeImage);
    } catch (error) {
      this._showErrors([{ key: 'save_failed', params: { message: error.message } }]);
      return;
    }
    const id = typeof saved === 'string'
      ? saved
      : saved?.id || saved?.recipe_id || this._recipe.id;
    // The popup owns the dialog lifecycle: it exits editor mode and reloads the
    // saved recipe. Do not close the shared dialog from the editor itself.
    await this._onSaved(id);
  }
}
