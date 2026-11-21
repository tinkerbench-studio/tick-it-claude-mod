import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { PullRequestView, ReviewRun, ReviewUsage, Steward, Ticket, TicketSize, TickitRound } from '../types'
import { SIZES, REVIEWS_KEY, SKILLS_DIR, OLD_SKILLS_DIR, BASES_DIR, KEEP_REVIEWS, MAX_FINDING_TEXT, PRICES, WARN_AT } from './state'
import { callTickit, fetchInstructions, fetchModConfig, hasModLimits, madeHere, repositoryHere, reviewBudgetOf, roundLimit } from './tickit'
import { setStatus, showStatus, refreshPullRequest, servedConfig, RECHECK_LINES } from './board'
import { report, changedContent, mergeBaseOfDefault, defaultBase } from './work'
import type { StopReport } from './work'
import { queue, flush, plural } from './outbox'
import { AREA_SKILL_DIR, AREA_NAMES, areaSkill, changesFor, parseChanges, touchedAreas, touchedLine, unknownChanges } from './security-areas'
import type { Changes, Touched } from './security-areas'
import { log } from './log'
import { saveResume } from './resume'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
const reviews = atom({ plugin: 'tick-it', key: 'reviews' } as const, [])
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
/** The ticket's spend as budgetStop last read it from get_ticket (reviewSpend.costUsd), kept so the stewarding pane shows it without a Tick-it call of its own. */
const spendKept = atom({ plugin: 'tick-it', key: 'spendKept' } as const, { ticket: '', costUsd: null as number | null })
const pullRequest = atom({ plugin: 'tick-it', key: 'pullRequest' } as const, null)
const pullRequestError = atom({ plugin: 'tick-it', key: 'pullRequestError' } as const, null)
/** What Tick-it's record_runs answer said of the round (roundVerdict, next): settleRound follows it, and reads the round itself when there is none. */
const tickitRound = atom({ plugin: 'tick-it', key: 'tickitRound' } as const, null as TickitRound | null)
const resumeAsked = atom({ plugin: 'tick-it', key: 'resumeAsked' } as const, false)
const lastNext = atom({ plugin: 'tick-it', key: 'lastNext' } as const, null as string | null)

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
  /** The `paths` globs (after brace groups are written out) that can match no path and are left out of `paths`. */
  unknownPaths?: string[]
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

