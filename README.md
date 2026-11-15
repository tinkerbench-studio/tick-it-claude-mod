# tick-it, the Claude Code mod

Tick-it in your Claude session. The board comes from Tick-it's MCP server for the repository you are in, read from its GitHub `origin` remote. `/tick-it take <id>` works on a ticket, and `/tick-it done` moves it to In review, with the lines its change touched since it was taken, and **stewards it to completion**.

Every move happens on Tick-it first: take, done, drop, Done after a clean review round with every acceptance check ticked (a check flagged after-deploy is left out), and `/tick-it add`. `/tick-it attach <id> <note> <file>` moves nothing: it attaches a file, such as a log or screenshot, to a note on a ticket's acceptance check (the mod reads it as bytes, so any type up to 3 MB). The board is cached, so when Tick-it can't be reached `/tick-it board` shows the last board read and says why, and nothing moves.

The manifest points at Tick-it on `https://mcp.tick-it.dev/mcp`. To use a local `tickit-mcp` instead (see the repository README), start Claude Code with `TICKIT_MCP_URL=http://localhost:8787/mcp`. Sign in once with `/mcp`.

## Install

In Claude Code, add the tinkerbench-studio marketplace, then install the plugin from it:

```
/plugin marketplace add tinkerbench-studio/marketplace
/plugin install tick-it@tinkerbench-studio
```

The repositories are private, so Claude Code clones them with your own git credentials (`gh auth login` or a credential helper). For a newer version: `/plugin marketplace update tinkerbench-studio`, then `/plugin update tick-it@tinkerbench-studio` and restart Claude Code. For development, `claude --plugin-dir .` loads it from a clone.

When an edit is refused for passing the size budget, the refusal gives Claude three choices to put to you: raise a new ticket for the extra work (same epic, Backlog, blocked by this ticket), raise this ticket to the next size with `update_ticket` (the guard then measures against the new budget), or leave it as scoped. A ticket already at L has no bigger size, so its second choice is to split it. A ticket with no epic gets its new ticket without one.

Tests: `claude plugin test .` runs the hook tests in `tests/`, and `node --test checks/*.test.mjs` checks the skills' wording. CI runs both.

