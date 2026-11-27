import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { ReviewRun, ReviewUsage, WorkRun } from '../types'
import { APPROVAL_MESSAGE, answeredIds, BREAKDOWN_SUGGESTION, MAX_FINDINGS } from './state'
import { findCurrent, refreshPullRequest, statusOnTickit, showStatus } from './board'
import { refreshDiff, takeUnseenHead, report, recordPullRequest, firstLine, finish } from './work'
import { gaveVerdict, withoutStopMarks, costOf, openVerdictLines, readFindings, readVerdicts, parseFinding, saveReviews, setSteward, startRound, settleRound, checkIn } from './reviews'
import type { CheckIn } from './reviews'
import { queue, flush } from './outbox'
import { log } from './log'
import { saveResume } from './resume'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const baseCommit = atom({ plugin: 'tick-it', key: 'baseCommit' } as const, null)
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
const pullRequestError = atom({ plugin: 'tick-it', key: 'pullRequestError' } as const, null)
const pullRequest = atom({ plugin: 'tick-it', key: 'pullRequest' } as const, null)
const reviews = atom({ plugin: 'tick-it', key: 'reviews' } as const, [])
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
/** The last UI-evidence refusal told to Claude at a turn end: the same one is not sent again, so a session that cannot fix it is not woken every turn. */
const lastUiRefusal = atom({ plugin: 'tick-it', key: 'lastUiRefusal' } as const, null as string | null)
const diffLines = atom({ plugin: 'tick-it', key: 'diffLines' } as const, 0)
const turnRunning = atom({ plugin: 'tick-it', key: 'turnRunning' } as const, false)
const pendingInstructions = atom({ plugin: 'tick-it', key: 'pendingInstructions' } as const, [] as string[])
const approvalsTaken = atom({ plugin: 'tick-it', key: 'approvalsTaken' } as const, [] as string[])
/** A ticket Claude moved to In review itself: its review agents start when the turn ends. */
const reviewNext = atom({ plugin: 'tick-it', key: 'reviewNext' } as const, null)

