import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { DroppedRun, OutboxRun, TickitRound } from '../types'
import { OUTBOX_KEY, DROPPED_KEY, KEEP_DROPPED, BATCH_SIZE, RECORD_TOOL, AGENTS_TOOL } from './state'
import { sendTickit, textOf, repositoryHere, madeHere } from './tickit'
import { sendWaitingLinks, sendWaitingStops, heardSessionStopped } from './work'
import { findSkills, saveReviews } from './reviews'
import { log } from './log'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const outbox = atom({ plugin: 'tick-it', key: 'outbox' } as const, [])
const syncError = atom({ plugin: 'tick-it', key: 'syncError' } as const, null)
const dropped = atom({ plugin: 'tick-it', key: 'dropped' } as const, [])
/** link_pull_request calls Tick-it has not taken yet: sent again with the outbox. */
const unlinked = atom({ plugin: 'tick-it', key: 'unlinked' } as const, [])
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
/** What Tick-it's record_runs answer said of the round (roundVerdict and next), read by settleRound. */
const tickitRound = atom({ plugin: 'tick-it', key: 'tickitRound' } as const, null as TickitRound | null)

/** What record_runs answers, as JSON text (a plugin is handed the content blocks only, but a structuredContent is read when there is one). */
export type RecordAnswer = { accepted: string[]; rejected: { agentId: string; reason: string }[]; roundVerdict?: unknown; next?: unknown; sessionStopped?: unknown; reviewers?: unknown; skills?: unknown }

const VERDICTS = ['clean', 'blocked', 'incomplete', 'running'] as const

/**
 * The round verdict of a record_runs answer for the round of `run`: `roundVerdict` is one of clean, blocked, incomplete or running, as a word or as an object with the word
 * (`verdict`, `value`, `state` or `status`) and the reviewers it names (`skills` or `reviewers`, also read beside it in the answer), and `next` says what to do. Undefined when the answer carries none, so the mod reads the round itself.
 */
export const readRound = (answer: RecordAnswer, run: { ticket: string; round?: number } | undefined): TickitRound | undefined => {
  const v = answer.roundVerdict
  const obj = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const word = typeof v === 'string' ? v : [obj.verdict, obj.value, obj.state, obj.status].find((w): w is string => typeof w === 'string')
  const verdict = VERDICTS.find(x => x === word?.toLowerCase())
  if (verdict === undefined || run === undefined || run.round === undefined) return undefined
  const named = [obj.skills, obj.reviewers, answer.skills, answer.reviewers].find(Array.isArray) as unknown[] | undefined
  const next = [obj.next, answer.next].find((n): n is string => typeof n === 'string' && n.trim() !== '')
  return { ticket: run.ticket, round: run.round, verdict, skills: (named ?? []).filter((n): n is string => typeof n === 'string'), ...(next === undefined ? {} : { next: next.slice(0, 500) }) }
}

export const readAnswer = (result: { content: readonly { type: string; text?: string }[]; structuredContent?: unknown }): RecordAnswer | undefined => {
  const isAnswer = (v: unknown): v is RecordAnswer => typeof v === 'object' && v !== null && Array.isArray((v as RecordAnswer).accepted) && Array.isArray((v as RecordAnswer).rejected)
  if (isAnswer(result.structuredContent)) return result.structuredContent
  for (const block of result.content) {
    if (block.type !== 'text' || block.text === undefined) continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (isAnswer(parsed)) return parsed
    } catch {
      // Not JSON: keep looking.
    }
  }

  return undefined
}

/** "TCK-143 principal round 1", "TCK-143 build turn": how a run is named in /tick-it reviews. */
export const describeRun = (run: OutboxRun): string => ('kind' in run ? `${run.ticket} ${run.kind} turn` : `${run.ticket} ${run.skill} round ${run.round}`)

/** A run carries the repository it was made in; one with none is stamped with the repository it is first read in. */
const stamp = (runs: OutboxRun[], repository: string | undefined): OutboxRun[] => runs.map(r => (r.repository === undefined && repository !== undefined ? { ...r, repository } : r))

