/**
 * GridView — recipe tile grid with filter toolbar.
 * Images served by the cookbook integration's HTTP endpoint.
 */

import {
  sortRecipes,
  computeNewRecipeIds,
  resolveDefaultSort,
  SORT_OPTIONS,
  DEFAULT_SORT,
} from '../services/recipe-logic.js';
import { createI18n } from '../i18n/i18n.js';

const PALETTE_SIZE = 10;

export function categoryColorIndex(category) {
  if (!category) return 0;
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash * 31 + category.charCodeAt(i)) & 0xffff;
  }
  return hash % PALETTE_SIZE;
}

function parseDuration(iso) {
  if (!iso) return '';
  const h = (iso.match(/(\d+)H/) || [])[1] | 0;
  const m = (iso.match(/(\d+)M/) || [])[1] | 0;
  if (h && m) return `${h}h ${m}min`;
  if (h) return `${h}h`;
  if (m) return `${m}min`;
  return '';
}

export class GridView {
  constructor(container, api, onTileClick, placeholderUrl = '', newBannerDays = 30, defaultSort = DEFAULT_SORT, actions = {}) {
    this._container  = container;
    this._api        = api;
    this._onTileClick = onTileClick;
    this._placeholder = placeholderUrl;
    this._newBannerDays = newBannerDays;
    this._defaultSort = resolveDefaultSort(defaultSort);
    this._onAdd = actions.onAdd || (() => {});
    this._i18n = actions.i18n || createI18n();

    this._recipes  = [];
    this._categories = [];
    this._filtered = [];
    // Ids of the newest recipes that should show the "new" banner (global).
    this._newIds   = new Set();

    this._searchValue   = '';
    this._categoryValue = '';
    this._tagValue      = '';
    this._sortValue     = this._defaultSort;

    this._toolbar  = null;
    this._grid     = null;
    this._countEl  = null;
    this._statusEl  = null;
    this._spinner = null;
    this._errorEl = null;
    this._updateCount();

    this._render();
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  /**
   * Show the current (possibly stale) list instantly: cache when warm, else the
   * local same-origin file. Never triggers a sync — that is revalidate()'s job.
   * Shows skeletons while there is nothing to display yet.
   */
  async loadFromCache() {
    this._showSpinner(false);
    try {
      const [recipes, categories] = await Promise.all([
        this._api.getRecipes(),
        this._api.getCategories(),
      ]);
      this._recipes    = recipes;
      this._categories = categories;
      if (recipes.length) {
        this._recomputeNewIds();
        this._buildFilterOptions();
        this._applyFilter();
        return true;
      }
      // Nothing yet — show skeletons until revalidate() delivers fresh data.
      this._showSkeletons(8);
      return false;
    } catch (err) {
      this._showError(err instanceof Error ? err.message : '');
      return false;
    }
  }

  /**
   * Revalidate list + categories fresh from the API (stale-while-revalidate).
   * Keeps current tiles visible while fetching; on fresh data, re-renders so
   * new recipes appear automatically. No blank-screen flash.
   */
  async revalidate() {
    try {
      const { recipes, categories } = await this._api.refreshData();
      this._clearError();
      // Only re-render if we actually got data (don't wipe stale tiles on a
      // transient API/sync failure that returned empty).
      if (recipes.length || categories.length) {
        if (recipes.length)    this._recipes    = recipes;
        if (categories.length) this._categories = categories;
        this._recomputeNewIds();
        this._buildFilterOptions();
        this._applyFilter();
      }
    } catch (err) {
      this._showError(err instanceof Error ? err.message : '', true);
      console.warn('[cookbook-card] revalidate failed:', err);
    }
  }

  /**
   * Show/hide the sync indicator (small spinner in status bar).
   * Does NOT clear the tile grid.
   */
  showSyncIndicator(visible) {
    this._syncBanner?.classList.toggle('metro-sync-banner--hidden', !visible);
    this._showSpinner(visible);
  }

  setI18n(i18n) {
    this._i18n = i18n;
    this._render();
    this._buildFilterOptions();
    this._toolbar.querySelector('.metro-search').value = this._searchValue;
    const selects = this._toolbar.querySelectorAll('.metro-select');
    selects[0].value = this._categoryValue;
    selects[1].value = this._tagValue;
    this._toolbar.querySelector('.metro-select--sort').value = this._sortValue;
    this._renderTiles();
    this._updateCount();
  }

  async refresh() {
    // Manual refresh button: drop cache, revalidate from API, and pull images.
    this._api._cache?.delete('recipes');
    this._api._cache?.delete('categories');
    this.showSyncIndicator(true);
    try {
      await this.revalidate();
      await this._api.triggerImageSync?.();
    } catch (err) {
      this._showError(err instanceof Error ? err.message : '', true, 'grid.image_sync_error');
    } finally {
      this.showSyncIndicator(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — build DOM
  // ---------------------------------------------------------------------------

  _render() {
    this._container.innerHTML = '';

    // Toolbar
    this._toolbar = document.createElement('div');
    this._toolbar.className = 'metro-toolbar';
    const t = this._i18n.t;
    this._toolbar.innerHTML = `
      <span class="metro-toolbar__title">${t('grid.title')}</span>
      <input class="metro-search" type="search" placeholder="${t('grid.search_placeholder')}" aria-label="${t('grid.search_label')}">
      <select class="metro-select" aria-label="${t('grid.category_label')}">
        <option value="">${t('grid.all_categories')}</option>
      </select>
      <select class="metro-select" aria-label="${t('grid.tag_label')}">
        <option value="">${t('grid.all_tags')}</option>
      </select>
      <select class="metro-select metro-select--sort" aria-label="${t('grid.sort_label')}">
        ${SORT_OPTIONS.map(o =>
          `<option value="${o.value}"${o.value === this._defaultSort ? ' selected' : ''}>${t(`grid.sort_${o.value.replace('-', '_')}`)}</option>`
        ).join('')}
      </select>
       <button class="metro-btn metro-btn--accent metro-btn--add" type="button">+ ${t('grid.add_recipe')}</button>
       <button class="metro-btn metro-btn--accent metro-btn--refresh" type="button" aria-label="${t('grid.refresh')}">↺</button>
    `;
    this._container.appendChild(this._toolbar);

    this._toolbar.querySelector('.metro-search').addEventListener('input', (e) => {
      this._searchValue = e.target.value.toLowerCase().trim();
      this._applyFilter();
    });
    this._toolbar.querySelectorAll('.metro-select')[0].addEventListener('change', (e) => {
      this._categoryValue = e.target.value;
      this._applyFilter();
    });
    this._toolbar.querySelectorAll('.metro-select')[1].addEventListener('change', (e) => {
      this._tagValue = e.target.value;
      this._applyFilter();
    });
    this._toolbar.querySelector('.metro-select--sort').addEventListener('change', (e) => {
      this._sortValue = e.target.value;
      this._applyFilter();
    });
     this._toolbar.querySelector('.metro-btn--add').addEventListener('click', () => this._onAdd());
     this._toolbar.querySelector('.metro-btn--refresh').addEventListener('click', () => this.refresh());

    // Sync banner (shown while background sync runs)
    this._syncBanner = document.createElement('div');
    this._syncBanner.className = 'metro-sync-banner metro-sync-banner--hidden';
    this._syncBanner.innerHTML = `
      <div class="metro-sync-banner__spinner"></div>
      <span>${t('grid.syncing')}</span>
    `;
    this._container.appendChild(this._syncBanner);

    // Status bar
    const bar = document.createElement('div');
    bar.className = 'metro-statusbar';
    this._countEl  = document.createElement('span');
    this._countEl.className = 'metro-statusbar__count';
    bar.appendChild(this._countEl);
    this._spinner = document.createElement('span');
    this._spinner.className = 'metro-spinner metro-spinner--hidden';
    this._spinner.setAttribute('aria-label', t('grid.loading'));
    bar.appendChild(this._spinner);
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'metro-statusbar__message';
    this._statusEl.hidden = true;
    bar.appendChild(this._statusEl);
    this._container.appendChild(bar);

    // Grid — columns driven by --metro-columns CSS var set on card root
    this._grid = document.createElement('div');
    this._grid.className = 'metro-grid';
    this._container.appendChild(this._grid);
    // Expose grid element so card can set CSS var directly if needed
    this.gridEl = this._grid;
  }

  // ---------------------------------------------------------------------------
  // Private — filter
  // ---------------------------------------------------------------------------

  _applyFilter() {
    const q   = this._searchValue;
    const cat = this._categoryValue;
    const tag = this._tagValue;

    const filtered = this._recipes.filter((r) => {
      const matchQ   = !q   || String(r.id || '').toLowerCase().includes(q)
                            || (r.name || '').toLowerCase().includes(q)
                            || (r.recipeCategory || '').toLowerCase().includes(q)
                            || (r.keywords || '').toLowerCase().includes(q);
      // '*' is the API's "no category" marker → match recipes without a category.
      const matchCat = !cat
        || (cat === '*' ? !(r.recipeCategory || '') : r.recipeCategory === cat);
      const matchTag = !tag || (r.keywords || '').split(',').map((k) => k.trim()).includes(tag);
      return matchQ && matchCat && matchTag;
    });

    // Sort the filtered view (never mutates this._recipes).
    this._filtered = sortRecipes(filtered, this._sortValue);

    this._renderTiles();
    this._updateCount();
  }

  /**
   * Recompute the global set of "new" recipe ids from the full list.
   * Independent of any active filter — the banner is stable across filters.
   */
  _recomputeNewIds() {
    this._newIds = computeNewRecipeIds(this._recipes, {
      days: this._newBannerDays,
    });
  }

  // ---------------------------------------------------------------------------
  // Private — tiles
  // ---------------------------------------------------------------------------

  _renderTiles() {
    this._grid.innerHTML = '';

    if (this._filtered.length === 0) {
      const el = document.createElement('div');
      el.className = 'metro-empty';
      el.textContent = this._i18n.t('grid.no_recipes');
      this._grid.appendChild(el);
      return;
    }

    this._filtered.forEach((stub) => {
      this._grid.appendChild(this._buildTile(stub));
    });
  }

  _buildTile(stub) {
    const tile = document.createElement('div');
    tile.className = `metro-tile metro-tile--color-${categoryColorIndex(stub.recipeCategory)}`;
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', stub.name);

    // Background image — fills tile, cropped via object-fit:cover in CSS.
    // Served by the cookbook integration (see CookbookApi.imageUrl).
    const img = document.createElement('img');
    img.className = 'metro-tile__img';
    img.alt       = stub.name;
    img.onload    = () => {
      img.classList.add('metro-tile__img--loaded');
      placeholder.classList.add('metro-tile__placeholder--hidden');
    };
    img.onerror   = () => {
      if (this._placeholder && img.src !== this._placeholder) {
        img.src = this._placeholder;
      }
    };
    // Set src after attaching handlers
    img.src = this._api.imageUrl(stub.id, stub.image_mtime || stub.dateModified || '');
    tile.appendChild(img);

    const placeholder = document.createElement('div');
    placeholder.className = 'metro-tile__placeholder';
    placeholder.textContent = '🍽️';
    tile.appendChild(placeholder);

    const overlay = document.createElement('div');
    overlay.className = 'metro-tile__overlay';

    const nameEl = document.createElement('span');
    nameEl.className   = 'metro-tile__name';
    nameEl.textContent = stub.name;

    const catEl = document.createElement('span');
    catEl.className   = 'metro-tile__category';
    catEl.textContent = stub.recipeCategory || '';

    overlay.appendChild(nameEl);
    overlay.appendChild(catEl);
    tile.appendChild(overlay);

    // "New" banner for the newest recipes (global, within the configured window)
    if (this._newIds.has(String(stub.id))) {
      const badge = document.createElement('span');
      badge.className = 'metro-tile__new-badge';
      badge.textContent = this._i18n.t('grid.new_badge');
      tile.appendChild(badge);
    }

    const activate = () => this._onTileClick(stub.id);
    tile.addEventListener('click', activate);
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });

    return tile;
  }

  // ---------------------------------------------------------------------------
  // Private — filters population
  // ---------------------------------------------------------------------------

  _buildFilterOptions() {
    const catSel = this._toolbar.querySelectorAll('.metro-select')[0];
    catSel.innerHTML = `<option value="">${this._i18n.t('grid.all_categories')}</option>`;
    this._categories.forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      // '*' is the API marker for "recipes without a category".
      o.textContent = name === '*' ? this._i18n.t('grid.no_category') : name;
      catSel.appendChild(o);
    });

    const tagSet = new Set();
    this._recipes.forEach((r) => {
      (r.keywords || '').split(',').forEach((k) => { const t = k.trim(); if (t) tagSet.add(t); });
    });
    const tagSel = this._toolbar.querySelectorAll('.metro-select')[1];
    tagSel.innerHTML = `<option value="">${this._i18n.t('grid.all_tags')}</option>`;
    [...tagSet].sort().forEach((tag) => {
      const o = document.createElement('option');
      o.value = tag; o.textContent = tag;
      tagSel.appendChild(o);
    });
  }

