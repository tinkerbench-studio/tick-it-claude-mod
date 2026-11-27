import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolCallInput, ToolCallResult } from 'claude-code'
import type { PendingLink, PendingStop, StartedSession, Ticket, TicketStatus } from '../types'
import { patchFiles } from './security-areas'
import type { ChangedFile } from './security-areas'
import { STARTED_KEY, REPORT_EVERY_MS, answeredIds, REPORT_TOOL, APPROVAL_MESSAGE, SKILLS_DIR, EMPTY_TREE, UNLINKED_KEY, STOPS_KEY, FILE_TYPES, MAX_ATTACH_BYTES, MAX_FILES, MAX_PATH, MAX_FILE_LINES } from './state'
import { sendTickit, callTickit, repositoryHere, sameRepository } from './tickit'
import type { Called } from './tickit'
import { findCurrent, changeTicket, showStatus, save, fromRemote, readTicket, heldUntil } from './board'
import type { RemoteTicket } from './board'
import { findSkills, setSteward } from './reviews'
import { uiEvidenceRefusal } from './ui-check'
import { TESTABLE_UI_FILE } from '../scripts/ui-paths.mjs'
import { runCopiesCheck, copiesRefusal, copiesNote } from './copies-check'
import { log } from './log'
import { saveResume } from './resume'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
const diffLines = atom({ plugin: 'tick-it', key: 'diffLines' } as const, 0)
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
const breakdownSession = atom({ plugin: 'tick-it', key: 'breakdown' } as const, null)
/** The commit the current ticket was taken at, so committing along the way does not reset its count. */
const baseCommit = atom({ plugin: 'tick-it', key: 'baseCommit' } as const, null)
const pullRequest = atom({ plugin: 'tick-it', key: 'pullRequest' } as const, null)
const pullRequestError = atom({ plugin: 'tick-it', key: 'pullRequestError' } as const, null)
const pendingInstructions = atom({ plugin: 'tick-it', key: 'pendingInstructions' } as const, [] as string[])
/** Stop reports Tick-it has not taken yet, sent again with the outbox. */
const unsentStops = atom({ plugin: 'tick-it', key: 'unsentStops' } as const, [] as PendingStop[])
/** A report_session answer carried a resume instruction: the next check-in acts on it. */
const resumeAsked = atom({ plugin: 'tick-it', key: 'resumeAsked' } as const, false)
/** A ticket Claude moved to In review itself: its review agents start when the turn ends. */
const reviewNext = atom({ plugin: 'tick-it', key: 'reviewNext' } as const, null)
/** Whether a turn is running: set when a prompt is submitted, cleared when the main loop's turn ends. */
const turnRunning = atom({ plugin: 'tick-it', key: 'turnRunning' } as const, false)
/** Approval answers that reached the session while no turn was running: submitted as a prompt by the approval timer, or handed to Claude with a prompt typed first, once. */
const approvalAnswers = atom({ plugin: 'tick-it', key: 'approvalAnswers' } as const, [] as string[])
const approvalsTaken = atom({ plugin: 'tick-it', key: 'approvalsTaken' } as const, [] as string[])
/** Tick-it answered a report with the unseen-head instruction: the mod starts the review round itself at the turn's end (TCK-94), and the instruction is not handed to Claude. */
const unseenHead = atom({ plugin: 'tick-it', key: 'unseenHead' } as const, false)
/** The instructions already handed over (or acted on) for a head while nothing changed: what is kept is the kind, the head and the text, so a repeat is told apart from a new commit or answer. */
const handedOver = atom({ plugin: 'tick-it', key: 'handedOver' } as const, [] as string[])
/** link_pull_request calls Tick-it has not taken yet: sent again with the outbox. */
const unlinked = atom({ plugin: 'tick-it', key: 'unlinked' } as const, [])

/** Whether a report_session call is the breakdown session's own: the mod reports for every other session. */
export async function reportsForItself($: Parameters<typeof read>[0], input: unknown) {
  const own = await read($, breakdownSession)
  return own !== null && typeof input === 'object' && input !== null && (input as { session?: unknown }).session === own.id
}

/** A file's text, or '' when it cannot be read (missing, over the read limit). Read directly: no outside command. */
export async function readText($: EngineInterface, path: string): Promise<string> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** Attaches a file (a screenshot, a log) to a note on a ticket's acceptance check with add_attachment; what happened, as a line. */
export async function attachFile($: EngineInterface, ticket: string, note: string, path: string): Promise<string> {
  const repository = await repositoryHere($)
  if (repository === undefined) return 'This folder has no GitHub origin remote, so tick-it does not know where to attach it.'
  let content: string
  try {
    content = (await $.fs.read(path, { as: 'bytes' })).base64
  } catch (error) {
    return `Could not attach ${path}: ${error instanceof Error ? error.message : 'it cannot be read'}.`
  }
  if (content === '') return `Could not attach ${path}: it is empty.`
  const size = Math.floor((content.length * 3) / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0)
  if (size > MAX_ATTACH_BYTES) return `Could not attach ${path}: it is over 3 MB.`
  const name = path.split(/[/\\]/).pop() ?? path
  const type = FILE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
  const sent = await callTickit($, 'add_attachment', { repository, ticket, note, name, type, content })
  return sent.ok ? `Attached ${name} (${type}, ${size} bytes) to note ${note} on ${ticket}.` : `Could not attach ${name}: ${sent.why}.`
}

