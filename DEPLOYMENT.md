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

## Local releases

Releases are started manually on your computer, not automatically by CI.
The TypeScript script uses the existing `tsx` dependency, Git, and GitHub CLI
(`gh`); it does not use semantic-release or add npm dependencies. It publishes
a GitHub Release, not an npm package. Release notes live in GitHub Releases.

### Prerequisites

- Use Node.js 22 or newer, Git, GitHub CLI, and Python with pytest installed.
  Install the project's development dependencies with `npm ci`.
- Authenticate GitHub CLI with `gh auth login`, or provide `GH_TOKEN` /
  `GITHUB_TOKEN` through your environment. Keep credentials out of repository
  files and command history. Git push authentication must also be configured.
- The account needs permission to push commits/tags and create releases.
  Branch protection must permit the release commit; the script does not bypass it.
- Run from a clean `main` checkout synchronized with `origin/main`, including
  no untracked files. Do not run two releases concurrently or change files/Git
  state while a release is running. CI and shallow clones are rejected.
- `origin` must be a credential-free GitHub.com HTTPS or SCP-style SSH URL,
  for example the repository URL used by this checkout. `GH_REPO` and `GH_HOST`
  do not choose the release destination: the script derives it from `origin`.
  Exactly one push URL is allowed and must identify that same GitHub repository.

The baseline is the highest numerically ordered stable version tag reachable
from HEAD, using unprefixed `MAJOR.MINOR.PATCH` tags, such as `1.0.0`. The script
fetches remote tags and `origin/main`; it does not invent an initial baseline.
The existing `1.0.0` tag bootstraps this repository. If the baseline is missing,
verify the repository's published release history and obtain its existing tag
before trying again. Do not create a replacement tag at an arbitrary commit.
Prerelease tags and tags on unmerged history are not release baselines.

### Commit rules

All commits after the baseline are considered, including merged topic commits.
The largest applicable change wins:

- `fix: ...` or `fix(scope): ...`: patch (`1.0.0` → `1.0.1`).
- `feat: ...` or `feat(scope): ...`: minor (`1.0.0` → `1.1.0`).
- A conventional header with `!` before the colon, such as `feat(api)!: ...`,
  or a nonempty body/footer line beginning exactly `BREAKING CHANGE:` or
  `BREAKING-CHANGE:`: major (`1.0.0` → `2.0.0`). Breaking footer detection requires
  a conventional commit header as well.
- Other types, such as `docs`, `chore`, `refactor`, or `revert`, do not trigger
  a release unless explicitly marked breaking. Reverts are not automatically
  paired with earlier commits. Use a `fix:` commit when a revert needs a patch.

Headers use lowercase types, an optional nonempty scope, a colon followed by a
space, and a nonempty description. Commit-body examples do not count as new
headers. With no release-worthy changes, the script reports a no-op. It does
not provide a forced version override or prerelease/multiple-branch support.

### Preview and publish

```bash
npm run release:preview
npm run release
```

Preview prints the baseline, proposed version, and notes without editing tracked
files, creating commits/tags, pushing, or publishing. It still checks GitHub
authentication and may fetch existing remote refs/tags. A later publication
recalculates from the current history rather than guaranteeing the preview's result.

Publication runs `npm test`, `npm run typecheck`, and
`python3 -m pytest tests/integration -q`, then checks the working tree, HEAD,
and remote synchronization again. A failed check stops before version edits.
Run the reported check directly to see its complete diagnostics.

The script synchronizes the manifest, `package.json`, and `package-lock.json`
(including the root package entry). It creates `chore(release): <version>` with
only those three files, stores recovery information/notes in the commit body,
and adds an annotated unprefixed version tag. It pushes only `main` and that tag
using `git push --atomic`, then calls GitHub CLI with `--verify-tag` and the
generated notes. If the server does not support atomic pushes, it stops instead
of falling back to separate pushes. It never force-pushes or publishes from CI.

### Interrupted releases

Git push and GitHub publication are not one transaction. A failed run can leave
local version edits, a release commit/tag, or a pushed tag without a GitHub
Release. The script deliberately does not delete tags or reset changes.

Inspect `git status`, the latest commit, local/remote version tags, and the
GitHub release before recovering. If a release commit exists, keep that exact
commit checked out on `main` and use its version, for example:

```bash
npm run release:preview -- --resume 1.1.0
npm run release -- --resume 1.1.0
```

Resume verifies the release marker, original parent/history and computed version,
version-only changes, original notes, and tag identity. It accepts a synchronized
checkout or exactly the pending release commit ahead of `origin/main`. It reuses
the existing commit, creates a missing tag, retries the atomic push, and creates
only a missing GitHub release. Repeating resume after complete success is a no-op.
An ordinary publication refuses to skip a tagged but unpublished scripted release.
HTTP errors other than a missing release (404), drafts, prereleases, conflicting
tags, altered release commits, or unexpected history stop for manual review.

If preparation or the commit itself failed, `--resume` is not yet available.
Inspect and repair/revert only the generated local version edits/staging, keeping
all unrelated work; then rerun preview from a clean synchronized checkout. If
other commits were added after a pending release, restore a safe checkout of its
release commit before resuming; do not force-push or move a published tag.

### After publishing

- Verify the existing HACS validation and Hassfest GitHub Actions pass; the
  release commit does not skip CI. These checks may finish after publication.
- Verify the published version in HACS before announcing it. HACS uses published
  releases to offer selectable versions. This script does not upload custom assets.
- Restart Home Assistant after updating so the versioned frontend route refreshes.

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
