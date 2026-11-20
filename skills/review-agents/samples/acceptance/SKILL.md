---
name: acceptance
base: acceptance
---

- Files this repository expects to change together, which are not a finding: [for example a lockfile with its manifest, or a behaviour change with its test and its documentation].

- Fetch the base branch (`[origin/<base branch>]`) before judging the diff. What this repository's acceptance reviewer owns beyond its base, and what it leaves to the others: [...]. A defect another reviewer owns is raised once, by that reviewer.

- Accepted findings are not raised again. When your prompt lists findings of the ticket a person decided accepted (with their ids), do not raise one again, not as BLOCKING or OPTIONAL and not with a verdict of open: Tick-it drops a verdict of open on an accepted finding when the run is recorded and leaves it out of your blocking count. A new finding with different text is still raised.
