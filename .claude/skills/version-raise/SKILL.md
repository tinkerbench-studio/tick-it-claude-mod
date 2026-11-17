---
name: version-raise
description: Raises the plugin version on a pull request whose Plugin version check fails because main took the version this one chose
---

Act only when Tick-it reports the `Plugin version` check failing on this pull request (`node scripts/plugin-version.mjs` fails: the plugin changed and `version` is not above the base's). A pull request that has not been told so leaves the version as it is: only the head of the merge queue raises it.

1. Read the base's version: `git fetch origin main`, then `git show origin/main:.claude-plugin/plugin.json`.
2. Set the next version above it, the next patch version (`0.50.4` becomes `0.50.5`), or the next minor (`0.51.0`) when the ticket asks for one, in all three copies, which must agree:
   - `version` in `.claude-plugin/plugin.json`
   - `MOD_VERSION` in `hooks/state.ts`
   - the `modVersion` of the `get_mod_config` call in `tests/contract-fixtures.json`
3. Run `node --test checks/*.test.mjs` and `node scripts/plugin-version.mjs origin/main`: both must pass before you push.
4. Commit ("Raise the plugin version to <version>") and push. Touch nothing else.
