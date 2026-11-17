export type TicketSize = 'XS' | 'S' | 'M' | 'L'
export type TicketStatus = 'Backlog' | 'Ready' | 'In progress' | 'In review' | 'Ready to merge' | 'Done' | 'Superseded' | 'Dropped'

/** A file attached to a ticket or its epic, as the brief names it. */
export type AttachmentRef = { id: string; name: string; type: string }
/** A memory Tick-it recalled for a ticket (get_ticket), as the brief lists it. */
export type MemoryRef = { key: string; kind: string; body: string; status: string; strength: number }

export type Ticket = {
  id: string
  title: string
  epic: string
  /** The epic's id, as Tick-it names it; absent for a ticket with no epic. Epics are matched and named to Tick-it by this, never by title. */
  epicId?: string
  size: TicketSize
  status: TicketStatus
  /** What the ticket is for, as markdown; absent when none was written. */
  description?: string
  acceptance: string[]
  /** Keys of the tickets that must be Done first, and of those waiting on this one. */
  blockedBy?: string[]
  blocks?: string[]
  labels?: string[]
  url?: string
  /** ISO time the ticket is held until (Tick-it's notBefore); absent when it has no hold. */
  notBefore?: string
  /** Read whole (get_ticket or update_ticket); a slim board row has no description, acceptance, links or url. */
  whole?: boolean
}

/** Token counts as the API reports them, summed over a review agent's run. */
export type ReviewUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One review agent's run on one round of a ticket's stewarding. */
export type ReviewRun = {
  /** The subagent's id, as `$.agent.spawn` answered it. */
  agentId: string
  /** The repository (owner/name) the run was made in; absent on a run an older mod stored, which belongs to the repository it is first read in. */
  repository?: string
  ticket: string
  epic: string
  round: number
  /** The skill's folder name under `.tick-it/skills/`. */
  skill: string
  model: string
  startedAt: number
  /** The commit the reviewer ran on (git rev-parse HEAD when the round started); Tick-it records it with the run. */
  headSha?: string
  status: 'running' | 'done' | 'failed'
  /** The Claude Code session the run was spawned in: a running run of another session has no agent left to answer. */
  claudeSession?: string
  durationMs?: number
  /** Set on a reviewer skipped because no changed file matches its paths, or (from round 2) because it was clean and no changed file since matches them, so its verdict carries forward: the reason, sent as `notApplicable`. */
  notApplicable?: string
  /** Set on a failed run of a reviewer that applied but could not be started: the refusal. */
  reason?: string
  usage?: ReviewUsage
  /** What the run would cost at API list prices; absent for a model with no price. */
  costUsd?: number
  blocking?: number
  optional?: number
  /** The BLOCKING lines, handed to the fix round. */
  findings?: string[]
  /** Every BLOCKING and OPTIONAL line as a finding, sent to Tick-it as the run's findings. */
  items?: { severity: 'blocking' | 'optional'; file?: string; line?: number; text: string; /** An earlier blocker the reviewer verified still open: counted and listed in the pane, not sent as a finding. */ open?: true }[]
  /** The open blocking findings of earlier rounds this reviewer was given, numbered from 1 in this order. */
  earlier?: { id?: string; file?: string; line?: number; text: string }[]
  /** The reviewer's verdict on each of those, sent to Tick-it as the run's verdicts. */
  verdicts?: { /** The Tick-it id of the finding, when it came from Tick-it: Tick-it closes that finding on a fixed or gone verdict. */ finding?: string; file?: string; text: string; verdict: 'fixed' | 'open' | 'gone'; reason: string }[]
}

/**
 * A main-loop turn spent on a ticket: building it (the ticket taken) or fixing
 * a review round's findings. Sent to Tick-it beside the review runs.
 */
export type WorkRun = {
  /** turn-<the turn's id>. */
  agentId: string
  /** The repository (owner/name) the run was made in; see ReviewRun. */
  repository?: string
  ticket: string
  kind: 'build' | 'fix'
  round?: number
  model: string
  status: 'done' | 'failed'
  durationMs: number
  /** When the turn began, by this machine's clock, so Tick-it orders a fix against the reviews on one clock. */
  startedAt?: number
  usage?: ReviewUsage
  costUsd?: number
}

/** Anything the outbox sends: a review run (no kind) or a work run. */
export type OutboxRun = ReviewRun | WorkRun

/** A link_pull_request call Tick-it has not taken yet. */
export type PendingLink = { repository: string; key: string; branch: string; number?: number }

/** A run Tick-it rejected, taken out of the outbox so it is not sent again. */
export type DroppedRun = {
  run: OutboxRun
  /** Tick-it's reason, which names the field it rejected. */
  reason: string
  at: number
}