/** The entries of a front-matter list: an inline list ([a, "b"]), or a comma- or space-separated line. A comma inside a closed brace group does not split. */
const splitList = (raw: string): string[] => {
  // A whole line in one pair of quotes (`sizes: "S, M"`) is read as its content, as before.
  const line = /^(["'])([^"']*)\1$/.exec(raw.trim())?.[2] ?? raw
  const body = /^\[([\s\S]*)\]$/.test(line.trim()) ? line.trim().slice(1, -1) : line
  const out: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i)
    if (c === '{' && body.indexOf('}', i) !== -1) depth++
    else if (c === '}' && depth > 0) depth--
    if (depth === 0 && (c === ',' || /\s/.test(c))) {
      out.push(current)
      current = ''
    } else current += c
  }
  out.push(current)
  return out.map(e => e.replace(/^(["'])(.*)\1$/, '$2')).filter(e => e !== '')
}

/** A glob with each brace group ({ts,tsx}) written out as one glob per alternative; a brace with no closing mate stays as it is. */
const expandBraces = (glob: string): string[] => {
  const group = /\{([^{}]*)\}/.exec(glob)
  if (group === null) return [glob]
  const head = glob.slice(0, group.index)
  const tail = glob.slice(group.index + group[0].length)
  return group[1].split(',').flatMap(alt => expandBraces(head + alt.trim() + tail)).slice(0, 100)
}

/** A glob no path glob can be: one with a bracket, a brace left unexpanded, a quote, or a leading !. */
const unusableGlob = (glob: string): boolean => /[[\]{}"']/.test(glob) || glob.startsWith('!')

/** Reads a SKILL.md: its front matter (name, description, model, sizes, paths, changes) and its body. */
export const parseSkill = (folder: string, text: string): ReviewSkill => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const fields = new Map<string, string>()
  // The raw value of each key: its line, or its block list (`- a` lines under the key) as an inline list.
  const raw = new Map<string, string>()
  let blockKey: string | undefined
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (blockKey !== undefined && item !== null) {
      raw.set(blockKey, `${raw.get(blockKey) ?? ''} ${item[1].trim()}`.trim())
      continue
    }
    const at = line.indexOf(':')
    blockKey = undefined
    if (at > 0) {
      const key = line.slice(0, at).trim()
      const value = line.slice(at + 1).trim()
      raw.set(key, value)
      if (value === '') blockKey = key
      fields.set(key, value.replace(/^["']|["']$/g, ''))
    }
  }
  const list = (key: string): string[] | undefined => (raw.has(key) ? splitList(raw.get(key) ?? '') : undefined)
  const sizes = list('sizes')
    ?.map(size => size.toUpperCase())
    .filter((size): size is TicketSize => (SIZES as string[]).includes(size))

  // Globs: a brace group is written out first; one that still cannot be a path glob is kept out and named. None usable (or none) leaves paths out: the skill applies to every path.
  const globs = list('paths')?.flatMap(expandBraces)
  const paths = globs?.filter(glob => !unusableGlob(glob))
  const unknownPaths = globs?.filter(unusableGlob)
  const changesText = list('changes')?.join(',')

  return {
    name: fields.get('name') || folder,
    description: fields.get('description') ?? '',
    model: fields.get('model') || undefined,
    sizes: sizes !== undefined && sizes.length > 0 ? sizes : undefined,
    paths: paths !== undefined && paths.length > 0 ? paths : undefined,
    ...(parseChanges(changesText) === undefined ? {} : { changes: parseChanges(changesText) }),
    ...(unknownChanges(changesText).length === 0 ? {} : { unknownChanges: unknownChanges(changesText) }),
    ...(unknownPaths === undefined || unknownPaths.length === 0 ? {} : { unknownPaths }),
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

/** A report line without the markdown round its marker: bullets, numbers, # and > marks, and bold, italic or code marks round the word and its colon. */
const plain = (line: string): string => {
  let rest = line.trim()
  for (let before = ''; before !== rest; ) {
    before = rest
    rest = rest.replace(/^(?:[-*+]\s+|\d+[.)]\s+|#+\s*|>\s*)/, '')
  }
  return rest.replace(/^[*_`]*(BLOCKING|OPTIONAL|FINDING|VERDICT)[*_`]*:[*_`]*\s*/i, '$1: ')
}

/** A line whose whole body, with punctuation and markdown stripped, is a nil word ("BLOCKING: none.", "OPTIONAL: **N/A**") says nothing is wrong: it is no finding. */
const NIL = /^(none|n\/a|nothing|no issues|no blocking findings|not applicable)$/i
const saysNothing = (line: string): boolean => NIL.test(line.replace(/^(BLOCKING|OPTIONAL):/i, '').replace(/[^\p{L}\p{N}/\s]/gu, '').replace(/\s+/g, ' ').trim())

/** The BLOCKING and OPTIONAL lines of a reviewer's report, leaving out a line that says nothing is wrong. */
export const readFindings = (answer: string) => {
  const lines = answer.split('\n').map(plain).filter(line => !saysNothing(line))
  return {
    blocking: lines.filter(line => /^BLOCKING:/i.test(line)),
    optional: lines.filter(line => /^OPTIONAL:/i.test(line)),
  }
}

/** Whether a reviewer's answer ends with a verdict: the last VERDICT line says clean or changes, read as the BLOCKING lines are (bullets, numbers, headings, quotes, bold and code marks removed). */
export const readVerdict = (answer: string): 'clean' | 'changes' | undefined => {
  const last = answer.split('\n').map(line => /^VERDICT:?\s*(clean|changes)\b/i.exec(plain(line))?.[1]?.toLowerCase()).filter(v => v !== undefined).at(-1)
  return last === 'clean' || last === 'changes' ? last : undefined
}

/** Whether a finished run is a review: its turn ended with an answer that says VERDICT: clean, or that lists a blocking finding (which blocks the round whatever else it says). A failed turn, an answer with no verdict, and VERDICT: changes with no BLOCKING line that could be read reviewed nothing. */
export const gaveVerdict = (answer: string, reason: string, blocking: number): boolean => reason === 'answer' && (blocking > 0 || readVerdict(answer) === 'clean')

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

/** How many fix rounds a finding may survive: raised, then still open after this many fixes, and it goes to a person (TCK-80). */
export const FIX_ROUNDS_PER_FINDING = 2

const findingKey = (skill: string, f: { file?: string; text: string }) => `${skill}\0${f.file ?? ''}\0${f.text.slice(0, MAX_FINDING_TEXT)}`

/**
 * The blocking findings of the rounds up to `round` still blocking, counted per finding (skill, file and text; an open verdict keeps the earlier finding's file and text, so it is the same one).
 * A finding raised afresh as a BLOCKING line counts as 1, and each open verdict on it in a later round adds one. A round of the skill that did not list it (a fixed or gone verdict) starts the count again, as does a round at or before the finding's `decidedFrom`; a round that skipped the skill (clean verdict carried forward) changes nothing.
 */
export const openRounds = (runs: ReviewRun[], ticket: string, round: number, decidedFrom: Record<string, number> = {}): Map<string, { skill: string; file?: string; text: string; rounds: number }> => {
  const counted = new Map<string, { skill: string; file?: string; text: string; rounds: number }>()
  const done = runs.filter(r => r.ticket === ticket && r.round <= round && r.status === 'done' && r.notApplicable === undefined).sort((a, b) => a.round - b.round || a.startedAt - b.startedAt)
  for (const r of done) {
    const here = new Set<string>()
    for (const f of r.items ?? []) {
      if (f.severity !== 'blocking') continue
      const key = findingKey(r.skill, f)
      here.add(key)
      if (r.round <= (decidedFrom[key] ?? 0)) continue
      const before = counted.get(key)
      counted.set(key, { skill: r.skill, ...(f.file === undefined ? {} : { file: f.file }), text: f.text, rounds: f.open === true ? (before?.rounds ?? 0) + 1 : 1 })
    }
    for (const [key, v] of counted) if (v.skill === r.skill && !here.has(key)) counted.delete(key)
  }
  return counted
}

/** The findings the session has now fixed more than FIX_ROUNDS_PER_FINDING times and that are still open, with the id Tick-it gives them when it can say; a finding a person decided since counts from the round the decision was first seen (the steward's decidedFrom, returned updated). */
export async function stuckFindings($: EngineInterface, s: Steward, runs: ReviewRun[]): Promise<{ stuck: { id?: string; skill: string; file?: string; text: string }[]; decidedFrom: Record<string, number> }> {
  let decidedFrom = s.decidedFrom ?? {}
  const over = (m: ReturnType<typeof openRounds>) => [...m].filter(([, v]) => v.rounds > FIX_ROUNDS_PER_FINDING)
  if (over(openRounds(runs, s.ticket, s.round, decidedFrom)).length === 0) return { stuck: [], decidedFrom }
  const repository = await repositoryHere($)
  const got = repository === undefined ? undefined : await callTickit($, 'get_ticket', { repository, key: s.ticket, include: ['findings'] }).catch(() => undefined)
  const list = got?.ok === true ? (got.value.ticket as { findings?: unknown } | undefined)?.findings : undefined
  const rows = (Array.isArray(list) ? list : []) as { id?: unknown; skill?: unknown; file?: unknown; text?: unknown; decision?: unknown }[]
  const same = (r: (typeof rows)[number], key: string) => typeof r.skill === 'string' && typeof r.text === 'string' && findingKey(r.skill, { ...(typeof r.file === 'string' ? { file: r.file } : {}), text: r.text }) === key
  // A decision first seen now was made before this round's review or during it: counting starts from the round before, so at most this round's appearance stands.
  for (const [key] of over(openRounds(runs, s.ticket, s.round, decidedFrom))) {
    if (decidedFrom[key] === undefined && rows.some(r => same(r, key) && (r.decision === 'accepted' || r.decision === 'fix'))) decidedFrom = { ...decidedFrom, [key]: s.round - 1 }
  }
  const stuck = over(openRounds(runs, s.ticket, s.round, decidedFrom)).map(([key, v]) => {
    const id = rows.find(r => same(r, key))?.id
    return { ...(typeof id === 'string' ? { id } : {}), skill: v.skill, ...(v.file === undefined ? {} : { file: v.file }), text: v.text }
  })
  return { stuck, decidedFrom }
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
    const m = /^FINDING:\s*(\d+)\s+(fixed|open|gone)\b[\s:–—-]*(.*)$/i.exec(plain(line))
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

export const reviewPrompt = (t: Ticket, skill: ReviewSkill, round: number, earlier: Earlier[] = [], head?: string, change?: ChangeReview, base?: string): string =>
  [
    `You are the "${skill.name}" reviewer for ticket ${t.id}: ${t.title} (epic: ${t.epic}), review round ${round}.`,
    `Ticket size: ${t.size}.`,
    'Acceptance:',
    ...t.acceptance.map(a => `- ${a}`),
    base === undefined
      ? `Review the change in the working tree against HEAD (git diff HEAD and the untracked files). Do not change any file.`
      : `Review the whole change of this ticket against its base branch ${base}: the diff from the merge base to the working tree (git diff $(git merge-base ${base} HEAD)) and the untracked files. Committed work counts, so an empty diff of the working tree alone is not a reason to report nothing to review. Do not change any file.`,
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

/** The review runs made in this repository (those an older mod stored with none are taken as this one's). */
export async function hereRuns($: EngineInterface): Promise<ReviewRun[]> {
  const repository = await repositoryHere($)
  return (await read($, reviews)).filter(r => madeHere(r, repository))
}

/** Marks the running runs `pick` chooses failed (not queued: Tick-it hears of a run only from its answer). Answers how many. */
export async function failRuns($: EngineInterface, pick: (r: ReviewRun) => boolean): Promise<number> {
  const repository = await repositoryHere($)
  const mine = (r: ReviewRun) => r.status === 'running' && madeHere(r, repository) && pick(r)
  const n = (await read($, reviews)).filter(mine).length
  if (n > 0) await saveReviews($, list => list.map(r => (mine(r) ? { ...r, status: 'failed' as const } : r)))
  return n
}

/** A run is running only while its agent can still answer: a ticket's running run whose agent is not listed, or is listed finished, is failed. Unreadable list: nothing changes. */
export async function failLostRuns($: EngineInterface, ticket: string): Promise<number> {
  if (!(await hereRuns($)).some(r => r.ticket === ticket && r.status === 'running')) return 0
  const listed = await $.agent.list().catch(() => undefined)
  if (listed === undefined) return 0
  const live = new Set(listed.filter(a => a.status === 'running').map(a => a.id))
  return failRuns($, r => r.ticket === ticket && !live.has(r.agentId))
}

export async function saveReviews($: EngineInterface, fn: (list: ReviewRun[]) => ReviewRun[]) {
  const repository = await repositoryHere($)
  // Each run carries the repository it was made in, set when it is saved; one with none yet is taken by the repository it is first read in.
  const list = fn(await read($, reviews)).map(r => (r.repository === undefined && repository !== undefined ? { ...r, repository } : r)).slice(-KEEP_REVIEWS)
  await update($, reviews, () => list)
  await $.store.set(REVIEWS_KEY, list)
}

/** The steward as a person's action leaves it: what marks a stop the mod made, or the review of a fix after it, belongs to that stop only. */
export const withoutStopMarks = (s: Steward): Steward => {
  const { stoppedBy: _by, afterStop: _after, tickitStopped: _said, waitingOn: _waiting, ...rest } = s
  return rest
}

/** `stop`: why the mod stopped, sent in the same report_session call as the status and the need (the typed stop); with no Tick-it session to report to, the need goes with set_needs_human as before. */
export async function setSteward($: EngineInterface, next: Steward | null, stop?: StopReport) {
  await update($, steward, () => next)
  await saveResume($)
  await showStatus($)
  if (next !== null && (await read($, startedSession))?.ticket === next.ticket) {
    const said = next.note ?? (next.phase === 'reviewing' ? `Review round ${next.round}.` : next.phase === 'fixing' ? `Fixing round ${next.round}'s findings.` : undefined)
    await report($, next.phase, said, true, stop)
  } else if (next !== null && stop !== undefined && stop.code !== 'person-stopped') {
    const repository = await repositoryHere($)
    if (repository !== undefined) await callTickit($, 'set_needs_human', { repository, key: next.ticket, kind: stop.need.kind, note: stop.need.note.slice(0, 200) }).catch(() => undefined)
  }
}

/** The mod stops stewarding: one report_session call with status stopped, the stop reason and the need, never a report followed by set_needs_human. */
async function stopByMod($: EngineInterface, s: Steward, code: string, note: string, needNote = note, skills?: string[], extra: Partial<Steward> = {}) {
  const head = await checkedOut($)
  await setSteward($, { ...s, ...extra, phase: 'stopped', stoppedBy: 'mod', note }, { code, round: s.round, ...(skills === undefined ? {} : { skills }), ...(head === undefined ? {} : { head }), need: { kind: 'no-clean-round', note: needNote } })
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

/** A branch name safe to pass to git as an argument: no option, no range, no ref syntax git refuses. */
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/

/** Runs git and answers its stdout when it exits 0, else undefined. */
async function git($: EngineInterface, argv: string[]): Promise<string | undefined> {
  const out = await $.process.run(['git', ...argv]).catch(() => undefined)
  return out === undefined || out.exitCode !== 0 ? undefined : out.stdout
}

/**
 * Checks out the open pull request's head when the checkout is elsewhere: only when the working tree is clean, nothing on HEAD or on a local branch of that name is
 * unpushed, and what origin gives for the branch is the head Tick-it names. Answers whether HEAD is now that head; anything else leaves the checkout as it was.
 */
export async function checkOutHead($: EngineInterface, pr: PullRequestView): Promise<boolean> {
  if (pr.headSha === undefined || pr.branch === undefined || !SAFE_BRANCH.test(pr.branch)) return false
  const status = await git($, ['status', '--porcelain'])
  if (status === undefined || status.trim() !== '') return false
  if ((await git($, ['fetch', 'origin', pr.branch])) === undefined) return false
  if ((await git($, ['rev-parse', 'FETCH_HEAD']))?.trim() !== pr.headSha) return false
  // Unpushed commits on HEAD, or on a local branch the checkout would reset, are someone's work: they stay, and the round stops as before.
  const unpushed = await git($, ['rev-list', 'HEAD', '--not', '--remotes'])
  if (unpushed === undefined || unpushed.trim() !== '') return false
  const local = await $.process.run(['git', 'rev-list', `refs/heads/${pr.branch}`, '--not', '--remotes']).catch(() => undefined)
  if (local === undefined || (local.exitCode === 0 && local.stdout.trim() !== '')) return false
  if ((await git($, ['checkout', '-B', pr.branch, 'FETCH_HEAD'])) === undefined) return false
  return (await git($, ['rev-parse', 'HEAD']))?.trim() === pr.headSha
}

/**
 * What stops a round before any reviewer starts (TCK-51): the checkout is not at the head of the ticket's open pull request, or the change against the base is empty.
 * `stop` says why; `note` is set when the head could not be checked (Tick-it unreadable, or it gave no head), and the round then runs as before.
 */
export async function roundGate($: EngineInterface, ticket: string): Promise<{ stop?: string; why?: 'head-differs' | 'empty-diff'; note?: string; checkedOut?: boolean; changed: string[] | null }> {
  await refreshPullRequest($, ticket).catch(() => update($, pullRequestError, () => 'could not read the pull request'))
  const pr = await read($, pullRequest)
  // Listed once for the round: the paths of the reviewers use it too.
  const changed = await changedSinceBase($).catch(() => null)
  if ((await read($, pullRequestError)) !== null) return { note: 'The pull request head could not be checked: Tick-it could not be read.', changed }
  // A ticket with no open pull request is reviewed as before.
  if (pr !== null && pr.state === 'open') {
    if (pr.headSha === undefined) return { note: 'The pull request head could not be checked: Tick-it gave no head commit.', changed }
    const here = (await $.process.run(['git', 'rev-parse', 'HEAD']).catch(() => undefined))?.stdout.trim()
    if (here === undefined || here === '') return { note: 'The pull request head could not be checked: git did not say which commit is checked out.', changed }
    if (here !== pr.headSha) {
      // A session started on another commit (a recovery session starts on the default branch) checks out the head itself, when that loses no work, and reviews it.
      const moved = await checkOutHead($, pr).catch(() => false)
      if (!moved) return { why: 'head-differs', stop: `No review started: the checkout is at ${here}, but pull request #${pr.number} is at ${pr.headSha}. Check out or push the pull request's head, then review again.`, changed }
      await log($, 'info', 'head-checked-out', { ticket, pullRequest: pr.number, from: here, to: pr.headSha })
      const after = await changedSinceBase($).catch(() => null)
      if (after !== null && after.length === 0) return { stop: 'No review started: git diff against the base branch is empty, so there is nothing to review.', why: 'empty-diff', changed: after }
      return { changed: after, checkedOut: true, note: `Checked out pull request #${pr.number}'s head ${pr.headSha.slice(0, 12)} (the checkout was at ${here.slice(0, 12)}).` }
    }
  }
  // Nothing changed against the base branch (the working tree, untracked files included): there is nothing to review. A listing that cannot be had does not stop the round.
  if (changed !== null && changed.length === 0) return { stop: 'No review started: git diff against the base branch is empty, so there is nothing to review.', why: 'empty-diff', changed }
  return { changed }
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
    await saveResume($)
    await log($, 'debug', 'round-not-started', { ticket: t.id, round: fromRound, why: 'stopped' })
    return `Stopped; round ${fromRound} of ${t.id} did not start.`
  }
  // The first round of a session (not the review of a fix) continues from the rounds Tick-it has recorded for the ticket, whichever session ran them. Unreadable, it is round 1 as before.
  const first = fromRound === 1 && trigger !== 'after-fix'
  // The turn that ticks the acceptance checks of a round settled without reviewers ends in this start too: the head it finds is as reviewed as before.
  const afterTicking = trigger === 'after-fix' && ticking === true
  const recorded = first || afterTicking ? await recordedReviews($, t.id) : undefined
  // Runs this session has not yet got to Tick-it (the outbox holds them) are not in the timeline: never go back to a round number the session already used.
  const ranHere = (await hereRuns($)).filter(r => r.ticket === t.id).reduce((most, r) => Math.max(most, r.round), 0)
  const carried = Math.max(recorded === undefined ? 0 : lastRecordedRound(recorded), ranHere)
  const round = first ? carried + 1 : fromRound
  const limit = await roundLimit($, t.size, t.id)
  // A reviewer of an earlier round still running is given up: a late answer from it changes no round.
  await failRuns($, r => r.ticket === t.id && r.round < round)
  // The fix that followed a round blocked by the pull request alone, with no budget for a reviewer round: no review agent starts, the pull request is read again and settles the round.
  if (trigger === 'after-fix' && (await read($, steward))?.pullRequestOnly === true && (round > limit || (await read($, steward))?.afterStop === true || (await budgetStop($, t.id, await reviewedRounds($, t.id))) !== undefined)) {
    // The stop button pressed while the spend was read: that round does not start.
    if ((await read($, steward))?.phase === 'stopped') {
      await update($, steward, v => (v === null ? v : { ...v, fixing: false }))
      await saveResume($)
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
  // The checkout must be the pull request's head and the change not empty: otherwise no reviewer starts and no run is recorded.
  const gate = await roundGate($, t.id)
  if (gate.stop !== undefined) {
    // The round never ran: the steward keeps the last one that did, so r tries this round number again.
    const ran = first ? carried : fromRound - 1
    await setSteward($, { ticket: t.id, round: ran, phase: 'stopped', maxRounds: Math.max(limit, ran), note: gate.stop, fixing: false })
    await log($, 'warn', 'round-not-started', { ticket: t.id, round, why: gate.why ?? 'head-differs' })
    return gate.stop
  }
  // Another session's round on this ticket's head is still being recorded (TCK-75): a second round would repeat its number and review its own checkout, so none starts here.
  const other = await otherReviewingSession($, t.id)
  if (other !== undefined) {
    const why = `No review started: session ${other} is running a review round on ${t.id}'s head. Wait for it to finish, then review again.`
    const ran = first ? carried : fromRound - 1
    await setSteward($, { ticket: t.id, round: ran, phase: 'stopped', maxRounds: Math.max(limit, ran), note: why, fixing: false })
    await log($, 'warn', 'round-not-started', { ticket: t.id, round, why: 'other-session-reviewing' })
    return why
  }
  if (gate.note !== undefined) {
    $.ui.toast(`tick-it: ${gate.note}`)
    if (gate.checkedOut !== true) await log($, 'debug', 'head-not-checked', { ticket: t.id, round })
  }
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
    return (await read($, pullRequestError)) === null && pullRequestFindings(await read($, pullRequest), await checkedOut($)).length === 0 && !ciUnconfirmed(await read($, pullRequest), await checkedOut($))
  }
  // The head only merged the base and Tick-it carries the review of the earlier commit over (reviewCarriedOver of list_pull_requests, TCK-52): no reviewer starts, and the round settles from the pull request and the acceptance ticks. An older Tick-it does not say, and the round runs as before.
  const pr = await read($, pullRequest)
  if (pr !== null && (await read($, pullRequestError)) === null && pr.state === 'open' && pr.reviewCarriedOver === true && (await cleanTree()) && (await settlesClean())) {
    const earlier = ((await recordedReviews($, t.id)) ?? []).flatMap(r => r.agents).findLast(a => a.headSha !== undefined)?.headSha
    const last = first ? carried : fromRound - 1
    const note = `Review carried over from the earlier commit${earlier === undefined ? '' : ` ${earlier.slice(0, 7)}`}: the head only merged the base, so no reviewer started.`
    const steward: Steward = { ticket: t.id, round: last, phase: 'reviewing', maxRounds: Math.max(limit, last), carriedOver: note, ...(ticking === true ? { ticking } : {}) }
    await setSteward($, steward)
    await log($, 'debug', 'round-not-started', { ticket: t.id, round: last, why: 'review-carried-over' })
    await settleRound($, steward)
    return `${t.id}: ${note} Settling from the pull request and the acceptance checks.`
  }
  const earlierRuns = await hereRuns($)
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
  const changedPaths = sized.some(({ skill }) => skill.paths !== undefined) ? gate.changed : null
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
  const base = (await defaultBase($).catch(() => null))?.ref
  // Every applicable skill already reviewed this head with nothing blocking: no reviewer starts, and the round settles from the pull request and the acceptance ticks alone.
  // A command cannot submit a prompt, and a settle that finds a check unticked or the pull request failing submits one: from a command the round settles here only when it ends clean, and is reviewed as before otherwise.
  if (recorded !== undefined && head !== undefined && recorded.length > 0 && skills.every(({ folder }) => reviewedClean(recorded, folder, head) && blockersOf(folder).length === 0) && (await cleanTree()) && (await settlesClean())) {
    const last = first ? carried : fromRound - 1
    const steward: Steward = { ticket: t.id, round: last, phase: 'reviewing', maxRounds: Math.max(limit, last), ...(ticking === true ? { ticking } : {}) }
    await setSteward($, steward)
    await log($, 'debug', 'round-not-started', { ticket: t.id, round: last, why: 'head-already-reviewed' })
    await settleRound($, steward)
    return `${t.id}: round ${last} already reviewed this head with nothing blocking, so no reviewer starts; settling from the pull request and the acceptance checks.`
  }
  await setSteward($, { ticket: t.id, round, phase: 'reviewing', maxRounds: Math.max(limit, round), ...(ticking === true ? { ticking } : {}), ...(trigger === 'after-stop' ? { afterStop: true } : {}), ...(gate.note === undefined ? {} : { note: gate.note }) })
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
    const prompt = reviewPrompt(t, skill, round, earlier, head, change, base)
    const spawn = async (model: string | undefined) => {
      try {
        return await $.agent.spawn({ prompt, description, subagentType: 'general-purpose', ...(model === undefined ? {} : { model }) })
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
      prompt,
      description,
      claudeSession: await $.session.id(),
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
  const oddPaths = skills.flatMap(({ folder, skill }) => (skill.unknownPaths === undefined ? [] : [`${folder} lists ${skill.unknownPaths.join(', ')} in paths, which can match no path (no bracket, brace, quote or leading ! in a glob), so ${skill.paths === undefined ? 'it runs on every path' : 'they are left out'}.`]))
  const odd = skills.flatMap(({ folder, skill }) => (skill.unknownChanges === undefined ? [] : [`${folder} lists ${skill.unknownChanges.join(', ')} in changes, which ${skill.unknownChanges.length === 1 ? 'is' : 'are'} no area (${AREA_NAMES.join(', ')}, all, none) and no glob.`]))

  await log($, 'debug', 'round-started', { ticket: t.id, round, why: trigger, skills: started.map(r => r.skill).join(','), ...(refused.length === 0 ? {} : { refused: failedRuns.map(r => r.skill).join(',') }), ...(touched.length === 0 ? {} : { touches: touched.map(x => x.area).join(',') }) })
  return `Round ${round}: ${started.map(r => r.skill).join(', ')} reviewing ${t.id} in this session.${refused.length === 0 ? '' : ` Could not be started, so the round is not clean: ${refused.join('; ')}.`}${[without.trim(), ...reasons, ...odd, ...oddPaths].filter(x => x !== '').map(x => ` ${x}`).join('')}`
}

/** The stewarding pane's r: the next round starts when the current turn ends, even after the rounds ran out or stewarding stopped. */
export async function reviewAgain($: EngineInterface): Promise<string> {
  const s = await read($, steward)
  if (s === null) return 'Nothing is being stewarded.'
  // Stopping does not end the reviewers already running: the next round waits for them. A reviewer whose agent is gone does not count.
  const lost = await failLostRuns($, s.ticket)
  if ((s.phase === 'reviewing' && lost === 0) || (await hereRuns($)).some(r => r.ticket === s.ticket && r.status === 'running')) return `Round ${s.round} of ${s.ticket} is still being reviewed.`
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
  await setSteward($, { ...withoutStopMarks(s), phase: 'stopped', note, fixing: s.phase === 'fixing' }, { code: 'person-stopped', round: s.round, need: { kind: 'session-stopped', note } })

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
 * CI that Tick-it reports as failing, but not for the commit checked out here: it names no head commit, or another one (a reading taken right after a push still shows the previous head's result).
 * That is CI not yet confirmed, never a blocking finding of the round (TCK-76). `here` is the checked-out commit; undefined when git did not say, which confirms nothing.
 */
export const ciUnconfirmed = (pr: PullRequestView | null, here: string | undefined): boolean => pr !== null && pr.state === 'open' && pr.ci === 'failure' && (pr.headSha === undefined || here === undefined || pr.headSha !== here)

/**
 * What a pull request adds to a round's blocking findings, so a round is not clean while it is red or stale. The queue owns the branch of a queued
 * pull request: it is never told to update it, only to resolve a conflict (Tick-it sends that itself). Tick-it's own CI instruction for the
 * current head commit is followed, not repeated with a second fix. History is never rewritten: the base is merged in.
 */
export const pullRequestFindings = (pr: PullRequestView | null, here: string | undefined): string[] => {
  if (pr === null || pr.state !== 'open') return []
  const found: string[] = []
  if (pr.ci === 'failure' && !ciUnconfirmed(pr, here)) {
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

/** The commit checked out here; undefined when git does not say. */
async function checkedOut($: EngineInterface): Promise<string | undefined> {
  const here = (await $.process.run(['git', 'rev-parse', 'HEAD']).catch(() => undefined))?.stdout.trim()
  return here === undefined || here === '' ? undefined : here
}

/** The pull request's own finding in words, for a note a person reads: what fails, not "a blocking finding". */
const ownFindingWords = (pr: PullRequestView | null, failed: boolean): string => {
  if (failed || pr === null) return 'the pull request could not be read, so its CI and branch are unchecked'
  const parts = [...(pr.ci === 'failure' ? [`CI is failing on pull request #${pr.number}`] : []), ...(!pr.queued && pr.conflicting ? [`pull request #${pr.number} has a merge conflict with its base`] : !pr.queued && pr.behind === true ? [`pull request #${pr.number} is behind its base`] : [])]
  return parts.length === 0 ? `pull request #${pr.number} blocks` : parts.join(' and ')
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
  await update($, spendKept, () => ({ ticket, costUsd }))
  // The spend covers every session's rounds, so it is divided by the rounds recorded for the ticket, not by this session's count alone.
  const recorded = await recordedReviews($, ticket)
  const ran = recorded === undefined ? rounds : Math.max(rounds, recorded.length)
  // Spend must be under the budget; and a round costing the average of those so far must fit in what remains.
  if (remaining <= 0) return { budget, costUsd, reached: true }
  if (ran >= 1 && costUsd / ran > remaining) return { budget, costUsd, reached: false }
  return undefined
}

/** The spend against the budget the stewarding band and pane heading show next to the rounds, e.g. `$1.20/$3` (`$3.40/$3 over` at or past the budget), with its tone; undefined, so the line is as with the round limit alone, when there is no budget or the spend is unknown. */
export const spendPart = (costUsd: number | null, budget: number | null): { text: string; tone: 'ok' | 'warn' | 'over' } | undefined => {
  if (costUsd === null || budget === null) return undefined
  const over = costUsd >= budget
  return { text: `${usd.format(costUsd)}/$${budget}${over ? ' over' : ''}`, tone: over ? 'over' : costUsd >= budget * WARN_AT ? 'warn' : 'ok' }
}

/** The spend kept for the ticket (see spendKept) against its kept reviewBudget; no Tick-it call. */
export async function keptSpendPart($: EngineInterface, ticket: string) {
  const kept = await read($, spendKept)
  return spendPart(kept.ticket === ticket ? kept.costUsd : null, await reviewBudgetOf($, ticket))
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

/** The ticket's latest recorded round (TCK-75): Tick-it refuses a duplicate round number, so a round is numbered after the highest one recorded, whichever session recorded it. */
export const lastRecordedRound = (rounds: RecordedRound[]): number => rounds.reduce((most, r) => Math.max(most, r.round), 0)

/** The id of another session of this ticket that is reviewing it now (list_sessions: a live build session whose status is reviewing), or undefined when none is or the sessions cannot be read (the round then starts as before). */
export async function otherReviewingSession($: EngineInterface, ticket: string): Promise<string | undefined> {
  const repository = await repositoryHere($)
  if (repository === undefined) return undefined
  const got = await callTickit($, 'list_sessions', { repository, key: ticket, kind: 'build' }).catch(() => undefined)
  const sessions = got?.ok === true ? got.value.sessions : undefined
  if (!Array.isArray(sessions)) return undefined
  const mine = (await read($, startedSession))?.id
  return (sessions as { id?: unknown; status?: unknown; live?: unknown }[]).find(s => typeof s.id === 'string' && s.id !== mine && s.status === 'reviewing' && s.live === true)?.id as string | undefined
}

/** Whether the skill's newest recorded run (the last in the timeline, which is oldest first) saw this head commit with no blocking finding; a run recorded as not applicable counts when it names this head too. */
export const reviewedClean = (rounds: RecordedRound[], skill: string, head: string): boolean => {
  const newest = rounds.flatMap(r => r.agents.filter(a => a.skill === skill)).at(-1)
  return newest !== undefined && newest.blocking === 0 && newest.headSha === head
}

/** The rounds of a ticket that ran reviewers: a round settled on the pull request alone costs nothing, so it is not part of the average cost of a round. */
async function reviewedRounds($: EngineInterface, ticket: string): Promise<number> {
  const rounds = [...new Set((await hereRuns($)).filter(r => r.ticket === ticket).map(r => r.round))]
  // A session's first round continues from the rounds earlier sessions ran, and the spend covers them too: they are rounds of the average as well.
  const earlier = rounds.length === 0 ? 0 : Math.min(...rounds) - 1
  return rounds.length + earlier
}

/**
 * Once every reviewer of the round has answered: done, a fix round, one more round past the limit, or stop.
 * With `withoutReviewers` no reviewer ran for this round (the budget had no room for one after a fix of the pull request alone): the round is settled on the pull request, so it is clean or it stops, and it asks for no further fix.
 */
export async function settleRound($: EngineInterface, s: Steward, withoutReviewers = false) {
  await failLostRuns($, s.ticket)
  const runs = (await hereRuns($)).filter(r => r.ticket === s.ticket && r.round === s.round)
  if (runs.some(r => r.status === 'running')) return
  const t = (await read($, tickets)).find(one => one.id === s.ticket)
  if (t === undefined) return
  // What Tick-it said of this round when it took its runs (roundVerdict of record_runs): followed when it said, and the mod's own reading below stays the fallback.
  const held = withoutReviewers ? null : await read($, tickitRound)
  const given = held !== null && held.ticket === s.ticket && held.round === s.round ? held : undefined
  // A verdict is used once: a later settle of the same round (a failed send, a carried-over round) reads the runs itself instead of a stale answer.
  if (held !== null) await update($, tickitRound, () => null)
  // running: Tick-it still waits for a reviewer. incomplete: the reviewers it names run again, and nothing stops.
  if (given?.verdict === 'running') return
  if (given?.verdict === 'incomplete' && (await rerunReviewers($, s, runs, given))) return
  // A reviewer that could not be started reviewed nothing: the round is not clean while its failed run stands.
  const own = runs.flatMap(r => [...(r.reason === undefined ? [] : [`[${r.skill}] BLOCKING: reviewer could not be started: ${r.reason}`]), ...(r.status === 'failed' && r.reason === undefined ? [] : r.findings ?? []).map(line => `[${r.skill}] ${line}`)])
  // clean: no finding of this round blocks, whatever the mod read (the pull request and the acceptance ticks still decide below). blocked: it blocks, with Tick-it's `next` when the mod found nothing itself.
  const reviewed = given?.verdict === 'clean' ? [] : given?.verdict === 'blocked' && own.length === 0 ? [`[tick-it] Tick-it reads round ${s.round} as blocked${given.next === undefined ? ': see its findings on the ticket (get_ticket).' : `: ${given.next}`}`] : own
  // Reviewers that found nothing do not make a round clean while the pull request is failing or behind: that is blocking too.
  // A refresh that throws is an unread pull request too, not a stranded round.
  if (reviewed.length === 0) await refreshPullRequest($, t.id).catch(() => update($, pullRequestError, () => 'could not read the pull request'))
  // A refresh that failed leaves the last reading in place: it is not trusted, so the round is not clean until Claude has looked with gh.
  let failed = reviewed.length === 0 && (await read($, pullRequestError)) !== null
  const here = reviewed.length === 0 ? await checkedOut($) : undefined
  // CI failing for another commit (or none named) is a reading taken before CI caught up with the push: the pull request is read once more before it is called not confirmed.
  if (reviewed.length === 0 && !failed && ciUnconfirmed(await read($, pullRequest), here)) {
    await refreshPullRequest($, t.id).catch(() => update($, pullRequestError, () => 'could not read the pull request'))
    failed = (await read($, pullRequestError)) !== null
  }
  const pr = await read($, pullRequest)
  const unconfirmedCi = reviewed.length === 0 && !failed && ciUnconfirmed(pr, here)
  const blocking = reviewed.length > 0 ? reviewed : failed ? ['[pull-request] Tick-it could not read the pull request, so its CI and branch are unchecked: check them with gh (gh pr checks, gh pr view) and fix what fails.'] : pullRequestFindings(pr, here)
  // No reviewer looked at the fix, so the pull request alone must show it: open, CI passed, and the branch neither behind nor conflicting (a queued one is the queue's to update). CI that has not finished is waited for by a person, never read as clean.
  const confirmed = pr !== null && pr.state === 'open' && pr.ci === 'success' && !pr.conflicting && (pr.queued || pr.behind === false)
  const pending = blocking.length === 0 && ((withoutReviewers && !confirmed) || unconfirmedCi)
  const spent = summarise(runs)
  // The stop button may be pressed while this waits on Tick-it or GitHub: stopped stays stopped.
  const stillReviewing = async () => (await read($, steward))?.phase === 'reviewing'
  // A reviewer whose newest run of the round failed or gave no verdict (it was already run again once; one that could not be started is blocking by its own reason below) reviewed nothing: the round is not clean, whatever the others found, and a person is asked.
  const newest = new Map<string, ReviewRun>()
  for (const r of runs) if (r.notApplicable === undefined && r.reason === undefined) newest.set(r.skill, r)
  const unreviewed = [...newest.values()].filter(r => r.status === 'failed').map(r => r.skill)
  // Reviewers that did find blocking things still send Claude to fix them: the failed reviewer is run again in the next round (a failed run carries no clean verdict forward).
  if (unreviewed.length > 0 && !withoutReviewers && reviewed.length === 0 && given?.verdict !== 'clean') {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-no-verdict', skills: unreviewed.join(',') })
    // "Twice" only where the run was started again: a lost or stopped run, or one saved before retries, ran once.
    const again = [...newest.values()].filter(r => r.status === 'failed').every(r => r.retry === true)
    const note = `${unreviewed.join(', ')} failed or gave no VERDICT${again ? ', twice' : ''} in round ${s.round}: not a clean review, so the round is not read as clean.`
    await stopByMod($, s, 'reviewer-no-verdict', note, note, unreviewed)
    $.ui.toast(`tick-it: ${unreviewed.join(', ')} gave no review of ${t.id} in round ${s.round}, so it is not read as clean. Over to you.`)
    return
  }
  if (pending) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-ci-pending' })
    const what = unconfirmedCi && pr !== null ? `CI of pull request #${pr.number} is not confirmed for the checked-out commit (Tick-it reports it failing for ${pr.headSha === undefined ? 'no head commit' : pr.headSha.slice(0, 7)})` : pr === null || pr.state !== 'open' ? 'no open pull request is found' : pr.ci === 'pending' ? `CI is still pending on pull request #${pr.number}` : `CI or the branch of pull request #${pr.number} is not confirmed (CI ${pr.ci ?? 'not reported'}, ${pr.behind === null ? 'behind unknown' : pr.behind ? 'behind its base' : 'up to date'})`
    const note = `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} ${withoutReviewers ? 'after the fix, and no reviewer round is left (round limit or review budget)' : `after round ${s.round}, where the reviewers found nothing`}: not read as clean. r reads the pull request again.`
    await stopByMod($, s, 'ci-pending', note)
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
  // A finding still open after two rounds of fixes is better sent to a person than tried a third time: no further round, and a need naming it (TCK-80).
  if (reviewed.length > 0 && !withoutReviewers) {
    const { stuck, decidedFrom } = await stuckFindings($, s, (await hereRuns($)).filter(r => r.ticket === t.id))
    if (!(await stillReviewing())) return
    if (stuck.length > 0) {
      const first = stuck[0]!
      const name = `${first.id === undefined ? '' : `${first.id} `}[${first.skill}] ${first.file === undefined ? '' : `${first.file} `}${first.text}`
      await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-finding-repeated', findings: stuck.length })
      const note = `Finding ${name} is still open after ${FIX_ROUNDS_PER_FINDING} fix rounds${stuck.length > 1 ? ` (and ${stuck.length - 1} more)` : ''}: decide it (accepted or fix), no further round.`
      await stopByMod($, s, 'other', note, note.slice(0, 200), undefined, { decidedFrom })
      $.ui.toast(`tick-it: ${t.id} has a finding still open after ${FIX_ROUNDS_PER_FINDING} fix rounds, so it asks no further round. Over to you.`)
      return
    }
    if (decidedFrom !== s.decidedFrom) s = { ...s, decidedFrom }
  }
  const limit = await roundLimit($, t.size, t.id)
  // The review of a fix made after the mod stopped is the last: it asks for no further fix or round, whatever the limit or budget say.
  // Reviewers that found nothing leave only the pull request's own finding: that is fixed and read again below, never a stop that says a reviewer still blocks.
  if ((s.round > limit || s.afterStop === true) && reviewed.length > 0) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-past-limit', blocking: blocking.length })
    // One call tells Tick-it why and that a person is needed; the toast below says the same.
    await stopByMod($, s, 'rounds-exhausted', `${blocking.length} blocking after ${s.round} rounds.`, `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} still open after ${s.round} rounds, no clean round.`)
    $.ui.toast(`tick-it: ${t.id} still has ${blocking.length} blocking findings after ${s.round} rounds. Over to you.`)
    return
  }
  if (!(await stillReviewing())) return
  // Another round (the review of a fix) starts only while spend is under the budget and the next round is not expected to overshoot what is left. A fix asked for here is always reviewed, so the check is made before asking for one.
  // Settled on the pull request alone: it still blocks after the fix, and no reviewer round can follow, so nothing more is asked for.
  if (withoutReviewers) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-pull-request-still-blocking', blocking: blocking.length })
    const note = `${failed ? 'The pull request could not be read after the fix' : `After the fix ${ownFindingWords(pr, false)}`}, and no reviewer round is left (round limit or review budget), no clean round.`
    await stopByMod($, s, 'pull-request-blocking', note)
    $.ui.toast(`tick-it: ${t.id}'s pull request still has ${blocking.length} blocking findings after the fix and no reviewer round is left. Over to you.`)
    return
  }
  const over = await budgetStop($, t.id, Math.max(await reviewedRounds($, t.id), 1))
  // Reviewers found nothing, so what blocks is the pull request's own (CI, base): fixing it needs no reviewer spend to confirm, as the pull request can be read again. The budget does not stop the round; Claude is asked for the fix, and with no room for a reviewer round after it, the pull request alone settles the round.
  const pullRequestOnly = reviewed.length === 0
  if (over !== undefined && !pullRequestOnly) {
    if (!(await stillReviewing())) return
    await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: 'stopped-at-budget', blocking: blocking.length })
    const note = `Review budget $${over.budget} ${over.reached ? 'reached' : `would be overshot by round ${s.round + 1}`} (${usd.format(over.costUsd)} spent over ${s.round} round${s.round === 1 ? '' : 's'}), ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} still open, no clean round.`
    await stopByMod($, s, 'budget', note)
    $.ui.toast(`tick-it: ${t.id} still has ${blocking.length} blocking findings and the $${over.budget} review budget is ${over.reached ? 'used up' : 'too low for another round'}. Over to you.`)
    return
  }
  // The limit is hit with reviewers still blocking: one further round goes past it, and the timeline shows it as one.
  const pastLimit = s.round === limit
  await log($, 'debug', 'round-settled', { ticket: t.id, round: s.round, outcome: pastLimit ? 'fix-then-last-round' : 'fix', blocking: blocking.length })
  // The budget has no room for a reviewer round after this fix: the pull request is read again instead, and settles the round.
  const beyondLimit = s.round > limit || s.afterStop === true
  const readOnly = pullRequestOnly && (over !== undefined || beyondLimit)
  await setSteward($, { ...s, phase: 'fixing', ticking: false, ...(readOnly ? { pullRequestOnly: true } : {}), ...(pastLimit && !readOnly ? { maxRounds: s.round + 1, note: `Still blocking after ${s.round} rounds; round ${s.round + 1} goes past the limit.` } : {}) })
  const served = await servedConfig($)
  const afterFix = served !== null && served.ticket === t.id ? served.briefLines.afterFix : undefined
  await $.prompt.submit({
    text: [`Round ${s.round} review of ${t.id} found ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}. ` + (readOnly ? `Fix each one within the ticket, then stop. No reviewer round is left (${beyondLimit ? 'the round limit is passed' : 'the review budget has no room'}), so tick-it reads the pull request again when you finish: it is clean when CI passes and the branch is not behind its base.` : 'Fix each one within the ticket, then stop. tick-it reviews again when you finish.') + (pastLimit && !readOnly ? ` The next review, round ${s.round + 1}, is the last: ${limit} rounds are the limit and it goes past it.` : ''), ...blocking.map(line => `- ${line}`), ...(afterFix === undefined ? [] : [afterFix])].join('\n'),
  })
}

/** Runs the reviewers Tick-it's `incomplete` round names (those that failed, when it names none) again, each once; false when none can start, and the round is then read by the mod's own rules. */
async function rerunReviewers($: EngineInterface, s: Steward, runs: ReviewRun[], given: TickitRound): Promise<boolean> {
  const failed = runs.filter(r => r.status === 'failed' && r.notApplicable === undefined && r.reason === undefined).map(r => r.skill)
  const fresh: ReviewRun[] = []
  for (const skill of new Set(given.skills.length > 0 ? given.skills : failed)) {
    const last = runs.filter(r => r.skill === skill && r.prompt !== undefined).at(-1)
    // A reviewer already run again once is not run a third time for the same word.
    if (last?.prompt === undefined || last.retry === true) continue
    const description = last.description ?? `tick-it review: ${skill} on ${s.ticket}, round ${s.round}`
    const spawned = await $.agent.spawn({ prompt: last.prompt, description, subagentType: 'general-purpose', model: last.model }).catch(error => ({ deny: error instanceof Error ? error.message : String(error) }) as { deny?: string; agentId?: string; model?: string })
    const agentId = spawned.deny === undefined ? (spawned.agentId ?? (await $.agent.list()).find(a => a.description === description && a.id !== last.agentId)?.id) : undefined
    if (agentId === undefined) continue
    fresh.push({ ...last, description, agentId, model: spawned.model ?? last.model, startedAt: await $.clock.now(), status: 'running', retry: true, blocking: undefined, optional: undefined, findings: undefined, items: undefined, verdicts: undefined, usage: undefined, costUsd: undefined, durationMs: undefined })
  }
  if (fresh.length === 0) return false
  await saveReviews($, list => [...list, ...fresh])
  await update($, tickitRound, () => null)
  await log($, 'debug', 'round-settled', { ticket: s.ticket, round: s.round, outcome: 'incomplete-run-again', skills: fresh.map(r => r.skill).join(',') })
  return true
}

/** What the check-in before going idle found: the next round was started (a resume), or Tick-it's `next` to submit as a prompt. */
export type CheckIn = { resumed?: true; next?: string }

const WAITING_ON = ['session', 'reviewers', 'queue', 'person', 'nothing']

/**
 * At turn end on a ticket In review, before the session goes idle: reports to Tick-it and reads whose move it is (`waitingOn`) and what to do (`next`).
 * With `session` the `next` is submitted as the next prompt, at most once for the same text in a row so an instruction the session cannot meet does not loop; with any other value the session goes idle and the pane says which.
 * A resume instruction starts the next round when the mod stopped stewarding, and is left with a note when the person pressed stop. A Tick-it that answers none of this leaves the session as it was.
 */
export async function checkIn($: EngineInterface): Promise<CheckIn> {
  const s = await read($, steward)
  const started = await read($, startedSession)
  if (s === null || started === null || started.ticket !== s.ticket || s.phase === 'fixing') return {}
  const sent = await report($, s.phase === 'done' ? 'done' : s.phase === 'stopped' ? 'stopped' : 'reviewing', s.note, true)
  if (sent === undefined || !sent.ok) return {}
  if (await read($, resumeAsked)) {
    await update($, resumeAsked, () => false)
    const now = await read($, steward)
    if (now?.phase === 'stopped' && now.stoppedBy === 'mod') {
      await log($, 'debug', 'resumed-by-tickit', { ticket: now.ticket, round: now.round })
      await reviewAgain($)
      return { resumed: true }
    }
    if (now?.phase === 'stopped') {
      await update($, steward, v => (v === null ? v : { ...v, note: `Tick-it asked to resume, but you stopped stewarding, so it stays stopped: r starts the next round.` }))
      await saveResume($)
      $.ui.toast(`tick-it: Tick-it asked to resume ${now.ticket}, but you stopped it; r starts the next round.`)
    }
  }
  const waitingOn = WAITING_ON.find(w => w === sent.value.waitingOn)
  // A value Tick-it did not give (or one the mod does not know) leaves no old one on the pane.
  await update($, steward, v => (v === null ? v : { ...v, ...(waitingOn === undefined ? { waitingOn: undefined } : { waitingOn }) }))
  if (waitingOn === undefined) return {}
  await showStatus($)
  const next = typeof sent.value.next === 'string' ? sent.value.next.trim().slice(0, 500) : ''
  // Another move than the session's own ends the run of the same next: it may be asked again later.
  if (waitingOn !== 'session') await update($, lastNext, () => null)
  if (waitingOn !== 'session' || next === '' || next === (await read($, lastNext))) return {}
  await update($, lastNext, () => next)
  return { next }
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
  const all = await hereRuns($)
  const elsewhere = (await read($, reviews)).length - all.length
  const apart = elsewhere === 0 ? '' : `\n${plural(elsewhere, 'review run')} of other repositories ${elsewhere === 1 ? 'is' : 'are'} not listed.`
  const runs = id === undefined ? all : all.filter(r => r.ticket === id.toUpperCase())
  if (runs.length === 0) return `${id === undefined ? 'No reviews yet.' : `No reviews of ${id.toUpperCase()} yet.`}${apart}`
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
  ].join('\n') + apart
}