/** Lines in a text, as wc -l counts them, and a last line with no newline too. */
export const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

/**
 * Changed lines since the ticket was taken (against HEAD when that is not
 * known), untracked files included. Never throws: a count that cannot be made
 * is 0, and must not stop a ticket moving or its review.
 */
export async function measureDiff($: EngineInterface): Promise<number> {
  try {
    return await countDiff($)
  } catch {
    return 0
  }
}

/** The remote's default branch (origin/HEAD, origin/main, origin/master, the first that has a merge base with HEAD) and that merge base, or null when there is none. */
export async function defaultBase($: EngineInterface): Promise<{ ref: string; sha: string } | null> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const mb = await $.process.run(['git', 'merge-base', 'HEAD', ref]).catch(() => undefined)
    const sha = mb?.exitCode === 0 ? mb.stdout.trim() : ''
    if (/^[0-9a-f]{40}$/.test(sha)) return { ref, sha }
  }
  return null
}

/** The merge base of HEAD and the remote's default branch, or null when there is none. */
export async function mergeBaseOfDefault($: EngineInterface): Promise<string | null> {
  return (await defaultBase($))?.sha ?? null
}

/**
 * The commit the ticket's change is measured against: the commit it was taken at, or, once the base branch has been
 * merged into the branch, the merge base of HEAD and the base branch when that is a descendant of the taken commit,
 * so what the merge brought in is not the ticket's. HEAD when no commit was recorded.
 */
export async function measureBase($: EngineInterface): Promise<string> {
  const taken = await read($, baseCommit)
  if (taken === null) return 'HEAD'
  const mb = await mergeBaseOfDefault($)
  if (mb === null || mb === taken) return taken
  const newer = await $.process.run(['git', 'merge-base', '--is-ancestor', taken, mb]).catch(() => undefined)
  return newer?.exitCode === 0 ? mb : taken
}

/** `git diff <args>` against the ticket's base. The empty tree stands in only for a repository with no HEAD; any other failure gives null. */
async function diffAgainstBase($: EngineInterface, args: string[]) {
  const tracked = await $.process.run([...args, await measureBase($)])
  if (tracked.exitCode === 0) return tracked
  // A repository with no commit yet has no HEAD: what it tracks is all new.
  const head = await $.process.run(['git', 'rev-parse', '--verify', 'HEAD'])
  return head.exitCode === 0 ? null : await $.process.run([...args, EMPTY_TREE])
}

/** The lines `old` becomes `new` in a file's text: every occurrence with `all`, else the first; the text itself when `old` is not in it. */
export const applyEdit = (text: string, old: string, replacement: string, all: boolean): string => {
  if (old === '' || !text.includes(old)) return text
  return all ? text.split(old).join(replacement) : text.replace(old, () => replacement)
}

/** How many times `old` is in a text. */
const occurrences = (text: string, old: string): number => (old === '' ? 0 : text.split(old).length - 1)

/**
 * What an edit of one file adds to the ticket's diff, in changed lines, or 0
 * when it adds nothing (a file outside the repository's top level, or one git
 * ignores). With the file's text at the ticket's base readable, the effect is
 * its changed lines against the base after the edit less before it; otherwise
 * the edit's own estimate (lines added plus removed, per occurrence). Never
 * throws: a measure that fails is 0, as the guard lets the edit through.
 */
export async function editEffect(
  $: EngineInterface,
  file: string,
  change: (before: string) => { after: string; estimate: number },
  count: (before: string, after: string) => number,
): Promise<number> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return change(await readText($, file)).estimate
    const root = top.stdout.trim()
    if (root === '' || !file.startsWith(`${root}/`)) return 0
    if ((await $.process.run(['git', 'check-ignore', '-q', '--', file])).exitCode === 0) return 0
    const before = await readText($, file)
    const { after, estimate } = change(before)
    // A file that could not be read, or an edit that finds nothing to change, cannot be measured against the base: the edit's own estimate stands.
    if (before === '' || after === before) return estimate
    // A base that cannot be read, by a non-zero exit or by git failing to run, leaves today's estimate.
    const base = await $.process.run(['git', 'show', `${await measureBase($)}:${file.slice(root.length + 1)}`]).catch(() => null)
    if (base === null || base.exitCode !== 0) return estimate
    return count(base.stdout, after) - count(base.stdout, before)
  } catch {
    return 0
  }
}

/** Occurrences an Edit changes: all of them with replace_all, else one. */
export const editCount = (before: string, old: string, all: boolean): number => (all ? Math.max(1, occurrences(before, old)) : 1)

