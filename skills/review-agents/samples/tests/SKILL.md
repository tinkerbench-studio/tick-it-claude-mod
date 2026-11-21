---
name: tests
base: tests
---

Run the checks: [the repository's commands, for example `npm test` and `npm run lint`, or `python -m pytest`].

- BLOCKING: a check the change makes slower than [a limit, if the repository has one].
- Where a test belongs: [the folders and helpers this repository's tests use].

[If the repository has no tests yet, ask for a runnable check that covers the criteria instead of a test framework.]

- Fetch the base branch (`[origin/<base branch>]`) before judging the diff. What this repository's tests reviewer owns beyond its base, and what it leaves to the others: [...]. A defect another reviewer owns is raised once, by that reviewer.

- Accepted findings are not raised again. When your prompt lists findings of the ticket a person decided accepted (with their ids), do not raise one again, not as BLOCKING or OPTIONAL and not with a verdict of open: Tick-it drops a verdict of open on an accepted finding when the run is recorded and leaves it out of your blocking count. A new finding with different text is still raised.
