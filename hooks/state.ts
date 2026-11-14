import type { TicketSize, TicketStatus } from '../types'

// Tickets live in Tick-it, reached through its MCP server (TICKIT_SERVER in the
// manifest, or the claude.ai connector, TICKIT_CONNECTORS, where that cannot connect). The board is read with list_tickets and cached in the mod's store,
// so it still shows when Tick-it cannot be reached; every move is made on the
// server first and the cache follows what the server answered.

export const PANE = 'tick-it-board'
/** The taken ticket's details, opened from its key or pull request in the band. */
export const TICKET_PANE = 'tick-it-ticket'
export const STORE_KEY = 'tickets'
export const STARTED_KEY = 'started-session'
/** The first line of a session Tick-it started for a ticket. A routine session receives it inside a routine-fire-payload block, indented, so spaces or tabs may come before it; text before it on the line may not. */
export const START_LINE = /^[ \t]*Tick-it session (s_[a-z0-9]{8,40}): work on ([A-Z]{3}-[1-9]\d*) in ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\.$/m
/** The first line of a breakdown session (or a temporary suggestion-analysis or post-deploy check session) Tick-it started: it builds nothing, so the mod does not track it. */
export const BREAKDOWN_LINE = /^[ \t]*Tick-it session (s_[a-z0-9]{8,40}): (?:break down|analyse suggestions of|check) ([A-Z]{3}-[1-9]\d*)(?: after deploy)? in ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\.$/m
export const BREAKDOWN_KEY = 'breakdown-session'
/** Progress goes to Tick-it on every change of status, and otherwise at most this often. */
export const REPORT_EVERY_MS = 60_000
export const REPORT_TOOL = 'report_session'
/** How the instruction Tick-it sends for a suggested breakdown begins (apps/mcp/src/breakdown-offer.ts). */
export const BREAKDOWN_SUGGESTION = 'Tick-it suggests breaking '

export const BUDGET: Record<TicketSize, number> = { XS: 100, S: 300, M: 700, L: 1500 }
export const WARN_AT = 0.8
export const STATUSES: TicketStatus[] = ['In progress', 'In review', 'Ready to merge', 'Ready', 'Backlog', 'Done']
/** The board's groups: Ready to merge shows only while a ticket is in it, so a board without a merge queue looks as it did. */
export const groupsOf = (list: { status: TicketStatus }[]) => STATUSES.filter(status => status !== 'Ready to merge' || list.some(t => t.status === status))
export const SIZES: TicketSize[] = ['XS', 'S', 'M', 'L']
export const REVIEWS_KEY = 'reviews'
export const SKILLS_DIR = '.tick-it/skills'
/** Where review skills lived before 0.22.0: still read when .tick-it/skills is not there. */
export const OLD_SKILLS_DIR = '.tickit/skills'
/** Git's tree with nothing in it, to diff against in a repository with no commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** The most rounds Tick-it allows a size (set_repository_settings: reviewRounds, 1 to 10). */
export const MAX_ROUND_LIMIT = 10
/** The review rounds a ticket gets by size until Tick-it says otherwise (get_repository_settings: reviewRounds); one round past the limit follows. */
export const DEFAULT_ROUNDS: Record<TicketSize, number> = { XS: 2, S: 3, M: 5, L: 6 }
export const KEEP_REVIEWS = 500
export const OUTBOX_KEY = 'outbox'
export const DROPPED_KEY = 'dropped'
export const UNLINKED_KEY = 'unlinked'
export const KEEP_DROPPED = 100