/** `git diff --numstat` (with `-z` for the per-file rows) against the ticket's base, or null when it cannot be had. */
export async function numstat($: EngineInterface, z = false): Promise<string | null> {
  const tracked = await diffAgainstBase($, z ? ['git', 'diff', '--numstat', '-z'] : ['git', 'diff', '--numstat'])
  return tracked !== null && tracked.exitCode === 0 ? tracked.stdout : null
}

/**
 * Rows of `git diff --numstat -z`: `added TAB removed TAB path NUL`, and for a
 * rename `added TAB removed TAB NUL old NUL new NUL`. Paths come raw, never quoted.
 */
export const numstatFiles = (out: string): Map<string, number> => {
  const files = new Map<string, number>()
  const parts = out.split('\0')
  const num = (n: string) => (/^\d+$/.test(n) ? Number(n) : 0)
  for (let i = 0; i < parts.length; i++) {
    const [added, removed, ...name] = (parts[i] ?? '').split('\t')
    if (added === undefined || removed === undefined || name.length === 0) continue
    let path = name.join('\t')
    if (path === '') {
      // A rename: the next two entries are the old and the new path.
      path = parts[i + 2] ?? ''
      i += 2
    }
    if (path !== '') files.set(path, (files.get(path) ?? 0) + num(added) + num(removed))
  }

  return files
}

export async function untrackedFiles($: EngineInterface): Promise<string[]> {
  const others = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard', '-z'])
  return others.stdout
    .split('\0')
    .filter(f => f !== '')
    .slice(0, 200)
}

export async function countDiff($: EngineInterface): Promise<number> {
  const tracked = await numstat($)
  if (tracked === null) return 0
  let total = 0
  for (const row of tracked.split('\n')) {
    const [added, removed] = row.split('\t')
    if (added !== undefined && /^\d+$/.test(added)) total += Number(added)
    if (removed !== undefined && /^\d+$/.test(removed)) total += Number(removed)
  }
  for (const file of await untrackedFiles($)) total += lineCount(await readText($, file))

  return total
}

/**
 * Lines changed per file, from the same base and files as measureDiff, within
 * what update_ticket accepts (the largest files first when there are too many,
 * no path that is too long). Never throws: files that cannot be listed are
 * none, and must not stop a ticket moving or its review.
 */
