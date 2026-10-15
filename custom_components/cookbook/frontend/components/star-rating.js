import { createI18n } from '../i18n/i18n.js';

/**
 * StarRating — interactive 5-star rating widget.
 *
 * Usage:
 *   const rating = new StarRating(containerEl, initialValue, onChangeFn);
 *   rating.setValue(3);
 *   rating.setReadonly(true);
 *   rating.destroy();
 *
 * CSS classes used (from metro.css):
 *   .metro-rating           — flex container
 *   .metro-rating__star     — individual star button
 *   .metro-rating__star--active — filled star
 *   .metro-rating__label    — text label
 */
export class StarRating {
  /**
   * @param {HTMLElement} container   — element to render into
   * @param {number}      value       — initial rating (0-5)
   * @param {(n: number) => void} onChange — callback on user change
   */
  constructor(container, value = 0, onChange = () => {}, i18n = createI18n()) {
    this._container = container;
    this._value = value;
    this._onChange = onChange;
    this._i18n = i18n;
    this._readonly = false;
    this._stars = [];
    this._render();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** @param {number} value 0-5 */
  setValue(value) {
    this._value = Math.max(0, Math.min(5, value));
    this._updateStars(this._value);
  }

  getValue() {
    return this._value;
  }

  /** @param {boolean} readonly */
  setReadonly(readonly) {
    this._readonly = readonly;
    this._stars.forEach((btn) => {
      btn.disabled = readonly;
      btn.style.cursor = readonly ? 'default' : 'pointer';
    });
  }

  setI18n(i18n) {
    this._i18n = i18n;
    this._stars.forEach((button, index) => {
      button.setAttribute('aria-label', i18n.t('popup.star_rating', { count: index + 1 }));
    });
    if (this._label) this._label.textContent = i18n.t('popup.rating');
  }

  destroy() {
    this._container.innerHTML = '';
    this._stars = [];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  _render() {
    this._container.innerHTML = '';
    this._container.className = 'metro-rating';

    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'metro-rating__star';
      btn.textContent = '★';
      btn.dataset.value = String(i);
      btn.setAttribute('aria-label', this._i18n.t('popup.star_rating', { count: i }));

      btn.addEventListener('mouseover', () => {
        if (!this._readonly) this._updateStars(i);
      });

      btn.addEventListener('mouseleave', () => {
        if (!this._readonly) this._updateStars(this._value);
      });

      btn.addEventListener('click', () => {
        if (this._readonly) return;
        // Clicking the active star again resets to 0
        const newValue = i === this._value ? 0 : i;
        this._value = newValue;
        this._updateStars(newValue);
        this._onChange(newValue);
      });

      this._stars.push(btn);
      this._container.appendChild(btn);
    }

    const label = document.createElement('span');
    label.className = 'metro-rating__label';
    label.textContent = this._i18n.t('popup.rating');
    this._label = label;
    this._container.appendChild(label);

    this._updateStars(this._value);
  }

  /** @param {number} upTo — highlight stars 1..upTo */
  _updateStars(upTo) {
    this._stars.forEach((btn, idx) => {
      if (idx < upTo) {
        btn.classList.add('metro-rating__star--active');
      } else {
        btn.classList.remove('metro-rating__star--active');
      }
    });
  }
}
