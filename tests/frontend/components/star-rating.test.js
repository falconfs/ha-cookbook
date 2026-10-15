import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StarRating } from '../../../custom_components/cookbook/frontend/components/star-rating.js';
import { createI18n } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
  }

  set innerHTML(value) { this.children = []; this._innerHTML = value; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener() {}
}

test('star rating labels follow the selected locale and preserve the rating', () => {
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
  try {
    const root = new FakeElement('div');
    const rating = new StarRating(root, 3, () => {}, createI18n({ locale: 'de' }));

    assert.equal(rating._stars[0].getAttribute('aria-label'), '1 Stern');
    assert.equal(rating._label.textContent, 'Bewertung');
    rating.setI18n(createI18n({ locale: 'en' }));
    assert.equal(rating.getValue(), 3);
    assert.equal(rating._stars[0].getAttribute('aria-label'), '1 star');
    assert.equal(rating._label.textContent, 'Rating');
  } finally {
    delete globalThis.document;
  }
});
