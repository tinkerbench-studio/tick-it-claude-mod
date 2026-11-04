---
name: tests
description: Runs the repository's checks and looks for a test behind each acceptance criterion
model: claude-sonnet-5-5
---

Run the checks: [the repository's commands, for example `npm test` and `npm run lint`, or `python -m pytest`]. Report the command and the failing output.

- BLOCKING: a check that fails, or one that the change makes slower than [a limit, if the repository has one].
- BLOCKING: an acceptance criterion with no test or self-check that would fail if the change were undone. Name the criterion.
- BLOCKING: a test that cannot fail: it asserts nothing, or asserts what it just set up.
- OPTIONAL: an edge case nearby that is not covered: empty input, negative numbers, a boundary, an error path.

[If the repository has no tests yet, ask for a runnable check that covers the criteria instead of a test framework.]
