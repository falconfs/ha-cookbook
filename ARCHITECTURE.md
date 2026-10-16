# Cookbook for Home Assistant — Architecture

This document describes version 6.0.0, the major release after 5.9.0.

## Runtime

The integration registers a versioned static path for its bundled frontend and
adds the main module to Home Assistant's frontend module URLs. The card runs in
the browser frontend and communicates with the local `cookbook` integration
through the Home Assistant WebSocket API.
The integration owns recipe storage at `/config/cookbook/recipes/`, with one
directory per recipe containing `recipe.json` and, when available, a local
image.

`custom_components/cookbook/frontend/services/api.js` is the card's data
boundary. It calls these services with `hass.callWS` and consumes their
service responses:

- `cookbook.list_recipes`
- `cookbook.get_recipe`
- `cookbook.upsert_recipe`
- `cookbook.delete_recipe`
- `cookbook.fetch_image_from_url`
- `cookbook.fetch_image_to_tmp`
- `cookbook.import_recipe_from_url` (native URL import, feature-07)
- `cookbook.ai_import_recipe_from_url` (AI fallback import, feature-07)
- `cookbook.ai_regroup_recipe` (AI ingredient-to-step regrouping, feature-07)
- `cookbook.get_meal_plan` (weekly meal plan document, feature-10)
- `cookbook.add_meal_plan_entry` (add one plan entry, feature-10)
- `cookbook.update_meal_plan_entry` (change date/slot/recipe, feature-10)
- `cookbook.delete_meal_plan_entry` (remove one plan entry, feature-10)
- `cookbook.save_meal_plan_slots` (replace global slot config, feature-10)

Images are served by the integration at
`/api/cookbook/recipes/<id>/image`. The card uses this same-origin endpoint for
tiles and recipe details. Multipart image uploads use the same route with
`POST`.

## Integration layout

```text
custom_components/cookbook/
├── __init__.py
├── config_flow.py
├── http_views.py
├── images.py
├── manifest.json
├── services.py
├── services.yaml
├── storage.py
├── meal_plan_store.py  # weekly meal plan + global slot config (feature-10)
├── url_import.py      # native URL import: validation, parsers, normalization
├── ai_import.py       # AI fallback: validation, prompts, orchestration
└── frontend/          # Lovelace ES modules and their local assets
```

`meal_plan_store.py` owns a single versioned JSON document at
`/config/cookbook/meal_plan.json` with the household meal plan (independent
UUID-keyed entries of `date`/`slot_id`/`recipe_id`) and the global slot
configuration (built-in + custom slots, activation, order). Writes are atomic
(temp file + replace) under an async lock; a recipe may be planned any number of
times and deleting a custom slot remaps its entries to `meal` or `unassigned`.

The integration provides asynchronous file access, atomic recipe replacement,
per-recipe locking, image validation, CRUD service handlers and HTTP views.
It has no additional Python dependency beyond Home Assistant's bundled APIs.

`url_import.py` and `ai_import.py` are pure, Home-Assistant-independent modules:
all I/O (HTTP session, DNS resolver, storage, AI call) is injected, so their
logic is fully unit-testable without a running Home Assistant. `services.py`
is a thin wrapper that supplies the real dependencies and calls
`ai_task.generate_data` for the AI paths.

## Card modules

```text
custom_components/cookbook/frontend/cookbook-card.js
                            # + custom:cookbook-card-editor (Lovelace config UI)
                            # + custom:cookbook-weekly-calendar (+ its editor)
├── services/api.js
├── services/cache.js
├── services/recipe-logic.js
├── services/recipe-view.js
├── services/recipe-scaling.js
├── services/recipe-form.js  # pure form<->v6 state (incl. moveIngredientBetweenSteps)
├── services/calendar-logic.js  # pure week/date + entry grouping (feature-10)
├── services/slot-logic.js      # pure slot model + localized labels (feature-10)
├── i18n/i18n.js                # shared locale resolution, messages and formatting
├── i18n/locales/de.js          # German UI catalogue
├── i18n/locales/en.js          # English UI catalogue and parity reference
├── components/grid-view.js
├── components/recipe-popup.js
├── components/recipe-editor.js
├── components/weekly-calendar-view.js  # week view/controller (feature-10)
└── components/star-rating.js
```

