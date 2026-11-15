---
name: periodic-retro
description: Write a repository's periodic retrospective in Tick-it from the review findings that keep repeating across its Done tickets. Use when Tick-it's daily run asks for it, when asked for a periodic retrospective, or on /tick-it:periodic-retro.
argument-hint: [days]
---

# Write the periodic retrospective

Write the periodic retrospective for the repository this session is in: `git remote get-url origin`, as `owner/name`. The window is the last 30 days, or the number of days in the arguments or in Tick-it's message (a repository sets it in its settings, 7 to 365).

1. **Read the facts.** Call Tick-it's `get_repeat_findings` tool for the window (`days`). It has the tickets that went Done, with their size, changed lines and review rounds, and the review agents' blocking and optional findings grouped by what repeats, with the earlier findings they match.
2. **Read the earlier retrospectives.** Call `list_periodic_retrospectives`, and look at the latest windows: which suggestions they made and how many windows in a row each has appeared (`windowsInARow`).
3. **Write at most five suggestions**, most costly first. Write only an issue that repeats across at least three tickets in this window, or across two windows (it was in an earlier retrospective too). Each has:
   - a title that says what keeps happening,
   - the detail, from the facts ("TCK-4, TCK-7 and TCK-9 each got the same blocking finding from principal"),
   - the evidence: ticket keys, review agents, pull requests,
   - one suggestion: a check for a review agent's skill, a planning rule, a repository instruction,
   - its kind (`blocking` or `optional`, as the finding was) and the review agent that raised it.

   Say which are new, repeated or getting worse. For one that is not new, give `repeats` the title of the earlier finding (of an epic's or an earlier periodic retrospective), and say in the detail whether it is happening more often than in that window. A new problem leaves `repeats` out.

   Write none when nothing repeats: an empty list is the right answer, and do not invent problems.

4. **Write what went well**, at most five, in a line each (for example a problem that stopped repeating since the last window).
5. **Record it once** with `record_periodic_retrospective`: the window is the `days` days ending today (UTC), as `start` and `end`. Writing it again for the same window replaces it.
6. Reply with the suggestions in short.

Do not change code or tickets while writing it, as the retro skill does not. A suggestion becomes work only when someone asks for it. Take no ticket, open no pull request, and call no `update_ticket`.

In any text you write into a ticket (a description, acceptance check, comment or note), name another repository's ticket as `owner/name#KEY` and its pull request as `owner/name#n`, never a bare key or `#n`: a bare one always means this repository, and repositories can share a prefix.