export async function queue($: EngineInterface, runs: OutboxRun[]) {
  const list = stamp([...(await read($, outbox)), ...runs], await repositoryHere($))
  await update($, outbox, () => list)
  await $.store.set(OUTBOX_KEY, list)
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Tells Tick-it which review agents the repository defines: each skill in .tick-it/skills with its
 * name, description, model, sizes and path globs. Tick-it replaces what it held, so a skill removed from the
 * repository is gone at the next report. Failing to reach it is not an error: the next session sends them again.
 */
export async function reportAgents($: EngineInterface): Promise<void> {
  const repository = await repositoryHere($)
  if (repository === undefined) return
  const agents = (await findSkills($)).map(({ skill }) => ({
    skill: skill.name.slice(0, 100),
    description: skill.description.slice(0, 2000),
    ...(skill.model === undefined ? {} : { model: skill.model.slice(0, 100) }),
    sizes: skill.sizes ?? [],
    paths: (skill.paths ?? []).slice(0, 20).map(glob => glob.slice(0, 200)),
  }))
  await sendTickit($, AGENTS_TOOL, { repository, agents: agents.slice(0, 50) })
}

/** A run as Tick-it takes it: its findings are its items, without an earlier blocker verified open (Tick-it adds those to the blocking count itself, from the run's verdicts). */
export const sendable = ({ epic: _epic, repository: _repository, claudeSession: _session, prompt: _prompt, description: _description, retry: _retry, ...run }: OutboxRun & { claudeSession?: string; prompt?: string; description?: string; retry?: true }) => {
  // The epic's title stays here: Tick-it knows the ticket's epic, and no title goes to its tools. The repository is the call's own field, not each run's. Nor does the Claude Code session a run was spawned in, or the prompt, description and retry marker kept for a restart.
  if (!('findings' in run || 'items' in run)) return run
  const { findings: _findings, items, ...rest } = run as typeof run & { items?: { open?: true }[]; blocking?: number }
  if (items === undefined) return rest
  const held = items.filter(i => i.open === true).length
  return { ...rest, ...(held === 0 || rest.blocking === undefined ? {} : { blocking: rest.blocking - held }), findings: items.filter(i => i.open !== true) }
}

/** Takes the runs an older mod stored with no repository for the repository they are first read in: the outbox, the dropped runs and the review history. */
export async function adoptRuns($: EngineInterface): Promise<void> {
  const repository = await repositoryHere($)
  if (repository === undefined) return
  const waiting = await read($, outbox)
  if (waiting.some(r => r.repository === undefined)) {
    const list = stamp(waiting, repository)
    await update($, outbox, () => list)
    await $.store.set(OUTBOX_KEY, list)
  }
  const gone = await read($, dropped)
  if (gone.some(d => d.run.repository === undefined)) {
    const list = gone.map(d => ({ ...d, run: stamp([d.run], repository)[0]! }))
    await update($, dropped, () => list)
    await $.store.set(DROPPED_KEY, list)
  }
  await saveReviews($, list => list)
}

/** Sends this repository's part of the outbox to Tick-it; answers what happened, for /tick-it sync. Runs made in other repositories stay waiting. */
export async function flush($: EngineInterface): Promise<string> {
  await sendWaitingLinks($).catch(() => undefined)
  await sendWaitingStops($).catch(() => undefined)
  await adoptRuns($)
  const repository = await repositoryHere($)
  const all = await read($, outbox)
  const waiting = all.filter(r => madeHere(r, repository))
  const elsewhere = all.length - waiting.length
  const other = elsewhere === 0 ? '' : ` ${plural(elsewhere, 'run')} ${elsewhere === 1 ? 'waits' : 'wait'} for other repositories.`
  const links = (await read($, unlinked)).length
  if (waiting.length === 0) return `${links === 0 ? 'Nothing waiting to send to Tick-it.' : `${plural(links, 'pull request link')} still waiting to send to Tick-it.`}${other}`

  const accepted = new Set<string>()
  const refused: DroppedRun[] = []
  let failure: string | null = null
  if (repository === undefined) {
    failure = 'this folder has no GitHub origin remote, so Tick-it would not know the repository'
  } else {
    const session = await $.session.id()
    // The Tick-it session (s_…) the session took a ticket for: Tick-it's review hold matches a run on it, since a routine-started session's Claude Code id there is the claude.ai one. Left out when no ticket was taken.
    const tickitSession = (await read($, startedSession))?.id
    // Tick-it takes at most 500 runs a call: they go in calls of BATCH_SIZE, and a call that fails leaves only its own runs waiting.
    for (let from = 0; from < waiting.length; from += BATCH_SIZE) {
      const batch = waiting.slice(from, from + BATCH_SIZE)
      const sent = await sendTickit($, RECORD_TOOL, place => ({
        session,
        ...(tickitSession === undefined ? {} : { tickitSession }),
        // owner/name, as Tick-it knows the repository: not the remote's URL.
        repository,
        // Each review run carries its findings with their text, parsed from its BLOCKING and OPTIONAL lines.
        runs: batch.map(run => ({
          place,
          ...sendable(run),
        })),
      }))
      let why: string | null = null
      let answer: RecordAnswer | undefined
      if (!sent.ok) why = sent.why
      else if (sent.result.isError) why = `Tick-it refused the call${textOf(sent.result) ? `: ${textOf(sent.result)}` : ''}`
      else {
        answer = readAnswer(sent.result)
        if (answer === undefined) why = `Tick-it's answer did not say which runs it took`
      }
      // A send that failed leaves no answer to follow, and an older one for the round no longer stands.
      if (answer === undefined) await update($, tickitRound, () => null)
      if (answer !== undefined) {
        const round = readRound(answer, batch.filter(r => 'skill' in r && r.round !== undefined).at(-1))
        // An answer with no verdict replaces an older one for the round: it falls back to the mod's own reading.
        await update($, tickitRound, () => round ?? null)
        await heardSessionStopped($, answer)
      }
      const at = await $.clock.now()
      const took = answer?.accepted ?? []
      for (const id of took) accepted.add(id)
      const rejected = (answer?.rejected ?? []).flatMap(r => {
        const run = batch.find(w => w.agentId === r.agentId)
        return run === undefined ? [] : [{ run, reason: r.reason.slice(0, 200), at }]
      })
      refused.push(...rejected)
      const unanswered = answer === undefined ? 0 : batch.filter(r => !took.includes(r.agentId) && !rejected.some(d => d.run.agentId === r.agentId)).length
      if (why === null && unanswered > 0) why = `Tick-it did not answer for ${plural(unanswered, 'run')}`
      failure ??= why
    }
  }

  await update($, syncError, () => failure)

  // Only what was settled leaves the outbox: a run queued while the call ran stays.
  const settled = new Set([...accepted, ...refused.map(d => d.run.agentId)])
  const left = (await read($, outbox)).filter(r => !settled.has(r.agentId))
  await update($, outbox, () => left)
  await $.store.set(OUTBOX_KEY, left)
  if (refused.length > 0) {
    const list = [...(await read($, dropped)), ...refused].slice(-KEEP_DROPPED)
    await update($, dropped, () => list)
    await $.store.set(DROPPED_KEY, list)
  }

  // Each run's fate under the session it was sent as: a session id Tick-it does not know for the ticket is why a clean round can still be held back.
  if (repository !== undefined) {
    const session = await $.session.id()
    const tickitSession = (await read($, startedSession))?.id ?? 'none'
    for (const run of waiting) {
      const refusal = refused.find(d => d.run.agentId === run.agentId)
      const sha = 'headSha' in run ? run.headSha : undefined
      await log($, 'debug', 'outbox-send', { claudeSession: session, tickitSession, agentId: run.agentId, skill: 'skill' in run ? run.skill : run.kind, round: run.round ?? 'none', headSha: sha ?? 'none', result: accepted.has(run.agentId) ? 'accepted' : refusal !== undefined ? 'rejected' : 'unanswered' })
    }
  }
  const sentCount = waiting.filter(r => accepted.has(r.agentId)).length
  if (refused.length > 0) await log($, 'error', 'runs-dropped', { dropped: refused.length })
  await log($, failure === null ? 'info' : 'warn', 'outbox-send', { sent: sentCount, dropped: refused.length, waiting: left.length, failed: failure !== null })
  const parts = [sentCount > 0 ? `Sent ${plural(sentCount, 'review run')} to Tick-it.` : '', refused.length > 0 ? `Dropped ${plural(refused.length, 'review run')} Tick-it rejected: ${refused.map(d => `${describeRun(d.run)} (${d.reason})`).join('; ')}.` : '', failure !== null ? `${plural(left.filter(r => madeHere(r, repository)).length, 'review run')} still waiting: ${failure}.` : '', other.trim()]

  return parts.filter(p => p !== '').join(' ')
}

export async function syncLine($: EngineInterface): Promise<string> {
  const repository = await repositoryHere($)
  const everyRun = await read($, outbox)
  const waiting = everyRun.filter(r => madeHere(r, repository)).length
  const elsewhere = everyRun.length - waiting
  const other = elsewhere === 0 ? '' : ` ${plural(elsewhere, 'run')} ${elsewhere === 1 ? 'waits' : 'wait'} for other repositories.`
  const error = await read($, syncError)
  const gone = (await read($, dropped)).filter(d => madeHere(d.run, repository))
  const status = (waiting === 0 ? (gone.length === 0 ? 'Tick-it has every review run.' : 'Nothing waiting to send to Tick-it.') : `${plural(waiting, 'review run')} waiting to send to Tick-it${error === null ? '' : `: ${error}`}. /tick-it sync to try again.`) + other
  if (gone.length === 0) return status

  return [status, `Dropped: ${plural(gone.length, 'run')} Tick-it rejected, so ${gone.length === 1 ? 'it is' : 'they are'} not in its costs.`, ...gone.slice(-5).map(d => `  ✗ ${describeRun(d.run)}  ${d.reason}`)].join('\n')
}
