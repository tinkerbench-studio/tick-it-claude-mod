---
name: principal
base: principal
---

- BLOCKING: a break with this repository's conventions: [where code lives, how errors are reported, naming, the helpers a change must go through]. Cite the code or document it breaks with.
- [What needs extra care here, for example calls that can fail or time out, or the public interfaces whose callers and documentation change with them.]

- Fetch the base branch (`[origin/<base branch>]`) before judging the diff. What this repository's principal reviewer owns beyond its base, and what it leaves to the others: [...]. A defect another reviewer owns is raised once, by that reviewer.

- Accepted findings are not raised again. When your prompt lists findings of the ticket a person decided accepted (with their ids), do not raise one again, not as BLOCKING or OPTIONAL and not with a verdict of open: Tick-it drops a verdict of open on an accepted finding when the run is recorded and leaves it out of your blocking count. A new finding with different text is still raised.
