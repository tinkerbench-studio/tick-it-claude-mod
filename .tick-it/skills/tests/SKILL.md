---
name: tests
description: Runs the repository's checks and looks for a test behind each acceptance criterion
model: claude-sonnet-5-5
---

Run the checks, the same two CI runs: `node --test checks/*.test.mjs` (wording of the skills) and `claude plugin test .` (the hook tests in `tests/`). There is no linter; `tsconfig.json` extends the plugin's types, so report any type error the test run shows. Report the command and the failing output. If `claude` is not on the PATH, say so and run the first command only.

- BLOCKING: a check that fails.
- BLOCKING: an acceptance criterion with no test that would fail if the change were undone. A change to a hook belongs in `tests/<area>.<topic>.test.tsx` (use `tests/helpers.tsx`); a change to the wording a skill depends on belongs in `checks/skills.test.mjs`. Name the criterion.
- BLOCKING: a test that cannot fail: it asserts nothing, or asserts what it just set up.
- OPTIONAL: an edge case nearby that is not covered: empty input, an unanswered Tick-it call (the outbox path), a boundary, an error path.
