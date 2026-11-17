import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { PullRequestView, ReviewRun, ReviewUsage, Steward, Ticket, TicketSize } from '../types'
import { SIZES, REVIEWS_KEY, SKILLS_DIR, OLD_SKILLS_DIR, BASES_DIR, KEEP_REVIEWS, MAX_FINDING_TEXT, PRICES } from './state'
import { callTickit, fetchInstructions, fetchModConfig, hasModLimits, repositoryHere, reviewBudgetOf, roundLimit } from './tickit'
import { setStatus, showStatus, refreshPullRequest, servedConfig } from './board'
import { report, changedContent, mergeBaseOfDefault } from './work'
import { queue, flush } from './outbox'
import { AREA_SKILL_DIR, AREA_NAMES, areaSkill, changesFor, parseChanges, touchedAreas, touchedLine, unknownChanges } from './security-areas'
import type { Changes, Touched } from './security-areas'
import { log } from './log'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
const reviews = atom({ plugin: 'tick-it', key: 'reviews' } as const, [])
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
const pullRequest = atom({ plugin: 'tick-it', key: 'pullRequest' } as const, null)
const pullRequestError = atom({ plugin: 'tick-it', key: 'pullRequestError' } as const, null)

// ---- Stewarding --------------------------------------------------------------
// When a ticket is built (/tick-it done), tick-it steers it to completion in the
// person's own Claude session: each review skill in the repository's
// .tick-it/skills/<name>/SKILL.md runs as a subagent of this session, their
// BLOCKING findings go back to the main session to fix, and the reviewers run
// again, until a round is clean or one round past the ticket's limit (roundLimit) has still blocked. Each reviewer's time
// and tokens come from its turn.complete; the cost is worked out from them.

/** A review skill found in the repository. */
export type ReviewSkill = {
  name: string
  description: string
  model?: string
  sizes?: TicketSize[]
  paths?: string[]
  /** The kinds of change that run it on a ticket of any size (front matter `changes`): security areas and the repository's own globs. */
  changes?: Changes
  /** The `changes` entries that name no area and are no glob. */
  unknownChanges?: string[]
  body: string
  /** The base review skill of the plugin it adds its rules to (front matter `base`). */
  base?: string
  /** That base's body, once found; left out when the plugin has no base of that name. */
  baseBody?: string
}

/** A base is named by its folder under BASES_DIR: lower-case letters, digits and hyphens only, so a name can never leave that folder. */
const BASE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** What the usage costs at API list prices, or undefined for a model with no price here. */
export const costOf = (model: string, u: ReviewUsage): number | undefined => {
  const price = PRICES.find(([prefix]) => model.startsWith(prefix))
  if (price === undefined) return undefined
  const [, input, output, cacheRead, cacheWrite] = price

  return (u.input * input + u.output * output + u.cacheRead * cacheRead + u.cacheWrite * cacheWrite) / 1_000_000
}

/** Reads a SKILL.md: its front matter (name, description, model, sizes, paths, changes) and its body. */
export const parseSkill = (folder: string, text: string): ReviewSkill => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const fields = new Map<string, string>()
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0)
      fields.set(
        line.slice(0, at).trim(),
        line
          .slice(at + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      )
  }
  const sizes = fields
    .get('sizes')
    ?.split(/[\s,]+/)
    .map(size => size.toUpperCase())
    .filter((size): size is TicketSize => (SIZES as string[]).includes(size))

  // Globs split on commas or spaces; none (or an empty value) leaves paths out: the skill applies to every path.
  const paths = fields
    .get('paths')
    ?.split(/[\s,]+/)
    .filter(glob => glob !== '')

  return {
    name: fields.get('name') || folder,
    description: fields.get('description') ?? '',
    model: fields.get('model') || undefined,
    sizes: sizes !== undefined && sizes.length > 0 ? sizes : undefined,
    paths: paths !== undefined && paths.length > 0 ? paths : undefined,
    ...(parseChanges(fields.get('changes')) === undefined ? {} : { changes: parseChanges(fields.get('changes')) }),
    ...(unknownChanges(fields.get('changes')).length === 0 ? {} : { unknownChanges: unknownChanges(fields.get('changes')) }),
    body: (match?.[2] ?? text).trim(),
    ...(fields.get('base') ? { base: fields.get('base') } : {}),
  }
}

/**
 * A repository's skill on its base: the base's body goes before the skill's own rules, and the description, model,
 * sizes and changes the skill leaves out are the base's. Its name and paths stay its own.
 */
export const withBase = (skill: ReviewSkill, base: ReviewSkill): ReviewSkill => ({
  ...skill,
  description: skill.description || base.description,
  model: skill.model ?? base.model,
  sizes: skill.sizes ?? base.sizes,
  ...((skill.changes ?? base.changes) === undefined ? {} : { changes: skill.changes ?? base.changes }),
  baseBody: base.body,
})

/** The skills whose base this version of the plugin does not have: they review by their own rules alone, and the round says so. */
export const missingBases = (skills: { folder: string; skill: ReviewSkill }[]): string[] =>
  skills.filter(({ skill }) => skill.base !== undefined && skill.baseBody === undefined).map(({ folder, skill }) => `${folder} (base ${JSON.stringify(skill.base)})`)

/** The BLOCKING and OPTIONAL lines of a reviewer's report. */
export const readFindings = (answer: string) => {
  const lines = answer.split('\n').map(line => line.trim().replace(/^[-*]\s*/, ''))
  return {
    blocking: lines.filter(line => /^BLOCKING:/i.test(line)),
    optional: lines.filter(line => /^OPTIONAL:/i.test(line)),
  }
}

/** A BLOCKING or OPTIONAL line as a finding: "BLOCKING: path/file.ts:12 what is wrong" gives its file and line; otherwise it is all text. */
export const parseFinding = (line: string): { severity: 'blocking' | 'optional'; file?: string; line?: number; text: string } => {
  const severity = /^BLOCKING:/i.test(line) ? 'blocking' : 'optional'
  const body = line.replace(/^(BLOCKING|OPTIONAL):\s*/i, '')
  // A file is a path with a slash or a :line, so a leading "Node.js" or "e.g." stays text.
  const at = /^`?((?:[\w@.-]+\/)+[\w@.-]+|[\w@.-]+\.\w+(?=:\d))(?::(\d+)(?:-\d+)?)?`?\s*(?:[-:—–]\s*)?(.*)$/.exec(body)
  const clip = (text: string) => text.slice(0, MAX_FINDING_TEXT)
  if (at === null || at[3] === '' || (at[1] ?? '').length > 500) return { severity, text: clip(body) }
  return { severity, file: at[1], ...(at[2] === undefined || !Number.isSafeInteger(Number(at[2])) || Number(at[2]) < 1 ? {} : { line: Number(at[2]) }), text: clip(at[3] ?? body) }
}

/** An earlier blocking finding as a reviewer is given it. */
export type Earlier = { id?: string; file?: string; line?: number; text: string }

/**
 * The blocking findings earlier rounds of one skill raised that are still open: each round's blocking findings, kept while a later round of the skill
 * verified it open, dropped when it said fixed or gone.
 */
export const earlierBlockers = (runs: ReviewRun[], ticket: string, skill: string, round: number): Earlier[] => {
  const key = (f: Earlier) => `${f.file ?? ''}\0${f.text}`
  // A finding a round verified open stays until a later round says fixed or gone, as Tick-it reads it; one only raised is dropped by a round that does not mention it.
  let open = new Map<string, { f: Earlier; verified: boolean }>()
  const done = runs.filter(r => r.ticket === ticket && r.skill === skill && r.round < round && r.status === 'done').sort((a, b) => a.round - b.round || a.startedAt - b.startedAt)
  for (const r of done) {
    const next = new Map<string, { f: Earlier; verified: boolean }>()
    for (const [k, v] of open) {
      const said = r.verdicts?.find(x => key(x) === k)
      if (said?.verdict === 'open') next.set(k, { f: v.f, verified: true })
      else if (said === undefined && v.verified) next.set(k, v)
    }
    for (const f of r.items ?? []) if (f.severity === 'blocking' && f.open !== true) next.set(key(f), { f: { ...(f.file === undefined ? {} : { file: f.file }), ...(f.line === undefined ? {} : { line: f.line }), text: f.text }, verified: false })
    open = next
  }
  return [...open.values()].map(v => v.f)
}