All browser-facing labels use the shared, dependency-free translator under
`custom_components/cookbook/frontend/i18n/`. Locale modules are registered in
`locales/index.js`; adding a locale requires the corresponding Home Assistant
translation file under `custom_components/cookbook/translations/` as well.
The cards follow the HA user's language by default and accept a per-card
`language: de|en` override.

## Weekly recipe calendar (feature-10)

`custom:cookbook-weekly-calendar` is a separate card that plans recipes across a
week. `WeeklyCalendarView` loads the plan + recipe stubs through `CookbookApi`,
renders a vertical day list (optional desktop grid) with globally-shared meal
slots, and reuses the existing `RecipePopup` for recipe details. Recipes are
added through a focused searchable dialog that saves each pick immediately and
stays open; a per-entry pencil opens a planning editor (date/slot/recipe,
explicit save, confirmed delete). Day boundaries use the HA timezone: the card
resolves an HA-local `today` string and all week math lives in the pure
`calendar-logic.js`. Slot activation, order and custom slots are global and
persist via `cookbook.save_meal_plan_slots`; per-card Lovelace config holds only
title, week start, images, layout, desktop layout, dates, past-day collapsing,
initial week and refresh interval. Missing recipes render as an accessible
"unavailable" entry and never open the popup. Runtime CSS for the calendar lives
in the shared Metro `<style>` template in `cookbook-card.js`.

