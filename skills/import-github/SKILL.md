---
name: import-github
description: Import a repository's open GitHub issues into Tick-it as sized tickets, once. Use when asked to import, bring over or copy GitHub issues into Tick-it, or on /tick-it:import-github.
argument-hint: '[gh issue list filters, e.g. --label payments]'
---

# Import GitHub issues into Tick-it

A one-off copy of this repository's GitHub issues into Tick-it. Tick-it does not sync with GitHub: later changes to the issues are not brought across, and nothing is written back to GitHub.

1. **Find the repository**: `git remote get-url origin`, as `owner/name`.
2. **Read the issues**: `gh issue list --state open --limit 100 --json number,title,body,labels,milestone,url`, adding any filters from the arguments. If `gh` is not there or not signed in, say so and stop.
3. **Size each issue** by the lines its change will touch: XS up to 100, S 300, M 700, L 1500. Read the code it touches when the issue alone cannot tell you.
   - An issue that fits one ticket becomes one ticket, with its title and acceptance checks a reviewer can verify, taken from the issue.
   - An issue too big for one L ticket becomes several tickets in build order, in an epic named after the issue.
   - Put an issue's tickets in an epic when its milestone or labels say where it belongs, otherwise leave the epic out.
   - Carry the issue's labels and text across: give each ticket its `labels` (up to 5, lowercase, up to 30 characters, no repeats; drop or shorten the rest) and its `description` (the issue body as markdown, at most 4000 characters, cut with a link to the issue if longer).
   - Leave out issues that are questions, duplicates or not work, and say which.
4. **Show the person the plan first**: a table of issue, what it becomes (ticket or epic of n), size and epic. Ask before importing; change it as they say.
5. **Import once** with Tick-it's `import_tickets` tool, every issue in one call. Issues imported before are skipped and named in its answer.
6. Reply with what was imported and skipped. The tickets are in the Backlog: people move them to Ready on the epic's page in the Tick-it web app, or with `update_ticket`.
