import { expect, test } from 'claude-code/testing'

import { PANE, engine, start } from './helpers'
import type { Net } from './helpers'
import { waited } from '../hooks/approval-pane'

const URL = 'https://app.tick-it.dev/r/acme/web-app/t/TCK-149'
const open = { id: 'ar_7k2m', state: 'open', subject: 'Approve the pane boards', items: [{ name: 'A', kind: 'board', url: 'https://x.test/a' }, { name: 'B', kind: 'board', url: 'https://x.test/b' }, { name: 'C', kind: 'picture', url: 'https://x.test/c' }], outcomes: { confirm: 'c', reject: 'r', rethink: 't' }, questions: [], reviewer: 'maddiecs84', staleReason: null, askedAt: new Date(0).toISOString() }
const answered = { ...open, id: 'ar_9z', state: 'confirmed', questions: [{ id: 'q1', text: 'Dark first?', choices: ['yes', 'no'], recommended: 'yes', state: 'answered', answer: 'yes' }] }

/** Opens TCK-149's pane from the board, with the fake Tick-it's ticket given `approvals` (left out when undefined). */
const shown = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], approvals?: unknown[], net: Net = {}) => {
  const seen = engine(on, { lines: 0 }, true, {}, net)
  Object.assign(seen.server[3]!, { url: URL, ...(approvals === undefined ? {} : { approvals }) })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  await board.unmount()
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  return { seen, pane }
}

test('an open request: subject, items by kind, who may answer, how long, a link to #ar_<id>, and no answer button', async ($, on) => {
  const { pane } = await shown($, on, [open])
  expect(await pane.find({ type: 'Text', text: 'WAITING FOR APPROVAL' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Approve the pane boards' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '3 items: 2 boards, 1 picture' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).toContain('may answer: maddiecs84')
  expect(JSON.stringify(await pane.drawn())).toContain('waiting under an hour')
  expect(JSON.stringify(await pane.drawn())).toContain(`${URL}#ar_7k2m`)
  // The answer is given in Tick-it: the pane has no button for it.
  const drawn = JSON.stringify(await pane.drawn())
  for (const word of ['Confirm', 'Reject', 'Rethink']) expect(drawn).not.toContain(word)
  expect(await pane.find({ type: 'Button', text: 'Confirm' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: 'Reject' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: 'Rethink' })).toBeUndefined()
  await pane.unmount()
})

test('an answered request: the decision, who answered and the answers to its questions', async ($, on) => {
  const { pane } = await shown($, on, [answered])
  expect(await pane.find({ type: 'Text', text: 'WAITING FOR APPROVAL' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'APPROVAL ANSWERED' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Confirmed by maddiecs84' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Dark first?: yes' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Rethink' })).toBeUndefined()
  await pane.unmount()
})

test('a request marked stale says changed since asked in place of waiting', async ($, on) => {
  const { pane } = await shown($, on, [{ ...open, staleReason: 'the pull request changed' }])
  expect(await pane.find({ type: 'Text', text: 'APPROVAL CHANGED SINCE ASKED' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'WAITING FOR APPROVAL' })).toBeUndefined()
  expect(JSON.stringify(await pane.drawn())).toContain('changed since asked (the pull request changed)')
  await pane.unmount()
})

test('no request: an empty approvals list leaves the pane as it was', async ($, on) => {
  const { pane } = await shown($, on, [])
  expect(await pane.find({ type: 'Text', text: 'TCK-149 Migrate orders.shipping_address to JSONB' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).not.toMatch(/APPROVAL/)
  await pane.unmount()
})

test('an older Tick-it that refuses the approvals part is read without it, and the pane is as it was', async ($, on) => {
  const { seen, pane } = await shown($, on, undefined, { noApprovals: true })
  expect(await pane.find({ type: 'Text', text: 'TCK-149 Migrate orders.shipping_address to JSONB' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).not.toMatch(/APPROVAL/)
  expect(seen.ticketCalls.filter(c => c.tool === 'get_ticket' && c.args.key === 'TCK-149').map(c => c.args.include)).toEqual([['approvals'], []])
  await pane.unmount()
})

test('the time a request has waited', () => {
  const at = '2026-11-10T00:00:00.000Z'
  expect(waited(at, Date.parse(at) + 5 * 3_600_000)).toBe('waiting 5 h')
  expect(waited(at, Date.parse(at) + 72 * 3_600_000)).toBe('waiting 3 days')
})

test('the approvals part is read only for the ticket shown or taken, never for the board', async ($, on) => {
  const { seen, pane } = await shown($, on, [open])
  await pane.unmount()
  const withApprovals = seen.ticketCalls.filter(c => Array.isArray(c.args.include) && c.args.include.includes('approvals'))
  expect(withApprovals.map(c => [c.tool, c.args.key])).toEqual([['get_ticket', 'TCK-149']])
  expect(seen.ticketCalls.filter(c => c.tool === 'list_tickets').every(c => c.args.include === undefined)).toBe(true)
})