/** The ticket's open required findings Tick-it holds, per skill: raised by any session, so a fresh container sees them. Undefined when Tick-it cannot say. */
export async function tickitBlockers($: EngineInterface, ticket: string): Promise<Map<string, Earlier[]> | undefined> {
  const repository = await repositoryHere($)
  if (repository === undefined) return undefined
  const got = await callTickit($, 'get_ticket', { repository, key: ticket, include: ['findings'] }).catch(() => undefined)
  const list = got?.ok === true ? (got.value.ticket as { findings?: unknown } | undefined)?.findings : undefined
  if (!Array.isArray(list)) return undefined
  const bySkill = new Map<string, Earlier[]>()
  for (const f of list as { id?: unknown; skill?: unknown; file?: unknown; line?: unknown; text?: unknown; required?: unknown; fixed?: unknown }[]) {
    if (f.required !== true || f.fixed !== false || typeof f.id !== 'string' || typeof f.skill !== 'string' || typeof f.text !== 'string') continue
    const one: Earlier = { id: f.id, ...(typeof f.file === 'string' ? { file: f.file } : {}), ...(typeof f.line === 'number' ? { line: f.line } : {}), text: f.text.slice(0, MAX_FINDING_TEXT) }
    bySkill.set(f.skill, [...(bySkill.get(f.skill) ?? []), one])
  }
  return bySkill
}

/** The local earlier blockers plus Tick-it's open ones for the skill: one the local state already has (same file and text) is not given twice, and takes the Tick-it id so its verdict closes it. */
export const withTickit = (local: Earlier[], remote: Earlier[] = []): Earlier[] => {
  const same = (a: Earlier, b: Earlier) => (a.file ?? '') === (b.file ?? '') && a.text === b.text
  const merged = local.map(l => ({ ...l, ...(remote.find(r => same(l, r))?.id === undefined ? {} : { id: remote.find(r => same(l, r))?.id }) }))
  // Two Tick-it findings alike in file and text are given once.
  const fresh = remote.filter(r => !local.some(l => same(l, r))).filter((r, i, all) => all.findIndex(o => same(o, r)) === i)
  return [...merged, ...fresh]
}

/** The FINDING lines of a reviewer's report ("FINDING: 2 fixed the loop now stops"), as verdicts on the numbered earlier findings it was given. */
export const readVerdicts = (answer: string, earlier: Earlier[]): NonNullable<ReviewRun['verdicts']> => {
  const given = new Set<number>()
  return answer.split('\n').flatMap(line => {
    const m = /^FINDING:\s*(\d+)\s+(fixed|open|gone)\b[\s:–—-]*(.*)$/i.exec(line.trim().replace(/^[-*]\s*/, ''))
    const f = m === null ? undefined : earlier[Number(m[1]) - 1]
    // The first verdict on a finding stands; a repeat is not counted twice.
    if (m !== null && f !== undefined) {
      if (given.has(Number(m[1]))) return []
      given.add(Number(m[1]))
    }
    return m === null || f === undefined ? [] : [{ ...(f.id === undefined ? {} : { finding: f.id }), ...(f.file === undefined ? {} : { file: f.file }), text: f.text, verdict: m[2]!.toLowerCase() as 'fixed' | 'open' | 'gone', reason: (m[3] ?? '').trim().slice(0, 500) || m[2]!.toLowerCase() }]
  })
}

/** The earlier blockers a reviewer verified still open, as BLOCKING lines: they go to the fix and keep the round from reading clean. */
export const openVerdictLines = (verdicts: NonNullable<ReviewRun['verdicts']>): string[] => verdicts.filter(v => v.verdict === 'open').map(v => `BLOCKING: ${v.file === undefined ? '' : `${v.file} `}${v.text} (still open: ${v.reason})`)

export async function findSkills($: EngineInterface): Promise<{ folder: string; skill: ReviewSkill }[]> {
  // At the top of the repository, wherever in it the session was started.
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  const root = top.exitCode === 0 && top.stdout.trim() !== '' ? `${top.stdout.trim()}/` : ''
  let dir = `${root}${SKILLS_DIR}`
  if (!(await $.fs.exists(dir))) {
    dir = `${root}${OLD_SKILLS_DIR}`
    if (!(await $.fs.exists(dir))) return []
  }
  const found: { folder: string; skill: ReviewSkill }[] = []
  for (const entry of await $.fs.list(dir)) {
    // A folder, or a link to one.
    if (entry.kind === 'file') continue
    const path = `${dir}/${entry.name}/SKILL.md`
    if (!(await $.fs.exists(path))) continue
    const text = await $.fs.read(path)
    if (typeof text !== 'string') continue
    const skill = parseSkill(entry.name, text)
    found.push({ folder: entry.name, skill: await readBase($, skill) })
  }

  return found.sort((a, b) => a.folder.localeCompare(b.folder))
}

/** The skill with its base read from the plugin's own folder; unchanged when it names none, or one the plugin does not have. */
async function readBase($: EngineInterface, skill: ReviewSkill): Promise<ReviewSkill> {
  if (skill.base === undefined || !BASE_NAME.test(skill.base)) return skill
  const path = `${$.plugin.root}/${BASES_DIR}/${skill.base}/SKILL.md`
  if (!(await $.fs.exists(path))) return skill
  const text = await $.fs.read(path)

  return typeof text === 'string' && text.trim() !== '' ? withBase(skill, parseSkill(skill.base, text)) : skill
}

/** An area's practices, from the plugin's own secure-coding skill for it; undefined when this version of the plugin has none. */
async function readPractices($: EngineInterface, area: string): Promise<string | undefined> {
  if (!AREA_NAMES.includes(area)) return undefined
  const path = `${$.plugin.root}/${AREA_SKILL_DIR(area)}/SKILL.md`
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  const body = typeof text === 'string' ? parseSkill(area, text).body : ''
  return body === '' ? undefined : body
}

/** What the reviewer follows: the skill's own body, or its base and then the repository's rules on top. */
export const skillLines = (skill: ReviewSkill): string[] =>
  skill.baseBody === undefined
    ? [`Follow this review skill (${SKILLS_DIR}/${skill.name}):`, skill.body]
    : [
        `Follow this review skill (${SKILLS_DIR}/${skill.name}). It adds this repository's rules to tick-it's "${skill.base}" base. The base:`,
        skill.baseBody,
        '',
        "This repository's own rules. They add to the base, and where the two differ these are the ones to follow:",
        skill.body === '' ? '(none)' : skill.body,
      ]

/** What a reviewer whose skill lists `changes` is told of this change: what it touches, the practices of each area touched, and whether that alone is why it runs. */
export type ChangeReview = { touched: Touched[]; practices: { area: string; body: string }[]; bySize: boolean }

/** The lines that point a reviewer at what the change touches, with the secure-coding practices its author was to follow there. */
export const changeLines = (t: Ticket, skill: ReviewSkill, review: ChangeReview | undefined): string[] =>
  review === undefined || review.touched.length === 0
    ? []
    : [
        `What this change touches, read from its changed paths and lines (a first reading: check it against the diff): ${touchedLine(review.touched)}.`,
        ...(review.bySize ? [] : [`${t.id} is size ${t.size}, outside this skill's sizes (${(skill.sizes ?? []).join(', ')}): you run because of what the change touches, so review those parts of it.`]),
        'Review each of those first, by what it is: a change to sign-in is judged as a change to sign-in, a migration as a migration.',
        ...(review.practices.length === 0
          ? []
          : [
              'The practices the author was to follow in each area are below. A "Must" the change breaks is BLOCKING, with the rule named; a "Should" it passes over is OPTIONAL. Judge only what the change adds or alters, and leave out a rule the change does not reach.',
              ...review.practices.flatMap(p => ['', `### ${p.area} (${areaSkill(p.area)})`, p.body]),
            ]),
        '',
      ]

