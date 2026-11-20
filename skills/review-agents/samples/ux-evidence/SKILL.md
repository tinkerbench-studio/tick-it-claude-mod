---
name: ux-evidence
base: ux-evidence
---

How this repository makes the evidence:

- Each component and state has a Storybook story; build Storybook with `[the storybook build command]` and take a screenshot of each affected story with `[the command or script that screenshots stories]`. [Or say that it has no Storybook and what stands in for it.]
- Pages that are not in Storybook are drawn and screenshotted the way [this repository does it].
- Pictures are uploaded to the ticket with `[how this repository uploads pictures]`.
- The base branch is `[main]`; fetch it before judging the diff.
- What this repository's ux-evidence reviewer owns beyond its base, and what it leaves to the others: [...]. Acceptance decides what must exist; ux-evidence decides how it is worded and drawn. A defect another reviewer owns is raised once, by that reviewer.

- Accepted findings are not raised again. When your prompt lists findings of the ticket a person decided accepted (with their ids), do not raise one again, not as BLOCKING or OPTIONAL and not with a verdict of open: Tick-it drops a verdict of open on an accepted finding when the run is recorded and leaves it out of your blocking count. A new finding with different text is still raised.