Plan entries can also be free text instead of a recipe: an entry carries an
optional `text` field. With no `recipe_id` it is a free-text entry (e.g. "Pizza
bestellen") that shows the text and never opens a popup; with a `recipe_id` the
`text` is an optional note shown beside the recipe (e.g. "Pick up groceries").
The add dialog reuses the search field with an "Als Text
hinzufügen" button, shows recipe thumbnails, and the planning editor exposes the
note/text field. The card can be previewed locally with
`PORT=4173 node local-preview-server.mjs` (in-memory meal-plan mocks).

The cache stores JSON-serializable recipe data in session storage. The grid
loads list stubs and filters them locally. The popup reads a full recipe and
supports structured preparation steps, ratings and cooked dates. The editor
serializes add and edit forms directly to the v6 schema via `recipe-form.js`.

CSS is inlined as a `<style>` template string inside `cookbook-card.js` (Shadow
DOM scoped). `styles/metro.css` is an orphaned reference copy and is NOT loaded
at runtime — edit the CSS in `cookbook-card.js`.

The Lovelace config editor (`cookbook-card-editor`) builds its form with real
DOM once and only syncs values afterwards (never rebuilds on `hass`/`setConfig`
pushes) so typing never loses focus. Config keys: `columns`, `dialog_size`,
`default_sort`, `new_banner_days`, `recipe_default_tab`, `ai_task_entity`.

## Service flow

The grid calls `cookbook.list_recipes`. Opening a tile calls
`cookbook.get_recipe`. Add and edit operations call `cookbook.upsert_recipe`,
then refresh the grid. Delete calls `cookbook.delete_recipe`, then refreshes
the grid. The image endpoint is used for display and upload. No polling or
generated runtime data files are part of this flow.

## Validation tooling

`recipe.schema.ts` and `validate-recipes.ts` are development tooling, not card
runtime modules. Run `npm run validate` against `../../cookbook_v6` and run
`npm run typecheck` to check the schema tooling.

## Recipe import

### URL import (feature-07)

`cookbook.import_recipe_from_url` downloads a page server-side (browser-like
headers, DNS-level SSRF re-check), extracts a schema.org recipe (JSON-LD first,
then microdata — Nextcloud Cookbook v0.11.9 parity re-implemented in Python
with the stdlib `html.parser`, including recipes nested in `WebPage.mainEntity`),
and normalizes it into a v6 draft. A candidate must contain a name, at least one
ingredient and at least one instruction. The draft is shown in the editor for
review and is never saved without explicit confirmation.

If a page downloads successfully but neither JSON-LD nor microdata yields a
usable draft, the same downloaded HTML is reduced to visible text and sent to
the configured Home Assistant AI Task. URL validation and download failures do
not invoke AI. The editor identifies AI-generated imports and discloses that
page text may be sent to the configured provider and provider costs may apply.

Key normalization rules (all in `url_import.py`, covered by tests):

- `@graph` may be an array OR an object keyed by numeric strings.
- `recipeIngredient` strings are split into `{name, amount, unit, note}` using a
  cooking-unit whitelist; group headers like "Für den Belag:" (no amount, ends
  with ":") are dropped.
- `recipeCategory` may be an array; without `keywords`, the first entry is the
  category and the rest become tags.
- `author` is preserved verbatim (string/object/array); `tool` is left empty
  when absent.
- `dateCreated`/`dateModified` are set to import time; `dateModified` is
  refreshed on every save (`recipe-form.js`).
- Ingredients are heuristically attached to the first step whose instruction
  text mentions them (whole-word match); unmatched go to step 1.
- The recipe image URL is staged via `fetch_image_to_tmp` and attached on save;
  the raw external URL is cleared from `image` so it never persists.

### AI fallback + regroup (feature-07, R4c + R10–R13)

The automatic URL-import fallback and the explicit `cookbook.ai_import_recipe_from_url`
service reduce page content to visible text and ask `ai_task.generate_data`
(structured output) to extract a v6 recipe. `cookbook.ai_regroup_recipe` asks
the AI to reassign already-extracted ingredients to the correct steps. These
flows:

- run through `ai_import.py` (pure, injected AI call);
- **strictly validate** the AI response against the v6 shape before it is ever
  shown or saved — invalid responses are rejected;
- use the preferred AI Task entity, or the optional `ai_task_entity` card config;
- never store AI provider credentials in the card (Lovelace config is
  client-readable).

The separate "Mit KI importieren" button remains available for a direct AI
import; the normal URL-import button now falls back automatically when native
markup is unusable. "Zutaten per KI zuordnen" runs the regroup flow.

## Random Recipe Card

`custom:cookbook-random-card` shares the existing API, cache, recipe popup,
image endpoint, and Shadow DOM style tokens. Its view calls
`cookbook.list_recipes`, applies category and tag filters with AND semantics,
and renders one existing Metro tile. The popup loads details through
`cookbook.get_recipe`; no random-card-specific backend service or image route
exists.

The random tile shares the grid card's `NEU` badge calculation and category
color palette. The optional `_ha_rating` value is included in recipe stubs and
shown as a numeric `Bewertung: N` value in the tile metadata when present.
The card exposes `cookbook-random-card-editor` through `getConfigElement()`, so
Home Assistant can edit its duration, category, tags, new-banner window,
dialog size, and default tab visually.

The `duration` value is parsed at the card boundary by
`services/random-logic.js`. It accepts compound strings, `HH:MM:SS` strings,
and duration objects with `days`, `hours`, `minutes`, or `seconds`. Invalid or
absent values fall back to `4h`. A category of `*` selects recipes without a
category.

Rotation uses one cancellable, one-shot browser timer. Manual next actions and
popup events cancel and re-arm it, preventing overlap. The timer and current
selection are instance state only, so restarts select a new recipe and persist
nothing.

## Optional Home Assistant automations

External automations can call the integration's registered services, including
the recipe URL import and meal-plan services. This repository does not include
any household-specific automation or messaging configuration.
