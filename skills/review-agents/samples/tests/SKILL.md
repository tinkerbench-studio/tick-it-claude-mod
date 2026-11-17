---
name: tests
base: tests
---

Run the checks: [the repository's commands, for example `npm test` and `npm run lint`, or `python -m pytest`].

- BLOCKING: a check the change makes slower than [a limit, if the repository has one].
- Where a test belongs: [the folders and helpers this repository's tests use].

[If the repository has no tests yet, ask for a runnable check that covers the criteria instead of a test framework.]

- Fetch the base branch (`[origin/<base branch>]`) before judging the diff. What this repository's tests reviewer owns beyond its base, and what it leaves to the others: [...]. A defect another reviewer owns is raised once, by that reviewer.
