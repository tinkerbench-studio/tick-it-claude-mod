import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, reports, PAGED, paged } from './helpers'
import type { Net } from './helpers'

test('the board is read from Tick-it for the repository the session is in', async ($, on) => {
  const seen = engine(on, { lines: 0 }, false)
  seen.server.push({ key: 'TCK-160', title: 'Only on the server', epic: null, size: 'XS', status: 'Backlog', acceptance: [], assignee: null })
  await start($)
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(seen.ticketCalls.filter(c => c.tool === 'list_tickets').map(c => c.args)).toContainEqual({ repository: 'acme/web-app' })
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
  expect(calls).toEqual([{ repository: 'acme/web-app' }, { repository: 'acme/web-app', cursor: '2' }, { repository: 'acme/web-app', cursor: '4' }, { repository: 'acme/web-app', cursor: '6' }, { repository: 'acme/web-app', cursor: '8' }].slice(0, Math.ceil(seen.server.length / 2)))
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