export const registerTurn: Register = on => {
  // A review agent's run ends here: its time and tokens, its findings, and
  // whether the round is over. The main loop's turn ending while a fix round
  // runs starts the next review round.
  on('turn.complete', async ($, e, next) => {
    try {
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
        // A merge-only session starts no review: its ticket was reviewed, and its turn ends with done or stopped below.
        if (toReview === null && building !== undefined && onTickit === 'In review' && (await read($, startedSession))?.mergeOnly !== true) {
          await recordPullRequest($, building.id)
          // A continue session's ticket is already In review: its review starts without an update_ticket, which would overwrite the ticket's changed lines with this session's own.
          const continued = (await read($, startedSession))?.continued === true
          let stillTaken = false
          if (continued) {
            await update($, current, () => null)
            await update($, baseCommit, () => null)
            await saveResume($)
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
        if (session.mergeOnly === true) {
          // Done when Tick-it says the head only merged the base (reviewCarriedOver); otherwise, or when it cannot say, stopped with a person to decide. Never working.
          const pr = await read($, pullRequest)
          if (pr !== null && pr.state === 'open' && pr.reviewCarriedOver === true) {
            await report($, 'done', firstLine(e.answer), true)
          } else {
            const why = pr === null ? 'Tick-it could not say whether the review carries over' : 'the pushed head is not one whose review carries over (reviewCarriedOver is not true)'
            const note = `The merge-only session for ${session.ticket} ended: ${why}.`
            await report($, 'stopped', note, true, { code: 'other', ...(pr?.headSha === undefined ? {} : { head: pr.headSha }), need: { kind: 'session-stopped', note } })
          }
          return done
        }
        const ended = session.continued === true && onTickit !== undefined && onTickit !== 'In review'
        // A session waiting on an approval stays waiting through a turn that only read: its changed lines are as they were when it began waiting.
        const onlyRead = session.status === 'waiting' && session.waitingLines === (await read($, diffLines))
        if (!onlyRead) await report($, ended ? 'done' : 'working', firstLine(e.answer), ended)
        else {
          // Still waiting, but the turn is over: a throttled report asks Tick-it whether the request has been answered, and an answer that comes back with no turn running is a toast, submitted as a prompt by the approval timer.
          await update($, turnRunning, () => false)
          await report($, 'waiting', firstLine(e.answer))
        }
      }
      if (toReview !== null) {
        await update($, reviewNext, () => null)
        await saveResume($)
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
      if (fixingNow?.fixing === true && fixingNow.phase === 'stopped') {
        await update($, steward, v => (v === null ? v : { ...v, fixing: false }))
        await saveResume($)
      }
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
        // Before the session goes idle on a ticket In review it reports and reads whose move it is: Tick-it's next step is submitted, or a resume starts the next round.
        const checked = await checkIn($).catch(() => ({}) as CheckIn)
        if (checked.resumed === true) return done
        // Tick-it says the head is one no review has seen, on a ticket already In review: the mod starts the round itself (the reviews are the mod's to record), instead of handing the session an instruction it cannot meet.
        if (await takeUnseenHead($)) {
          const mine = await read($, steward)
          const t = mine === null ? undefined : (await read($, tickets)).find(one => one.id === mine.ticket)
          if (t !== undefined && mine?.phase !== 'reviewing') {
            await startRound($, t, 1, undefined, 'head-unseen').catch(error => report($, 'stopped', `Could not start the review: ${error instanceof Error ? error.message : String(error)}`.slice(0, 450), true))
            return done
          }
          await log($, 'debug', 'round-not-started', { ticket: mine?.ticket ?? 'none', round: mine?.round ?? 0, why: mine === null ? 'no-steward' : t === undefined ? 'not-on-board' : 'already-reviewing' })
        }
        let pending = (await read($, steward))?.phase === 'reviewing' ? [] : await read($, pendingInstructions)
        // An answer handed over this way ends the waiting: the session is working on it.
        if (pending.some(i => APPROVAL_MESSAGE.test(i))) {
          await update($, approvalsTaken, taken => [...taken, ...answeredIds(pending)])
          await report($, 'working', 'The approval was answered; continuing.', true)
          pending = await read($, pendingInstructions)
        }
        if (pending.length > 0) await update($, pendingInstructions, () => [])
        if (pending.length > 0 || checked.next !== undefined) await $.prompt.submit({ text: [...pending, ...(checked.next === undefined ? [] : [checked.next])].join('\n\n') })
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
    // A run is a review only when its turn ended with an answer that gave a verdict; otherwise it reviewed nothing and is failed (it is run again once, see below).
    const status = gaveVerdict(e.answer, e.reason, found.blocking.length + held.length) ? 'done' : 'failed'
    // A failed run is started again once in the same round. The retry is started before the failed run is saved, and both are saved together, so no moment shows the round without a running reviewer for another reviewer's end to settle on.
    let retry: ReviewRun | undefined
    // Why a run with no verdict was not run again: the log names it, as the run's end otherwise leaves no trace of the skipped retry.
    let notRetried: Record<string, unknown> | undefined
    if (status === 'failed') {
      const before = await read($, steward)
      if (run.retry === true) notRetried = { why: 'already-run-again' }
      else if (run.prompt === undefined) notRetried = { why: 'no-saved-prompt' }
      else if (before === null || before.ticket !== run.ticket || before.round !== run.round || before.phase !== 'reviewing') notRetried = { why: 'steward-not-reviewing', steward: before === null ? 'none' : `${before.ticket}:round-${before.round}:${before.phase}` }
      else {
        const started = await $.clock.now()
        const description = run.description ?? `tick-it review: ${run.skill} on ${run.ticket}, round ${run.round}`
        const spawned = await $.agent.spawn({ prompt: run.prompt, description, subagentType: 'general-purpose', model: run.model }).catch(error => ({ deny: error instanceof Error ? error.message : String(error) }) as { deny?: string; agentId?: string; model?: string })
        const agentId = spawned.deny === undefined ? (spawned.agentId ?? (await $.agent.list()).find(a => a.description === description && a.id !== run.agentId)?.id) : undefined
        if (agentId !== undefined) {
          retry = { ...run, description, agentId, model: spawned.model ?? run.model, startedAt: started, status: 'running', retry: true, blocking: undefined, optional: undefined, findings: undefined, items: undefined, verdicts: undefined, usage: undefined, costUsd: undefined, durationMs: undefined }
        } else notRetried = { why: 'spawn-refused', error: (spawned.deny ?? 'no agent id').replace(/[^A-Za-z0-9_.:#/,-]+/g, '_').slice(0, 100) }
      }
      if (notRetried !== undefined) await log($, 'debug', 'run-not-run-again', { ticket: run.ticket, round: run.round, skill: run.skill, ...notRetried })
    }
    await saveReviews($, list => [
      ...list.map(r =>
        r.agentId === e.agentId
          ? {
              ...r,
              model,
              status,
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
      ...(retry === undefined ? [] : [retry]),
    ])
    const finished = (await read($, reviews)).find(r => r.agentId === e.agentId)
    if (finished !== undefined) await queue($, [finished])
    // Reporting never holds up stewarding: a run that cannot be sent waits in the outbox.
    await flush($).catch(() => undefined)
    // Read again: the stop button may have been pressed while the run was sent.
    const reviewing = await read($, steward)
    if (retry !== undefined) return done
    if (reviewing !== null && reviewing.ticket === run.ticket && reviewing.round === run.round && reviewing.phase === 'reviewing') await settleRound($, reviewing)

    return done
    } finally {
      // The turn is over only once its end has been handled, so a report made there still counts as inside it.
      if (e.agentId === undefined) await update($, turnRunning, () => false)
    }
  })
}
