# Installation and releases

Cookbook is distributed as one HACS custom integration. The integration owns
both the backend and the dashboard-card modules, so users do not need to deploy
a separate `www/` directory.

## HACS custom repository installation

1. Add `https://github.com/falconfs/ha-cookbook` to HACS as a custom repository
   with category **Integration**.
2. Install **Cookbook** from HACS.
3. Restart Home Assistant.
4. Add **Cookbook** from **Settings → Devices & services → Add integration**.
5. Add `custom:cookbook-card`, `custom:cookbook-random-card`, or
   `custom:cookbook-weekly-calendar` to a dashboard.

The integration serves the frontend from
`/cookbook/frontend/<integration-version>/` and registers
`cookbook-card.js` with Home Assistant. The manifest version is part of the
asset URL so each integration release receives a fresh browser module cache
key. Keep the `version` in `custom_components/cookbook/manifest.json` in sync
with every release. Users should restart Home Assistant after an update so the
new versioned route is registered.

HACS declares Home Assistant `2023.8.0` as the minimum version because service
names and descriptions are localized through the custom integration
translation system.

## GitHub repository settings for HACS

The repository must remain public, have Issues enabled, and have topics set.
The description is already set. Add these topics before requesting inclusion in
the HACS default store:

`home-assistant`, `hacs`, `hacs-integration`, `homeassistant-custom-component`,
`lovelace`, `lovelace-card`, `recipe-manager`, `meal-planner`.

## Release checklist

- Update the integration `version` in `custom_components/cookbook/manifest.json`.
- Run `npm test`, `npm run typecheck`, and
  `python3 -m pytest tests/integration -q`.
- Verify both GitHub Actions pass: HACS validation and hassfest.
- Publish a GitHub Release whose tag matches the manifest version (for example,
  `1.0.0`). HACS uses published releases to offer selectable versions.
- Check the release in HACS before announcing it.

## Local checks

```bash
npm ci
npm test
npm run typecheck
python3 -m pytest tests/integration -q
```

For the preview browser, set `COOKBOOK_RECIPES_DIR` to a directory of exported
v6 recipe folders and run `npm run dev`. Do not commit private recipe data or
Home Assistant configuration to this public repository.