export const reviewPrompt = (t: Ticket, skill: ReviewSkill, round: number, earlier: Earlier[] = [], head?: string, change?: ChangeReview): string =>
  [
    `You are the "${skill.name}" reviewer for ticket ${t.id}: ${t.title} (epic: ${t.epic}), review round ${round}.`,
    'Acceptance:',
    ...t.acceptance.map(a => `- ${a}`),
    `Review the change in the working tree against HEAD (git diff HEAD and the untracked files). Do not change any file.`,
    '',
    ...skillLines(skill),
    '',
    ...changeLines(t, skill, change),
    ...(earlier.length === 0
      ? []
      : [
          `Earlier rounds raised these blocking findings, still open${head === undefined ? '' : ` as of HEAD ${head}`}:`,
          ...earlier.map((f, i) => `${i + 1}. ${f.file === undefined ? '' : `${f.file}${f.line === undefined ? '' : `:${f.line}`} `}${f.text}`),
          'Check each against the current head. Report a line for each, "FINDING: <number> fixed", "FINDING: <number> open" or "FINDING: <number> gone" (no longer applies), then a one-line reason. A finding that is still open is not reported again as BLOCKING. Then look for new issues as usual.',
          '',
        ]),
    'Report each finding on its own line, starting "BLOCKING:" or "OPTIONAL:", then file:line and what is wrong.',
    'End with "VERDICT: clean" when nothing is blocking, else "VERDICT: changes".',
  ].join('\n')

export async function saveReviews($: EngineInterface, fn: (list: ReviewRun[]) => ReviewRun[]) {
  const list = fn(await read($, reviews)).slice(-KEEP_REVIEWS)
  await update($, reviews, () => list)
  await $.store.set(REVIEWS_KEY, list)
}

/** The steward as a person's action leaves it: what marks a stop the mod made, or the review of a fix after it, belongs to that stop only. */
export const withoutStopMarks = (s: Steward): Steward => {
  const { stoppedBy: _by, afterStop: _after, ...rest } = s
  return rest
}

export async function setSteward($: EngineInterface, next: Steward | null) {
  await update($, steward, () => next)
  await showStatus($)
  if (next !== null && (await read($, startedSession))?.ticket === next.ticket) {
    const said = next.note ?? (next.phase === 'reviewing' ? `Review round ${next.round}.` : next.phase === 'fixing' ? `Fixing round ${next.round}'s findings.` : undefined)
    await report($, next.phase, said, true)
  }
}

const BACKSLASH = String.fromCharCode(92)
const PLAIN = 'abcdefghijklmnopqrstuvwxyz0123456789_-/'

