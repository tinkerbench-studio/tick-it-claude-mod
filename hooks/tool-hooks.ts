import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { TicketSize } from '../types'
import { SIZES } from './state'
import { areaNudge, touchedAreas } from './security-areas'
import { repositoryHere, freshBriefOf, sameRepository } from './tickit'
import { budgetOf, changedLines, nextSize, findCurrent, save, showStatus } from './board'
import { heardSessionStopped, measureDiff, refreshDiff, take, finishedByClaude, editEffect, applyEdit, editCount } from './work'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)

/** The security areas Claude has been pointed at for the ticket being worked on: each is named once. */
const nudged = atom({ plugin: 'tick-it', key: 'securityNudged' } as const, { ticket: '', areas: [] } as { ticket: string; areas: string[] })

/** The nudge for an edit that lands in a security area not yet named for this ticket, or undefined. */
async function nudgeFor($: EngineInterface, ticket: string, file: string, text: string): Promise<string | undefined> {
  // The areas read a path within the repository: a folder above it named "auth" says nothing about the file.
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  const root = top.exitCode === 0 ? top.stdout.trim() : ''
  const path = root !== '' && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
  const held = await read($, nudged)
  const told = held.ticket === ticket ? held.areas : []
  const fresh = touchedAreas([{ path, lines: text }])
    .map(t => t.area)
    .filter(area => !told.includes(area))
  if (fresh.length === 0) return undefined
  await update($, nudged, () => ({ ticket, areas: [...told, ...fresh] }))
  return areaNudge(fresh)
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length)

export const registerTools: Register = on => {
  // The size budget: refuse an edit that would take the diff past the ticket's
  // budget. Measuring failures let the edit through (a proof of concept should
  // not block work), so the .catch passes rather than denies.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write' && (e.tool as string) !== 'MultiEdit') return next(e)
    const t = await findCurrent($)
    if (t === undefined) return next(e)

    // What the edit adds to the diff: the file's changed lines against the ticket's base after it, less before it. NotebookEdit is not guarded.
    const input = e as unknown as { file_path: string; old_string: string; new_string: string; replace_all?: boolean; content: string; edits?: { old_string: string; new_string: string; replace_all?: boolean }[] }
    const edits = e.tool === 'MultiEdit' ? (input.edits ?? []) : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }]
    const estimate = await editEffect(
      $,
      e.file_path,
      before => {
        if (e.tool === 'Write') return { after: input.content, estimate: lineCount(input.content) > lineCount(before) ? changedLines(before, input.content) : 0 }
        let after = before
        let each = 0
        for (const edit of edits) {
          const all = edit.replace_all === true
          // With no readable base the edit's own lines stand, but an edit with no more lines than it replaces does not grow the diff.
          if (lineCount(edit.new_string) > lineCount(edit.old_string)) each += changedLines(edit.old_string, edit.new_string) * editCount(after, edit.old_string, all)
          after = applyEdit(after, edit.old_string, edit.new_string, all)
        }
        return { after, estimate: each }
      },
      changedLines,
    )
    const now = await measureDiff($)
    const budget = await budgetOf($, t.size)
    // An edit that does not make the diff larger is never refused: the session must be able to edit its way back under the budget.
    if (estimate > 0 && now + estimate > budget) {
      return {
        deny:
          `tick-it: refused. This change takes the diff to about ${now + estimate} lines, ` +
          `over ${t.id}'s ${t.size} budget of ${budget}. Offer the person these choices and wait for their answer: ` +
          `1. Raise a new ticket for the extra work: propose its size and acceptance, then create_ticket${t.epicId === undefined ? '' : ` with epicId "${t.epicId}" (epic "${t.epic}")`} with status Backlog and blockedBy ["${t.id}"]. ` +
          (nextSize(t.size) === undefined ? `2. Split ${t.id}: it is already the largest size, so keep what fits and raise a ticket for each remaining part, as in 1. ` : `2. Raise ${t.id} to ${nextSize(t.size)}: update_ticket with its size; the guard then measures against the new budget. `) +
          '3. Leave it: finish the ticket as scoped.',
      }
    }
    const ran = await next(e)
    await refreshDiff($)
    // The first edit of the ticket that lands in a security area names the skill to follow there: once per area, so the reviewer finds less.
    const nudge = await nudgeFor($, t.id, e.file_path, e.tool === 'Write' ? e.content : edits.map(x => `${x.old_string}\n${x.new_string}`).join('\n')).catch(() => undefined)

    return nudge === undefined || !('result' in ran) || ran.isError === true ? ran : { ...ran, context: [...(ran.context ?? []), nudge] }
  }).catch(($, e, next) => next(e))

  // Tick-it's answer to a criterion tick or note may say its session is stopped (sessionStopped): Claude is told, so it does not say the ticket will merge.
  on('tool.call', { tool: /tick-?it.*__(set_criterion_checked|add_criterion_note)$/i }, async ($, e, next) => {
    const ran = await next(e)
    if (!('result' in ran) || ran.isError === true) return ran
    // The answer as text: a plain string, or content blocks.
    const result: unknown = ran.result
    const text = typeof result === 'string' ? result : Array.isArray(result) ? result.map(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join(' ') : JSON.stringify(result)
    try {
      await heardSessionStopped($, JSON.parse(text))
    } catch {
      // An answer that is not JSON says nothing of the session.
    }
    return ran
  })

  // Claude moving a ticket itself with update_ticket: taking it (In progress,
  // assignee me), as when asked in plain words, is /tick-it take; finishing it
  // (In review) is /tick-it done. One hook for both, matched by the tool alone.
  on('tool.call', { tool: /tick-?it.*__update_ticket$/i }, async ($, e, next) => {
    const input = e as { key?: unknown; repository?: unknown; status?: unknown; assignee?: unknown }
    if (input.status === 'In review') return finishedByClaude($, e, next)
    const resized = (e as { size?: unknown }).size
    if (typeof input.key === 'string' && typeof resized === 'string' && (SIZES as string[]).includes(resized) && sameRepository(input.repository, await repositoryHere($)) && (await read($, current)) === input.key.toUpperCase()) {
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
    if (typeof input.key !== 'string' || !sameRepository(input.repository, await repositoryHere($)) || (await read($, current)) === input.key.toUpperCase()) return next(e)
    const t = await take($, input.key)
    const ran = await next(e)
    if (typeof t === 'string' || !('result' in ran) || ran.isError === true) return ran
    await showStatus($)
    return { ...ran, context: [...(ran.context ?? []), `tick-it: ${t.id} is yours.`, await freshBriefOf($, t)] }
  })
}
