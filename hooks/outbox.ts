import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { DroppedRun, OutboxRun } from '../types'
import { OUTBOX_KEY, DROPPED_KEY, KEEP_DROPPED, RECORD_TOOL, AGENTS_TOOL } from './state'
import { sendTickit, textOf, repositoryHere } from './tickit'
import { sendWaitingLinks } from './work'
import { findSkills } from './reviews'
import { log } from './log'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const outbox = atom({ plugin: 'tick-it', key: 'outbox' } as const, [])
const syncError = atom({ plugin: 'tick-it', key: 'syncError' } as const, null)
const dropped = atom({ plugin: 'tick-it', key: 'dropped' } as const, [])
/** link_pull_request calls Tick-it has not taken yet: sent again with the outbox. */
const unlinked = atom({ plugin: 'tick-it', key: 'unlinked' } as const, [])

/** What record_runs answers, in structuredContent or as JSON text. */
export type RecordAnswer = { accepted: string[]; rejected: { agentId: string; reason: string }[] }

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

export async function queue($: EngineInterface, runs: OutboxRun[]) {
  const list = [...(await read($, outbox)), ...runs]
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
export const sendable = ({ epic: _epic, ...run }: OutboxRun) => {
  // The epic's title stays here: Tick-it knows the ticket's epic, and no title goes to its tools.
  if (!('findings' in run || 'items' in run)) return run
  const { findings: _findings, items, ...rest } = run as typeof run & { items?: { open?: true }[]; blocking?: number }
  if (items === undefined) return rest
  const held = items.filter(i => i.open === true).length
  return { ...rest, ...(held === 0 || rest.blocking === undefined ? {} : { blocking: rest.blocking - held }), findings: items.filter(i => i.open !== true) }
}

/** Sends the outbox to Tick-it; answers what happened, for /tick-it sync. */
export async function flush($: EngineInterface): Promise<string> {
  await sendWaitingLinks($).catch(() => undefined)
  const waiting = await read($, outbox)
  const links = (await read($, unlinked)).length
  if (waiting.length === 0) return links === 0 ? 'Nothing waiting to send to Tick-it.' : `${plural(links, 'pull request link')} still waiting to send to Tick-it.`

  let answer: RecordAnswer | undefined
  let failure: string | null = null
  const repository = await repositoryHere($)
  if (repository === undefined) {
    failure = 'this folder has no GitHub origin remote, so Tick-it would not know the repository'
  } else {
    const session = await $.session.id()
    const sent = await sendTickit($, RECORD_TOOL, place => ({
      session,
      // owner/name, as Tick-it knows the repository: not the remote's URL.
      repository,
      // Each review run carries its findings with their text, parsed from its BLOCKING and OPTIONAL lines.
      runs: waiting.map(run => ({
        place,
        ...sendable(run),
      })),
    }))
    if (!sent.ok) failure = sent.why
    else if (sent.result.isError) failure = `Tick-it refused the call${textOf(sent.result) ? `: ${textOf(sent.result)}` : ''}`
    else {
      answer = readAnswer(sent.result)
      if (answer === undefined) failure = `Tick-it's answer did not say which runs it took`
    }
  }

  const accepted = new Set(answer?.accepted ?? [])
  const at = await $.clock.now()
  const refused: DroppedRun[] = (answer?.rejected ?? []).flatMap(r => {
    const run = waiting.find(w => w.agentId === r.agentId)
    return run === undefined ? [] : [{ run, reason: r.reason.slice(0, 200), at }]
  })
  const unanswered = answer === undefined ? 0 : waiting.filter(r => !accepted.has(r.agentId) && !refused.some(d => d.run.agentId === r.agentId)).length
  if (failure === null && unanswered > 0) failure = `Tick-it did not answer for ${plural(unanswered, 'run')}`
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

  const sentCount = waiting.filter(r => accepted.has(r.agentId)).length
  if (refused.length > 0) await log($, 'error', 'runs-dropped', { dropped: refused.length })
  await log($, failure === null ? 'info' : 'warn', 'outbox-send', { sent: sentCount, dropped: refused.length, waiting: left.length, failed: failure !== null })
  const parts = [sentCount > 0 ? `Sent ${plural(sentCount, 'review run')} to Tick-it.` : '', refused.length > 0 ? `Dropped ${plural(refused.length, 'review run')} Tick-it rejected: ${refused.map(d => `${describeRun(d.run)} (${d.reason})`).join('; ')}.` : '', failure !== null ? `${plural(left.length, 'review run')} still waiting: ${failure}.` : '']

  return parts.filter(p => p !== '').join(' ')
}

export async function syncLine($: EngineInterface): Promise<string> {
  const waiting = (await read($, outbox)).length
  const error = await read($, syncError)
  const gone = await read($, dropped)
  const status = waiting === 0 ? (gone.length === 0 ? 'Tick-it has every review run.' : 'Nothing waiting to send to Tick-it.') : `${plural(waiting, 'review run')} waiting to send to Tick-it${error === null ? '' : `: ${error}`}. /tick-it sync to try again.`
  if (gone.length === 0) return status

  return [status, `Dropped: ${plural(gone.length, 'run')} Tick-it rejected, so ${gone.length === 1 ? 'it is' : 'they are'} not in its costs.`, ...gone.slice(-5).map(d => `  ✗ ${describeRun(d.run)}  ${d.reason}`)].join('\n')
}