export async function measureFiles($: EngineInterface): Promise<{ path: string; lines: number }[]> {
  try {
    const files = numstatFiles((await numstat($, true)) ?? '')
    for (const file of await untrackedFiles($)) files.set(file, lineCount(await readText($, file)))

    return [...files]
      .filter(([path]) => path.length <= MAX_PATH)
      .map(([path, lines]) => ({ path, lines: Math.min(lines, MAX_FILE_LINES) }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, MAX_FILES)
  } catch {
    return []
  }
}

/** How much of an untracked file is read for the words that put a change in a security area. */
const MAX_AREA_TEXT = 200_000

/**
 * The files the ticket changed, each with its changed lines: from the same base and files as measureFiles.
 * A file whose lines cannot be read (a binary, a patch git cut short) still counts by its path. Never throws:
 * a change that cannot be read touches nothing, and must not stop a review.
 */
export async function changedContent($: EngineInterface): Promise<ChangedFile[]> {
  try {
    const args = ['git', 'diff', '-U0', '--no-color', '--no-ext-diff']
    const patch = await diffAgainstBase($, args)
    const files = new Map(patchFiles(patch !== null && patch.exitCode === 0 ? patch.stdout : '').map(f => [f.path, f.lines]))
    for (const path of numstatFiles((await numstat($, true)) ?? '').keys()) if (!files.has(path)) files.set(path, '')
    for (const file of await untrackedFiles($)) files.set(file, (await readText($, file)).slice(0, MAX_AREA_TEXT))

    return [...files].map(([path, lines]) => ({ path, lines }))
  } catch {
    return []
  }
}

export async function refreshDiff($: EngineInterface) {
  const lines = await measureDiff($)
  await update($, diffLines, () => lines)
  await showStatus($)
}

/** What Tick-it answered a report with for the session to do, such as resolving a merge conflict. */
export const instructionsOf = (sent: Called): string[] => (sent.ok && Array.isArray(sent.value.instructions) ? sent.value.instructions.filter((i): i is string => typeof i === 'string') : [])

/** Why the mod stopped (the typed stop of report_session) and the need that goes with it, in the same call. */
export type StopReport = { code: string; skills?: string[]; round?: number; head?: string; need: { kind: 'no-clean-round' | 'session-stopped'; note: string } }

async function saveStops($: EngineInterface, list: PendingStop[]) {
  await update($, unsentStops, () => list)
  await $.store.set(STOPS_KEY, list)
}

/** What Tick-it's answer to a report asks of the session: a resume is noted for the next check-in, and instructions (such as resolving a merge conflict) wait for the turn's end, since submitting from inside a hook would wait on the turn the hook holds. */
async function takeAnswer($: EngineInterface, sent: Called, status?: StartedSession['status']) {
  if (resumeIn(sent)) await update($, resumeAsked, () => true)
  let instructions = instructionsOf(sent).filter(i => !/^resume\b/i.test(i))
  // The unseen-head instruction is never handed to Claude, which may not record runs; the answer to a report that stops the session is not judged again, which is how the loop ends.
  const unseen = instructions.filter(i => UNSEEN_HEAD.test(i))
  instructions = instructions.filter(i => !unseen.includes(i))
  if (status !== 'stopped' && unseen.length > 0 && (await onceForHead($, 'unseen-head', unseen.join('\n')))) await update($, unseenHead, () => true)
  // An approval answer that arrives with no turn running is shown and kept: the approval timer (watchApproval) submits it as a prompt, and a prompt typed first carries it.
  const answers = (await read($, turnRunning)) ? [] : instructions.filter(i => APPROVAL_MESSAGE.test(i))
  if (answers.length > 0) {
    $.ui.toast(`tick-it: ${answers.map(a => a.split('\n').find(line => APPROVAL_MESSAGE.test(line)) ?? a).join(' ')}`.slice(0, 300))
    await update($, approvalAnswers, held => [...held, ...answers])
  }
  const rest = instructions.filter(i => !answers.includes(i))
  if (rest.length > 0) await update($, pendingInstructions, pending => [...pending, ...rest])
}

/** Tick-it's instruction for a head no review has seen (its doneUnseenText): the mod runs that round itself. */
const UNSEEN_HEAD = /\bno review has seen\b/i

/**
 * Whether an instruction may be acted on for the head checked out: true the first time, false when the same text came for the same head (a new commit or a new answer is a new key).
 * A repeat reports the session stopped with a need, so a person sees it instead of the mod asking again every turn (TCK-94).
 */
async function onceForHead($: EngineInterface, kind: string, text: string): Promise<boolean> {
  const head = (await $.process.run(['git', 'rev-parse', 'HEAD']).catch(() => undefined))?.stdout.trim() ?? ''
  const s = await read($, startedSession)
  const key = `${kind}|${head}|${text}`
  if (!(await read($, handedOver)).includes(key)) {
    await update($, handedOver, list => [...list, key].slice(-20))
    return true
  }
  const why = kind === 'unseen-head' ? 'Tick-it keeps answering that this head is one no review has seen' : 'Tick-it keeps refusing the done report'
  const note = `${why}, and nothing has changed since the mod acted on it (head ${head.slice(0, 7) || 'unknown'}), so it is not asked again.`
  const code = kind === 'unseen-head' ? 'unseen-head-repeated' : 'done-refused-repeated'
  const stop = { code, ...(head === '' ? {} : { head }), need: { kind: 'session-stopped' as const, note } }
  const stewarding = await read($, steward)
  if (stewarding !== null && stewarding.ticket === s?.ticket) await setSteward($, { ...stewarding, phase: 'stopped', stoppedBy: 'mod', note }, stop)
  else await report($, 'stopped', note, true, stop)
  return false
}

/** Sends the stop reports Tick-it has not taken yet, once each; the ones that fail stay with their need. */
export async function sendWaitingStops($: EngineInterface): Promise<void> {
  const repository = await repositoryHere($)
  for (const stop of await read($, unsentStops)) {
    // A stop kept for another repository, or with no repository to judge it by, waits.
    if (repository === undefined || !sameRepository(stop.repository, repository)) continue
    // A session of this Claude session resumed since the stop is not stopped any more: the stale report is dropped, never sent. A stop kept by an earlier Claude session has no steward here to judge it by, and is sent.
    const mine = (await read($, startedSession))?.id === stop.session
    if (mine && (await read($, steward))?.phase !== 'stopped') {
      await saveStops($, (await read($, unsentStops)).filter(w => w.session !== stop.session))
      continue
    }
    const sent = await callTickit($, REPORT_TOOL, stop.args).catch(() => ({ ok: false as const, why: 'unreachable' }))
    if (sent.ok) {
      await saveStops($, (await read($, unsentStops)).filter(w => w.session !== stop.session))
      if (mine) await takeAnswer($, sent, 'stopped')
    }
  }
}

/** Whether Tick-it's answer asks the session to resume: a `resume` field, or an instruction that starts with the word. Such an instruction is not handed to Claude. */
const resumeIn = (sent: Called): boolean => sent.ok && (sent.value.resume === true || (typeof sent.value.resume === 'string' && sent.value.resume !== '') || instructionsOf(sent).some(i => /^resume\b/i.test(i)))

/** The reason Tick-it's answer gives for a stopped session (a `sessionStopped` that is true, a string or an object with a `reason`/`note`); undefined when it carries none. */
export const stoppedIn = (value: unknown): string | undefined => {
  const v = typeof value === 'object' && value !== null ? (value as { sessionStopped?: unknown }).sessionStopped : undefined
  if (v === undefined || v === null || v === false) return undefined
  const why = typeof v === 'string' ? v : typeof v === 'object' ? ((v as { reason?: unknown; note?: unknown }).reason ?? (v as { note?: unknown }).note) : undefined
  return typeof why === 'string' && why !== '' ? why.slice(0, 200) : 'no reason given'
}

/** Tick-it said its session for the ticket is stopped (the answer of set_criterion_checked, add_criterion_note or record_runs): the pane shows it and Claude is told, so it does not say the ticket will merge. */
export async function heardSessionStopped($: EngineInterface, value: unknown): Promise<void> {
  const why = stoppedIn(value)
  if (why === undefined) return
  const started = await read($, startedSession)
  const text = `tick-it: Tick-it says this session's Tick-it session${started === null ? '' : ` ${started.id} on ${started.ticket}`} is stopped (${why}), so Tick-it will not merge the ticket yet. Do not tell the person it will merge. To resume it, finish this turn: the mod reports to Tick-it, whose answer starts the next review round, or the person presses r in the stewarding pane.`
  await update($, pendingInstructions, pending => (pending.includes(text) ? pending : [...pending, text]))
  if ((await read($, steward)) !== null) await update($, steward, v => (v === null ? v : { ...v, tickitStopped: `Tick-it says its session is stopped: ${why}.` }))
  $.ui.toast(`tick-it: Tick-it says its session${started === null ? '' : ` on ${started.ticket}`} is stopped (${why}).`)
}

/**
 * Tells Tick-it how the session it started is going. Best effort: a report that
 * cannot be sent is not retried, since the next one says the same and more; a stop is the exception:
 * it carries the need, so one that cannot be sent is kept and sent again with the outbox.
 */
export async function report($: EngineInterface, status: StartedSession['status'], summary?: string, force = false, stop?: StopReport): Promise<Called | undefined> {
  const s = await read($, startedSession)
  if (s === null) return undefined
  const now = await $.clock.now()
  if (!force && s.status === status && now - s.reportedAt < REPORT_EVERY_MS) return undefined
  const args = {
    repository: s.repository,
    session: s.id,
    status,
    changedLines: await read($, diffLines),
    ...(summary === undefined ? {} : { summary: summary.slice(0, 500) }),
    ...(stop === undefined ? {} : { stop: { code: stop.code, ...(stop.skills === undefined ? {} : { skills: stop.skills }), ...(stop.round === undefined ? {} : { round: stop.round }), ...(stop.head === undefined ? {} : { head: stop.head }) }, needsHuman: { kind: stop.need.kind, note: stop.need.note.slice(0, 200) } }),
  }
  const sent = await callTickit($, REPORT_TOOL, args).catch(() => ({ ok: false as const, why: 'unreachable' }))
  await log($, sent.ok ? 'info' : 'warn', 'report', { ticket: s.ticket, session: s.id, claudeSession: s.claudeSession, status, sent: sent.ok, ...(stop === undefined ? {} : { stop: stop.code }) })
  const next = { ...s, status, reportedAt: sent.ok ? now : s.reportedAt, ...(status === 'waiting' ? { waitingLines: await read($, diffLines) } : {}) }
  await update($, startedSession, () => next)
  await $.store.set(STARTED_KEY, next)
  // A stop that did not get through keeps its need; one that did, or a live report after it, makes the waiting one stale.
  const waiting = (await read($, unsentStops)).filter(w => w.session !== s.id)
  if (stop !== undefined && !sent.ok) await saveStops($, [...waiting, { repository: s.repository, session: s.id, args }])
  else if ((stop !== undefined || status !== 'stopped') && sent.ok) await saveStops($, waiting)
  await takeAnswer($, sent, status)
  // A waiting session asks Tick-it for its answer once a minute while idle; any other status ends that.
  if (status === 'waiting') watchApproval($)
  else stopWatching()
  // A done report Tick-it refused (behind, conflicting) was only logged: its refusal text is handed to Claude, once for the head (TCK-94).
  if (!sent.ok && status === 'done' && sent.refused === true) {
    // Tick-it's words are data: plain characters on one line, in quotes, never a second instruction.
    const refusal = sent.why.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 400)
    const advice = /behind|conflict/i.test(refusal) ? ' The pull request is behind the base or conflicts with it: merge the base into the branch (git merge, never rebase) and push; the mod reports done again at the turn\'s end.' : ''
    const text = `tick-it: Tick-it refused the done report for ${s.ticket}. Its answer, quoted as data: ${JSON.stringify(refusal)}.${advice}`
    if (await onceForHead($, 'done-refused', sent.why)) await update($, pendingInstructions, pending => (pending.includes(text) ? pending : [...pending, text]))
  }

  return sent
}

