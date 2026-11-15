import { expect, test } from 'claude-code/testing'

import { brief } from '../hooks/register'
import { PANE, RUN, engine, start } from './helpers'

const T = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] }
const FUTURE = '2999-12-01T09:00:00Z'
const PAST = '2001-01-01'

test('the brief names the hold and its date for a held ticket, and says nothing for a passed date or no hold', () => {
  const held = brief({ ...T, notBefore: FUTURE })
  expect(held).toContain('Held: TCK-2 is waiting until 1 Dec 2999 (its notBefore). Do not start work on it before then.')
  expect(brief({ ...T, notBefore: PAST })).not.toContain('Held:')
  expect(brief(T)).not.toContain('Held:')
})

test('the board pane marks a held ticket Waiting until its date, and a passed date or no hold shows nothing', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-143')!, { notBefore: FUTURE })
  Object.assign(seen.server.find(t => t.key === 'TCK-147')!, { notBefore: PAST })
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { notBefore: null })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await board.find({ type: 'Text', text: 'Waiting until 1 Dec 2999' })).toBeDefined()
  // Only the one held ticket is marked: the passed date and the null add nothing.
  expect(await board.find({ type: 'Text', text: /Waiting until (?!1 Dec 2999)/ })).toBeUndefined()
  await board.unmount()
})

test('a held ticket is not listed as the next ticket to take', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-143')!, { notBefore: FUTURE })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await board.find({ type: 'Text', text: 'Next to take: TCK-147' })).toBeDefined()
  await board.unmount()
})

test('a ticket whose date has passed is the next ticket to take again', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-143')!, { notBefore: PAST })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await board.find({ type: 'Text', text: 'Next to take: TCK-143' })).toBeDefined()
  await board.unmount()
})

test('the ticket pane shows the hold of a held ticket at a narrow width, and none for a ticket with no hold', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-143')!, { notBefore: FUTURE })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-143' })
  await board.unmount()
  const props = { title: 'TCK-143', isFocused: true, bodyColumns: 30, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props } as const)
  expect((await pane.find({ type: 'Text', text: 'Waiting until 1 Dec 2999' }))?.props?.wrap).toBe('truncate-end')
  await pane.unmount()
  const b2 = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await b2.press({ key: 'open-TCK-147' })
  await b2.unmount()
  const none = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { ...props, title: 'TCK-147' } } as const)
  expect(await none.find({ type: 'Text', text: /Waiting until/ })).toBeUndefined()
  await none.unmount()
})

test('the board pane shows the hold and the next ticket on a narrow terminal', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-143')!, { notBefore: FUTURE })
  await start($)
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 30 } } as typeof PANE
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...narrow })
  const held = await board.find({ type: 'Text', text: 'Waiting until 1 Dec 2999' })
  expect(held?.props?.wrap).toBe('truncate-end')
  const next = await board.find({ type: 'Text', text: 'Next to take: TCK-147' })
  expect(next?.props?.wrap).toBe('truncate-end')
  await board.unmount()
})

const take = ($: Parameters<typeof start>[0], key: string) => $.command.run({ ...RUN, command: 'tick-it', args: `take ${key}` })

test('/tick-it take refuses a ticket held until a future date, naming it, and writes nothing', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { notBefore: FUTURE })
  const before = { ...seen.server.find(t => t.key === 'TCK-149')! }
  await start($)
  const out = await take($, 'TCK-149')
  expect(JSON.stringify(out)).toContain('TCK-149 is held until 1 Dec 2999')
  const after = seen.server.find(t => t.key === 'TCK-149')!
  expect(after.status).toBe(before.status)
  expect(after.assignee).toBe(before.assignee)
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket')).toBe(false)
})

test('/tick-it take takes a ticket whose date has passed, and one with no hold, as before', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { notBefore: PAST })
  await start($)
  await take($, 'TCK-149')
  expect(seen.server.find(t => t.key === 'TCK-149')).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
  await take($, 'TCK-147')
  expect(seen.server.find(t => t.key === 'TCK-147')).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
})

test("the pane's start shows the server's refusal of a held ticket unchanged and does not retry", async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { notBefore: FUTURE })
  const before = { ...seen.server.find(t => t.key === 'TCK-149')! }
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  await board.unmount()
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  await pane.press({ key: 'start-session' })
  expect(seen.toasts.at(-1)).toContain(`could not start a session on TCK-149: TCK-149 is held until ${FUTURE}: it cannot be started before then.`)
  expect(seen.ticketCalls.filter(c => c.tool === 'start_session')).toHaveLength(1)
  expect(seen.server.find(t => t.key === 'TCK-149')).toMatchObject({ status: before.status, assignee: before.assignee })
  await pane.unmount()
})

test("/tick-it take shows the server's refusal of a hold in its reason, sends update_ticket once, and moves nothing", async ($, on) => {
  const seen = engine(on, { lines: 0 })
  const reason = `TCK-149 is held until ${FUTURE}: it cannot be started before then.`
  // The hold is not in what the mod read (a date set after it read), so only the server refuses.
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { refuseHold: reason })
  const before = { ...seen.server.find(t => t.key === 'TCK-149')! }
  await start($)
  const out = await take($, 'TCK-149')
  expect(JSON.stringify(out)).toContain(reason)
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket')).toHaveLength(1)
  expect(seen.server.find(t => t.key === 'TCK-149')).toMatchObject({ status: before.status, assignee: before.assignee })
})

test('/tick-it take resumes a held ticket that is already In progress, as the server does', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { notBefore: FUTURE, status: 'In progress' })
  await start($)
  await take($, 'TCK-149')
  expect(seen.server.find(t => t.key === 'TCK-149')).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
})