/** A path glob as a regular expression, read as Tick-it reads it (globPattern in its areas.ts): a glob matches at any depth unless it starts with a slash, which reads it from the top of the repository; a double star and slash crosses folders, a double star with no slash after it matches anything, and a single star or a question mark stays in one folder. */
export const globMatches = (glob: string, path: string): boolean => {
  const anchored = glob.startsWith('/')
  const body = anchored ? glob.slice(1) : glob
  let source = ''
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i)
    if (c === '*') {
      if (body[i + 1] === '*') {
        i++
        if (body[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (c === '?') source += '[^/]'
    else source += PLAIN.includes(c.toLowerCase()) ? c : BACKSLASH + c
  }
  return new RegExp('^' + (anchored ? '' : '(?:.*/)?') + source + '$').test(path)
}

/** The files the branch changed against its merge base with the remote's default branch (the working tree, untracked files included), or null when they cannot be listed. */
export async function changedSinceBase($: EngineInterface): Promise<string[] | null> {
  const sha = await mergeBaseOfDefault($)
  if (sha === null) return null
  const diff = await $.process.run(['git', 'diff', '--name-only', '--no-renames', '-z', sha]).catch(() => undefined)
  if (diff === undefined || diff.exitCode !== 0 || diff.isStdoutTruncated) return null
  // --full-name gives root-relative paths, as git diff does, and the :/ pathspec lists the whole repository, not only the session folder, so a folder below the root matches the same globs.
  // The working tree against the merge base, as the reviewers and the size budget see the change: uncommitted edits and untracked files count too.
  const others = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/']).catch(() => undefined)
  // An untracked listing that failed or was cut short is a listing that cannot be had in full.
  if (others === undefined || others.exitCode !== 0 || others.isStdoutTruncated) return null
  return [...diff.stdout.split('\0'), ...others.stdout.split('\0')].filter(f => f !== '')
}

/** What began a round, as the log says it: the done command, the steward command, Claude's own move to In review, or the fix turn ending. */
export type RoundTrigger = 'done-command' | 'steward-command' | 'moved-by-claude' | 'after-fix' | 'after-stop'

/** The files changed since a commit (the working tree against it, untracked files included), or null when they cannot be listed. */
export async function changedSince($: EngineInterface, sha: string): Promise<string[] | null> {
  const diff = await $.process.run(['git', 'diff', '--name-only', '--no-renames', '-z', sha]).catch(() => undefined)
  if (diff === undefined || diff.exitCode !== 0 || diff.isStdoutTruncated) return null
  const others = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/']).catch(() => undefined)
  if (others === undefined || others.exitCode !== 0 || others.isStdoutTruncated) return null
  return [...diff.stdout.split('\0'), ...others.stdout.split('\0')].filter(f => f !== '')
}

/** Starts one review round: every skill that applies to the ticket's size and whose paths match a changed file, each as a subagent (from round 2, only those with work left). */
export async function startRound($: EngineInterface, t: Ticket, fromRound: number, ticking?: boolean, trigger: RoundTrigger = 'done-command'): Promise<string> {
  // The ticket may not have been taken in this session: the repository's settings are read afresh as its rounds begin, before the stop check below.
  if (fromRound === 1) {
    await fetchInstructions($).catch(() => undefined)
    // Its own rounds and budget, from get_mod_config, when taking the ticket here did not already read them.
    if (!(await hasModLimits($, t.id))) await fetchModConfig($, t.id).catch(() => undefined)
  }
  const before = (await read($, steward))?.phase
  const all = await findSkills($)
  // The stop button pressed while the skills were read: that round does not start.
  if (before !== 'stopped' && (await read($, steward))?.phase === 'stopped') {
    // No turn is running either, so r has to carry the next round in with a prompt of its own.
    await update($, steward, v => (v === null ? v : { ...v, fixing: false }))
    await log($, 'debug', 'round-not-started', { ticket: t.id, round: fromRound, why: 'stopped' })
    return `Stopped; round ${fromRound} of ${t.id} did not start.`
  }
  // The first round of a session (not the review of a fix) continues from the rounds Tick-it has recorded for the ticket, whichever session ran them. Unreadable, it is round 1 as before.
  const first = fromRound === 1 && trigger !== 'after-fix'
  // The turn that ticks the acceptance checks of a round settled without reviewers ends in this start too: the head it finds is as reviewed as before.
  const afterTicking = trigger === 'after-fix' && ticking === true
  const recorded = first || afterTicking ? await recordedReviews($, t.id) : undefined
  // Runs this session has not yet got to Tick-it (the outbox holds them) are not in the timeline: never go back to a round number the session already used.
  const ranHere = (await read($, reviews)).filter(r => r.ticket === t.id).reduce((most, r) => Math.max(most, r.round), 0)
  const carried = Math.max(recorded === undefined ? 0 : lastRecordedRound(recorded), ranHere)
  const round = first ? carried + 1 : fromRound
  const limit = await roundLimit($, t.size, t.id)
  // The fix that followed a round blocked by the pull request alone, with no budget for a reviewer round: no review agent starts, the pull request is read again and settles the round.
  if (trigger === 'after-fix' && (await read($, steward))?.pullRequestOnly === true && (await budgetStop($, t.id, await reviewedRounds($, t.id))) !== undefined) {
    // The stop button pressed while the spend was read: that round does not start.
    if ((await read($, steward))?.phase === 'stopped') {
      await update($, steward, v => (v === null ? v : { ...v, fixing: false }))
      await log($, 'debug', 'round-not-started', { ticket: t.id, round, why: 'stopped' })
      return `Stopped; round ${round} of ${t.id} did not start.`
    }
    // pullRequestOnly stays on the steward through every stop and tick turn of this round: a later round (r) is read the same way while the budget has no room.
    const next: Steward = { ticket: t.id, round, phase: 'reviewing', maxRounds: Math.max(limit, round), pullRequestOnly: true, ...(ticking === true ? { ticking } : {}) }
    await setSteward($, next)
    await log($, 'debug', 'round-started', { ticket: t.id, round, why: trigger, readOnly: true })
    await settleRound($, next, true)
    return `Round ${round}: no reviewer started for ${t.id} (the review budget has no room); the pull request is read again.`
  }
  const earlierRuns = await read($, reviews)
  // The ticket's open required findings in Tick-it, from any session: a fresh container has no local state for them.
  const remote = (await tickitBlockers($, t.id)) ?? new Map<string, Earlier[]>()
  // A Tick-it finding this session's newest verdict on it closed (fixed or gone) may still be waiting in the outbox, so Tick-it lists it open: it is not asked about again.
  const closedHere = new Set<string>()
  for (const r of [...earlierRuns].filter(r => r.ticket === t.id).sort((a, b) => a.round - b.round || a.startedAt - b.startedAt))
    for (const v of r.verdicts ?? []) if (v.finding !== undefined) (v.verdict === 'open' ? closedHere.delete(v.finding) : closedHere.add(v.finding))
  const blockersOf = (folder: string) => withTickit(earlierBlockers(earlierRuns, t.id, folder, round), (remote.get(folder) ?? []).filter(f => f.id === undefined || !closedHere.has(f.id)))
  const bySize = (skill: ReviewSkill) => skill.sizes === undefined || skill.sizes.includes(t.size)
  const sized = all.filter(({ skill }) => bySize(skill))
  // A reviewer of the size runs only when a changed file matches its paths; when the files cannot be listed, every reviewer of the size runs.
  const changedPaths = sized.some(({ skill }) => skill.paths !== undefined) ? await changedSinceBase($).catch(() => null) : null
  const pathsMatch = (skill: ReviewSkill) => skill.paths === undefined || changedPaths === null || changedPaths.some(f => (skill.paths ?? []).some(g => globMatches(g, f)))
  // A skill also runs, when it lists `changes`, for what the change touches whatever the size. The change is read only when a skill asks.
  const listing = all.some(({ skill }) => skill.changes !== undefined)
  const changed = listing ? await changedContent($) : []
  const touched = touchedAreas(changed)
  const paths = changed.map(f => f.path)
  // Once a skill has reviewed the ticket it stays eligible for every later round: a fix that takes the change out of an area still has that round's findings to answer. From round 2 `forwarded` below then carries a clean one forward unless it has an open blocker or a changed file matches its paths (`changes` areas do not count as work left).
  const ranBefore = (folder: string) => earlierRuns.some(r => r.ticket === t.id && r.skill === folder && r.round < round)
  // A skill with blocking findings still open from an earlier round also runs, whatever its paths: a fix that takes the change out of its paths still has those findings to answer.
  const eligible = all.filter(({ folder, skill }) => (bySize(skill) && pathsMatch(skill)) || changesFor(skill.changes, touched, paths).length > 0 || (skill.changes !== undefined && ranBefore(folder)) || blockersOf(folder).length > 0)
  // From round 2 a reviewer runs only with work left: a blocking finding still open, or a changed file since the previous round that matches its paths (any file, for a reviewer with no paths).
  // One that reviewed the ticket clean and finds none carries its clean verdict forward. A round 1 (a fresh steward run) runs every applicable reviewer; files that cannot be listed run them all too.
  // Skipped (carried-forward) runs have no head, so after a round that started no reviewer this is an older head: the window is wider, so reviewers run at most more often, never less.
  const previous = first ? undefined : earlierRuns.filter(r => r.ticket === t.id && r.round < round && r.headSha !== undefined).sort((a, b) => a.round - b.round || a.startedAt - b.startedAt).at(-1)
  const since = previous?.headSha === undefined || eligible.length === 0 ? null : await changedSince($, previous.headSha).catch(() => null)
  // Carry forward only from a skill whose newest real run finished (a failed or stopped one reviewed nothing); its open blockers are checked apart, through earlierBlockers.
  const reviewedBefore = (folder: string) => {
    const last = earlierRuns.filter(r => r.ticket === t.id && r.skill === folder && r.round < round && r.notApplicable === undefined).sort((a, b) => a.round - b.round || a.startedAt - b.startedAt).at(-1)
    // A finding the run counted but left no open item for (a bare BLOCKING: line) is no clean verdict either.
    return last?.status === 'done' && (last.blocking ?? 0) === 0
  }
  const forwarded = eligible.filter(({ folder, skill }) => since !== null && reviewedBefore(folder) && blockersOf(folder).length === 0 && !since.some(f => skill.paths === undefined || skill.paths.some(g => globMatches(g, f))))
  const skills = eligible.filter(f => !forwarded.includes(f))
  const skipped = all.filter(f => !skills.includes(f) && (sized.includes(f) || forwarded.includes(f)))
  if (skipped.length > 0) {
    // Recorded on the round as not applicable, with the reason; they hold nothing up.
    const session = await $.session.id()
    const now = await $.clock.now()
    const runs: ReviewRun[] = skipped.map(({ folder, skill }) => ({
      agentId: `${session}-${t.id}-${folder}-r${round}`,
      ticket: t.id,
      epic: t.epic,
      round,
      skill: folder,
      model: skill.model ?? 'none',
      startedAt: now,
      status: 'done',
      durationMs: 0,
      notApplicable: (forwarded.some(c => c.folder === folder) ? `Clean before and no changed file since the previous round matches its paths (${(skill.paths ?? []).join(', ') || 'every file'}): its clean verdict carries forward.` : `No changed file matches its paths (${(skill.paths ?? []).join(', ')}).`).slice(0, 300),
    }))
    await queue($, runs)
    await flush($).catch(() => undefined)
  }
  // Every reviewer carried a clean verdict forward and none has work left: the round settles from the pull request and the acceptance ticks, as when a head was already reviewed.
  if (skills.length === 0 && forwarded.length > 0) {
    const steward: Steward = { ticket: t.id, round, phase: 'reviewing', maxRounds: Math.max(limit, round), ...(ticking === true ? { ticking } : {}), ...(trigger === 'after-stop' ? { afterStop: true } : {}) }
    await setSteward($, steward)
    await log($, 'debug', 'round-not-started', { ticket: t.id, round, why: 'carried-forward' })
    // Settled as any round whose reviewers found nothing: the pull request and the acceptance ticks decide (a failing pull request asks for a fix). Not the budget stop, which is for a round with no room for a reviewer.
    await settleRound($, steward)
    return `Round ${round}: no reviewer has work left on ${t.id} (${forwarded.map(c => c.folder).join(', ')} carry their clean verdicts forward); settling from the pull request and the acceptance checks.`
  }
  if (skills.length === 0) {
    await log($, 'debug', 'round-not-started', { ticket: t.id, round, why: all.length === 0 ? 'no-skills' : sized.length === 0 ? 'no-skill-for-size' : 'no-skill-for-paths' })
    const untouched = listing ? ', and its change touches nothing that runs one whatever the size' : ''
    const none = all.length === 0 ? `No review skills in ${SKILLS_DIR}.` : sized.length === 0 ? `None of the review skills in ${SKILLS_DIR} (${all.map(f => f.folder).join(', ')}) review a ticket of size ${t.size}${untouched}.` : `No changed file matches the paths of the review skills for size ${t.size} (${sized.map(f => f.folder).join(', ')})${untouched}.`
    await setSteward($, { ticket: t.id, round, phase: 'done', maxRounds: limit, note: none })
    const why = await setStatus($, t.id, 'Done', sized.length === 0 ? 'Done without review: no review skill applies to this ticket.' : 'Done without review: no changed file matches the paths of any review skill that applies to this ticket.')
    if (why !== undefined) return `${none} Tick-it did not take ${t.id} to Done: ${why}.`
    return `${none} ${t.id} is Done without review.${all.length === 0 ? ' /tick-it:review-agents sets some up.' : ''}`
  }
  const head = (await $.process.run(['git', 'rev-parse', 'HEAD'])).stdout.trim() || undefined
  // Every applicable skill already reviewed this head with nothing blocking: no reviewer starts, and the round settles from the pull request and the acceptance ticks alone.
  // A command cannot submit a prompt, and a settle that finds a check unticked or the pull request failing submits one: from a command the round settles here only when it ends clean, and is reviewed as before otherwise.
  const fromCommand = trigger === 'done-command' || trigger === 'steward-command'
  // Reviewers read the working tree against HEAD: edits made since a review at this head (uncommitted or untracked) have not been reviewed, so the head alone does not say it was.
  const cleanTree = async () => {
    const status = await $.process.run(['git', 'status', '--porcelain'])
    return status.exitCode === 0 && status.stdout.trim() === ''
  }
  const settlesClean = async () => {
    if (!fromCommand) return true
    const unticked = await untickedAcceptance($, t.id)
    if (unticked === null || unticked.length > 0) return false
    await refreshPullRequest($, t.id).catch(() => update($, pullRequestError, () => 'could not read the pull request'))
    return (await read($, pullRequestError)) === null && pullRequestFindings(await read($, pullRequest)).length === 0
  }
  if (recorded !== undefined && head !== undefined && recorded.length > 0 && skills.every(({ folder }) => reviewedClean(recorded, folder, head) && blockersOf(folder).length === 0) && (await cleanTree()) && (await settlesClean())) {
    const last = first ? carried : fromRound - 1
    const steward: Steward = { ticket: t.id, round: last, phase: 'reviewing', maxRounds: Math.max(limit, last), ...(ticking === true ? { ticking } : {}) }
    await setSteward($, steward)
    await log($, 'debug', 'round-not-started', { ticket: t.id, round: last, why: 'head-already-reviewed' })
    await settleRound($, steward)
    return `${t.id}: round ${last} already reviewed this head with nothing blocking, so no reviewer starts; settling from the pull request and the acceptance checks.`
  }
  await setSteward($, { ticket: t.id, round, phase: 'reviewing', maxRounds: Math.max(limit, round), ...(ticking === true ? { ticking } : {}), ...(trigger === 'after-stop' ? { afterStop: true } : {}) })
  const started: ReviewRun[] = []
  const refused: string[] = []
  // A reviewer that applies but could not be started is part of the round: a failed run, with the refusal as its reason.
  const failedRuns: ReviewRun[] = []
  const practices = new Map<string, string>()
  for (const { area } of touched) {
    const body = await readPractices($, area)
    if (body !== undefined) practices.set(area, body)
  }
  const forChanges: string[] = []
  for (const { folder, skill } of skills) {
    const earlier = blockersOf(folder)
    const mine = changesFor(skill.changes, touched, paths)
    const change: ChangeReview | undefined = skill.changes === undefined ? undefined : { touched: mine, practices: mine.flatMap(m => (practices.has(m.area) ? [{ area: m.area, body: practices.get(m.area) ?? '' }] : [])), bySize: bySize(skill) }
    if (!bySize(skill) && mine.length > 0) forChanges.push(`${folder} runs for what the change touches: ${mine.map(m => m.area).join(', ')}.`)
    const startedAt = await $.clock.now()
    const description = `tick-it review: ${skill.name} on ${t.id}, round ${round}`
    const spawn = async (model: string | undefined) => {
      try {
        return await $.agent.spawn({ prompt: reviewPrompt(t, skill, round, earlier, head, change), description, subagentType: 'general-purpose', ...(model === undefined ? {} : { model }) })
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    }
    let spawned = await spawn(skill.model)
    // A model this session cannot run: the session's own model reviews instead.
    if (spawned.deny !== undefined && skill.model !== undefined) spawned = await spawn(undefined)
    if (spawned.deny !== undefined) {
      refused.push(`${folder}: ${spawned.deny}`)
      failedRuns.push({ agentId: `${await $.session.id()}-${t.id}-${folder}-r${round}-refused`, ticket: t.id, epic: t.epic, round, skill: folder, model: skill.model ?? 'none', startedAt, status: 'failed', durationMs: 0, reason: spawned.deny.slice(0, 300), ...(head === undefined ? {} : { headSha: head }) })
      continue
    }
    // Core answers the id; where a hook answered the spawn without it, the agent list still names the run.
    const agentId = spawned.agentId ?? (await $.agent.list()).find(a => a.description === description)?.id
    if (agentId === undefined) {
      const reason = 'started, but Claude Code did not say which agent it is'
      refused.push(`${folder}: ${reason}`)
      failedRuns.push({ agentId: `${await $.session.id()}-${t.id}-${folder}-r${round}-refused`, ticket: t.id, epic: t.epic, round, skill: folder, model: spawned.model, startedAt, status: 'failed', durationMs: 0, reason, ...(head === undefined ? {} : { headSha: head }) })
      continue
    }
    started.push({
      agentId,
      ticket: t.id,
      epic: t.epic,
      round,
      skill: folder,
      model: spawned.model,
      startedAt,
      status: 'running',
      ...(head === undefined ? {} : { headSha: head }),
      ...(earlier.length === 0 ? {} : { earlier }),
    })
  }
  await saveReviews($, list => [...list, ...started, ...(started.length === 0 ? [] : failedRuns)])
  // Tick-it hears of the refused reviewer as a failed run, with no usage.
  if (started.length > 0 && failedRuns.length > 0) {
    await queue($, failedRuns)
    await flush($).catch(() => undefined)
  }
  if (started.length === 0) {
    await log($, 'warn', 'round-not-started', { ticket: t.id, round, why: 'spawn-refused' })
    const why = `No reviewer could be started: ${refused.join('; ')}`.slice(0, 450)
    await setSteward($, { ticket: t.id, round, phase: 'stopped', maxRounds: limit, note: why })
    return `${why} (${t.id})`
  }

  const noBase = missingBases(skills)
  const without = noBase.length === 0 ? '' : ` This version of tick-it has no such base, so ${noBase.join(', ')} ${noBase.length === 1 ? 'reviews' : 'review'} by the repository's own rules alone.`

  const ran = new Set(started.map(r => r.skill))
  const reasons = forChanges.filter(line => ran.has(line.slice(0, line.indexOf(' runs for'))))
  const odd = skills.flatMap(({ folder, skill }) => (skill.unknownChanges === undefined ? [] : [`${folder} lists ${skill.unknownChanges.join(', ')} in changes, which ${skill.unknownChanges.length === 1 ? 'is' : 'are'} no area (${AREA_NAMES.join(', ')}, all, none) and no glob.`]))

  await log($, 'debug', 'round-started', { ticket: t.id, round, why: trigger, skills: started.map(r => r.skill).join(','), ...(refused.length === 0 ? {} : { refused: failedRuns.map(r => r.skill).join(',') }), ...(touched.length === 0 ? {} : { touches: touched.map(x => x.area).join(',') }) })
  return `Round ${round}: ${started.map(r => r.skill).join(', ')} reviewing ${t.id} in this session.${refused.length === 0 ? '' : ` Could not be started, so the round is not clean: ${refused.join('; ')}.`}${[without.trim(), ...reasons, ...odd].filter(x => x !== '').map(x => ` ${x}`).join('')}`
}

/** The stewarding pane's r: the next round starts when the current turn ends, even after the rounds ran out or stewarding stopped. */
export async function reviewAgain($: EngineInterface): Promise<string> {
  const s = await read($, steward)
  if (s === null) return 'Nothing is being stewarded.'
  // Stopping does not end the reviewers already running: the next round waits for them.
  if (s.phase === 'reviewing' || (await read($, reviews)).some(r => r.ticket === s.ticket && r.status === 'running')) return `Round ${s.round} of ${s.ticket} is still being reviewed.`
  if (s.phase !== 'fixing') {
    // Stopped, or Done: the ticket goes back In review for another round.
    const why = await setStatus($, s.ticket, 'In review')
    if (why !== undefined) return `Could not move ${s.ticket} to In review: ${why}.`
  }
  const idle = s.phase !== 'fixing' && s.fixing !== true
  const note = `Round ${s.round + 1} starts when this turn ends.`
  await setSteward($, { ...withoutStopMarks(s), phase: 'fixing', ticking: false, maxRounds: Math.max(s.maxRounds, s.round + 1), note })
  // With no fix turn running, nothing would end: a turn of nothing to fix carries the next round in.
  if (idle) await $.prompt.submit({ text: `tick-it: ${s.ticket} is reviewed again. There is nothing to fix; stop, and round ${s.round + 1} starts when you finish.` })

  return `tick-it: ${note}`
}

/** The stewarding pane's s: no more rounds; the ticket stays In review. */
export async function stopStewarding($: EngineInterface): Promise<string> {
  const s = await read($, steward)
  if (s === null || s.phase === 'done' || s.phase === 'stopped') return 'Nothing is being stewarded.'
  const note = `Stopped after round ${s.round}; ${s.ticket} stays In review.`
  // Stopped in the middle of a fix turn: that turn is still running, so r has no turn to start.
  await setSteward($, { ...withoutStopMarks(s), phase: 'stopped', note, fixing: s.phase === 'fixing' })

  return `tick-it: ${note}`
}

/** The acceptance checks not ticked yet. Claude ticks the ones it has met, each with a note; the mod never ticks for it. Null when Tick-it cannot say. */
export async function untickedAcceptance($: EngineInterface, id: string): Promise<string[] | null> {
  const repository = await repositoryHere($)
  if (repository === undefined) return null
  const got = await callTickit($, 'get_ticket', { repository, key: id, include: [] })
  if (!got.ok) return null
  const items = (got.value.ticket as { acceptanceItems?: { text: string; checked: boolean; afterDeploy?: boolean }[] } | undefined)?.acceptanceItems ?? []
  // A criterion flagged after-deploy cannot be shown before the deploy, so it is not asked for.
  return items.filter(i => !i.checked && i.afterDeploy !== true).map(i => i.text)
}

/** Tick-it's reason a ticket is still held back (its reviewState.heldBack or queueHold, read once with get_ticket), as a token the log keeps; undefined when it is not held back or cannot be read. */
export async function heldBackReason($: EngineInterface, id: string): Promise<string | undefined> {
  const repository = await repositoryHere($)
  if (repository === undefined) return undefined
  const got = await callTickit($, 'get_ticket', { repository, key: id, include: [] }).catch(() => undefined)
  if (got === undefined || !got.ok) return undefined
  // Tick-it answers both as strings: reviewState.heldBack the reason a clean ticket is held back, queueHold the reason it waits out of the merge queue.
  const ticket = got.value.ticket as { reviewState?: { heldBack?: unknown }; queueHold?: unknown } | undefined
  const reason = [ticket?.reviewState?.heldBack, ticket?.queueHold].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return reason?.trim().replace(/[^A-Za-z0-9_.:#/,-]+/g, '-').slice(0, 100)
}

/**
 * What a pull request adds to a round's blocking findings, so a round is not clean while it is red or stale. The queue owns the branch of a queued
 * pull request: it is never told to update it, only to resolve a conflict (Tick-it sends that itself). Tick-it's own CI instruction for the
 * current head commit is followed, not repeated with a second fix. History is never rewritten: the base is merged in.
 */
export const pullRequestFindings = (pr: PullRequestView | null): string[] => {
  if (pr === null || pr.state !== 'open') return []
  const found: string[] = []
  if (pr.ci === 'failure') {
    found.push(
      pr.ciInstructed
        ? `[ci] CI is failing on pull request #${pr.number}, and Tick-it has already told this session about this commit: fix it from that instruction (do not start a second fix; the failing checks are in gh pr checks ${pr.number} if it has not reached you yet), push, and it is reviewed again.`
        : `[ci] CI is failing on pull request #${pr.number}: read the failing checks with gh (gh pr checks ${pr.number}, then gh run view <run> --log-failed), fix them within the ticket and push. Never skip, disable or loosen a test.`,
    )
  }
  if (!pr.queued && (pr.behind === true || pr.conflicting)) {
    found.push(`[base] Pull request #${pr.number} ${pr.conflicting ? 'has a merge conflict with' : 'is behind'} its base branch: merge the base into the branch (git merge, never rebase or force-push), resolve any conflict, run the repository's checks and push.`)
  }
  return found
}

/** Whether the repository merges a clean pull request itself (get_repository_settings: autoMerge); false when Tick-it cannot say. */
async function autoMergeOn($: EngineInterface, repository: string): Promise<boolean> {
  const got = await callTickit($, 'get_repository_settings', { repository }).catch(() => undefined)
  return got?.ok === true && got.value.autoMerge === true
}

/**
 * Whether the review budget stops the next round: the ticket's reviewSpend (get_ticket: costUsd, budget, remaining) says the budget is reached, or the
 * average cost of the rounds so far is more than what remains. Undefined, so the round limit alone decides, when the ticket has no budget (get_mod_config),
 * when Tick-it cannot be read, or when reviewSpend is null (costs cannot be seen) or names no budget.
 */
export async function budgetStop($: EngineInterface, ticket: string, rounds: number): Promise<{ budget: number; costUsd: number; reached: boolean } | undefined> {
  if ((await reviewBudgetOf($, ticket)) === null) return undefined
  const repository = await repositoryHere($)
  if (repository === undefined) return undefined
  const got = await callTickit($, 'get_ticket', { repository, key: ticket, include: [] }).catch(() => undefined)
  const spend = got?.ok === true ? (got.value.ticket as { reviewSpend?: { costUsd?: unknown; budget?: unknown; remaining?: unknown } | null } | undefined)?.reviewSpend : undefined
  if (spend === null || spend === undefined) return undefined
  const { costUsd, budget, remaining } = spend
  if (typeof costUsd !== 'number' || typeof budget !== 'number' || typeof remaining !== 'number') return undefined
  // The spend covers every session's rounds, so it is divided by the rounds recorded for the ticket, not by this session's count alone.
  const recorded = await recordedReviews($, ticket)
  const ran = recorded === undefined ? rounds : Math.max(rounds, recorded.length)
  // Spend must be under the budget; and a round costing the average of those so far must fit in what remains.
  if (remaining <= 0) return { budget, costUsd, reached: true }
  if (ran >= 1 && costUsd / ran > remaining) return { budget, costUsd, reached: false }
  return undefined
}

/** A review round Tick-it has recorded for a ticket, from its timeline: each agent's skill, blocking count and (when Tick-it names it) the head commit it reviewed. */
export type RecordedRound = { round: number; agents: { skill: string; blocking: number; headSha?: string }[] }

/** The review rounds Tick-it has recorded for the ticket across every session (get_ticket_timeline, review entries); undefined when they cannot be read. */
export async function recordedReviews($: EngineInterface, ticket: string): Promise<RecordedRound[] | undefined> {
  const repository = await repositoryHere($)
  if (repository === undefined) return undefined
  const got = await callTickit($, 'get_ticket_timeline', { repository, key: ticket, types: ['review'] }).catch(() => undefined)
  const entries = got?.ok === true ? got.value.timeline : undefined
  if (!Array.isArray(entries)) return undefined
  const rounds: RecordedRound[] = []
  for (const e of entries as { type?: unknown; round?: unknown; agents?: unknown }[]) {
    if (e.type !== 'review' || typeof e.round !== 'number' || !Array.isArray(e.agents)) continue
    const agents = (e.agents as { skill?: unknown; blocking?: unknown; headSha?: unknown }[]).flatMap(a =>
      typeof a.skill === 'string' && typeof a.blocking === 'number' ? [{ skill: a.skill, blocking: a.blocking, ...(typeof a.headSha === 'string' ? { headSha: a.headSha } : {}) }] : [],
    )
    rounds.push({ round: e.round, agents })
  }
  return rounds
}

/** How many review rounds Tick-it has recorded for the ticket: one timeline entry per round per session, and round numbers repeat across sessions, so entries are counted, not the highest number. */
export const lastRecordedRound = (rounds: RecordedRound[]): number => rounds.length

/** Whether the skill's newest recorded run (the last in the timeline, which is oldest first) saw this head commit with no blocking finding; a run recorded as not applicable counts when it names this head too. */
export const reviewedClean = (rounds: RecordedRound[], skill: string, head: string): boolean => {
  const newest = rounds.flatMap(r => r.agents.filter(a => a.skill === skill)).at(-1)
  return newest !== undefined && newest.blocking === 0 && newest.headSha === head
}

/** The rounds of a ticket that ran reviewers: a round settled on the pull request alone costs nothing, so it is not part of the average cost of a round. */
async function reviewedRounds($: EngineInterface, ticket: string): Promise<number> {
  const rounds = [...new Set((await read($, reviews)).filter(r => r.ticket === ticket).map(r => r.round))]
  // A session's first round continues from the rounds earlier sessions ran, and the spend covers them too: they are rounds of the average as well.
  const earlier = rounds.length === 0 ? 0 : Math.min(...rounds) - 1
  return rounds.length + earlier
}

/**
 * Once every reviewer of the round has answered: done, a fix round, one more round past the limit, or stop.
 * With `withoutReviewers` no reviewer ran for this round (the budget had no room for one after a fix of the pull request alone): the round is settled on the pull request, so it is clean or it stops, and it asks for no further fix.
 */
export async function settleRound($: EngineInterface, s: Steward, withoutReviewers = false) {
  const runs = (await read($, reviews)).filter(r => r.ticket === s.ticket && r.round === s.round)
  if (runs.some(r => r.status === 'running')) return
  const t = (await read($, tickets)).find(one => one.id === s.ticket)
  if (t === undefined) return
  // A reviewer that could not be started reviewed nothing: the round is not clean while its failed run stands.
  const reviewed = runs.flatMap(r => [...(r.reason === undefined ? [] : [`[${r.skill}] BLOCKING: reviewer could not be started: ${r.reason}`]), ...(r.findings ?? []).map(line => `[${r.skill}] ${line}`)])
  // Reviewers that found nothing do not make a round clean while the pull request is failing or behind: that is blocking too.
  // A refresh that throws is an unread pull request too, not a stranded round.
  if (reviewed.length === 0) await refreshPullRequest($, t.id).catch(() => update($, pullRequestError, () => 'could not read the pull request'))
  // A refresh that failed leaves the last reading in place: it is not trusted, so the round is not clean until Claude has looked with gh.
  const failed = reviewed.length === 0 && (await read($, pullRequestError)) !== null
  const pr = await read($, pullRequest)
  const blocking = reviewed.length > 0 ? reviewed : failed ? ['[pull-request] Tick-it could not read the pull request, so its CI and branch are unchecked: check them with gh (gh pr checks, gh pr view) and fix what fails.'] : pullRequestFindings(pr)
  // No reviewer looked at the fix, so the pull request alone must show it: open, CI passed, and the branch neither behind nor conflicting (a queued one is the queue's to update). CI that has not finished is waited for by a person, never read as clean.
  const confirmed = pr !== null && pr.state === 'open' && pr.ci === 'success' && !pr.conflicting && (pr.queued || pr.behind === false)
  const pending = withoutReviewers && blocking.length === 0 && !confirmed
  const spent = summarise(runs)
  // The stop button may be pressed while this waits on Tick-it or GitHub: stopped stays stopped.
  const stillReviewing = async () => (await read($, steward))?.phase === 'reviewing'
  if (pending) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-ci-pending' })
    const what = pr === null || pr.state !== 'open' ? 'no open pull request is found' : pr.ci === 'pending' ? `CI is still pending on pull request #${pr.number}` : `CI or the branch of pull request #${pr.number} is not confirmed (CI ${pr.ci ?? 'not reported'}, ${pr.behind === null ? 'behind unknown' : pr.behind ? 'behind its base' : 'up to date'})`
    const note = `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} after the fix, and the budget has no room for a reviewer round: not read as clean. r reads the pull request again.`
    await setSteward($, { ...s, phase: 'stopped', stoppedBy: 'mod', note })
    const repository = await repositoryHere($)
    if (repository !== undefined) await callTickit($, 'set_needs_human', { repository, key: t.id, kind: 'no-clean-round', note: note.slice(0, 200) }).catch(() => undefined)
    $.ui.toast(`tick-it: ${what} for ${t.id}, so it is not read as clean. Over to you.`)
    return
  }
  if (blocking.length === 0) {
    if (!(await stillReviewing())) return
    // Tick-it reads a round as clean only while every acceptance check is ticked (one flagged after-deploy is left out), and Claude ticks the ones it has met. The first time one is left, Claude gets a turn to tick it; one still unticked after that is one it could not meet (or the checks cannot be read), so a person is asked and the ticket stays In review.
    const unticked = await untickedAcceptance($, t.id)
    // The stop button may have been pressed while Tick-it was read.
    if (!(await stillReviewing())) return
    if (unticked === null || unticked.length > 0) {
      const many = (unticked?.length ?? 0) !== 1
      if (unticked !== null && s.ticking !== true) {
        await setSteward($, { ...s, phase: 'fixing', ticking: true, note: `Clean, but ${unticked.length} acceptance check${many ? 's are' : ' is'} not ticked: asking Claude to tick them.` })
        await $.prompt.submit({
          text: [`Round ${s.round} review of ${t.id} found nothing blocking, but ${unticked.length} acceptance check${many ? 's are' : ' is'} not ticked. Tick each one you have met with set_criterion_checked, each with a note on how it is met (add_criterion_note). Do not tick one that is not met: name it in your reply instead. Then stop; tick-it reviews again.`, ...unticked.map(text => `- ${text}`)].join('\n'),
        })
        return
      }
      const repository = await repositoryHere($)
      if (!(await stillReviewing())) return
      await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'clean-with-unticked-checks' })
      const note = (unticked === null ? 'The acceptance checks could not be read after a clean round, so they are not known to be ticked.' : `${unticked.length} acceptance check${many ? 's are' : ' is'} not ticked after a clean round: ${unticked[0]}`).slice(0, 200)
      // Done as far as the session goes (a stop would hold the pull request back for good): a person ticking the check completes the review.
      await setSteward($, { ...s, phase: 'done', note: `Clean after ${s.round} round${s.round === 1 ? '' : 's'}, but ${unticked === null ? 'the acceptance checks could not be read' : `${unticked.length} acceptance check${many ? 's are' : ' is'} not ticked`}.` })
      if (repository !== undefined) await callTickit($, 'set_needs_human', { repository, key: t.id, kind: 'no-clean-round', note }).catch(() => undefined)
      $.ui.toast(`tick-it: round ${s.round} reviews of ${t.id} were clean, but ${unticked === null ? 'its acceptance checks could not be read' : `${unticked.length} acceptance check${many ? 's are' : ' is'} not ticked`}, so it is not reviewed. Over to you.`)
      return
    }
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'clean' })
    const held = await heldBackReason($, t.id)
    if (held !== undefined) await log($, 'warn', 'held-back-after-clean', { ticket: t.id, round: s.round, reason: held })
    const why = await setStatus($, t.id, 'Done', 'Review rounds were clean.')
    // Stopped while Tick-it was answering: the ticket stays In review, as the stop said.
    if (!(await stillReviewing())) {
      if (why === undefined) await setStatus($, t.id, 'In review')
      return
    }
    // With its pull request still open, Tick-it keeps the ticket In review until GitHub says it merged.
    const open = why === undefined ? null : /pull request #(\d+) is still open/.exec(why)
    const waitsForMerge = open !== null
    // A clean round is the cue for people to review: take the pull request out of draft. Best effort, a no-op if it is not one.
    if (open !== null && (await stillReviewing())) await $.process.run(['gh', 'pr', 'ready', open[1] ?? '']).catch(() => undefined)
    const rounds = `${s.round} round${s.round === 1 ? '' : 's'}`
    // A clean round leaves nothing to fix, only the pull request for a person to review and merge: say so, replacing any earlier need.
    if (waitsForMerge) {
      const repository = await repositoryHere($)
      const pr = /pull request #(\d+)/.exec(why)?.[1]
      // With autoMerge on, Tick-it merges the clean pull request itself: a flag would send a person to one that needs nobody. Settings that cannot be read leave the flag.
      if (repository !== undefined && !(await autoMergeOn($, repository))) await callTickit($, 'set_needs_human', { repository, key: t.id, kind: 'review-pull-request', note: `Pull request #${pr} is clean after ${rounds} and needs your review.` }).catch(() => undefined)
    }
    if (!(await stillReviewing())) return
    await setSteward($, { ...s, phase: 'done', note: waitsForMerge ? `Clean after ${rounds}; Done when its pull request merges.` : `Clean after ${rounds}.` })
    $.ui.toast(why === undefined ? `tick-it: ${t.id} is Done. Round ${s.round} reviews were clean (${spent}).` : waitsForMerge ? `tick-it: round ${s.round} reviews of ${t.id} were clean (${spent}). ${why}` : `tick-it: round ${s.round} reviews of ${t.id} were clean (${spent}), but Tick-it did not take it to Done: ${why}. /tick-it steward ${t.id} to try again.`)
    return
  }
  const limit = await roundLimit($, t.size, t.id)
  // The review of a fix made after the mod stopped is the last: it asks for no further fix or round, whatever the limit or budget say.
  if (s.round > limit || s.afterStop === true) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-past-limit', blocking: blocking.length })
    await setSteward($, { ...s, phase: 'stopped', stoppedBy: 'mod', note: `${blocking.length} blocking after ${s.round} rounds.` })
    // Tell Tick-it a person is needed. Best effort, like a report: the toast below says the same.
    const repository = await repositoryHere($)
    if (repository !== undefined) await callTickit($, 'set_needs_human', { repository, key: t.id, kind: 'no-clean-round', note: `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} still open after ${s.round} rounds, no clean round.` }).catch(() => undefined)
    $.ui.toast(`tick-it: ${t.id} still has ${blocking.length} blocking findings after ${s.round} rounds. Over to you.`)
    return
  }
  if (!(await stillReviewing())) return
  // Another round (the review of a fix) starts only while spend is under the budget and the next round is not expected to overshoot what is left. A fix asked for here is always reviewed, so the check is made before asking for one.
  // Settled on the pull request alone: it still blocks after the fix, and no reviewer round can follow, so nothing more is asked for.
  if (withoutReviewers) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-pull-request-still-blocking', blocking: blocking.length })
    const note = `${failed ? 'The pull request could not be read after the fix' : 'The pull request still blocks after the fix'} (${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}) and the review budget has no room for another round, no clean round.`
    await setSteward($, { ...s, phase: 'stopped', stoppedBy: 'mod', note })
    const repository = await repositoryHere($)
    if (repository !== undefined) await callTickit($, 'set_needs_human', { repository, key: t.id, kind: 'no-clean-round', note: note.slice(0, 200) }).catch(() => undefined)
    $.ui.toast(`tick-it: ${t.id}'s pull request still has ${blocking.length} blocking findings after the fix and the review budget has no room for another round. Over to you.`)
    return
  }
  const over = await budgetStop($, t.id, Math.max(await reviewedRounds($, t.id), 1))
  // Reviewers found nothing, so what blocks is the pull request's own (CI, base): fixing it needs no reviewer spend to confirm, as the pull request can be read again. The budget does not stop the round; Claude is asked for the fix, and with no room for a reviewer round after it, the pull request alone settles the round.
  const pullRequestOnly = reviewed.length === 0
  if (over !== undefined && !pullRequestOnly) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-at-budget', blocking: blocking.length })
    const note = `Review budget $${over.budget} ${over.reached ? 'reached' : `would be overshot by round ${s.round + 1}`} (${usd.format(over.costUsd)} spent over ${s.round} round${s.round === 1 ? '' : 's'}), ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} still open, no clean round.`
    await setSteward($, { ...s, phase: 'stopped', stoppedBy: 'mod', note })
    const repository = await repositoryHere($)
    if (repository !== undefined) await callTickit($, 'set_needs_human', { repository, key: t.id, kind: 'no-clean-round', note: note.slice(0, 200) }).catch(() => undefined)
    $.ui.toast(`tick-it: ${t.id} still has ${blocking.length} blocking findings and the $${over.budget} review budget is ${over.reached ? 'used up' : 'too low for another round'}. Over to you.`)
    return
  }
  // The limit is hit with reviewers still blocking: one further round goes past it, and the timeline shows it as one.
  const pastLimit = s.round === limit
  await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: pastLimit ? 'fix-then-last-round' : 'fix', blocking: blocking.length })
  // The budget has no room for a reviewer round after this fix: the pull request is read again instead, and settles the round.
  const readOnly = over !== undefined && pullRequestOnly
  await setSteward($, { ...s, phase: 'fixing', ticking: false, ...(readOnly ? { pullRequestOnly: true } : {}), ...(pastLimit && !readOnly ? { maxRounds: s.round + 1, note: `Still blocking after ${s.round} rounds; round ${s.round + 1} goes past the limit.` } : {}) })
  const served = await servedConfig($)
  const afterFix = served !== null && served.ticket === t.id ? served.briefLines.afterFix : undefined
  await $.prompt.submit({
    text: [`Round ${s.round} review of ${t.id} found ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}. ` + (readOnly ? `Fix each one within the ticket, then stop. The review budget has no room for another reviewer round, so tick-it reads the pull request again when you finish: it is clean when CI passes and the branch is not behind its base.` : 'Fix each one within the ticket, then stop. tick-it reviews again when you finish.') + (pastLimit && !readOnly ? ` The next review, round ${s.round + 1}, is the last: ${limit} rounds are the limit and it goes past it.` : ''), ...blocking.map(line => `- ${line}`), ...(afterFix === undefined ? [] : [afterFix])].join('\n'),
  })
}