/** A ticket's newest pull request as list_pull_requests last told the pane. */
export type PullRequestView = {
  number: number
  state: 'open' | 'closed' | 'merged' | 'unknown'
  draft: boolean
  /** CI on its latest commit; null when none has reported. */
  ci: 'pending' | 'success' | 'failure' | null
  /** Its branch lacks commits its base has; null while GitHub has not said. */
  behind: boolean | null
  /** GitHub reports a merge conflict with its base. */
  conflicting: boolean
  /** It is in the merge queue: the queue owns its branch. */
  queued: boolean
  /** Tick-it has already told the ticket's session about CI failing on the current head commit. */
  ciInstructed: boolean
  /** Its page on GitHub; absent on one read by an older mod. */
  url?: string
  /** The commit its branch is at on GitHub (headSha of list_pull_requests); absent when Tick-it did not say. */
  headSha?: string
}

export type StewardPhase = 'reviewing' | 'fixing' | 'done' | 'stopped'

/** A session Tick-it started for a ticket, which this session reports progress to. */
export type StartedSession = {
  /** Tick-it's id for the session, from its first message. */
  id: string
  repository: string
  ticket: string
  status: 'working' | 'reviewing' | 'fixing' | 'done' | 'stopped'
  /** When it last reported, by the engine's clock. */
  reportedAt: number
  /** The Claude Code session it belongs to: a later session in the same folder does not pick it up. */
  claudeSession?: string
  /** Started by a continue line: the ticket was already In review or Ready to merge and is not moved, so the session is done when its turn ends with the ticket not In review. */
  continued?: boolean
}

/** Where the stewarding of one ticket stands. */
export type Steward = {
  ticket: string
  round: number
  phase: StewardPhase
  /** Shown as round x/y; the stop is the ticket size's round limit plus the round past it. */
  maxRounds: number
  note?: string
  /** Stopped while a fix turn was running: that turn has not ended yet. */
  fixing?: boolean
  /** Claude has been asked, in this round's turn, to tick the acceptance checks it has met: a clean round that still has one unticked asks a person. */
  ticking?: boolean
  /** Stewarding stopped by the mod itself (the round limit or the review budget), not by the stop button: a fix made later is still reviewed once. */
  stoppedBy?: 'mod'
  /** This round reviews a fix made after the mod stopped: if it still has blocking findings the mod stops again and starts no further round. */
  afterStop?: boolean
  /** The round's only blocking findings were the pull request's own and the review budget has no room for a reviewer round: after the fix the pull request is read again and settles the round. */
  pullRequestOnly?: boolean
}

/** What a resumed session keeps, stored beside the started session (hooks/resume.ts). */
export type ResumeState = {
  /** The Claude Code session and the repository it belongs to: another session, or another repository, restores none of it. */
  claudeSession: string
  repository: string
  current: string | null
  baseCommit: string | null
  steward: Steward | null
  reviewNext: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'tick-it': {
      tickets: Ticket[]
      /** Why the board could not be read from Tick-it, shown with the cached board; null once it is read. */
      boardError: string | null
      current: string | null
      /** The ticket the details pane shows; the taken one when null. */
      viewed: string | null
      /** The link to the session last started from the ticket pane. */
      sessionLink: { ticket: string; href: string } | null
      diffLines: number
      /** The current ticket's newest pull request; the last one read stays when a read fails. */
      pullRequest: PullRequestView | null
      /** Why the pull request could not be read from Tick-it; null once it is read. */
      pullRequestError: string | null
      /** The session Tick-it started this one as, if it did. */
      started: StartedSession | null
      /** The commit the current ticket was taken at; null when not known. */
      baseCommit: string | null
      reviews: ReviewRun[]
      steward: Steward | null
      /** A ticket Claude moved to In review itself, whose review agents start when the turn ends. */
      reviewNext: string | null
      /** What Tick-it asked of the session (resolving a merge conflict), handed to Claude when the turn ends. */
      pendingInstructions: string[]
      /** Finished runs not yet accepted by Tick-it. */
      outbox: OutboxRun[]
      /** Why the last send to Tick-it failed; null once one succeeds. */
      syncError: string | null
      /** Runs Tick-it rejected, newest last. */
      dropped: DroppedRun[]
      /** The security areas Claude has been pointed at for a ticket's edits, so each is named once. */
      securityNudged: { ticket: string; areas: string[] }
    }
  }
}

/** A milestone as list_milestones answers it, in roadmap order. */
export type MilestoneView = {
  title: string
  dueOn: string | null
  epics: { id?: string; title: string; tickets: number; done: number }[]
  tickets: number
  done: number
}
