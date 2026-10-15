import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createI18n, resolveLocale } from '../../../custom_components/cookbook/frontend/i18n/i18n.js';
import { LOCALES } from '../../../custom_components/cookbook/frontend/i18n/locales/index.js';

test('resolves the explicit language override before the Home Assistant locale', () => {
  assert.equal(resolveLocale({ locale: { language: 'en-US' } }, 'de-AT'), 'de');
  assert.equal(resolveLocale({ locale: { language: 'en-US' } }, 'auto'), 'en');
});

test('resolves Home Assistant language variants and falls back to English', () => {
  assert.equal(resolveLocale({ locale: { language: 'de-AT' } }), 'de');
  assert.equal(resolveLocale({ language: 'de_DE' }), 'de');
  assert.equal(resolveLocale({ locale: { language: 'fr-FR' } }), 'en');
  assert.equal(resolveLocale(null), 'en');
});

test('translates nested keys and interpolates named parameters', () => {
  const i18n = createI18n({ locale: 'de', messages: LOCALES });

  assert.equal(i18n.t('common.save'), 'Speichern');
  assert.equal(i18n.t('calendar.add_recipe_to', { target: 'Montag' }), 'Rezept hinzufügen zu: Montag');
});

test('selects zero, one, and many plural forms', () => {
  const english = createI18n({ locale: 'en', messages: LOCALES });
  const german = createI18n({ locale: 'de', messages: LOCALES });

  assert.equal(english.t('grid.recipe_count', { count: 0, total: 3 }), '0 of 3 recipes');
  assert.equal(english.t('grid.recipe_count', { count: 1, total: 3 }), '1 of 3 recipes');
  assert.equal(english.t('grid.recipe_count', { count: 3, total: 3 }), '3 of 3 recipes');
  assert.equal(german.t('grid.recipe_count', { count: 0, total: 3 }), '0 von 3 Rezepten');
  assert.equal(german.t('grid.recipe_count', { count: 1, total: 3 }), '1 von 3 Rezepten');
  assert.equal(german.t('grid.recipe_count', { count: 3, total: 3 }), '3 von 3 Rezepten');
});

test('uses English fallback for missing translations and warns once per missing key', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const i18n = createI18n({ locale: 'de', messages: { de: {}, en: {} } });
    assert.equal(i18n.t('missing.key'), 'missing.key');
    assert.equal(i18n.t('missing.key'), 'missing.key');
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('formats dates using the resolved locale', () => {
  const english = createI18n({ locale: 'en', messages: LOCALES });
  const german = createI18n({ locale: 'de', messages: LOCALES });
  const options = { day: 'numeric', month: 'long', timeZone: 'UTC' };

  assert.equal(english.formatDate('2026-04-02', options), 'April 2');
  assert.equal(german.formatDate('2026-04-02', options), '2. April');
});

test('all locales define the same keys and interpolation parameters', () => {
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof entry === 'string' ? [[path, entry]] : flatten(entry, path);
  });
  const english = new Map(flatten(LOCALES.en));

  for (const [locale, messages] of Object.entries(LOCALES)) {
    const entries = new Map(flatten(messages));
    assert.deepEqual([...entries.keys()].sort(), [...english.keys()].sort(), `${locale} key parity`);
    for (const [key, text] of entries) {
      const placeholders = value => [...new Set([...value.matchAll(/\{([\w]+)\}/g)].map(match => match[1]))].sort();
      assert.deepEqual(placeholders(text), placeholders(english.get(key)), `${locale}.${key} placeholders`);
    }
  }
});