export const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const count = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export const tokensOf = (u: ReviewUsage | undefined) => (u === undefined ? 0 : u.input + u.output + u.cacheRead + u.cacheWrite)

/** "3m 04s · 182K tokens · $0.41" over the runs that finished. */
export const summarise = (runs: ReviewRun[]): string => {
  const ms = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0)
  const tokens = runs.reduce((sum, r) => sum + tokensOf(r.usage), 0)
  const priced = runs.filter(r => r.costUsd !== undefined)
  const cost = priced.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const unpriced = runs.some(r => r.status === 'done' && r.costUsd === undefined)
  return `${formatDuration(ms)} · ${count.format(tokens)} tokens · ${priced.length === 0 ? '—' : usd.format(cost)}${unpriced ? '+' : ''}`
}

export const reviewLine = (r: ReviewRun): string => (r.status === 'running' ? `  … ${r.skill.padEnd(18)} round ${r.round}  running` : `  ${r.status === 'failed' ? '✗' : (r.blocking ?? 0) > 0 ? '▲' : '✓'} ${r.skill.padEnd(18)} round ${r.round}  ` + `${r.blocking ?? 0} blocking, ${r.optional ?? 0} optional  ${summarise([r])}  ${r.model}${r.reason === undefined ? '' : `  could not be started: ${r.reason}`}`)

