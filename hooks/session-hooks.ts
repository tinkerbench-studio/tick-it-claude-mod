import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { DroppedRun, OutboxRun, PendingLink, ReviewRun, StartedSession, Ticket } from '../types'
import { STORE_KEY, STARTED_KEY, START_LINE, CONTINUE_LINE, BREAKDOWN_LINE, BREAKDOWN_KEY, REPORT_TOOL, REVIEWS_KEY, OUTBOX_KEY, DROPPED_KEY, UNLINKED_KEY, RECORD_TOOL, AGENTS_TOOL } from './state'
import { callTickit, originHere, checkoutBeside, freshBriefOf } from './tickit'
import { refreshBoard, showStatus } from './board'
import { reportsForItself, instructionsOf, take, resume } from './work'
import { reportAgents, flush } from './outbox'
import { failRuns } from './reviews'
import { log } from './log'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
const breakdownSession = atom({ plugin: 'tick-it', key: 'breakdown' } as const, null)
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
const reviews = atom({ plugin: 'tick-it', key: 'reviews' } as const, [])
const pendingInstructions = atom({ plugin: 'tick-it', key: 'pendingInstructions' } as const, [] as string[])
const outbox = atom({ plugin: 'tick-it', key: 'outbox' } as const, [])
const dropped = atom({ plugin: 'tick-it', key: 'dropped' } as const, [])
/** link_pull_request calls Tick-it has not taken yet: sent again with the outbox. */
const unlinked = atom({ plugin: 'tick-it', key: 'unlinked' } as const, [])
/** The Tick-it session id of a start line whose ticket the mod could not take: that session reports for itself. */
const takeFailed = atom({ plugin: 'tick-it', key: 'takeFailed' } as const, null)