/** The timer that asks for the approval answer while the session is idle (TCK-95): one at a time, cancelled when the session stops waiting or ends. */
let approvalTimer: { cancel(): void } | undefined

/** Stops the approval timer, if one runs. */
export function stopWatching(): void {
  approvalTimer?.cancel()
  approvalTimer = undefined
}

/** Hands an approval answer kept while no turn ran to Claude as a prompt of its own, once: the session reports working, so the timer ends. */
async function handOverAnswer($: EngineInterface): Promise<void> {
  const answers = await read($, approvalAnswers)
  if (answers.length === 0) return
  await update($, approvalAnswers, () => [])
  await update($, approvalsTaken, taken => [...taken, ...answeredIds(answers)])
  await report($, 'working', 'The approval was answered; continuing.', true)
  await $.prompt.submit({ text: answers.join('\n\n') })
}

/** While the session is waiting on an approval, once a minute (it also runs with no turn): reports waiting to hear the answer and submits one that comes back. A turn running leaves it to the turn's end. */
function watchApproval($: EngineInterface): void {
  if (approvalTimer !== undefined) return
  approvalTimer = $.clock.every(REPORT_EVERY_MS, async () => {
    const s = await read($, startedSession)
    if (s === null || s.status !== 'waiting') return stopWatching()
    if (await read($, turnRunning)) return
    await handOverAnswer($)
    if ((await read($, startedSession))?.status !== 'waiting') return
    await report($, 'waiting', 'Waiting for the approval to be answered.', true)
    await handOverAnswer($)
  })
}

