import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolCallInput, ToolCallResult } from 'claude-code'
import type { PendingLink, StartedSession, Ticket, TicketStatus } from '../types'
import { patchFiles } from './security-areas'
import type { ChangedFile } from './security-areas'
import { STARTED_KEY, REPORT_EVERY_MS, REPORT_TOOL, SKILLS_DIR, EMPTY_TREE, UNLINKED_KEY, FILE_TYPES, MAX_ATTACH_BYTES, MAX_FILES, MAX_PATH, MAX_FILE_LINES } from './state'
import { sendTickit, callTickit, repositoryHere } from './tickit'
import type { Called } from './tickit'
import { findCurrent, changeTicket, showStatus, save, fromRemote, readTicket, heldUntil } from './board'
import type { RemoteTicket } from './board'
import { findSkills, setSteward } from './reviews'
import { uiEvidenceRefusal } from './ui-check'
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
/** A ticket Claude moved to In review itself: its review agents start when the turn ends. */
const reviewNext = atom({ plugin: 'tick-it', key: 'reviewNext' } as const, null)
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

/** The merge base of HEAD and the remote's default branch (origin/HEAD, origin/main, origin/master, the first that has one), or null when there is none. */
export async function mergeBaseOfDefault($: EngineInterface): Promise<string | null> {
  for (const base of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const mb = await $.process.run(['git', 'merge-base', 'HEAD', base]).catch(() => undefined)
    const sha = mb?.exitCode === 0 ? mb.stdout.trim() : ''
    if (/^[0-9a-f]{40}$/.test(sha)) return sha
  }
  return null
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

/**
 * Tells Tick-it how the session it started is going. Best effort: a report that
 * cannot be sent is not retried, since the next one says the same and more.
 */
export async function report($: EngineInterface, status: StartedSession['status'], summary?: string, force = false) {
  const s = await read($, startedSession)
  if (s === null) return
  const now = await $.clock.now()
  if (!force && s.status === status && now - s.reportedAt < REPORT_EVERY_MS) return
  const sent = await callTickit($, REPORT_TOOL, {
    repository: s.repository,
    session: s.id,
    status,
    changedLines: await read($, diffLines),
    ...(summary === undefined ? {} : { summary: summary.slice(0, 500) }),
  }).catch(() => ({ ok: false as const, why: 'unreachable' }))
  await log($, sent.ok ? 'info' : 'warn', 'report', { ticket: s.ticket, session: s.id, claudeSession: s.claudeSession, status, sent: sent.ok })
  const next = { ...s, status, reportedAt: sent.ok ? now : s.reportedAt }
  await update($, startedSession, () => next)
  await $.store.set(STARTED_KEY, next)
  // Tick-it hands over what it wants the session to do, such as resolving a merge conflict on its pull request.
  const instructions = instructionsOf(sent)
  // Submitting from inside a hook would wait on the turn the hook holds: the next turn.complete hands them to Claude.
  if (instructions.length > 0) await update($, pendingInstructions, pending => [...pending, ...instructions])
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
  return uiEvidenceRefusal(
    $,
    ticket,
    (await measureFiles($)).map(f => f.path),
  )
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
    const missing = await uiEvidenceRefusal(
      $,
      t.id,
      (await measureFiles($)).map(f => f.path),
    )
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
  const input = e as { key?: unknown; status?: unknown }
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
  if (typeof given === 'string' && given !== (await repositoryHere($))) return next(e)
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
