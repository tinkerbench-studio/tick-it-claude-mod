import { expect, test } from 'claude-code/testing'

import { PANE, RUN, engine, start, reports, PAGED, paged } from './helpers'
import type { Net } from './helpers'

test('the board is read from Tick-it for the repository the session is in', async ($, on) => {
  const seen = engine(on, { lines: 0 }, false)
  seen.server.push({ key: 'TCK-160', title: 'Only on the server', epic: null, size: 'XS', status: 'Backlog', acceptance: [], assignee: null })
  await start($)
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(seen.ticketCalls.filter(c => c.tool === 'list_tickets').map(c => c.args)).toContainEqual({ repository: 'acme/web-app', slim: true })
  expect(board.text).toContain('Backlog (1)')
  expect(board.text).toContain('TCK-160  Only on the server  XS')
  expect(board.text).not.toContain('Showing the last board read')
})

test('a board of several pages is saved whole, once each and in order', async ($, on) => {
  const net: Net = { pageSize: 2 }
  const seen = engine(on, { lines: 0 }, false, {}, net)
  paged(seen)
  await start($)
  const before = seen.ticketCalls.filter(c => c.tool === 'list_tickets').length
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const calls = seen.ticketCalls
    .filter(c => c.tool === 'list_tickets')
    .slice(before)
    .map(c => c.args)
  expect(calls).toEqual([{ repository: 'acme/web-app', slim: true }, { repository: 'acme/web-app', slim: true, cursor: '2' }, { repository: 'acme/web-app', slim: true, cursor: '4' }, { repository: 'acme/web-app', slim: true, cursor: '6' }, { repository: 'acme/web-app', slim: true, cursor: '8' }].slice(0, Math.ceil(seen.server.length / 2)))
  const text = board.text ?? ''
  const at = PAGED.map(n => text.indexOf(`TCK-${n}  `))
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
  expect([...at].sort((x, y) => x - y)).toEqual(at)
  for (const n of PAGED) expect(text.split(`TCK-${n}  `).length - 1).toBe(1)
  expect(text).not.toContain('Showing the last board read')
})

test('a failure on a later page keeps the cached board and reports why', async ($, on) => {
  const net: Net = { pageSize: 2 }
  const seen = engine(on, { lines: 0 }, false, {}, net)
  await start($)
  const known = seen.server.map(t => t.key)
  paged(seen, [161, 162, 163])
  net.failAt = '2'
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).toContain('Showing the last board read: Tick-it is down')
  for (const k of known) expect(board.text).toContain(k)
  expect(board.text).not.toContain('TCK-161')
})

test('a page cursor that comes round again fails the read and keeps the cached board', async ($, on) => {
  const net: Net = { pageSize: 2 }
  const seen = engine(on, { lines: 0 }, false, {}, net)
  await start($)
  paged(seen, [161, 162, 163])
  net.loop = true
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).toContain('Showing the last board read: Tick-it repeated a page cursor')
  expect(board.text).not.toContain('TCK-161')
})

test('signed out: the last board read still shows, with why, and nothing moves', async ($, on) => {
  const net: Net = {}
  const seen = engine(on, { lines: 0 }, false, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  net.connected = false
  const calls = seen.ticketCalls.length
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).toContain('Showing the last board read: not connected to Tick-it (Tick-it needs you to sign in). Sign in with /mcp')
  expect(board.text).toContain('TCK-143  Persist checkout step in session  XS')
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(taken.text).toContain('Could not read TCK-143: not connected to Tick-it')
  expect(seen.ticketCalls).toHaveLength(calls)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Ready')
})