/** The repository's default branch: origin/HEAD's, else main or master. */
async function defaultBranches($: EngineInterface): Promise<string[]> {
  const head = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => undefined)
  const name = head?.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : ''
  return name === '' ? ['main', 'master'] : [name]
}

/**
 * Tells Tick-it the branch the ticket was built on and, if one is open, its pull
 * request (from gh), so GitHub's events about it reach the ticket. Best effort:
 * with no gh, the branch alone still ties a later pull request to it.
 */
export async function recordPullRequest($: EngineInterface, ticket: string) {
  const repository = await repositoryHere($)
  const branch = (await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (repository === undefined || branch === '' || branch === 'HEAD') return
  // The default branch is no ticket's branch: linking it would tie every later pull request to the ticket.
  if ((await defaultBranches($)).includes(branch)) return
  const pr = await $.process.run(['gh', 'pr', 'view', '--json', 'number']).catch(() => undefined)
  let number: number | undefined
  try {
    const parsed = pr?.exitCode === 0 ? (JSON.parse(pr.stdout) as { number?: unknown }) : {}
    if (typeof parsed.number === 'number') number = parsed.number
  } catch {
    // Not JSON: no pull request to record.
  }
  await sendLink($, { repository, key: ticket, branch, ...(number === undefined ? {} : { number }) })
}

export async function saveUnlinked($: EngineInterface, list: PendingLink[]) {
  await update($, unlinked, () => list)
  await $.store.set(UNLINKED_KEY, list)
}

/**
 * Sends a link_pull_request call; one that fails waits in the unlinked list
 * (the newest per ticket) instead of being dropped, and is sent again by
 * sendWaitingLinks. Tick-it also finds the pull request by itself from GitHub,
 * so this only makes the link quicker.
 */
export async function sendLink($: EngineInterface, link: PendingLink, retry = false): Promise<void> {
  const sent = await sendTickit($, 'link_pull_request', link)
  // Tick-it answering with an error (no such ticket, no scope) would answer the same again: only a call that did not get through waits.
  const list = await read($, unlinked)
  const same = (l: PendingLink) => l.repository === link.repository && l.key === link.key
  const identical = (l: PendingLink) => same(l) && l.branch === link.branch && l.number === link.number
  // A resend whose entry was replaced meanwhile by a newer link leaves the newer one alone.
  if (retry && !list.some(identical)) return
  await saveUnlinked($, [...list.filter(l => !same(l)), ...(sent.ok ? [] : [link])])
}

/** Sends the link calls Tick-it has not taken yet, once each; the ones that fail stay. */
export async function sendWaitingLinks($: EngineInterface): Promise<void> {
  for (const link of await read($, unlinked)) await sendLink($, link, true)
}

/** The first line of an answer, as a session's latest word. */
export const firstLine = (answer: string) =>
  answer
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '')
    ?.slice(0, 300)

/** Takes a ticket whose key is known: it is read with get_ticket, never by reading the whole board (list_tickets is for the board command and pane). */
export async function take($: EngineInterface, id: string): Promise<Ticket | string> {
  const wanted = id.toUpperCase()
  const problem = await readTicket($, wanted)
  if (problem !== undefined) return /\bno ticket\b/i.test(problem) ? `No ticket ${id}. Try /tick-it board.` : `Could not read ${wanted}: ${problem}.`
  // A mistyped key must not reopen finished work, though Tick-it's move rules allow it: nothing is written.
  const status = (await read($, tickets)).find(t => t.id === wanted)?.status
  if (status === 'Done' || status === 'Superseded' || status === 'Dropped') return `${wanted} is finished (${status}), so it was not taken. Check the key; a finished ticket is not reopened here.`
  // A ticket held until a date is not taken: nothing is written, so it stays unassigned and out of In progress (Tick-it refuses its start for the same hold). Only a Backlog or Ready ticket counts, as on the server: one already in flight (In progress, In review) is resumed, never refused for a hold.
  const held = (await read($, tickets)).find(t => t.id === wanted)
  const until = held === undefined || (held.status !== 'Backlog' && held.status !== 'Ready') ? undefined : heldUntil(held)
  if (until !== undefined) return `${wanted} is held until ${until} (its notBefore), so it was not taken. Take it once that date has come.`
  // Tick-it answers the session it keeps for this: one it started, or one it made now. Reports go to it.
  const adopt = async (session: string) => {
    const repository = await repositoryHere($)
    const s = await read($, startedSession)
    if (repository === undefined || (s !== null && s.id === session)) return
    // Its first latest word goes at once: Tick-it already has it as working.
    const next: StartedSession = { id: session, repository, ticket: wanted, status: 'working', reportedAt: (await $.clock.now()) - REPORT_EVERY_MS, claudeSession: await $.session.id() }
    await update($, startedSession, () => next)
    await $.store.set(STARTED_KEY, next)
  }
  const why = await changeTicket($, wanted, { status: 'In progress', assignee: 'me' }, adopt)
  if (why !== undefined) return `Could not take ${wanted}: ${why}.`
  const was = await read($, current)
  if (was !== null && was !== wanted) await changeTicket($, was, { status: 'Ready', assignee: null })
  await update($, current, () => wanted)
  await update($, pullRequest, () => null)
  await update($, pullRequestError, () => null)
  if (was !== wanted) {
    const head = await $.process.run(['git', 'rev-parse', 'HEAD'])
    await update($, baseCommit, () => (head.exitCode === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null))
  }
  await saveResume($)
  await refreshDiff($)

  return (await read($, tickets)).find(one => one.id === wanted) ?? `No ticket ${id}.`
}

