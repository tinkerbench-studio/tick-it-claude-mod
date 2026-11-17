---
name: security
base: security
---

- What this repository takes in and reaches: [its inputs, for example request bodies, command arguments, uploaded files; and what they reach].
- Where this repository's sensitive code lives, for each area the change may touch: [authentication in ..., access rules in ..., queries and migrations in ..., infrastructure in ...; and the document or test that holds its rule].
- BLOCKING: a break of this repository's own rules for access: [who may do what, and the check every path must make].

- Fetch the base branch (`[origin/<base branch>]`) before judging the diff. What this repository's security reviewer owns beyond its base, and what it leaves to the others: [...]. A defect another reviewer owns is raised once, by that reviewer.
