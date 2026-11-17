import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'
import type { TicketSize } from '../types'
import { PANE, groupsOf, SIZES, USAGE } from './state'
import { callTickit, repositoryHere, briefOf, freshBriefOf } from './tickit'
import { budgetOf, findCurrent, save, fromRemote, refreshBoard, setStatus } from './board'
import type { RemoteTicket } from './board'
import { attachFile, recordPullRequest, take, finish, uiRefusal } from './work'
import { startRound, reviewReport } from './reviews'
import { flush, syncLine } from './outbox'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
const boardError = atom({ plugin: 'tick-it', key: 'boardError' } as const, null)
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)

export const registerCommand: Register = on => {
  on('command.run', { command: 'tick-it' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    switch (verb.toLowerCase()) {
      case 'board': {
        await refreshBoard($)
        const opened = await $.ui.open({ id: PANE, title: 'Tick-it' })
        if (opened.isPlaced) return { text: 'Tick-it board opened.' }
        // No pane here (a session with no surface attached): print the board instead.
        const list = await read($, tickets)
        const taken = await read($, current)
        const groups = groupsOf(list).map(status => {
          const rows = list.filter(t => t.status === status)
          const lines = rows.map(t => `  ${t.id === taken ? '◆' : ' '} ${t.id}  ${t.title}  ${t.size}`)
          return [`${status} (${rows.length})`, ...(lines.length ? lines : ['    none'])].join('\n')
        })
        const problem = await read($, boardError)
        return {
          text: [...(problem === null ? [] : [`Showing the last board read: ${problem}.`, '']), ...groups, '', 'No pane can be shown here, so this is the board as text. /tick-it take <id> to work on one.'].join('\n'),
        }
      }
      case 'take': {
        if (rest[0] === undefined || rest[0] === '') return { text: 'Usage: /tick-it take <id>' }
        const t = await take($, rest[0])
        if (typeof t === 'string') return { text: t }
        const fresh = await freshBriefOf($, t)
        const lines = [`◆ ${t.id} ${t.title} · ${t.size} · ${t.epic}`, ...t.acceptance.map(a => `  [ ] ${a}`), `  Budget ${await budgetOf($, t.size)} changed lines. The brief is in Claude's system prompt.`]
        return { text: lines.join('\n'), context: [fresh] }
      }
      case 'done': {
        const t = await findCurrent($)
        // Best effort: a git failure must not keep the ticket from moving.
        if (t !== undefined) await recordPullRequest($, t.id).catch(() => undefined)
        const moved = await finish($, 'In review')
        // Stewarding starts only once Tick-it has the ticket in review.
        if (t === undefined || (await read($, current)) !== null) return { text: moved }
        return { text: `${moved}\n${await startRound($, t, 1)}` }
      }
      case 'steward': {
        const id = (rest[0] ?? (await read($, steward))?.ticket ?? '').toUpperCase()
        const t = (await read($, tickets)).find(one => one.id === id)
        if (t === undefined) return { text: 'Usage: /tick-it steward <id>' }
        // The changed files can be measured only for the ticket being built here.
        const missing = (await findCurrent($))?.id === t.id ? await uiRefusal($, t.id) : undefined
        if (missing !== undefined) return { text: missing }
        const why = await setStatus($, t.id, 'In review')
        if (why !== undefined) return { text: `Could not move ${t.id} to In review: ${why}.` }
        return { text: await startRound($, t, 1, undefined, 'steward-command') }
      }
      case 'reviews':
        return { text: `${await reviewReport($, rest[0])}\n${await syncLine($)}` }
      case 'sync':
        return { text: await flush($) }
      case 'drop':
        return { text: await finish($, 'Ready') }
      case 'add': {
        const size = (rest[0] ?? '').toUpperCase() as TicketSize
        const title = rest.slice(1).join(' ')
        if (!SIZES.includes(size) || title === '') return { text: 'Usage: /tick-it add <XS|S|M|L> <title>' }
        const repository = await repositoryHere($)
        if (repository === undefined) return { text: 'This folder has no GitHub origin remote, so tick-it does not know where to add it.' }
        const made = await callTickit($, 'create_ticket', { repository, title, size, acceptance: [] })
        if (!made.ok) return { text: `Could not add it: ${made.why}.` }
        const t = fromRemote(made.value.ticket as RemoteTicket)
        await save($, [...(await read($, tickets)), t])
        return { text: `Added ${t.id} ${t.title} (${t.size}).` }
      }
      case 'attach': {
        // The path is the rest of the line as typed, spaces and all.
        const given = /^attach\s+(\S+)\s+(\S+)\s+(.+)$/i.exec(e.args.trim())
        if (given === null) return { text: 'Usage: /tick-it attach <id> <note> <file>' }
        return { text: await attachFile($, (given[1] ?? '').toUpperCase(), given[2] ?? '', given[3] ?? '') }
      }
      default: {
        const t = await findCurrent($)
        return { text: `${t === undefined ? 'No ticket taken.' : `Working on ${t.id} ${t.title}.`}\n${USAGE}` }
      }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const t = await findCurrent($)
    if (t === undefined) return composed

    return {
      sections: [...composed.sections, { id: 'tick-it:brief', text: await briefOf($, t), scope: 'session' as const }],
    }
  })
}
