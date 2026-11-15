import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { ReviewUsage, WorkRun } from '../types'
import { BREAKDOWN_SUGGESTION, MAX_FINDINGS } from './state'
import { findCurrent, refreshPullRequest, statusOnTickit, showStatus } from './board'
import { refreshDiff, report, recordPullRequest, firstLine, finish } from './work'
import { withoutStopMarks, costOf, openVerdictLines, readFindings, readVerdicts, parseFinding, saveReviews, setSteward, startRound, settleRound } from './reviews'
import { queue, flush } from './outbox'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const baseCommit = atom({ plugin: 'tick-it', key: 'baseCommit' } as const, null)
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
const pullRequestError = atom({ plugin: 'tick-it', key: 'pullRequestError' } as const, null)
const reviews = atom({ plugin: 'tick-it', key: 'reviews' } as const, [])
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
/** The last UI-evidence refusal told to Claude at a turn end: the same one is not sent again, so a session that cannot fix it is not woken every turn. */
const lastUiRefusal = atom({ plugin: 'tick-it', key: 'lastUiRefusal' } as const, null as string | null)
const pendingInstructions = atom({ plugin: 'tick-it', key: 'pendingInstructions' } as const, [] as string[])
/** A ticket Claude moved to In review itself: its review agents start when the turn ends. */
const reviewNext = atom({ plugin: 'tick-it', key: 'reviewNext' } as const, null)