/** Takes a ticket into the session without moving it (a continue line): it is read with get_ticket, and its status and assignee stay as they are. */
export async function resume($: EngineInterface, id: string): Promise<Ticket | string> {
  const wanted = id.toUpperCase()
  const problem = await readTicket($, wanted)
  if (problem !== undefined) return /\bno ticket\b/i.test(problem) ? `No ticket ${id}. Try /tick-it board.` : `Could not read ${wanted}: ${problem}.`
  const was = await read($, current)
  await update($, current, () => wanted)
  await update($, pullRequest, () => null)
  await update($, pullRequestError, () => null)
  if (was !== wanted) {
    const head = await $.process.run(['git', 'rev-parse', 'HEAD'])
    await update($, baseCommit, () => (head.exitCode === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null))
  }
  await saveResume($)
  await refreshDiff($)
  return (await read($, tickets)).find(one => one.id === wanted) ?? `No ticket ${id}.`
}

/** The per-file lines sent with a move to review; nothing when there are none, so the areas stay as they were. */
export async function changedFiles($: EngineInterface, status: TicketStatus) {
  const files = status === 'In review' ? await measureFiles($) : []
  return files.length > 0 ? { changedFiles: files } : {}
}

/** The refusal for the current ticket's UI change that lacks its pictures, or undefined. */
export async function uiRefusal($: EngineInterface, ticket: string): Promise<string | undefined> {
  const paths = await changedPaths($)
  return uiEvidenceRefusal($, ticket, paths, typeof paths === 'string' ? [] : await storyContent($, paths))
}

