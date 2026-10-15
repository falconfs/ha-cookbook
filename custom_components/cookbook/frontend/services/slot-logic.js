/**
 * slot-logic.js — pure slot-model helpers for the weekly recipe calendar.
 *
 * Built-in slots have stable ids and labels from the shared i18n catalog.
 * Custom slots carry a user-provided
 * name shown verbatim. The special `unassigned` system slot only appears while
 * it holds entries.
 *
 * No DOM or side effects.
 */

import { createI18n } from '../i18n/i18n.js';

/** Built-in slot ids in default order (mirrors meal_plan_store.BUILTIN_SLOT_IDS). */
export const BUILTIN_SLOT_IDS = ['meal', 'breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'side'];

/** Temporary system slot for entries orphaned by a deleted custom slot. */
export const UNASSIGNED_SLOT_ID = 'unassigned';

/**
 * Display label for a slot. Custom slots return their name; built-in and system
 * slots use the shared translator. A locale string remains supported for tests
 * and older internal callers.
 * @param {{id:string, kind:string, name?:string}} slot
 * @param {string|{t: (key: string) => string}} translator
 * @returns {string}
 */
export function slotLabel(slot, translator = 'en') {
  if (slot.kind === 'custom') return slot.name ?? slot.id;
  if (!BUILTIN_SLOT_IDS.includes(slot.id) && slot.id !== UNASSIGNED_SLOT_ID) return slot.id;
  const i18n = typeof translator === 'string' ? createI18n({ locale: translator }) : translator;
  return i18n.t(`slots.${slot.id}`);
}

/**
 * Enabled slots in configured order.
 * @param {Array<{enabled?: boolean}>} slots
 * @returns {Array<object>}
 */
export function activeSlots(slots) {
  return slots.filter(slot => slot.enabled);
}

/**
 * Slots to render for one day: the active slots, plus the `unassigned` system
 * slot appended when that day actually has unassigned entries.
 * @param {Array<{id:string}>} slots  full slot config
 * @param {Record<string, Array<object>>} daySlotEntries  slot_id -> entries for the day
 * @returns {Array<object>}
 */
export function displaySlotsForDay(slots, daySlotEntries = {}) {
  const result = activeSlots(slots);
  const unassigned = daySlotEntries[UNASSIGNED_SLOT_ID];
  if (Array.isArray(unassigned) && unassigned.length > 0) {
    return [...result, { id: UNASSIGNED_SLOT_ID, kind: 'system', enabled: true }];
  }
  return result;
}

/**
 * Slots to render for one day: only those that actually have entries, in global
 * slot order. A slot with entries is shown even if it is currently disabled (so
 * existing plans never silently disappear). The `unassigned` system slot is
 * appended when it holds entries. Empty slots are omitted entirely.
 * @param {Array<{id:string}>} slots  full slot config (global order)
 * @param {Record<string, Array<object>>} daySlotEntries  slot_id -> entries
 * @returns {Array<object>}
 */
export function nonEmptySlotsForDay(slots, daySlotEntries = {}) {
  const hasEntries = id => Array.isArray(daySlotEntries[id]) && daySlotEntries[id].length > 0;
  const result = slots.filter(slot => hasEntries(slot.id));
  const known = new Set(slots.map(slot => slot.id));
  if (hasEntries(UNASSIGNED_SLOT_ID) && !known.has(UNASSIGNED_SLOT_ID)) {
    result.push({ id: UNASSIGNED_SLOT_ID, kind: 'system', enabled: true });
  }
  return result;
}

/** Derive a stable, url-safe id from a display name. */
export function slugifySlotName(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'slot';
}

/**
 * Validate a proposed custom slot name against every existing slot label,
 * case-insensitively, in the active locale (so a custom "Frühstück" collides
 * with the built-in breakfast label).
 * @param {string} name
 * @param {Array<object>} slots
 * @param {string} locale
 * @returns {{ok: boolean, reason?: 'empty'|'duplicate'}}
 */
export function validateNewSlotName(name, slots, locale) {
  const clean = String(name).trim();
  if (!clean) return { ok: false, reason: 'empty' };
  const lowered = clean.toLowerCase();
  const taken = new Set(slots.map(slot => slotLabel(slot, locale).toLowerCase()));
  if (taken.has(lowered)) return { ok: false, reason: 'duplicate' };
  return { ok: true };
}

/**
 * Classify a plan entry for the image-grid layout: a resolvable recipe with
 * images enabled renders as an image tile; free-text entries and entries whose
 * recipe is unavailable render as a plain text card.
 * @param {{recipe_id?: string, text?: string}} entry
 * @param {Map<string, object>} recipesById
 * @param {{showImages?: boolean}} [options]
 * @returns {'image'|'text'}
 */
export function entryTileKind(entry, recipesById, { showImages = true } = {}) {
  if (!showImages) return 'text';
  const recipeId = String(entry?.recipe_id ?? '');
  if (!recipeId) return 'text';
  return recipesById.has(recipeId) ? 'image' : 'text';
}

/**
 * Return a new slot array with `slotId` moved by `direction` (-1 up, +1 down),
 * clamped at the ends. Does not mutate the input.
 * @param {Array<{id:string}>} slots
 * @param {string} slotId
 * @param {number} direction
 * @returns {Array<object>}
 */
export function reorderSlots(slots, slotId, direction) {
  const list = [...slots];
  const index = list.findIndex(slot => slot.id === slotId);
  if (index < 0) return list;
  const target = index + direction;
  if (target < 0 || target >= list.length) return list;
  [list[index], list[target]] = [list[target], list[index]];
  return list;
}
