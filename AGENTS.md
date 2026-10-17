# Repository guidance — ha-cookbook

## What this is

A Home Assistant HACS custom integration that includes its Lovelace dashboard
cards. Python integration code lives in `custom_components/cookbook/`; browser
modules and assets are under `custom_components/cookbook/frontend/`. Recipe
records are stored on the Home Assistant host at
`/config/cookbook/recipes/<id>/`.

## Golden rules

- **TDD is mandatory.** Write the failing test first, then implement. No new
  logic without a corresponding test.
- Never hardcode user-visible UI strings. Use the shared `i18n.t()` API and add
  matching keys to every locale; locale parity is checked by tests.
- Derive the locale from the card's `language` option and `hass.locale`; an
  unsupported locale must fall back to English.
- After each change run `npm test`, `npm run typecheck`, and
  `python3 -m pytest tests/integration -q`.
- Verify UI changes in a real browser using the local preview server. Do not
  commit personal recipe data or Home Assistant configuration.
- Code and documentation are in English; communicate with the user in German.
- Commit only when explicitly requested.

## Non-obvious implementation details

### Card styles and versioned assets

The card CSS is an inlined `<style>` template in
`custom_components/cookbook/frontend/cookbook-card.js` (Shadow DOM). The
integration serves the frontend under a path containing the integration
manifest version. Bump `custom_components/cookbook/manifest.json` for every
release so all relative ES module imports receive a fresh URL.

### Config editor and popup lifecycle

- The cookbook card editor must build its form once and then sync values; HA
  pushes `hass` frequently and echoes `setConfig`, so rebuilding steals input
  focus. Avoid `outerHTML` round-trips for input values.
- `recipe-popup.js` reuses its editor. `open()` must reset transient import and
  staged-image state so one recipe cannot leak state into the next.

### Backend boundaries

- Keep `url_import.py` and `ai_import.py` I/O injectable so parser and
  orchestration logic remains unit-testable without Home Assistant.
- `services.py` is the integration layer that wires Home Assistant I/O and
  calls `ai_task.generate_data`.
- Validate every AI response using `validate_ai_recipe()` before displaying or
  saving it. Never put provider credentials in Lovelace configuration.

### schema.org data is inconsistent

Regression tests cover `@graph` objects keyed by numeric strings, ingredient
headers, amounts embedded in ingredient strings, category arrays, and author
strings/objects/arrays. `tool` is often absent; do not invent it.

## Tests and preview

- JavaScript: `npm test` (Node's built-in test runner).
- TypeScript schema tooling: `npm run typecheck`.
- Python integration logic: `python3 -m pytest tests/integration -q`.
- Browser preview: set `COOKBOOK_RECIPES_DIR` to a local recipe export and run
  `npm run dev`; the preview uses the real frontend and the in-memory API mock.

The root `conftest.py` stubs Home Assistant dependencies for pure Python tests.
Do not add production test files inside `custom_components/cookbook/`, since
HACS distributes that directory to users.

## GitHub CLI and releases

- Prefer the repository release workflow: inspect `DEPLOYMENT.md`, run
  `npm run release:preview`, and publish only with `npm run release` after
  reviewing the proposed version and notes. Do not create or move version tags
  manually to bypass the release script.
- The release script runs all GitHub CLI commands in Docker using
  `serversideup/github-cli:latest`. This integration has been implemented and
  tested, including authentication, API reads, and multiline stdin. Host `gh`
  is not needed; Git operations and Git push authentication remain on the host.
- For direct GitHub CLI commands in Docker, use the same image and the named
  `gh-config` volume. Set `GH_CONFIG_DIR=/config/gh` on every invocation so
  credentials are written to the mounted volume rather than the disposable
  container's default home.
- The login is complete only when `gh auth status` reports the account and the
  config path `/config/gh/hosts.yml`. The CLI stores credentials in plain text
  in that Docker volume; protect access to the volume and never paste tokens into
  chat, source files, logs, or command history. The container itself can be
  removed with `--rm`; the named volume persists.
- Reuse the same volume and `GH_CONFIG_DIR` for every later `gh` invocation.
  For example, run `gh release view <version> --repo <owner/repo>` as the
  container command after the image name. Git push authentication is separate
  and must also be configured for release publication.
- Automated commands must not allocate a TTY; use `--interactive` to preserve
  stdin for release notes. Forward token/proxy environment variables by name,
  not by embedding secrets in command arguments.
