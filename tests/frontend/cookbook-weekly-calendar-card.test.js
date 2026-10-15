/**
 * Registration + wiring contract for the weekly recipe calendar card
 * (feature-10). Mirrors the source-inspection style of cookbook-card.test.js
 * so it stays robust without a full DOM/custom-element runtime.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '../../custom_components/cookbook/frontend/cookbook-card.js'),
  'utf8',
);

test('registers cookbook-weekly-calendar idempotently', () => {
  assert.match(
    source,
    /if \(!customElements\.get\('cookbook-weekly-calendar'\)\) \{\s*customElements\.define\('cookbook-weekly-calendar', CookbookWeeklyCalendarCard\);\s*\}/,
  );
});

test('registers the weekly-calendar editor element', () => {
  assert.match(
    source,
    /customElements\.define\('cookbook-weekly-calendar-editor', CookbookWeeklyCalendarEditor\)/,
  );
});

test('lists the card in window.customCards', () => {
  assert.match(source, /window\.customCards\.find\(c => c\.type === 'cookbook-weekly-calendar'\)/);
  assert.match(source, /type:\s*'cookbook-weekly-calendar'/);
});

test('exposes a visual config editor via getConfigElement', () => {
  assert.match(
    source,
    /static getConfigElement\(\) \{\s*return document\.createElement\('cookbook-weekly-calendar-editor'\);\s*\}/,
  );
});

test('stub config carries the agreed defaults', () => {
  assert.match(source, /week_start:\s*'monday'/);
  assert.match(source, /show_images:\s*true/);
  assert.match(source, /layout:\s*'normal'/);
  assert.match(source, /desktop_layout:\s*'vertical'/);
  assert.match(source, /collapse_past_days:\s*false/);
  assert.match(source, /initial_week:\s*'current'/);
  assert.match(source, /refresh_ms:\s*3600000/);
});

test('mounts a WeeklyCalendarView and opens recipes through the shared popup', () => {
  assert.match(source, /new WeeklyCalendarView\(/);
  assert.match(source, /this\._popup\?\.open\(id\)/);
});

test('resolves HA-local today from the hass timezone', () => {
  assert.match(source, /function resolveHaToday\(hass\)/);
  assert.match(source, /hass\?\.config\?\.time_zone/);
});

test('injects scoped calendar CSS into the shared Metro stylesheet', () => {
  assert.match(source, /\.cal-day \{/);
  assert.match(source, /\.cal-entry__edit \{/);
  assert.match(source, /\.cal-body--grid/);
});

test('refresh interval choices include off and one-hour default', () => {
  assert.match(source, /CALENDAR_REFRESH_CHOICES/);
  assert.match(source, /\['0', 'off'\]/);
  assert.match(source, /\['3600000', '1h'\]/);
});