export const registerSession: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await read($, tickets)).length === 0) {
      const cached = await $.store.get(STORE_KEY)
      if (Array.isArray(cached)) await update($, tickets, () => cached as Ticket[])
    }
    if ((await read($, reviews)).length === 0) {
      const saved = await $.store.get(REVIEWS_KEY)
      if (Array.isArray(saved)) await update($, reviews, () => saved as ReviewRun[])
    }
    // A run still running from another session lost its agent with that session.
    const here = await $.session.id()
    await failRuns($, r => r.claudeSession !== here)
    if ((await read($, outbox)).length === 0) {
      const waiting = await $.store.get(OUTBOX_KEY)
      if (Array.isArray(waiting)) await update($, outbox, () => waiting as OutboxRun[])
    }
    if ((await read($, unlinked)).length === 0) {
      const waiting = await $.store.get(UNLINKED_KEY)
      if (Array.isArray(waiting)) await update($, unlinked, () => waiting as PendingLink[])
    }
    if ((await read($, dropped)).length === 0) {
      const gone = await $.store.get(DROPPED_KEY)
      if (Array.isArray(gone)) await update($, dropped, () => gone as DroppedRun[])
    }
    if ((await read($, startedSession)) === null) {
      const saved = (await $.store.get(STARTED_KEY)) as StartedSession | null | undefined
      // Only into the Claude Code session it belongs to (a resume), never a new one.
      if (typeof saved === 'object' && saved !== null && saved.claudeSession === (await $.session.id())) await update($, startedSession, () => saved)
    }
    if ((await read($, breakdownSession)) === null) {
      const saved = (await $.store.get(BREAKDOWN_KEY)) as { id: string; claudeSession: string } | null | undefined
      // Only into the Claude Code session it belongs to (a resume), never a new one.
      if (typeof saved === 'object' && saved !== null && saved.claudeSession === (await $.session.id())) await update($, breakdownSession, () => saved)
    }
    await $.command.register({
      name: 'tick-it',
      description: 'Tick-it: board, take a ticket, finish it',
      argumentHint: 'board | take <id> | done | drop | add <size> <title> | attach <id> <note> <file>',
    })
    await showStatus($)
    const started = await next(e)
    await refreshBoard($).catch(() => undefined)
    await flush($).catch(() => undefined)
    await reportAgents($).catch(() => undefined)

    return started
  })

  // Review runs are facts the mod measured; the model may not write them. The
  // rest of Tick-it's tools (tickets, epics, costs) stay the model's to use.
  on('tool.check', async ($, e, next) => {
    const isTickit = /tick-?it/i.test(e.tool)
    // A session Tick-it started whose ticket the mod could not take (the take was refused, or the start line named another repository): nothing is recorded or reported for it, so it reports for itself and these calls are its own.
    if (isTickit && next.origin.plugin === 'engine' && (await read($, takeFailed)) !== null && (await read($, current)) === null && (await read($, startedSession)) === null && [RECORD_TOOL, REPORT_TOOL, AGENTS_TOOL].some(t => e.tool.endsWith(`__${t}`))) {
      await log($, 'warn', 'tool-allowed-untaken', { tool: e.tool })
      return next(e)
    }
    // With no ticket taken the mod records and reports nothing, so say that: the model must not assume reviews are being recorded.
    const untaken = async () => ((await read($, current)) === null && (await read($, startedSession)) === null ? ' The mod did not take a ticket in this session, so nothing is being recorded or reported for it: take the ticket with /tick-it take, or follow the brief without the mod.' : '')
    const denied = async (why: string, reason: string) => {
      const none = await untaken()
      await log($, 'debug', 'tool-denied', { tool: e.tool, why, ...(none === '' ? {} : { ticket: 'none' }) })
      return { decision: 'deny' as const, reason: reason + none }
    }
    if (isTickit && e.tool.endsWith(`__${RECORD_TOOL}`) && next.origin.plugin === 'engine') {
      return denied('runs-are-the-mods', 'tick-it records review runs itself, from what each review agent spent.')
    }
    if (isTickit && e.tool.endsWith(`__${AGENTS_TOOL}`) && next.origin.plugin === 'engine') {
      return denied('agents-are-the-mods', 'tick-it reports the repository’s review agents itself, from its .tick-it/skills.')
    }
    if (isTickit && e.tool.endsWith(`__${REPORT_TOOL}`) && next.origin.plugin === 'engine' && !(await reportsForItself($, e.input))) {
      return denied('reports-are-the-mods', 'tick-it reports the session’s progress itself.')
    }
    return next(e)
  })

  // A session Tick-it started: its first message names the session and the
  // ticket. Take the ticket, hand Claude its brief with the message, and tell
  // Tick-it the session is working.
  on('prompt.submit', async ($, e, next) => {
    const started = START_LINE.exec(e.text)
    const line = started ?? CONTINUE_LINE.exec(e.text)
    const continuing = started === null && line !== null
    await log($, 'debug', 'start-line', { matched: line !== null, command: e.command !== undefined })
    if (line === null && e.command === undefined) {
      // A breakdown session: the mod takes no ticket and reports nothing for it, so that session reports for itself. A message that starts a build is never one, and the first one to name a session arms it, once.
      const breakdown = BREAKDOWN_LINE.exec(e.text)
      if (breakdown !== null && (await read($, breakdownSession)) === null && (await read($, startedSession)) === null) {
        const own = { id: breakdown[1] ?? '', claudeSession: await $.session.id() }
        await update($, breakdownSession, () => own)
        await $.store.set(BREAKDOWN_KEY, own)
      }
      return next(e)
    }
    if (line === null || e.command !== undefined) return next(e)
    const [, id = '', ticket = '', repository = ''] = line
    const origin = await originHere($)
    if (origin !== null && origin !== repository) {
      const checkout = await checkoutBeside($, repository)
      await log($, 'debug', 'start-not-taken', { ticket, why: 'other-repository', ...(checkout === undefined ? {} : { checkout }) })
      // As with a refused take, the mod records and reports nothing for this session, so its own calls are let through.
      await update($, takeFailed, () => id)
      const declined = `tick-it: this session is in ${origin ?? 'a folder whose origin is not on GitHub'}, not ${repository}, so it did not take ${ticket}.`
      const move = checkout === undefined ? '' : ` ${repository} is checked out at ${checkout}: work there and take ${ticket} with update_ticket (In progress, assignee me).`
      return next({ ...e, context: [...(e.context ?? []), `${declined}${move} The mod records and reports nothing for it: record its runs and report the session yourself, as the message says for a session without the mod.`] })
    }
    // A folder with no origin works on the repository the first message names.
    const notes = origin === null ? [`tick-it: this folder has no origin remote, so it works on ${repository} as Tick-it asked.`] : []
    const previous = await read($, startedSession)
    if (origin === null) {
      const claudeSession = await $.session.id()
      await update($, startedSession, () => ({ id, repository, ticket: ticket.toUpperCase(), status: 'working' as const, reportedAt: 0, claudeSession }))
    }
    const t = continuing ? await resume($, ticket) : await take($, ticket)
    if (typeof t === 'string') {
      await log($, 'warn', 'start-not-taken', { ticket, session: id, why: 'take-refused' })
      await update($, startedSession, () => previous)
      await update($, takeFailed, () => id)
      return next({ ...e, context: [...(e.context ?? []), ...notes, `tick-it could not take ${ticket}: ${t}`] })
    }
    await update($, takeFailed, () => null)
    await log($, 'debug', 'ticket-taken', { ticket: t.id, session: id, claudeSession: await $.session.id() })
    const s: StartedSession = { id, repository, ticket: t.id, status: 'working', reportedAt: 0, claudeSession: await $.session.id(), ...(continuing ? { continued: true } : {}) }
    await update($, startedSession, () => s)
    await $.store.set(STARTED_KEY, s)
    const sent = await callTickit($, REPORT_TOOL, {
      repository,
      session: id,
      status: 'working',
      claudeSessionId: await $.session.id(),
      summary: continuing ? `Continuing ${t.id}.` : `Took ${t.id}.`,
    }).catch(() => ({ ok: false as const, why: 'unreachable' }))
    if (sent.ok) {
      const reported = { ...s, reportedAt: await $.clock.now() }
      await update($, startedSession, () => reported)
      await $.store.set(STARTED_KEY, reported)
    }
    // Tick-it hands over at once what it already wants of the session, such as a merge conflict to resolve: Claude gets it when this turn ends.
    await log($, sent.ok ? 'info' : 'warn', 'report', { ticket: t.id, session: id, claudeSessionId: s.claudeSession, status: 'working', sent: sent.ok })
    const asked = instructionsOf(sent)
    if (asked.length > 0) await update($, pendingInstructions, pending => [...pending, ...asked])
    return next({ ...e, context: [...(e.context ?? []), ...notes, await freshBriefOf($, t)] })
  })

  on('session.end', async ($, e, next) => {
    await flush($).catch(() => undefined)
    return next(e)
  })
}
