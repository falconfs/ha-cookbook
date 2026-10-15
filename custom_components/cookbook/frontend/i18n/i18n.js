import { LOCALES } from './locales/index.js';

const DEFAULT_LOCALE = 'en';

function languageCode(value) {
  return String(value || '').trim().replaceAll('_', '-').split('-')[0].toLowerCase();
}

/** Resolve the card override, then HA's user locale, then English. */
export function resolveLocale(hass, override = 'auto', supportedLocales = Object.keys(LOCALES)) {
  const requestedOverride = languageCode(override);
  if (override && override !== 'auto' && supportedLocales.includes(requestedOverride)) {
    return requestedOverride;
  }

  const requested = hass?.locale?.language || hass?.language;
  const normalized = languageCode(requested);
  return supportedLocales.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

function getNestedValue(messages, key) {
  return String(key).split('.').reduce((value, part) => value?.[part], messages);
}

function selectPlural(template, count, locale) {
  const choices = template.split('|').map(choice => choice.trim());
  if (choices.length === 1 || !Number.isFinite(Number(count))) return choices[0];

  const category = new Intl.PluralRules(locale).select(Number(count));
  if (choices.length === 2) return choices[category === 'one' ? 0 : 1];
  if (choices.length === 3) {
    if (Number(count) === 0) return choices[0];
    return choices[category === 'one' ? 1 : 2];
  }

  const categories = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const index = categories.indexOf(category);
  return choices[index >= 0 && index < choices.length - 1 ? index : choices.length - 1];
}

/** Create a small, synchronous translator with Vue-I18n-style dotted keys. */
export function createI18n({ locale = DEFAULT_LOCALE, fallbackLocale = DEFAULT_LOCALE, messages = LOCALES } = {}) {
  const requestedLocale = languageCode(locale);
  const resolvedLocale = Object.hasOwn(messages, requestedLocale) ? requestedLocale : fallbackLocale;
  const fallbackMessages = messages[fallbackLocale] || messages[DEFAULT_LOCALE] || {};
  const localeMessages = messages[resolvedLocale] || {};
  const warnedKeys = new Set();

  function t(key, params = {}) {
    const localized = getNestedValue(localeMessages, key);
    const fallback = getNestedValue(fallbackMessages, key);
    const template = typeof localized === 'string'
      ? localized
      : typeof fallback === 'string'
        ? fallback
        : null;

    if (template === null) {
      const missingKey = String(key);
      if (!warnedKeys.has(missingKey)) {
        warnedKeys.add(missingKey);
        console.warn(`[ha-cookbook] Missing translation: ${missingKey}`);
      }
      return missingKey;
    }

    const pluralized = Object.hasOwn(params, 'count')
      ? selectPlural(template, params.count, resolvedLocale)
      : template;
    return pluralized.replace(/\{([\w]+)\}/g, (match, name) => (
      params[name] === undefined || params[name] === null ? match : String(params[name])
    ));
  }

  function formatDate(value, options = { dateStyle: 'medium' }) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(resolvedLocale, options).format(date);
  }

  return Object.freeze({ locale: resolvedLocale, t, formatDate });
}