export const registerTurn: Register = on => {
  // A review agent's run ends here: its time and tokens, its findings, and
  // whether the round is over. The main loop's turn ending while a fix round
  // runs starts the next review round.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const s = await read($, steward)
    if (e.agentId === undefined) {
      // The pane's pull request and CI are read again at the end of each turn.
      const taken = await findCurrent($)
      if (taken !== undefined) {
        await refreshPullRequest($, taken.id).catch(error => update($, pullRequestError, () => (error instanceof Error ? error.message : String(error)).slice(0, 200)))
      }
      // A main-loop turn spent on a ticket: building it, or fixing a review round's findings.
      const building = await findCurrent($)
      const finished = await read($, reviewNext)
      const fixing = s?.phase === 'fixing' ? s : null
      const ticket = building?.id ?? finished ?? fixing?.ticket
      if (ticket !== undefined && e.usage !== undefined) {
        const usage: ReviewUsage = {
          input: e.usage.input_tokens,
          output: e.usage.output_tokens,
          cacheRead: e.usage.cache_read_input_tokens,
          cacheWrite: e.usage.cache_creation_input_tokens,
        }
        const work: WorkRun = {
          agentId: `turn-${e.turnId}`,
          ticket,
          kind: building !== undefined || finished !== null ? 'build' : 'fix',
          ...(building === undefined && finished === null && fixing !== null ? { round: fixing.round } : {}),
          model: e.usage.model,
          status: e.reason === 'answer' ? 'done' : 'failed',
          durationMs: e.durationMs,
          startedAt: (await $.clock.now()) - e.durationMs,
          usage,
          ...(costOf(e.usage.model, usage) === undefined ? {} : { costUsd: costOf(e.usage.model, usage) }),
        }
        await queue($, [work])
        await flush($).catch(() => undefined)
      }
      // Claude may have moved the ticket to In review in a way the tool.call
      // hook did not see: Tick-it says, and it is /tick-it done all the same.
      let toReview = finished
      // What Tick-it said the ticket's status is, when it said: a continue session is done only on a status it confirmed.
      let onTickit: Awaited<ReturnType<typeof statusOnTickit>>
      try {
        if (toReview === null && building !== undefined) onTickit = await statusOnTickit($, building.id)
        if (toReview === null && building !== undefined && onTickit === 'In review') {
          await recordPullRequest($, building.id)
          // A continue session's ticket is already In review: its review starts without an update_ticket, which would overwrite the ticket's changed lines with this session's own.
          const continued = (await read($, startedSession))?.continued === true
          let stillTaken = false
          if (continued) {
            await update($, current, () => null)
            await update($, baseCommit, () => null)
            await showStatus($)
          } else {
            const moved = await finish($, 'In review')
            // Refused (a UI change with no pictures): Claude is told what is missing with its next turn.
            stillTaken = (await read($, current)) !== null
            if (stillTaken && moved.includes(' changes the UI') && (await read($, lastUiRefusal)) !== moved) {
              await update($, lastUiRefusal, () => moved)
              await update($, pendingInstructions, pending => [...pending, `tick-it: ${moved}`])
            }
          }
          if (!stillTaken) {
            toReview = building.id
            await report($, 'reviewing', `Tick-it has ${building.id} In review; starting its review agents.`, true)
          }
        }
      } catch (error) {
        await report($, 'stopped', `Could not start the review: ${error instanceof Error ? error.message : String(error)}`.slice(0, 450), true)
      }
      const session = await read($, startedSession)
      if (session !== null && toReview === null && building?.id === session.ticket) {
        await refreshDiff($).catch(() => undefined)
        // A continue session's ticket is not moved to review here (it is Ready to merge, say): its turn is the work, so it is done.
        // Only on a status Tick-it confirmed that is not In review: a failed read, or a review that could not start, leaves it working.
        const done = session.continued === true && onTickit !== undefined && onTickit !== 'In review'
        await report($, done ? 'done' : 'working', firstLine(e.answer), done)
      }
      if (toReview !== null) {
        await update($, reviewNext, () => null)
        const t = (await read($, tickets)).find(one => one.id === toReview)
        try {
          if (t === undefined) throw new Error(`${toReview} is not on the board this session has`)
          await startRound($, t, 1, undefined, 'moved-by-claude')
        } catch (error) {
          await report($, 'stopped', `Could not start the review: ${error instanceof Error ? error.message : String(error)}`.slice(0, 450), true)
        }
        return done
      }
      // Read again: the stop button may have been pressed while this turn's end was handled.
      const fixingNow = await read($, steward)
      if (fixingNow?.fixing === true && fixingNow.phase === 'stopped') await update($, steward, v => (v === null ? v : { ...v, fixing: false }))
      const suggested = fixingNow?.phase === 'fixing' ? (await read($, pendingInstructions)).filter(i => i.startsWith(BREAKDOWN_SUGGESTION)) : []
      if (fixingNow?.phase === 'fixing' && suggested.length > 0) {
        // Tick-it suggests breaking the ticket down: no further fix round starts. Claude offers the breakdown to the person, and r starts the next round if they decline.
        const note = `Breakdown suggested for ${fixingNow.ticket} after ${fixingNow.round} rounds; it stays In review until you decide (r starts round ${fixingNow.round + 1}).`
        // The offer is a turn of its own: fixing stays true while it runs, as for the stop button, so r then waits for its end rather than queueing a turn of nothing to fix.
        await setSteward($, { ...withoutStopMarks(fixingNow), phase: 'stopped', note, fixing: true })
        await update($, pendingInstructions, pending => pending.filter(i => !i.startsWith(BREAKDOWN_SUGGESTION)))
        await $.prompt.submit({ text: suggested.join('\n\n') })
      } else if (fixingNow?.phase === 'fixing') {
        const t = (await read($, tickets)).find(one => one.id === fixingNow.ticket)
        if (t !== undefined) await startRound($, t, fixingNow.round + 1, fixingNow.ticking, fixingNow.afterStop === true ? 'after-stop' : 'after-fix')
      } else {
        // What the reports above brought are handed over last, with the session idle; while a review round runs they wait for the next turn's end.
        const pending = (await read($, steward))?.phase === 'reviewing' ? [] : await read($, pendingInstructions)
        if (pending.length > 0) {
          await update($, pendingInstructions, () => [])
          await $.prompt.submit({ text: pending.join('\n\n') })
        }
      }
      return done
    }
    const run = (await read($, reviews)).find(r => r.agentId === e.agentId)
    if (run === undefined || run.status !== 'running') return done
    const usage: ReviewUsage | undefined =
      e.usage === undefined
        ? undefined
        : {
            input: e.usage.input_tokens,
            output: e.usage.output_tokens,
            cacheRead: e.usage.cache_read_input_tokens,
            cacheWrite: e.usage.cache_creation_input_tokens,
          }
    const model = e.usage?.model ?? run.model
    const found = readFindings(e.answer)
    const verdicts = run.earlier === undefined ? [] : readVerdicts(e.answer, run.earlier)
    const held = verdicts.filter(v => v.verdict === 'open')
    await saveReviews($, list =>
      list.map(r =>
        r.agentId === e.agentId
          ? {
              ...r,
              model,
              status: e.reason === 'answer' ? 'done' : 'failed',
              durationMs: e.durationMs,
              usage,
              costUsd: usage === undefined ? undefined : costOf(model, usage),
              // An earlier blocker the reviewer verified still open is blocking in this round too: the pane counts and lists it, it goes to the fix, and it keeps the round from reading clean. Tick-it adds it to the count itself, so the outbox leaves it out of what it sends.
              blocking: found.blocking.length + held.length,
              optional: found.optional.length,
              findings: [...found.blocking, ...openVerdictLines(held)],
              items: [
                ...[...found.blocking, ...found.optional]
                  .map(parseFinding)
                  .filter(f => f.text !== '')
                  .slice(0, MAX_FINDINGS),
                ...held.map(v => ({ severity: 'blocking' as const, ...(v.file === undefined ? {} : { file: v.file }), text: v.text, open: true as const })),
              ],
              ...(r.earlier === undefined ? {} : { verdicts }),
            }
          : r,
      ),
    )
    const finished = (await read($, reviews)).find(r => r.agentId === e.agentId)
    if (finished !== undefined) await queue($, [finished])
    // Reporting never holds up stewarding: a run that cannot be sent waits in the outbox.
    await flush($).catch(() => undefined)
    // Read again: the stop button may have been pressed while the run was sent.
    const reviewing = await read($, steward)
    if (reviewing !== null && reviewing.ticket === run.ticket && reviewing.round === run.round && reviewing.phase === 'reviewing') await settleRound($, reviewing)

    return done
  })
}