  // ---------------------------------------------------------------------------
  // Private — states
  // ---------------------------------------------------------------------------

  _showSkeletons(n) {
    this._grid.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const sk = document.createElement('div');
      sk.className = 'metro-tile metro-tile--skeleton';
      this._grid.appendChild(sk);
    }
  }

  _showSpinner(v) { this._spinner?.classList.toggle('metro-spinner--hidden', !v); }

  _updateCount() {
    if (this._countEl) {
      this._countEl.textContent = this._i18n.t('grid.recipe_count', {
        count: this._filtered.length,
        total: this._recipes.length,
      });
    }
  }

  _showError(msg, preserveTiles = false, translationKey) {
    this._clearError();
    if (!preserveTiles && this._filtered.length === 0) this._grid.innerHTML = '';

    const error = document.createElement('div');
    error.className = 'metro-error';
    error.setAttribute('role', 'alert');
    const key = translationKey || (preserveTiles ? 'grid.refresh_error' : 'grid.load_error');
    error.textContent = this._i18n.t(key, { message: msg });
    this._statusEl?.appendChild(error);
    if (this._statusEl) this._statusEl.hidden = false;
    this._errorEl = error;
  }

  _clearError() {
    this._errorEl?.remove?.();
    this._errorEl = null;
    if (this._statusEl && this._statusEl.children.length === 0) this._statusEl.hidden = true;
  }
}
