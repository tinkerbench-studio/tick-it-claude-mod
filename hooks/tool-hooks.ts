import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'
import type { TicketSize } from '../types'
import { SIZES } from './state'
import { repositoryHere, freshBriefOf } from './tickit'
import { budgetOf, changedLines, nextSize, findCurrent, save, showStatus } from './board'
import { readText, measureDiff, refreshDiff, take, finishedByClaude } from './work'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)

export const registerTools: Register = on => {
  // The size budget: refuse an edit that would take the diff past the ticket's
  // budget. Measuring failures let the edit through (a proof of concept should
  // not block work), so the .catch passes rather than denies.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)
    const t = await findCurrent($)
    if (t === undefined) return next(e)

    let estimate = 0
    if (e.tool === 'Edit') {
      estimate = changedLines(e.old_string, e.new_string)
    } else {
      estimate = changedLines(await readText($, e.file_path), e.content)
    }
    const now = await measureDiff($)
    const budget = await budgetOf($, t.size)
    if (now + estimate > budget) {
      return {
        deny:
          `tick-it: refused. This change takes the diff to about ${now + estimate} lines, ` +
          `over ${t.id}'s ${t.size} budget of ${budget}. Offer the person these choices and wait for their answer: ` +
          `1. Raise a new ticket for the extra work: propose its size and acceptance, then create_ticket${t.epicId === undefined ? '' : ` in epic ${t.epicId} (its id; "epic" takes the id, never the title)`} with status Backlog and blockedBy ["${t.id}"]. ` +
          (nextSize(t.size) === undefined ? `2. Split ${t.id}: it is already the largest size, so keep what fits and raise a ticket for each remaining part, as in 1. ` : `2. Raise ${t.id} to ${nextSize(t.size)}: update_ticket with its size; the guard then measures against the new budget. `) +
          '3. Leave it: finish the ticket as scoped.',
      }
    }
    const ran = await next(e)
    await refreshDiff($)

    return ran
  }).catch(($, e, next) => next(e))

  // Claude moving a ticket itself with update_ticket: taking it (In progress,
  // assignee me), as when asked in plain words, is /tick-it take; finishing it
  // (In review) is /tick-it done. One hook for both, matched by the tool alone.
  on('tool.call', { tool: /tick-?it.*__update_ticket$/i }, async ($, e, next) => {
    const input = e as { key?: unknown; repository?: unknown; status?: unknown; assignee?: unknown }
    if (input.status === 'In review') return finishedByClaude($, e, next)
    const resized = (e as { size?: unknown }).size
    if (typeof input.key === 'string' && typeof resized === 'string' && (SIZES as string[]).includes(resized) && input.repository === (await repositoryHere($)) && (await read($, current)) === input.key.toUpperCase()) {
      const ran = await next(e)
      if (!('result' in ran) || ran.isError === true) return ran
      // The guard measures against the new budget from the next edit on.
      await save(
        $,
        (await read($, tickets)).map(one => (one.id === input.key?.toString().toUpperCase() ? { ...one, size: resized as TicketSize } : one)),
      )
      await showStatus($)
      return ran
    }
    if (input.status !== 'In progress' || input.assignee !== 'me') return next(e)
    if (typeof input.key !== 'string' || input.repository !== (await repositoryHere($)) || (await read($, current)) === input.key.toUpperCase()) return next(e)
    const t = await take($, input.key)
    const ran = await next(e)
    if (typeof t === 'string' || !('result' in ran) || ran.isError === true) return ran
    await showStatus($)
    return { ...ran, context: [...(ran.context ?? []), `tick-it: ${t.id} is yours.`, await freshBriefOf($, t)] }
  })
}