Shared settings: the size budgets, default review rounds and the brief's instruction lines come from Tick-it's `get_mod_config` tool when a ticket is taken (`hooks/tickit.ts`, `fetchModConfig`). The copies in `hooks/state.ts` and `hooks/board.ts` are only the fallback for when Tick-it cannot answer. The call also sends `repository`, so the answer carries `reviewRounds` and `reviewBudget` for the ticket's size: `reviewRounds` is that ticket's round limit when it is a whole number of 1 or more (otherwise the limit is the repository's `reviewRounds` setting and the defaults, as before), and `reviewBudget` (whole dollars, or null) is the review budget the steward and the brief use ("Review spend budget and the stopping rule" below); both are kept as they were when Tick-it cannot say. Two more brief lines come from `get_mod_config` too, with no local copy: `briefLines.beforeReview` (an array of lines, put in the brief before the line that says how to finish) and `briefLines.afterFix` (one line, added at the end of the fix prompt in `hooks/reviews.ts`). When Tick-it serves neither key, the brief and the fix prompt are the same as without them. The call also sends `modVersion` (`MOD_VERSION` in `hooks/state.ts`), which the server requires; `checks/contract-fixtures.test.mjs` fails when it differs from `version` in `.claude-plugin/plugin.json`. When the mod is older than the server's `minModVersion`, the answer carries a `notice`, and the mod shows that text to you as a toast each time a ticket is taken; a null notice shows nothing.

## Logging

The mod logs the decisions it makes, so a cause can be read afterwards: whether a start line matched, which ticket it took, why a review round started or did not, why a tool call was denied, and each report to Tick-it and each send of review runs from the outbox.

- **Setting:** the environment variable `TICK_IT_LOG`, one of `error`, `warn`, `info` or `debug` (not case-sensitive). A level logs itself and the levels before it. Unset, or any other value, it is `warn`: only errors and warnings are logged, so the log stays quiet.
  - `error`: runs Tick-it rejected.
  - `warn`: a ticket that could not be taken, a report or send that did not get through, a round no reviewer could start.
  - `info`: each report to Tick-it and each send of review runs.
  - `debug`: the decisions above (`start-line`, `ticket-taken`, `start-not-taken`, `round-started` (with `why`: `done-command`, `steward-command`, `moved-by-claude` or `after-fix`), `round-not-started`, `round-settled`, `tool-denied`).
- **Where:** `tick-it-mod.log` in `TMPDIR` (`/tmp` when it is not set), or the file named by `TICK_IT_LOG_FILE`. The file keeps its newest 1000 lines; the mod rewrites it whole, as the engine writes whole files.
- **What a line holds:** `<time> <level> <event> key=value ...`, only ids, states and reasons (`ticket=TCK-151 why=no-skills`). A value that is not a short token (a title, comment, path or file's text) is replaced with `<omitted>`, and nothing from the environment is logged, not even the level's value. Writing a line never stops the mod: a log that cannot be written is skipped.

## Releases

The marketplace (`tinkerbench-studio/marketplace`) pins this plugin to a git tag, `v<version>`, so an install gets a release and not whatever is on `main`. To release:

1. Raise `version` in `.claude-plugin/plugin.json` in the change that is released. CI fails a pull request that changes `hooks/`, `skills/`, `types/` or `plugin.json` without raising it.
2. Merge it. CI tags the merge commit `v<version>` and creates a GitHub release (`.github/workflows/release.yml`); nothing is done by hand.
3. In the marketplace, set `ref` of the `tick-it` entry to `v<version>` and merge that.

Installed copies update only after step 3, and only when `version` changed.

## Ticket references in replies

A ticket key Claude writes in a reply (`TCK-2`, or the repository's own prefix, in any case) is drawn as a bold link with the ticket's title, `Title (TCK-2)`. Pressing it opens the ticket pane. Only tickets on the board are linked, so `UTF-8` is left alone, and code, fences and links already written are not touched (`linkTickets` in `hooks/board.ts`, drawn by the `AssistantMessage` hook in `hooks/ui.tsx`).

## Pull requests

At `/tick-it done` the mod tells Tick-it the branch the ticket was built on and, if `gh` finds an open pull request for it, its number (`link_pull_request`); a call that does not get through waits and is sent again with the outbox. Tick-it also finds the pull request itself from its description. The Tick-it GitHub App then keeps the ticket's pull request state and CI, and the merge moves the ticket to Done. If clean review rounds find its pull request still open, the ticket stays In review and the mod says it moves to Done when it merges.

The band above the prompt shows the taken ticket's key, title, status and diff against its budget, with a Board button. Pressing the key opens the ticket pane: status, size, epic, milestone, labels, links to the ticket in Tick-it and its newest pull request on GitHub, the description and the acceptance. The mod reads the pull request with `list_pull_requests` at the end of each turn. The board pane lists tickets as a table (key, title with its epic, size, status), grouped by status: pressing a title takes the ticket, pressing its key opens the same ticket pane for it without taking it. The ticket pane shows the ticket's status, size, epic, milestone, pull request and diff (for the ticket taken here), links to the ticket and its pull request, the tickets it waits on and blocks (pressing one shows that ticket; one off the board links to its page), the description, acceptance and labels. For a ticket not taken here, `t Start a session on this ticket` starts a Claude Code session on it on this computer (`start_session`) and the pane links to it. When CI on that pull request turns failing, the mod raises a toast naming it (`tick-it: CI is failing on #12 open for TCK-34.`) and opens the pane, once: it speaks again only after CI has left failing and failed anew, or for another pull request.

With a pull request read, the board pane has three actions for it: `f Fix with Claude` puts a prompt in the session asking Claude to read the failing checks with `gh` and fix them within the ticket's size budget (only while CI is failing), `r Re-run failed` runs `gh run rerun --failed` for the newest run of each workflow on the pull request's branch, when that run failed, and `g Open PR on GitHub` opens it with `gh pr view --web`. Each answers with a toast saying what happened or why it failed (no pull request, gh not started, gh's own error).

## Sessions Tick-it starts

Tick-it can start a session for a ticket, on your computer (a `claude-cli://` link with the first message filled in) or in the cloud (your claude.ai routine). That first message begins `Tick-it session s_…: work on <key> in owner/name.` (the key carries the repository's current prefix, `TCK-n` until it is changed): the mod recognises it, takes the ticket, hands Claude its brief with the message, and tells Tick-it the session is working, with Claude Code's session id. As the session goes on it reports its latest word and changed lines (at most once a minute) and every change of status at once: in review, each review round, fixing, done, stopped. The ticket's page in the web app shows it. A first message for another repository takes nothing and says why; in a folder with no origin remote at all (a new project not yet pushed), the mod works on the repository the message names. The line may be indented by spaces or tabs, as a scheduled (routine) session receives it inside its routine-fire-payload block; a mention of it mid-sentence is not a start.

The brief opens with the ticket's description, when it has one, above its acceptance, and tells Claude the acceptance lines are checkable items: tick each one it has met, with a note, and attach a screenshot or other file as evidence to a note on the criterion it proves. When the ticket names a path of the repository's `design.uiPaths` globs (when it sets them; they replace the built-in paths below), or else one of the web app's page and component files (`apps/web/src/pages.tsx`, `apps/web/src/client.tsx`, `links.tsx`, `markdown.tsx`, `pictures.tsx`, `render.tsx`, `style.ts` and `dropzone.ts` in that same folder, or anything under `apps/web/src/design/`; not its server code or tests), a path under a `design/` directory (but not `docs/design/`) or under `.storybook/`, or a `.stories.ts`, `.stories.tsx`, `.css` or `.css.ts` file, and its acceptance does not carry them, the brief adds the fixed UI-evidence checklist (the "UI evidence:" lines in `mod/hooks/ui-evidence.ts`, which say the before/after pictures are uploaded to Tick-it, not committed) after the acceptance; a ticket that names none gets nothing added. It also names the tickets this one builds on and the tickets that wait on it, each with its status, from the board's `blockedBy` and `blocks`. When Tick-it gives the ticket a `url` (its page in the web app), the brief also tells Claude to put a link to it, with the key and title, in the description of every pull request it opens for the ticket. It also asks Claude to name, in `memoriesUsed` when it reports with `report_session`, the recalled memories its plan or change relied on. It tells Claude how to add a finding or follow-up to the ticket: a comment (`add_comment`, `byClaude` true) for discussion, the description (`get_ticket`, then `update_ticket` with the whole description) for lasting detail, and every comment begins with the name of the session that wrote it (its `s_…` id); it also says Tick-it's tools may be deferred and to load them first with `ToolSearch` (`select:mcp__Tick-It__report_session,mcp__Tick-It__get_ticket,mcp__Tick-It__recall,mcp__Tick-It__get_memory,mcp__Tick-It__remember,mcp__Tick-It__record_runs`). The start message says the same, for a session without the mod too, which needs only Tick-it's tools. It also tells Claude that when its ticket needs an open ticket of the repository that must land first, it adds that ticket as a blocker at once with `update_ticket` (`blockedBy`, `session`, `blockerReason`) instead of stopping with `set_needs_human` `blocked-on-decision`; no person approves it. It tells Claude to ask Tick-it for the ticket's branch name with `get_branch_name` before creating a branch, and to reuse an existing branch or open pull request instead of opening another; the start message says the same. It also tells Claude to link every ticket it creates to the ticket it works on straight away, with `add_ticket_link` and a one-line note: `follows-up` for a fix or next step, `caused-by` when the work found the problem, `related` otherwise. It also names the ten security areas and the `secure-*` skill to load before writing or changing code in each (see Secure-coding skills below).

Before a ticket goes to review (`update_ticket` to In review, or `/tick-it done`), the mod checks a branch whose changed files match `touchesUi` (`hooks/ui-evidence.ts`): the repository's `design.uiPaths` globs when it sets them, the built-in tick-it paths otherwise. Pictures are uploaded to Tick-it (`presign_screenshot_upload`, `confirm_screenshot`) and never committed, so the check asks Tick-it for the ticket's pictures with `list_screenshots` and reads none from the repository: no git or gh command looks for them, and the pull request description is not read (whether it lists the pictures and names the visible differences is the ux-evidence reviewer's to judge). It refuses, leaving the ticket taken, when the ticket has no confirmed picture, or when the branch changes a canvas board or board-map entry and `list_screenshots` shows no picture named `board-beside-story-*`. A move to In review that Claude made where the mod did not see it (found at a turn's end) is not undone: Claude is told once what is missing, and no review round starts. Each refusal says what is missing and the steps to produce and upload it ("Showing a UX change" in `docs/design-system.md`). A branch that touches no UI path is not checked, and a check that cannot run lets the move through: when git cannot list the changed files, or Tick-it cannot answer `list_screenshots`, nothing is refused. `/tick-it steward` runs the same check for the ticket being built. The check is `hooks/ui-check.ts`.

When the ticket or its epic has attachments, the brief lists each with its type and id (read with `get_ticket` when the ticket is taken) and tells Claude to fetch images (PNG, JPEG, GIF and WebP) with `get_attachment` before building; a PDF is marked as a link Claude cannot read itself. A ticket with none gets no such text.

When Tick-it has recalled memories for the ticket (up to 5, by its epic, its text and the files its blockers changed, read with `get_ticket` when the ticket is taken), the brief lists each with its M-id, kind, strength and status, and marks an unconfirmed one "unconfirmed: check before relying on it"; a ticket with none adds no such lines. The brief also tells Claude to call `recall` before guessing at a convention or decision and `remember` when it learns something a later session would need. The start message carries the same lines.

The brief ends with the repository's instructions for every brief (its owner or an admin writes them on the repository's Settings page in the web app; the mod reads them with `get_repository_settings` when it takes the ticket), when there are any.

Asking Claude in plain words works too ("start on TCK-1"): Claude taking a ticket with `update_ticket` (refused while someone else's live session holds it) is `/tick-it take`, so the brief, the size budget and progress reports follow. Tick-it keeps a session for it even though it did not start one, and the mod reports to that. Claude is kept off `report_session`, as off `record_runs`. The exception is a breakdown session (`start_breakdown_session`), a temporary suggestion-analysis session (`start_suggestion_analysis`) or a post-deploy check session: its first message starts "Tick-it session s\_…: break down TCK-n" (or "analyse suggestions of TCK-n", or "check TCK-n after deploy"), the mod takes no ticket for it, and that one session may call `report_session` for itself. As with the start line, the line may be indented by spaces or tabs (a scheduled session receives it inside its routine-fire-payload block), and a mention of it mid-sentence does not count. Without the mod, Tick-it still moves the session along with its ticket's status, with no latest word or changed lines.

When a ticket's pull request turns conflicting, Tick-it tells the ticket's live session to merge the base branch in, resolve, run the checks and push. A live session, cloud or local, is told in the reply to a `report_session` (its first report, when it takes the ticket, included), and the mod hands it to Claude as a prompt when the turn ends. A note a person sends a ticket back with (`answer_need`) reaches its session the same way, once: in the reply to the next `report_session` of the live session, cloud or local (or the next session's first, when none is live). A routine only starts a new session, so it is never used to reach a running one; it starts one only for a conflict on a pull request whose session has finished. A session started after the conflict takes the instruction up the same way; one that ended before it got it leaves the pull request flagged and its instruction to the next session. A pull request from a fork, or with a branch name that is not a plain name, is not sent to a session (the text goes into a prompt) and shows as skipped. With no live session, the pull request shows "needs a session" in the web app. Each instruction is on the ticket's timeline.

## Screenshots and the UI evidence check, for any repository

Two scripts ship with the plugin, so a repository does not copy them. Pictures go to Tick-it through `presign_screenshot_upload` and `confirm_screenshot`, never into git. In a repository that is not tick-it, with the plugin installed (its path is `${CLAUDE_PLUGIN_ROOT}`; with `claude --plugin-dir .` it is the clone):

```sh
# 1. Upload the pictures in ./shots for ticket ABC-12: `/tick-it:upload-screenshots ABC-12 ./shots` has Claude do all four steps.
node "${CLAUDE_PLUGIN_ROOT}/scripts/upload-screenshots.mjs" plan ./shots                   # { name, type } of each picture
#    Claude calls presign_screenshot_upload for each and saves url + headers + name in presigned.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/upload-screenshots.mjs" put ./shots presigned.json      # PUTs them, prints what to confirm
#    Claude calls confirm_screenshot for each name printed

# 2. Before review, check a UI change does not commit pictures (the branch side only; whether pictures were uploaded is read from Tick-it by `/tick-it done`):
node "${CLAUDE_PLUGIN_ROOT}/scripts/ui-evidence-check.mjs" ABC-12 --base origin/main --pictures-under docs/screenshots
```

The check reads the repository's UI path globs from `design.uiPaths` in `.tick-it/config.json` (the file Tick-it's GitHub App reads; `--config <file>` names another); with none, no path is a UI path and nothing is checked:

```json
{ "design": { "uiPaths": ["src/ui/**", "**/*.css"] } }
```

A change touching a `uiPaths` glob fails when it adds or changes a picture file (PNG, JPEG, GIF, WebP) under `--pictures-under` (default `docs/change-screenshots/`). Globs: `**` crosses folders, `*` and `?` stay within one. The mod's `/tick-it done` gate and the brief's UI-evidence checklist read the same globs (from `get_repository_settings`' `config`, the first base branch that sets `design.uiPaths`), so a repository sets them once; with none set they use the built-in tick-it paths. The skill is `skills/upload-screenshots/SKILL.md`. The tick-it repository moving onto these copies is a follow-up ticket.

## Planning an epic

`/tick-it:plan-epic <what to build>` takes a description of the work or an epic title; given a description, Claude names the epic itself. It has Claude read the code the epic touches and break it into tickets by [docs/ticket-breakdown.md](https://github.com/tinkerbench-studio/tick-it/blob/main/docs/ticket-breakdown.md) (sizes, area and dependency rules, the design and implementation tickets for anything a person sees), each with acceptance checks a reviewer can verify, in build order with `after` set for every real dependency and nothing else, and up to 5 labels each, reusing the repository's existing ones where they fit. It first reads every repository the epic covers (from `get_epic`, or the organisation's repositories for a new organisation epic; only this one for a repository epic unless the change reaches another, when it proposes that repository's tickets and moving the epic up to the organisation without creating them), getting each by `docs/other-repositories.md`; a repository it cannot get is named to you before any plan is shown, and nothing is guessed about its code. Claude makes them with `plan_epic`, all or none per call, which names one repository (an organisation epic with tickets in several repositories gets one call per repository), and `create_ticket` names the repository of each ticket it adds, and, once the epic's own files (if the person gave an existing title) are linked, stops, reporting the waves and what can start now. The acceptance-check conventions (docs, refusal, failure-path and test-coverage checks, and the UI-evidence checklist) are in [docs/ticket-breakdown.md](https://github.com/tinkerbench-studio/tick-it/blob/main/docs/ticket-breakdown.md), section 6. Claude also reads the epic's attached images with `get_attachment` and links each file to the tickets that use it with `link_attachment` (the epic then lists them under used by); it never invents a file and says when a PDF could not be read. The tickets wait in the Backlog until people agree them and move them to Ready. The skill is `skills/plan-epic/SKILL.md`; Claude also uses it when asked to plan an epic.

## Drafting a ticket

`/tick-it:draft-ticket <what the ticket is for>` has Claude read the code and the board, then propose a title, a size (XS to L) and acceptance checks, and name any similar open ticket. It splits work by [docs/ticket-breakdown.md](https://github.com/tinkerbench-studio/tick-it/blob/main/docs/ticket-breakdown.md), as plan-epic and breakdown sessions do. It reads only this repository unless the work reaches another, which it gets by `docs/other-repositories.md` and proposes tickets for without creating them; a repository it cannot get is named before the draft is shown, and each ticket is created with its repository. Once you agree, a new epic is made first with `create_epic` (its owner goes there) and `create_ticket` is given its `epicId`, never an epic title or an owner. The acceptance-check conventions (docs, refusal, failure-path and test-coverage checks, and the UI-evidence checklist) are in [docs/ticket-breakdown.md](https://github.com/tinkerbench-studio/tick-it/blob/main/docs/ticket-breakdown.md), section 6. The skill is `skills/draft-ticket/SKILL.md`; Claude also uses it when asked to draft or add a ticket.

## Revising a plan

People comment on a plan on the epic's page in the Tick-it web app: on the plan as a whole or on a ticket, and a comment can ask for a change. `/tick-it:revise-plan <epic title>` has Claude answer the questions, make the changes it agrees with (retitle, resize, split, rewrite checks, all in the Backlog; a new ticket from a split names its repository), reply to each suggestion with what it did or why not, and resolve the ones it made. A suggestion a person accepted on the page is applied too, then marked applied so a later run leaves it alone; a rejected one is left as it is. The plan can be agreed once no suggestion is open. The skill is `skills/revise-plan/SKILL.md`.

## Importing GitHub issues

`/tick-it:import-github [filters]` has Claude read the repository's open issues with `gh`, size each one, make an oversized issue into an epic of several tickets and show you the plan before importing it: once you agree, a new epic is made first with `create_epic`, then one `import_tickets` call gives each ticket its `epicId` (it never makes an epic or takes an owner). The tickets land in the Backlog and link back to their issue, with the issue's labels and text as the ticket's labels and description. It is a one-off copy: issues imported before are skipped, later changes on GitHub are not brought across, and nothing is written back. The skill is `skills/import-github/SKILL.md`.

## Retrospectives

`/tick-it:retro <epic title>` has Claude read the epic's facts from Tick-it (`get_retrospective`, which takes an epic or a milestone, a milestone's facts being its epics' summed, with `epics`: title, done and total of each: when each ticket was taken and Done, its changed lines against its size budget and against the range the sizing model predicted at plan approval (with the epic's mean absolute log error, beside the declared size's), its review rounds and blocking findings, each review agent's required fixes and the rounds they took, and its costs, for an owner or admin), look into the tickets that needed rework or cost the most, and record at most five things to improve, each with evidence and one suggestion, and what went well (`record_retrospective`). The Tick-it web app shows it on the epic's Retrospective page. `/tick-it:retro milestone <title>` writes a milestone's retrospective the same way from the milestone's summed facts: it compares how long the milestone took with its priority order, looks at the tickets that waited Ready, names review fixes that repeat across its epics, and records it with `record_retrospective` given the milestone in place of the epic; it changes no code or tickets, as the epic's does. The skill is `skills/retro/SKILL.md`.

`/tick-it:periodic-retro [days]` has Claude read a repository's repeated review findings (`get_repeat_findings`, 30 days unless given) and the earlier periodic retrospectives (`list_periodic_retrospectives`), and record at most five suggestions (`record_periodic_retrospective`), each for an issue that repeats across at least three tickets or across two windows and marked new, repeated or getting worse, or none when nothing repeats. It changes no code or tickets. Tick-it also starts it each day for a repository that turned on the daily retrospective. The skill is `skills/periodic-retro/SKILL.md`.

## Stewarding

Stewarding starts at `/tick-it done`, or when Claude moves its ticket to In review with `update_ticket`, as a session Tick-it started does with no one there to type the command: the mod moves it with its changed lines (in total and per file) and pull request, and the review agents start when that turn ends.

1. Every review skill in the repository runs as a subagent of **your own Claude session**: `.tick-it/skills/<name>/SKILL.md`. (Skills still in `.tickit/skills`, where they lived before 0.22.0, are read when `.tick-it/skills` is not there; move them across.)
2. Each reviewer reports `BLOCKING:` and `OPTIONAL:` lines and a `VERDICT:`. From round 2 each is also given the blocking findings its skill raised earlier that are still open, with the head commit, and reports a `FINDING: <number> fixed|open|gone` line with a reason for each; the mod sends these as the run's `verdicts`, so a blocker fixed by hand is marked fixed and one verified open stays blocking.
3. Blocking findings go back to your session as a prompt to fix. When that turn ends, the reviewers run again: a fix is never left unreviewed. After the round past the limit (see step 4) the mod asks for no more fixes, so none is left unreviewed; Tick-it also flags any ticket whose newest fix is later than its newest review and refuses to take it to Done.
4. A clean round (see "Who does what" below for the pull request's part in it) with every acceptance check ticked by Claude, except those flagged after-deploy (Tick-it reads a review as clean only while every check is ticked, those flagged after-deploy aside; the mod never ticks one itself: a clean round with one unticked first gives Claude a turn to tick the ones it has met, then reviews again, and one still unticked asks a person with `set_needs_human` and leaves the ticket In review) moves the ticket to Done. The limit is the review rounds the ticket's size gets (`reviewRounds` in `get_repository_settings`, read with the repository's instructions when a ticket is taken and as its first round starts, and kept as they were when Tick-it cannot say; by default XS 2, S 3, M 5, L 6), and the pane shows rounds as x/y with y that limit. The ticket's own `reviewRounds` from `get_mod_config` is the limit when it gives one. The steward also stops at the review budget (see "Review spend budget and the stopping rule"). When the last round of the limit still has blocking findings, it fixes them and runs one further round (limit + 1), which the ticket timeline marks as past the limit; if that still has blocking findings, it stops and leaves the ticket to you, telling Tick-it the ticket needs a person (`set_needs_human`, kind `no-clean-round`, with the open findings counted in the note). A clean round whose pull request is still open leaves the ticket In review. If the repository's `autoMerge` setting is on (read with `get_repository_settings`), Tick-it merges the pull request itself and the mod flags nobody; if it is off, or the settings cannot be read, the mod marks the ticket as needing a review of the pull request (kind `review-pull-request`). The merge clears it.

When the repository has milestones, the board pane opens with a header (`◇ <milestone> · 3/9 done · due Nov 6`) read with `list_milestones` along with the board, and shows only the tickets of that milestone's epics. `m next milestone` moves to the next one in roadmap order, then to a last `No milestone` stop for the tickets in no milestone (when there are any), and back to the first. With no milestones the pane has no header and lists every ticket.

While a ticket is stewarded, the board pane has three actions: `r review again now` starts the next round when the current turn ends (also after the rounds ran out or stewarding stopped; with no turn running, a prompt with nothing to fix carries it in), the `o show/hide optional` button shows or hides optional findings, and `s stop stewarding` ends the rounds and leaves the ticket In review. `r` and `s` are reported in the session's status updates. When Tick-it suggests breaking the ticket down (after several review rounds in a row that each end with blocking findings), no further fix round starts: stewarding stops with a note, the ticket stays In review, and Claude is handed the suggestion to offer to you; `r` starts the next round if you decline. The pane lists the round's blocking findings by file and line. The pane reads findings the session already holds and sends nothing new to Tick-it; the counts are the ones recorded with the round's runs, and a line says how many findings are not listed.

No review skills means no review: `/tick-it done` takes the ticket straight to Done (with a reason on the move, since no pull request has merged for it). `/tick-it:review-agents` has Claude set some up in `.tick-it/skills`, fitted to the repository, from five samples that come with the mod (`skills/review-agents/samples`), each of which names its base (see Base review skills below) and holds only the repository's own rules: `acceptance` (every size, Haiku), `tests` (every size, Sonnet), `principal` (S and up, Opus), `security` (M and L, and any size whose change touches a security area, Sonnet) and `ux-evidence` (every size, Sonnet: a change to what a person sees needs before and after Storybook screenshots on its pull request and ticket).

A review skill (`paths` lists the globs of the files it applies to, separated by commas or spaces; a skill with no `paths`, or an empty one, applies to every path, and the mod reports each skill's globs to Tick-it with `report_review_agents`; Tick-it records them, the mod still runs every skill):

```markdown
---
name: principal
description: Second principal engineer on every change
model: claude-sonnet-5-5 # optional; the session's model otherwise
sizes: S, M, L # optional; every size otherwise
changes: authentication, database, src/billing/** # optional; the kinds of change that run it whatever the size (see Security areas below)
paths: apps/mcp/migrations/**, docs/** # optional; globs on one line, separated by commas or spaces; every path otherwise
---

What to check, in your own words.
```

### Base review skills

The plugin ships a base for each of the five roles, in `skills/review-agents/bases/<name>/SKILL.md`: `acceptance`, `principal`, `security`, `tests` and `ux-evidence`. A base holds the rules that are the same in every repository and none that belongs to one. A repository's own skill adds its rules to a base by naming it in its front matter:

```markdown
---
name: principal
base: principal
---

- BLOCKING: a break with our conventions: hooks live in `hooks/` and register through `hooks/register.tsx`.
```

When the round starts, the mod reads the base from its own folder and gives the reviewer the base first and the repository's rules after it, as rules that add to the base and are the ones to follow where the two differ. The `description`, `model` and `sizes` a skill leaves out are its base's, and so is its `changes`; `name` and `paths` are always the skill's own, and those are what `report_review_agents` sends. So a repository keeps only what is particular to it, and a change to a base reaches every repository with the next release of the plugin. A skill with no `base` is read whole, as before. A `base` this version of the plugin does not have (the name is a folder name: lower-case letters, digits and hyphens) changes nothing in the skill, which reviews by its own rules alone, and the line that starts the round says so.

The base is put in by the mod. A session without the mod (one that stewards from Tick-it's own instructions) reads only the file in `.tick-it/skills`, so there a skill with a `base` reviews by the repository's rules alone.

### Security areas

Size is not the only thing that runs a reviewer. A review skill that lists `changes` in its front matter also runs on a ticket outside its `sizes` when the change touches one of the kinds of change it lists. The `security` base lists `changes: all`, so an XS ticket that edits sign-in, a query, a role check or a workflow file is reviewed for security, and an XS ticket that edits a label is not.

An entry of `changes` is the name of a security area, `all` for every area, or a glob of the repository's own sensitive paths (an entry with a slash, a dot or a star, read like `paths`: `**` crosses folders). `changes: none` turns it off, so the skill runs by size alone whatever its base says. An entry that is none of these is named in the line that starts the round. A skill with no `changes`, and no base that has one, runs by size as before.

The areas, and what puts a change in each (`hooks/security-areas.ts`), read from the changed paths and the added and removed lines of the same diff the size budget measures (since the ticket was taken, with untracked files):

| Area | Covers | Skill |
| --- | --- | --- |
| `authentication` | sign-in, sessions, passwords, tokens, account recovery | `tick-it:secure-authentication` |
| `access-control` | permissions, roles, scopes, ownership, tenants, admin | `tick-it:secure-access-control` |
| `database` | SQL, queries, migrations, schema files | `tick-it:secure-database` |
| `infrastructure` | Terraform and other infrastructure as code, CI workflows, containers, platform and runtime configuration | `tick-it:secure-infrastructure` |
| `secrets` | keys, tokens, environment secrets, encryption, hashing, signatures | `tick-it:secure-secrets` |
| `input` | shell commands, file paths and uploads, server-side fetches, redirects, webhooks, parsers | `tick-it:secure-input` |
| `web` | HTML built from data, cookies, CSRF, CORS, security headers | `tick-it:secure-web` |
| `dependencies` | manifests, lock files, registries, a dependency line of a `package.json` | `tick-it:secure-dependencies` |
| `agents` | prompts, tools, MCP servers, hooks, agent permissions | `tick-it:secure-agents` |
| `personal-data` | personal data stored, logged, sent, exported or deleted; analytics and consent | `tick-it:secure-personal-data` |

A path can put a change in an area by its name (`auth/`, `migrations/`, `*.tf`, `.github/workflows/`); so can a word on a changed line (`password`, `SELECT … FROM`, `innerHTML`). Prose and pictures (`.md`, `.txt`, `.svg`, a `LICENSE` and the like) put a change in no area. In lock files, tests and fixtures (a `test/` or `fixtures/` folder, a `.test.` or `.spec.` file) only the path counts and words are not read: a test that signs in changes no sign-in, and the code it tests is read for itself. The reading is made without a model and is a first guess: it decides that the reviewer runs and what it is told to look at, never what it finds. A repository whose own words collide with an area (a product that calls its conversations "sessions") lists the areas it wants in its `security` skill's `changes`.

The reviewer is told what the change touches, with the files that say so, to review those parts first and by what they are, and is given the practices of each area touched: the body of that area's `secure-*` skill, read from the plugin's own folder. A "Must" there that the change breaks is a blocking finding, a "Should" an optional one. A skill running for its size gets the same when the change touches an area it lists. When a skill runs only for what the change touches, the line that starts the round says so (`security runs for what the change touches: authentication, database.`), and the reviewer is told the ticket is outside its sizes. Once a skill has reviewed a ticket it reviews every later round of it, so a fix that takes the change out of an area still has that round's findings answered.

`report_review_agents` sends Tick-it each skill's `sizes` and `paths` as before, and not its `changes`: Tick-it does not yet know that a skill can run outside its sizes, and leaves a run of a skill whose `sizes` leave out the ticket's size out of what holds the ticket back. The mod's own rounds are not affected (its blocking findings go back to be fixed, and the ticket is Done only after a clean round), but Tick-it's own reading of such a ticket does not count that run until the server takes `changes` too.

### Secure-coding skills

The ten `secure-*` skills in the table above are part of the plugin (`skills/secure-<area>/SKILL.md`). Each holds the practices for one area as "Before you write", "Must", "Should" and "Check before review", for any application and no one repository. They are for the session that writes the code as much as for the reviewer:

- Each skill's description says when to use it, so Claude loads it before writing or changing code in that area, in a session with or without a ticket.
- The brief of a taken ticket names the ten areas and how the skill of each is named (`SECURE_CODING_LINE` in `hooks/security-areas.ts`, the mod's own line, not one `get_mod_config` serves), and says that the security reviewer checks the change against the same skill.
- The first edit of a ticket that lands in an area (by the edited file's path, or the words of the edit) adds a line to that edit's result naming the area and its skill, once per area for a ticket (`hooks/tool-hooks.ts`).
- The security reviewer is given the body of the skill for each area the change touches, so the author and the reviewer work from one text.

What is particular to a repository (where its sign-in lives, the helper every query goes through) stays in its own `.tick-it/skills/security/SKILL.md`, which adds to the base as before.

### VibeSec-Skill

The secure-coding skill `VibeSec-Skill` is not part of the `tick-it` plugin, and the plugin's own `secure-*` skills above do not replace or copy it: it is one long guide to web application security, where they are short rules by area that the reviewer checks. This repository's marketplace (`tickit`, in `.claude-plugin/marketplace.json`) lists it as a plugin of its own, `vibesec`, which is a reference to the skill's own repository, [BehiSecc/VibeSec-Skill](https://github.com/BehiSecc/VibeSec-Skill) (Apache-2.0), pinned to one commit; no copy of it is kept here. Install it with:

```
/plugin marketplace add tinkerbench-studio/tick-it-claude-mod
/plugin install vibesec@tickit
```

The skill is then `vibesec:VibeSec-Skill` in every repository, in place of a copy in each one's `.claude/skills`. To take a newer version of the skill, read what changed upstream and set `sha` of the `vibesec` entry to the new commit.

### Who does what: the steward, the CI instruction and the merge queue

A round is clean only when its reviewers found nothing **and** its pull request is neither failing CI nor stale (behind its base or in conflict; a queued pull request is exempt from that, the queue updates it). The steward reads the pull request (`list_pull_requests`: `ci`, `behind`, `mergeState`, `mergeQueue`, `ciInstructed`) when the reviewers are clean and adds blocking findings of its own:

- **CI failing** is a blocking finding. A fix is followed by another review round, which is also what the merge queue wants: it drops an entry whose CI fails on the head commit, and the ticket rejoins only after a clean review and CI on a new commit. When `ciInstructed` is true, Tick-it's own CI instruction (sent once per head commit, after all checks finished) has already told the session about this commit: the steward's fix prompt says to follow that instruction and not to start a second, separate fix; the review round after that turn decides. A new push clears it.
- **Behind its base or conflicting**, and not in the queue: the steward merges the base into the PR branch (`git merge`, never a rebase, amend or force-push), runs the checks, pushes, and reviews again. This is what the backend's conflict instruction says too.
- **In the merge queue:** the queue owns the branch. Only the queue head is brought up to date, by the queue, with the repository's update method, and a commit the queue did not make takes the entry out of the queue. The steward never merges the base into a queued branch or updates it; it acts on a queued branch's conflict only through Tick-it's conflict instruction. The one push it makes there is a fix for failing CI, which the queue has already taken the entry out for.
- **Pending CI** does not block a round: the steward does not wait on it. The backend tells the session when it fails, and the merge queue and Done (which waits for the pull request to merge) hold the ticket until CI passes.

A pull request the steward cannot read counts as a blocking finding too: the round is not clean until Claude has checked it with `gh`. These findings go to Claude in the fix prompt only; they are not part of any review run, so the pane's counts and finding list do not show them. They are added only when the reviewers found nothing; a round with reviewer findings is fixed first.

The cloud steward (the brief of a session Tick-it starts on claude.ai) follows the same rules, step 5 of its procedure.

## Time and cost

For each reviewer run, tick-it records the following from its `turn.complete`:

- wall-clock time
- the four token counts
- the model

The cost is what those tokens would cost at API list prices. On a Claude plan they count against the plan's usage instead. Prices are in `PRICES` in `hooks/state.ts`, and a model with no price there shows `—`.

`/tick-it reviews [id]` shows each run, then totals by reviewer and overall. The history is kept in the mod's store across sessions (the last 500 runs).

## Review spend budget and the stopping rule

Besides the round limit, Tick-it can give a ticket a review spend budget: what review and fix may spend on it, in whole dollars, by ticket size (`reviewBudgets` in `get_repository_settings`, next to `reviewRounds`). A repository whose owner has set no figure uses the defaults, which are the 75th percentile of what finished tickets spent, rounded up:

| Size   | XS  | S   | M   | L                        |
| ------ | --- | --- | --- | ------------------------ |
| Budget | $1  | $3  | $5  | none (rounds limit only) |

The owner can change them with `set_repository_settings` (`reviewBudgets`); setting a size to `null` puts it back on its default. How they were worked out is in Tick-it's `docs/review-budgets.md`.

**How spend is measured.** Spend is the `costUsd` of the ticket's review and fix runs added up, the runs this mod records with `record_runs` (see "Time and cost": the four token counts priced at API list prices). Build runs are not counted. A run with no price is left out of the sum and counted as unpriced, so the figure is a lower bound when any run is unpriced. Tick-it reads it back as the ticket's `reviewSpend` (`costUsd`, `budget`, `remaining`), which `get_ticket` returns; it is null for a caller who cannot see costs.

**The stopping rule.** The review rounds stay a ceiling alongside the budget: the budget never raises the number of rounds, and a ticket with no budget is limited by rounds alone. A session runs another round only while blocking findings are open, spend is under the budget and the round count is under the ceiling (the size's `reviewRounds`, plus the one further round after the last, as described in "Stewarding"). Before a further round it reads `reviewSpend` and does not start a round whose cost, judged by the rounds so far, would clearly overshoot `remaining`; with `reviewSpend` null it goes by the rounds alone. A fix already made is still reviewed once first. When either the budget or the rounds run out with blocking findings still open, the session fixes nothing more, calls `set_needs_human` with kind `no-clean-round` and a note naming the budget or rounds and the open findings, and leaves the ticket In review for a person. `continue_reviews` lifts both the ceiling and the budget for that one ticket until a round is clean.

The mod's steward applies both. Once a round has blocking findings and the round ceiling allows another, and the ticket has a `reviewBudget` (`get_mod_config`), it reads `reviewSpend` with `get_ticket` and starts no further round when `remaining` is used up or the average cost of the rounds so far is more than `remaining`. It stops as at the ceiling (the ticket stays In review, `set_needs_human` with kind `no-clean-round`, a note naming the budget and the open blocking findings), and asks for no fix, so none is left unreviewed. With no `reviewBudget`, with `reviewSpend` null (costs cannot be seen) or with `get_ticket` unreachable, it goes by the round ceiling alone. A session that Tick-it starts without the mod is told the same in its start message, and the brief of a ticket with a budget carries the same words.

## Reporting to Tick-it, from local and cloud sessions

What `/tick-it done` does, how it differs from `report_session` with `done`, and how a session finishes the same way with `update_ticket` is written in [Finish a session](https://github.com/tinkerbench-studio/tick-it/blob/main/docs/cloud-sessions.md#finish-a-session-tick-it-done); the brief points to it.

Tick-it is an MCP server, and this mod lists it in `.claude-plugin/plugin.json` as `tickit`. Each finished run goes to its `record_runs` tool as soon as the run lands: every review agent, and every main-loop turn spent on a ticket, as a build turn while the ticket is taken or a fix turn while a review round's findings are being fixed. That way a ticket's cost covers building, reviewing and fixing. A cloud session's container, and the mod's store with it, is thrown away when the session ends, which is why runs aren't held until later.

- **Signing in:** the mod holds no token; the call uses the session's own MCP connection.
  - On your machine, sign in once with `/mcp`.
  - In cloud sessions, add the Tick-it connector on claude.ai. The session reaches it through that connector, so no Allowed domains change is needed.
- **Cloud sessions load the mod from the environment's setup script:** a project's `extraKnownMarketplaces` and `enabledPlugins` in `.claude/settings.json` are not applied in a cloud session, and a SessionStart hook would install it too late for that session. Add these to the cloud environment's setup script:

  ```sh
  claude plugin marketplace add tinkerbench-studio/tick-it-claude-mod
  claude plugin install tick-it@tickit
  ```

  The plugin's own `tickit` server cannot connect there (the sandbox proxy answers `mcp.tick-it.dev` with 403, and the mod holds no token), so the mod falls back to the claude.ai connector, whose tools a cloud session lists as `mcp__Tick-It__*` (server name `Tick-It`). With the mod loaded, runs carry the real input, output and cache token counts; the start message tells a session without it to record runs itself.

- **What it sends:** the session id, the repository's `origin` URL, and the runs. Each run carries its time, token counts, model, cost, where the session runs (`place`: `cloud` when the connector a cloud session lists, `Tick-It`, took the call; `local` when the plugin's own server or a local session's `claude.ai Tick-It` connector did), the number of blocking and optional findings, and each finding with its file, line and text (read from the reviewer's `BLOCKING:` and `OPTIONAL:` lines, clipped to 2000 characters, 200 to a run). Tick-it keeps them so `get_ticket` can show them; a reviewer should not put secrets in a finding.
- **What Tick-it answers:** `{ accepted: [agentId], rejected: [{ agentId, reason }] }`.
  - Accepted runs leave the outbox.
  - Rejected runs are dropped and listed under "Dropped" in `/tick-it reviews` with Tick-it's reason, because sent again they would only be rejected again.
  - A run the answer doesn't mention stays waiting.
- **When the call fails as a whole** (not signed in, server down, an error result): every run stays waiting. They go with the next finished run, at session start and end, and on `/tick-it sync`. Tick-it keys a run by its `agentId`, so a run sent twice counts once.
- **The model can't write runs:** the mod refuses the model's own calls to `record_runs` and `report_review_agents` (the mod sends the repository's review skills itself at session start). Tick-it's other tools (tickets, epics, costs) are the model's to use.
