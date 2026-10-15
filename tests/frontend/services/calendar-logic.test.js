/**
 * Tests for calendar-logic.js — pure week/date + entry-grouping helpers for the
 * weekly recipe calendar (feature-10).
 *
 * All functions are timezone-explicit: the caller passes the HA-local "today"
 * as a YYYY-MM-DD string, never a Date, so browser timezone never leaks in.
 *
 * Run with: node --test www/cookbook-card/services/calendar-logic.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getWeekStart,
  getWeekDays,
  formatWeekRange,
  groupEntriesByDaySlot,
  classifyDay,
  isValidPlanDate,
  addDays,
} from '../../../custom_components/cookbook/frontend/services/calendar-logic.js';

// ---------------------------------------------------------------------------
// getWeekStart
// ---------------------------------------------------------------------------

test('getWeekStart returns Monday for a mid-week date (monday start)', () => {
  // 2026-09-02 is a Wednesday -> Monday is 2026-08-31
  assert.equal(getWeekStart('2026-09-02', 'monday'), '2026-08-31');
});

test('getWeekStart returns the same day when already Monday', () => {
  assert.equal(getWeekStart('2026-08-31', 'monday'), '2026-08-31');
});

test('getWeekStart returns Sunday for a mid-week date (sunday start)', () => {
  // 2026-09-02 Wednesday -> preceding Sunday is 2026-08-30
  assert.equal(getWeekStart('2026-09-02', 'sunday'), '2026-08-30');
});

test('getWeekStart handles a Sunday with monday start (goes back 6 days)', () => {
  // 2026-09-06 is a Sunday -> Monday of that week is 2026-08-31
  assert.equal(getWeekStart('2026-09-06', 'monday'), '2026-08-31');
});

test('getWeekStart crosses a month/year boundary correctly', () => {
  // 2027-01-01 is a Friday -> Monday is 2026-12-28
  assert.equal(getWeekStart('2027-01-01', 'monday'), '2026-12-28');
});

// ---------------------------------------------------------------------------
// getWeekDays / addDays
// ---------------------------------------------------------------------------

test('getWeekDays returns 7 consecutive ISO dates', () => {
  const days = getWeekDays('2026-08-31');
  assert.deepEqual(days, [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
    '2026-09-04', '2026-09-05', '2026-09-06',
  ]);
});

test('addDays adds and subtracts across boundaries', () => {
  assert.equal(addDays('2026-08-31', 7), '2026-09-07');
  assert.equal(addDays('2026-09-07', -7), '2026-08-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// ---------------------------------------------------------------------------
// classifyDay
// ---------------------------------------------------------------------------

test('classifyDay marks past, today and future relative to HA today', () => {
  assert.equal(classifyDay('2026-09-01', '2026-09-02'), 'past');
  assert.equal(classifyDay('2026-09-02', '2026-09-02'), 'today');
  assert.equal(classifyDay('2026-09-03', '2026-09-02'), 'future');
});

// ---------------------------------------------------------------------------
// isValidPlanDate
// ---------------------------------------------------------------------------

test('isValidPlanDate accepts valid ISO dates', () => {
  assert.equal(isValidPlanDate('2026-09-07'), true);
  assert.equal(isValidPlanDate('2024-02-29'), true); // 2024 is a leap year
});

test('isValidPlanDate rejects impossible calendar dates', () => {
  assert.equal(isValidPlanDate('2026-13-01'), false);
  assert.equal(isValidPlanDate('2026-00-10'), false);
  assert.equal(isValidPlanDate('2026-09-31'), false);
  assert.equal(isValidPlanDate('2026-2-29'), false);
  assert.equal(isValidPlanDate(''), false);
  assert.equal(isValidPlanDate('garbage'), false);
});

// ---------------------------------------------------------------------------
// groupEntriesByDaySlot
// ---------------------------------------------------------------------------

test('groupEntriesByDaySlot indexes entries by date then slot, preserving add order', () => {
  const entries = [
    { id: 'a', date: '2026-08-31', slot_id: 'meal', recipe_id: '1' },
    { id: 'b', date: '2026-08-31', slot_id: 'meal', recipe_id: '2' },
    { id: 'c', date: '2026-09-01', slot_id: 'dinner', recipe_id: '3' },
  ];
  const grouped = groupEntriesByDaySlot(entries);
  assert.deepEqual(grouped['2026-08-31'].meal.map(e => e.id), ['a', 'b']);
  assert.deepEqual(grouped['2026-09-01'].dinner.map(e => e.id), ['c']);
  assert.equal(grouped['2026-09-01'].meal, undefined);
});

test('groupEntriesByDaySlot ignores entries outside a given week when a filter is passed', () => {
  const entries = [
    { id: 'a', date: '2026-08-31', slot_id: 'meal', recipe_id: '1' },
    { id: 'z', date: '2026-10-01', slot_id: 'meal', recipe_id: '9' },
  ];
  const grouped = groupEntriesByDaySlot(entries, getWeekDays('2026-08-31'));
  assert.ok(grouped['2026-08-31']);
  assert.equal(grouped['2026-10-01'], undefined);
});

// ---------------------------------------------------------------------------
// formatWeekRange
// ---------------------------------------------------------------------------

test('formatWeekRange produces a localized range string via injected formatter', () => {
  const fmt = (iso) => iso.slice(8) + '.'; // fake day-of-month formatter
  const out = formatWeekRange('2026-08-31', { formatDay: fmt });
  assert.match(out, /31\./);
  assert.match(out, /06\./);
});
