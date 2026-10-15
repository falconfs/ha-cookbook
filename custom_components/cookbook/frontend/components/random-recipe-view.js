/**
 * RandomRecipeView — single rotating recipe tile for the random card.
 *
 * Framework-free view/controller seam behind the future
 * `custom:cookbook-random-card` element (the element registration itself
 * lives in cookbook-card.js). Loads the recipe pool through the existing API
 * boundary, renders one random recipe in the GridView tile language, and
 * rotates it on a one-shot schedule that never overlaps.
 *
 * Constructor:
 *   new RandomRecipeView(container, api, onOpenRecipe, placeholderUrl, options)
 *
 *     options.durationMs  rotation duration in ms; the card parses the HA
 *                         duration config via services/random-logic.js
 *                         (falls back to the 4h default when omitted)
 *     options.category    optional category filter for the random pool
 *     options.tags        optional tag filter (string or array) for the pool
 *     options.random      injectable random source, () => [0, 1)
 *     options.schedule    injectable one-shot scheduler:
 *                         schedule(delayMs, callback) => cancel function
 *
 * Lifecycle:
 *   await load()   fetch stubs via api.getRecipes(), filter the pool, render
 *                  one random recipe immediately, arm the rotation
 *   pause()        stop the rotation timer (popup opened)
 *   resume()       re-arm the rotation with the full duration
 *   destroy()      stop the timer, tear down the rendered DOM, ignore late
 *                  callbacks; idempotent
 *
 * CSS classes used (Shadow DOM styles live in cookbook-card.js):
 *   .metro-tile, .metro-tile__img, .metro-tile__placeholder,
 *   .metro-tile__overlay, .metro-tile__name, .metro-tile__category,
 *   .metro-btn, .metro-btn--next, .metro-empty, .metro-error
 */

import {
  DEFAULT_ROTATION_DURATION,
  filterRecipePool,
  parseRotationDuration,
  pickRandomRecipe,
} from '../services/random-logic.js';
import { categoryColorIndex } from './grid-view.js';
import { computeNewRecipeIds } from '../services/recipe-logic.js';
import { createI18n } from '../i18n/i18n.js';

/** Browser default for options.schedule: one-shot setTimeout wrapper. */
function scheduleTimeout(delayMs, callback) {
  const timeoutId = setTimeout(callback, delayMs);
  return () => clearTimeout(timeoutId);
}

export class RandomRecipeView {
  constructor(container, api, onOpenRecipe, placeholderUrl = '', options = {}) {
    this._container = container;
    this._api = api;
    this._onOpenRecipe = onOpenRecipe;
    this._placeholder = placeholderUrl;
    this._category = options.category ?? '';
    this._tags = options.tags ?? '';
    this._newBannerDays = options.newBannerDays ?? 30;
    this._i18n = options.i18n || createI18n();
    this._durationMs = options.durationMs ?? parseRotationDuration(DEFAULT_ROTATION_DURATION);
    this._random = options.random ?? Math.random;
    this._schedule = options.schedule ?? scheduleTimeout;

    this._pool = [];
    this._current = null;
    this._cancelRotation = null;
    this._loadGeneration = 0;
    this._destroyed = false;
    this._loadError = null;
  }

  // ---------------------------------------------------------------------------
  // Public — lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Fetch stubs, filter the pool, render one random recipe immediately and
   * arm the rotation. A newer load() or destroy() invalidates an earlier
   * in-flight call (no stale renders, no stacked timers). Load failures
   * render the error state instead of rejecting.
   */
  async load() {
    if (this._destroyed) return;
    const generation = ++this._loadGeneration;
    this._cancelRotationTimer();
    try {
      const recipes = await this._api.getRecipes();
      if (this._isStaleLoad(generation)) return;
      this._loadError = null;
      this._pool = filterRecipePool(recipes, { category: this._category, tags: this._tags });
      if (this._pool.length === 0) {
        this._renderEmpty();
        return;
      }
      this._newIds = computeNewRecipeIds(this._pool, { days: this._newBannerDays });
      this._renderRecipe(pickRandomRecipe(this._pool, { random: this._random }));
      this._armRotation();
    } catch (err) {
      if (this._isStaleLoad(generation)) return;
      this._renderError(err);
    }
  }

  /** Stop the rotation timer (e.g. while the recipe popup is open). */
  pause() {
    this._cancelRotationTimer();
  }

  /** Re-arm the rotation with the full duration. */
  resume() {
    if (this._destroyed) return;
    this._armRotation();
  }

  setI18n(i18n) {
    this._i18n = i18n;
    if (this._loadError) this._renderError(this._loadError);
    else if (this._current) this._renderRecipe(this._current);
    else if (this._pool.length === 0) this._renderEmpty();
  }

