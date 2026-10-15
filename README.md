# Cookbook for Home Assistant

Cookbook is a local recipe manager for Home Assistant. It provides a custom
integration with built-in Lovelace cards for browsing, editing and importing
recipes, plus a weekly meal planner. Recipe data stays on the Home Assistant
host under `/config/cookbook/`.

## Features

- Search and filter recipes by category and keywords
- View structured ingredients and preparation steps
- Add, edit, rate and delete recipes from the dashboard
- Import recipes from websites using schema.org JSON-LD and microdata
- Optional AI-assisted recipe import and ingredient-to-step regrouping through
  Home Assistant's `ai_task` integration
- Plan recipes and free-text meals in a shared weekly calendar
- Use a rotating random-recipe card for inspiration
- Store recipe data and meal plans locally on the Home Assistant instance

## Installation with HACS

Until this repository is included in the HACS default store, add it as a custom
repository:

1. In HACS, open **Integrations** and choose the three-dot menu.
2. Select **Custom repositories**.
3. Add `https://github.com/falconfs/ha-cookbook` with category **Integration**.
4. Find **Cookbook** in HACS and install it.
5. Restart Home Assistant.
6. Go to **Settings → Devices & services → Add integration**, search for
   **Cookbook**, and complete setup.

Restart Home Assistant after installing an update as well, so it serves the
new versioned card assets.

The integration serves and registers the Lovelace card modules automatically;
no separate card download or dashboard resource URL is needed. After setup, add
one or more of the card types below to a dashboard.

## Cards

### Recipe collection

```yaml
type: custom:cookbook-card
language: auto
columns_mobile: 1
columns_tablet: 2
columns_desktop: 3
dialog_size: large
default_sort: date-desc
new_banner_days: 30
recipe_default_tab: ingredients
```

The column settings control the number of recipe tiles per row for the rendered
card width. Defaults are `1`, `2`, and `3`. Mobile applies below `600px`, tablet
from `600px` through `1023px`, and desktop at `1024px` and wider.

### Weekly meal planner

```yaml
type: custom:cookbook-weekly-calendar
language: auto
title: Meal plan
week_start: monday
show_images: true
layout: normal
desktop_layout: vertical
show_dates: true
collapse_past_days: false
initial_week: current
refresh_ms: 3600000
```

Meal slots and entries are shared between calendar cards and stored in
`/config/cookbook/meal_plan.json`.

### Random recipe

```yaml
type: custom:cookbook-random-card
language: auto
duration: 4h
category: Main course
tags:
  - quick
  - vegetarian
dialog_size: large
```

`duration` accepts values such as `1h 30min`, `HH:MM:SS`, or an object with
`days`, `hours`, `minutes` and `seconds`. Missing or invalid values use the
`4h` default. Filters are optional and all configured filters must match. Use
`category: "*"` for recipes without a category.

## Languages

The cards support English and German. With `language: auto` (the default), the
UI follows the Home Assistant user's language. Set `language: en` or
`language: de` on a card to override it. Unsupported languages fall back to
English.

### Adding a language

1. Add `frontend/i18n/locales/<language>.js` and register it in
   `frontend/i18n/locales/index.js`.
2. Add the matching Home Assistant translation file at
   `custom_components/cookbook/translations/<language>.json`.
3. Run `npm test` (the locale parity test checks keys and placeholders) and
   Hassfest to verify the integration translation file.

## AI-assisted features

AI features use Home Assistant's `ai_task.generate_data` service. Configure an
AI Task integration in Home Assistant first. The card can use the preferred AI
Task entity automatically; an optional `ai_task_entity` card setting can
select a specific entity. No provider credentials are stored in the dashboard
configuration.

## Development

```bash
npm ci
npm test
npm run typecheck
python3 -m pytest tests/integration -q
```

To run the local browser preview, provide a directory containing exported v6
recipe folders:

```bash
COOKBOOK_RECIPES_DIR=/path/to/recipes-export npm run dev
```

The preview server defaults to `../../recipes-export` if the variable is not
set. The recipe validator accepts an explicit directory as well:

```bash
npm run validate -- /path/to/recipes-export
```

The card is plain JavaScript and does not require a bundling step. TypeScript
and Zod are used only for recipe-schema validation tooling.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Recipe schema](RECIPE_SCHEMA.md)
- [Deployment and release notes](DEPLOYMENT.md)
- [MIT License](LICENSE)
- [Third-party notices](THIRD_PARTY_LICENSES.md)

## Support

Please report bugs and feature requests in the
[GitHub issue tracker](https://github.com/falconfs/ha-cookbook/issues).
