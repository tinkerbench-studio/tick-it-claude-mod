---
name: review-agents
description: Set up the review agents tick-it runs on a built ticket, in the repository's .tick-it/skills, from the samples that come with tick-it, fitted to this repository. Use when a repository has no .tick-it/skills, when asked for review agents or reviewers, or on /tick-it:review-agents.
argument-hint: '[which samples, e.g. acceptance tests]'
---

# Set up review agents

When a ticket is built (`/tick-it done`), tick-it runs every review skill in `.tick-it/skills/<name>/SKILL.md` as a subagent of this session. Their blocking findings come back to be fixed, and the ticket is Done after a clean round with every acceptance check ticked, except those flagged after-deploy (any other check left unticked asks a person). A repository with none has no review: the ticket goes straight to Done, with a reason on the move (a ticket with no merged pull request needs one).

1. **Look at what is there.** List `.tick-it/skills`. Keep any skill already there; only add what is missing, and never overwrite one without asking.
2. **Look at the repository.** Its languages, how its tests run (package.json scripts, pytest, go test, a Makefile, the CI workflow), its linters, and anything in CLAUDE.md or the README about how changes are made. If `.tick-it/merge-checks.json` exists, tell the person it is no longer read and point them to `docs/config.md#upgrade` in tinkerbench-studio/tick-it. A repository with no tests yet is fine: say so.
3. **Pick the samples.** The ones named in the arguments, or else all five (leave out `ux-evidence` for a repository with no user interface), which are in the `samples` folder beside this file:
   - `acceptance`: every acceptance criterion is met, and nothing beyond the ticket changed. Every size, a small model.
   - `tests`: the checks run and pass, and each criterion has one that would fail without the change. Every size.
   - `principal`: correctness, design and fit with the code around it. S and up, a larger model.
   - `security`: input handling, secrets, access. M and L.
   - `ux-evidence`: a change to what a person sees carries before and after screenshots from Storybook, on its pull request and its ticket, with every visible difference named. Every size, Sonnet. It assumes Storybook; fit it to how this repository builds and screenshots its stories, or say that it has none and what stands in for it.
4. **Fit each to this repository.** Copy it to `.tick-it/skills/<name>/SKILL.md` and replace the bracketed placeholders with what this repository has: the real test and lint commands, its conventions, the places that need extra care. Remove a check that cannot apply rather than leaving a placeholder. Keep the sample's memory line (the `principal` sample tells its reviewer to `recall` conventions and cite an M-id); it needs the Tick-it tools in the reviewer, so remove it only if they have none. Keep the front matter's `name`, `description`, `model`, `sizes` and `paths` (sizes are XS, S, M and L; `paths` are globs on one line, separated by commas or spaces; leave sizes or paths out for every size or every path).
5. **Show what you wrote**: each skill, its sizes and model, and what you fitted. Do not commit: the person decides.

Each reviewer reports `BLOCKING:` and `OPTIONAL:` lines, each with file:line, then `VERDICT: clean` or `VERDICT: changes`; tick-it adds that to the prompt, so the skills need not say it. Blocking is for what must change before the ticket is Done; a matter of taste is optional.