  /** Stop the timer, tear down the rendered DOM; idempotent. */
  destroy() {
    this._destroyed = true;
    this._cancelRotationTimer();
    this._container.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // Private — rotation
  // ---------------------------------------------------------------------------

  /** True when destroy() or a newer load() invalidated this load's result. */
  _isStaleLoad(generation) {
    return this._destroyed || generation !== this._loadGeneration;
  }

  /** Select another recipe (avoiding the previous one) and restart the duration. */
  _rotate() {
    if (this._destroyed || this._pool.length === 0) return;
    this._renderRecipe(pickRandomRecipe(this._pool, {
      previousId: this._current?.id,
      random: this._random,
    }));
    this._armRotation();
  }

  /** Arm exactly one rotation; a pending schedule is cancelled first. */
  _armRotation() {
    this._cancelRotationTimer();
    if (this._pool.length === 0) return;
    const cancel = this._schedule(this._durationMs, () => {
      // Late-fire guard: pause(), destroy(), a re-arm or a reload may have
      // retired this schedule between the host firing it and this callback.
      if (this._destroyed || cancel !== this._cancelRotation) return;
      this._rotate();
    });
    this._cancelRotation = cancel;
  }

  _cancelRotationTimer() {
    this._cancelRotation?.();
    this._cancelRotation = null;
  }

  // ---------------------------------------------------------------------------
  // Private — rendering
  // ---------------------------------------------------------------------------

  _renderRecipe(recipe) {
    this._current = recipe;
    this._container.innerHTML = '';
    this._container.appendChild(this._buildTile(recipe));
    this._container.appendChild(this._buildNextButton());
  }

  _renderEmpty() {
    this._cancelRotationTimer();
    this._current = null;
    this._container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'metro-empty';
    empty.setAttribute('role', 'status');
    empty.textContent = this._i18n.t('random.empty');
    this._container.appendChild(empty);
  }

  _renderError(err) {
    this._cancelRotationTimer();
    // Terminal error state: keep the rotation dead until the next load().
    this._current = null;
    this._pool = [];
    this._container.innerHTML = '';
    this._loadError = err;
    const message = err instanceof Error ? err.message : String(err);
    const error = document.createElement('div');
    error.className = 'metro-error';
    error.setAttribute('role', 'alert');
    error.textContent = this._i18n.t('grid.load_error', { message });
    this._container.appendChild(error);
  }

  _buildTile(recipe) {
    const tile = document.createElement('div');
    tile.className = `metro-tile metro-tile--color-${categoryColorIndex(recipe.recipeCategory)}`;
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', recipe.name);

    const img = document.createElement('img');
    img.className = 'metro-tile__img';
    img.alt = recipe.name;
    img.onload = () => {
      img.classList.add('metro-tile__img--loaded');
      placeholder.classList.add('metro-tile__placeholder--hidden');
    };
    img.onerror = () => {
      if (this._placeholder && img.src !== this._placeholder) {
        img.src = this._placeholder;
      }
    };
    // Set src after attaching handlers so a cached image cannot slip past onload.
    img.src = this._api.imageUrl(recipe.id, recipe.image_mtime || recipe.dateModified || '');
    tile.appendChild(img);

    const placeholder = document.createElement('div');
    placeholder.className = 'metro-tile__placeholder';
    placeholder.textContent = '🍽️';
    tile.appendChild(placeholder);

    const overlay = document.createElement('div');
    overlay.className = 'metro-tile__overlay';
    const meta = document.createElement('div');
    meta.className = 'metro-tile__meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'metro-tile__name';
    nameEl.textContent = recipe.name;
    const catEl = document.createElement('span');
    catEl.className = 'metro-tile__category';
    catEl.textContent = recipe.recipeCategory || '';
    const details = document.createElement('div');
    details.className = 'metro-tile__details';
    details.appendChild(nameEl);
    details.appendChild(catEl);
    meta.appendChild(details);
    if (recipe._ha_rating !== undefined && recipe._ha_rating !== null) {
      const ratingEl = document.createElement('span');
      ratingEl.className = 'metro-tile__rating';
      ratingEl.textContent = this._i18n.t('random.rating', { rating: recipe._ha_rating });
      meta.appendChild(ratingEl);
    }
    overlay.appendChild(meta);
    tile.appendChild(overlay);

    if (this._newIds?.has(String(recipe.id))) {
      const badge = document.createElement('span');
      badge.className = 'metro-tile__new-badge';
      badge.textContent = this._i18n.t('grid.new_badge');
      tile.appendChild(badge);
    }

    const activate = () => this._onOpenRecipe(recipe.id);
    tile.addEventListener('click', activate);
    tile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    return tile;
  }

  _buildNextButton() {
    const button = document.createElement('button');
    button.className = 'metro-btn metro-btn--next';
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', this._i18n.t('random.next_recipe'));
    button.textContent = '↻';
    button.addEventListener('click', (event) => {
      // The button overlays the tile and the click bubbles through the view
      // up to the card. Keep it private so no ancestor handler (delegated
      // tile or card-level click) can also open the recipe popup.
      event.stopPropagation();
      this._rotate();
    });
    return button;
  }
}
