---
name: version-raise
description: How the plugin version is raised, after the merge by the release job and never on a pull request
---

A pull request never changes the plugin version. Leave `version` in `.claude-plugin/plugin.json`, `MOD_VERSION` in `hooks/state.ts` and the `modVersion` of the `get_mod_config` call in `tests/contract-fixtures.json` as they are, whatever the change: the `Plugin version` check (tinkerbench-studio/github-actions' shared `version-check`, in `.github/workflows/release.yml`) fails a pull request that changes any of the three, and passes one that changes `hooks/`, `skills/`, `types/` or `plugin.json` with the version as it is.

After a merge to main that changed one of those paths, the release job (`.github/workflows/release.yml`) runs tinkerbench-studio/github-actions' shared `version-raise`, which raises the three copies to the next patch version (`0.50.4` becomes `0.50.5`); the job then commits "Raise the plugin version to <version>" to main, and tags that commit `v<version>` with a GitHub release.

A ticket that wants a minor version raises it by hand on main after the merge, in the same three copies, which must agree, and runs `node --test checks/*.test.mjs` first.