/** A finding as the pane shows it: "src/a.ts:12 what is wrong", or its text alone when it names no file. */
export const findingLine = (f: { file?: string; line?: number; text: string }): string => (f.file === undefined ? f.text : `${f.file}${f.line === undefined ? '' : `:${f.line}`} ${f.text}`)

/** One round's findings of one severity, tagged with the skill that found them. Read from the session's stored runs; the pane sends nothing. */
export const roundFindings = (runs: ReviewRun[], round: number, severity: 'blocking' | 'optional'): { skill: string; text: string }[] =>
  runs
    .filter(r => r.round === round)
    .flatMap(r => {
      const items = r.items?.filter(f => f.severity === severity)
      const lines = items !== undefined ? items.map(findingLine) : severity === 'blocking' ? (r.findings ?? []).map(l => l.replace(/^BLOCKING:\s*/i, '')) : []
      return lines.map(text => ({ skill: r.skill, text }))
    })

/**
 * The rows the stewarding pane draws for one round: its blocking findings, then its optional ones only when shown.
 * A run's counts are what record_runs carries; its listed findings can be fewer (empty lines, the cap), so a row says how many are not listed.
 */
export const findingRows = (runs: ReviewRun[], round: number, showOptional: boolean): { severity: 'blocking' | 'optional'; text: string; note?: true }[] => {
  const ofRound = runs.filter(r => r.round === round)
  const rows: { severity: 'blocking' | 'optional'; text: string; note?: true }[] = []
  for (const severity of showOptional ? (['blocking', 'optional'] as const) : (['blocking'] as const)) {
    const listed = roundFindings(ofRound, round, severity)
    for (const f of listed) rows.push({ severity, text: `${severity === 'blocking' ? '▲' : '·'} [${f.skill}] ${f.text}` })
    const counted = ofRound.reduce((n, r) => n + ((severity === 'blocking' ? r.blocking : r.optional) ?? 0), 0)
    if (counted > listed.length) rows.push({ severity, text: `  ${counted - listed.length} ${severity} not listed`, note: true })
  }
  return rows
}