test('a ticket that could not be read is not called "no ticket" when Tick-it could not be reached', async ($, on) => {
  const net: Net = {}
  engine(on, { lines: 0 }, false, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  net.connected = false
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-999' })
  expect(taken.text).toContain('Could not read TCK-999: not connected to Tick-it')
  expect(taken.text).not.toContain('No ticket')
  net.connected = true
  expect((await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-999' })).text).toBe('No ticket TCK-999. Try /tick-it board.')
})

test('a ticket is taken by reading just that ticket: the board is not read, so a board that cannot be read does not stop it', async ($, on) => {
  const net: Net = { listFails: true }
  const seen = engine(on, { lines: 0 }, false, {}, net)
  await start($)
  const before = seen.ticketCalls.length
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(taken.text).not.toContain('Could not')
  const calls = seen.ticketCalls.slice(before)
  expect(calls.some(c => c.tool === 'get_ticket' && (c.args as { key?: string }).key === 'TCK-143')).toBe(true)
  expect(calls.some(c => c.tool === 'list_tickets')).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In progress')
})

test('a get_ticket answer with no result names its content blocks and the start of its text', async ($, on) => {
  const seen = engine(on, { lines: 0 }, false, {}, { ticketNoResult: true })
  await start($)
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(taken.text).toContain('had no result in it (2 content blocks: text 234 chars, image 0 chars; the text starts: Tick-it is busy, try again later.')
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).not.toBe('In progress')
})

test('every page of the board is read slim', async ($, on) => {
  const seen = engine(on, { lines: 0 }, false, {}, { pageSize: 2 })
  paged(seen)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const lists = seen.ticketCalls.filter(c => c.tool === 'list_tickets')
  expect(lists.length).toBeGreaterThan(1)
  for (const c of lists) expect(c.args).toMatchObject({ slim: true })
})

test('a slim board read keeps what a ticket read whole holds, and a ticket only on the board is read whole when opened', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server[3]!, { description: 'Why the migration is needed', blockedBy: ['TCK-147'], url: 'https://app.tick-it.dev/r/acme/web-app/t/TCK-149' })
  await start($)
  // Opened from the board: only a slim row is known, so get_ticket (the core only) reads it whole.
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  await board.unmount()
  const reads = seen.ticketCalls.filter(c => c.tool === 'get_ticket' && (c.args as { key?: string }).key === 'TCK-149')
  expect(reads.map(c => c.args)).toEqual([{ repository: 'acme/web-app', key: 'TCK-149', include: ["approvals"] }])
  // The board read again is slim, yet the ticket keeps what it was read with.
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  expect(JSON.stringify(await pane.drawn())).toContain('Why the migration is needed')
  expect(JSON.stringify(await pane.drawn())).toContain('https://app.tick-it.dev/r/acme/web-app/t/TCK-149')
  expect(await pane.find({ type: 'Text', text: 'WAITING ON' })).toBeDefined()
  await pane.unmount()
  // A ticket read whole may have changed on Tick-it: opened again, it is read again.
  Object.assign(seen.server[3]!, { description: 'Edited on Tick-it' })
  const board2 = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board2.press({ key: 'open-TCK-149' })
  await board2.unmount()
  const again = seen.ticketCalls.filter(c => c.tool === 'get_ticket' && (c.args as { key?: string }).key === 'TCK-149')
  expect(again).toHaveLength(2)
  const pane2 = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  expect(JSON.stringify(await pane2.drawn())).toContain('Edited on Tick-it')
  await pane2.unmount()
})

test('a board read with no ticket read whole still links ticket keys, from one get_ticket for the address pattern', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  for (const t of seen.server) Object.assign(t, { url: `https://app.tick-it.dev/r/acme/web-app/t/${t.key}` })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Do TCK-147 first.', isFirstOfReply: true, isExpanded: true } } as never)
  const drawn = await ui.find({ type: 'Markdown' })
  expect(drawn?.props?.text).toContain('(https://app.tick-it.dev/r/acme/web-app/t/TCK-147)')
})

test('a board reply Claude Code did not pass on whole is reported as too large, and the cached board stays', async ($, on) => {
  const net: Net = {}
  const seen = engine(on, { lines: 0 }, false, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  net.tooLarge = 'list_tickets'
  seen.server.push({ key: 'TCK-160', title: 'Only on the server', epic: null, size: 'XS', status: 'Backlog', acceptance: [], assignee: null })
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).toContain("Showing the last board read: Tick-it's answer to list_tickets was too large for Claude Code to pass on whole")
  expect(board.text).not.toContain('had no result')
  expect(board.text).toContain('TCK-143  Persist checkout step in session  XS')
  expect(board.text).not.toContain('TCK-160')
})

test('a get_ticket reply Claude Code did not pass on whole is reported as too large', async ($, on) => {
  engine(on, { lines: 0 }, false, {}, { tooLarge: 'get_ticket' })
  await start($)
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(taken.text).toContain("Tick-it's answer to get_ticket was too large for Claude Code to pass on whole")
})
