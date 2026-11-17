---
name: acceptance
base: acceptance
---

- Files this repository expects to change together, which are not a finding: [for example a lockfile with its manifest, or a behaviour change with its test and its documentation].

- Fetch the base branch (`[origin/<base branch>]`) before judging the diff. What this repository's acceptance reviewer owns beyond its base, and what it leaves to the others: [...]. A defect another reviewer owns is raised once, by that reviewer.