export const COLOR = {
  accent: '#8FA8FF',
  ok: '#6CCB8F',
  warn: '#E9B35C',
  over: '#F07A65',
  dim: '#8B8D94',
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const USAGE = [
  '/tick-it board                      open the board pane',
  '/tick-it take <id>                  work on a ticket (its brief goes to Claude)',
  '/tick-it done                       move the current ticket to In review and steward it',
  '/tick-it steward [id]               run the review agents on a ticket again',
  '/tick-it reviews [id]               time, tokens and cost of the review agents',
  '/tick-it sync                       send waiting review runs to Tick-it (its MCP server)',
  '/tick-it drop                       put the current ticket back in Ready',
  '/tick-it add <size> <title>         add a ticket (size XS, S, M or L)',
  '/tick-it attach <id> <note> <file>  attach a file, such as a log or screenshot, to a note on a ticket',
  '/tick-it:plan-epic <what to build>  have Claude plan it as an epic of tickets, as a draft',
  "/tick-it:revise-plan <epic>         have Claude answer the plan's comments and make the changes",
  "/tick-it:retro <epic>               have Claude write the epic's retrospective",
  '/tick-it:import-github              have Claude import the open GitHub issues as tickets, once',
  '/tick-it:review-agents              have Claude set up review agents in .tick-it/skills from the samples',
  '/tick-it:upload-screenshots <id> <dir>  have Claude upload a ticket picture folder to Tick-it, not git',
].join('\n')

// ---- Reporting to Tick-it ------------------------------------------------------
// Tick-it is an MCP server. A cloud session's container, and the mod's store
// with it, is gone when the session ends, so each finished review run is sent
// to Tick-it's record_runs tool as it lands, over the session's own MCP
// connection: the mod holds no token, and the person signs in once (/mcp
// locally, or the Tick-it connector on claude.ai, which cloud sessions use).
// Runs wait in an outbox until Tick-it has answered for them, and are sent
// again on the next finished run, at session start and end, and on /tick-it sync.
//
// The tool answers for each run: accepted runs leave the outbox, rejected runs
// are dropped with Tick-it's reason (sent again they would be rejected again,
// and would hold the others back), and a run it does not mention stays. A call
// that fails as a whole (not signed in, server down) keeps every run waiting.
// Tick-it keys a run by its agentId, so sending one twice is harmless.

export const RECORD_TOOL = 'record_runs'

export const AGENTS_TOOL = 'report_review_agents'

/** API list prices in US dollars per million tokens: input, output, cache read, cache write (5 minutes). */
export const PRICES: [prefix: string, input: number, output: number, cacheRead: number, cacheWrite: number][] = [
  ['claude-fable-5-1', 10, 50, 0.25, 12.5],
  ['claude-opus-5-5', 4, 20, 0.2, 5],
  ['claude-sonnet-5-5', 2, 10, 0.2, 2.5],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01, 0.125],
]

/** Tick-it keeps up to this many characters of a finding, and this many findings of a run; the mod clips so a long one is not refused with its run. */
export const MAX_FINDING_TEXT = 2000

export const MAX_FINDINGS = 200

// ---- Tick-it, the server -----------------------------------------------------

/** This mod's version, sent with get_mod_config (the server requires it). Kept equal to `version` in .claude-plugin/plugin.json: checks/contract-fixtures.test.mjs fails when they differ. */
export const MOD_VERSION = '0.28.0'

/** The server's key in this mod's manifest (.claude-plugin/plugin.json). */
export const TICKIT_SERVER = 'tickit'

/**
 * The claude.ai Tick-it connector as a cloud session lists it: its tools are
 * mcp__Tick-It__*, so its server is `Tick-It` (a local session may list it as
 * `claude.ai Tick-It`, which `$.mcp.call` takes too). A cloud session cannot
 * reach the plugin's own server (the sandbox proxy answers mcp.tick-it.dev with
 * 403 and the mod holds no token), so the connector is the way in there.
 * `$.mcp.connect` only takes servers of this plugin's manifest, so connectors
 * are called directly.
 */
export const TICKIT_CONNECTORS = ['Tick-It', 'claude.ai Tick-It']

/** The media type of a file by its extension; a type not listed is application/octet-stream. */
export const FILE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  yml: 'application/yaml',
  yaml: 'application/yaml',
}

/** The most a call to Tick-it takes: its request is 4 MiB, so a file of 3 MB (3,000,000 bytes) is about 4.0 million base64 characters, with room left for the rest of the call. */
export const MAX_ATTACH_BYTES = 3_000_000

/** What update_ticket accepts of changedFiles: at most this many files, a path of at most this many characters. */
export const MAX_FILES = 5000

export const MAX_PATH = 500

export const MAX_FILE_LINES = 1_000_000