/** The review report for one ticket, or every ticket reviewed. */
export async function reviewReport($: EngineInterface, id: string | undefined): Promise<string> {
  const all = await read($, reviews)
  const runs = id === undefined ? all : all.filter(r => r.ticket === id.toUpperCase())
  if (runs.length === 0) return id === undefined ? 'No reviews yet.' : `No reviews of ${id.toUpperCase()} yet.`
  const byTicket = new Map<string, ReviewRun[]>()
  for (const r of runs) byTicket.set(r.ticket, [...(byTicket.get(r.ticket) ?? []), r])
  const bySkill = new Map<string, ReviewRun[]>()
  for (const r of runs) bySkill.set(r.skill, [...(bySkill.get(r.skill) ?? []), r])
  const s = await read($, steward)

  return [
    ...[...byTicket].flatMap(([ticket, list]) => [`${ticket}  ${summarise(list)}${s?.ticket === ticket ? `  · ${s.phase}, round ${s.round}` : ''}`, ...list.map(reviewLine)]),
    '',
    'By reviewer',
    ...[...bySkill].map(([skill, list]) => `  ${skill.padEnd(18)} ${list.length} run${list.length === 1 ? '' : 's'}  ${summarise(list)}`),
    '',
    `All review agents  ${summarise(runs)}`,
    'Costs are what the tokens would cost at API list prices; on a Claude plan they count against its usage instead.',
  ].join('\n')
}