/** The changed paths, or why git cannot list them: the UI gate refuses on a change it cannot see (measureFiles alone gives none then). */
async function changedPaths($: EngineInterface): Promise<string[] | string> {
  try {
    if ((await numstat($, true)) === null) return "git diff against the ticket's base failed"
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return (await measureFiles($)).map(f => f.path)
}

/** The changed lines of the ticket, read only when a story or .storybook/ file changed (the only files that can be test-only): any other change reads no patch. */
async function storyContent($: EngineInterface, paths: readonly string[]) {
  return paths.some(p => TESTABLE_UI_FILE.test(p)) ? changedContent($) : []
}

/** The current ticket's copies:check as the steward command needs it: the refusal when it fails, or the note when it could not run; neither when it passed or there is none. */
export async function copiesGate($: EngineInterface, ticket: string): Promise<{ refusal?: string; note?: string }> {
  const copies = await runCopiesCheck($)
  if (copies.kind === 'failed') return { refusal: copiesRefusal(ticket, copies.output) }
  return copies.kind === 'unrun' ? { note: copiesNote(copies.why) } : {}
}

export async function finish($: EngineInterface, status: TicketStatus): Promise<string> {
  const t = await findCurrent($)
  if (t === undefined) return 'No ticket taken. Try /tick-it board or /tick-it take <id>.'
  let copiesUnrun: string | undefined
  // A UI change goes to review with its before/after pictures, or not at all: the reviewer would only send it back.
  if (status === 'In review') {
    const paths = await changedPaths($)
    const missing = await uiEvidenceRefusal($, t.id, paths, typeof paths === 'string' ? [] : await storyContent($, paths))
    if (missing !== undefined) return missing
    // The repository's own stale-copy check (its package.json copies:check script) must pass: a failure refuses the move and changes nothing. A check that cannot run is only said, with the move.
    const copies = await runCopiesCheck($)
    if (copies.kind === 'failed') return copiesRefusal(t.id, copies.output)
    if (copies.kind === 'unrun') copiesUnrun = copiesNote(copies.why)
  }
  // Going to review, the ticket's changed lines go with it, for estimate against actual.
  const why = await changeTicket($, t.id, status === 'Ready' ? { status, assignee: null } : { status, changedLines: await measureDiff($), ...(await changedFiles($, status)) })
  if (why !== undefined) return `${t.id} is still yours: ${why}.`
  await update($, current, () => null)
  await update($, baseCommit, () => null)
  await saveResume($)
  await showStatus($)
  if ((await read($, startedSession))?.ticket === t.id) {
    await report($, status === 'In review' ? 'reviewing' : 'stopped', status === 'In review' ? `Moved to In review.` : 'Put back in Ready.', true)
  }

  return status === 'In review' ? `${t.id} moved to In review.${copiesUnrun === undefined ? '' : `\n${copiesUnrun}`}` : `${t.id} put back in Ready.`
}

/**
 * Claude finishing the ticket itself (update_ticket to In review), as a
 * session Tick-it started does with no one there to type /tick-it done, is
 * /tick-it done: the mod moves it with its changed lines and pull request, and
 * its review agents start when the turn ends.
 */
export async function finishedByClaude($: EngineInterface, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>): Promise<ToolCallResult> {
  const input = e as { key?: unknown; repository?: unknown; status?: unknown }
  // The same key in another repository is another ticket (GitHub names are case-insensitive).
  if (!sameRepository(input.repository, await repositoryHere($))) return next(e)
  const t = await findCurrent($)
  if (input.status === 'In review' && typeof input.key === 'string' && t === undefined) return fixAfterStop($, input.key.toUpperCase(), e, next)
  if (input.status !== 'In review' || typeof input.key !== 'string' || t === undefined || input.key.toUpperCase() !== t.id) return next(e)
  let unrun: string | undefined
  try {
    await recordPullRequest($, t.id)
    const moved = await finish($, 'In review')
    if ((await read($, current)) !== null) return { deny: `tick-it: ${moved}` }
    unrun = moved.split('\n').find(line => line.includes('could not run'))
  } catch (error) {
    // The turn's end looks again: Tick-it will have the ticket In review once Claude's own call runs.
    await report($, 'working', `Could not take ${t.id} to review yet: ${error instanceof Error ? error.message : String(error)}`.slice(0, 450), true)
    return next(e)
  }
  await update($, reviewNext, () => t.id)
  await saveResume($)
  if ((await read($, startedSession))?.ticket === t.id) await report($, 'reviewing', `Claude moved ${t.id} to In review; its review agents start when this turn ends.`, true)
  const ran = await next(e)
  if (!('result' in ran) || ran.isError === true) return ran
  const skills = (await findSkills($)).length
  return {
    ...ran,
    context: [...(ran.context ?? []), ...(unrun === undefined ? [] : [`tick-it: ${unrun}`]), skills === 0 ? `tick-it: ${t.id} is In review. There are no review skills in ${SKILLS_DIR}, so when this turn ends it goes to Done without review.` : `tick-it: ${t.id} is In review. When this turn ends tick-it runs its review agents; their blocking findings come back to you to fix.`],
  }
}

/**
 * Claude moving a ticket to In review again after the mod stopped stewarding it
 * itself (the round limit or the review budget): the fix it pushed is reviewed
 * once, when the turn ends, and the outcome is reported. A stop the person
 * pressed (no stoppedBy) is left alone, as is a stop after that one review (afterStop: a person is asked), as is any ticket not being stewarded.
 */
async function fixAfterStop($: EngineInterface, key: string, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>): Promise<ToolCallResult> {
  const s = await read($, steward)
  if (s === null || s.phase !== 'stopped' || s.stoppedBy !== 'mod' || s.afterStop === true || s.ticket !== key) return next(e)
  // The same key in another repository is another ticket.
  const given = (e as { repository?: unknown }).repository
  if (typeof given === 'string' && !sameRepository(given, await repositoryHere($))) return next(e)
  const ran = await next(e)
  if (!('result' in ran) || ran.isError === true) return ran
  // The state may have changed while Tick-it answered (the stop button, r): only the stop the mod made is carried on.
  const now = await read($, steward)
  if (now === null || now.phase !== 'stopped' || now.stoppedBy !== 'mod' || now.ticket !== key) return ran
  // The ticket is already In review with its changed lines and UI evidence from the first move: only its pull request is recorded again, as the fix may have opened one.
  await recordPullRequest($, key).catch(() => undefined)
  await setSteward($, { ticket: key, round: now.round, phase: 'fixing', maxRounds: Math.max(now.maxRounds, now.round + 1), ticking: false, afterStop: true, note: `Reviewing the fix made after stewarding stopped: round ${now.round + 1} starts when this turn ends.` })
  return { ...ran, context: [...(ran.context ?? []), `tick-it: stewarding of ${key} had stopped. Its fix is reviewed once when this turn ends (round ${now.round + 1}); if that still has blocking findings it stops again and a person is asked.`] }
}

/** Whether Tick-it said the head is one no review has seen: read once, the mod then starts the round itself. */
export async function takeUnseenHead($: EngineInterface): Promise<boolean> {
  const asked = await read($, unseenHead)
  if (asked) await update($, unseenHead, () => false)
  return asked
}
