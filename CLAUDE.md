# Working in tick-it-claude-mod

## Tickets that span the mod and tick-it

Some changes touch both this repository (the Claude Code mod) and tick-it (`tinkerbench-studio/tick-it`). When writing or refining a ticket for one:

- **Acceptance criteria never depend on the other repository.** Each criterion must be satisfiable and checkable with only this repository's change merged. Do not write "requires TCK-X", "once the mod ships" or "after the tick-it change lands". If a criterion could not be ticked until the other ticket is done, rewrite it, or split it so the dependent part is its own ticket. Do not leave it for a person to unblock later.
- **Mention the other side in a comment, not a criterion.** Add a comment on the ticket saying what the counterpart change is and link its ticket. That is information for the reader, never a blocker.
- **Changes are backwards compatible in both directions.** The mod must keep working against a tick-it without the change, and tick-it must keep working with a mod that does not know about it. New fields, tools and behaviours are optional on the receiving side, absence is tolerated, and there is a sensible default. Where it matters, say in a criterion what happens when the other side is older, for example "without the mod update, the response is unchanged".
