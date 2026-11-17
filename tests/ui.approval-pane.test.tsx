import { expect, test } from 'claude-code/testing'

import { PANE, engine, start } from './helpers'

const TICKET = { plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const URL = 'https://app.tick-it.dev/r/acme/web-app/t/TCK-149'
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const request = (more: Record<string, unknown>) => ({ id: 'a1', state: 'open', subject: 'Ship the picker?', items: [{ kind: 'pull-request' }, { kind: 'picture' }, { kind: 'picture' }], questions: [], reviewer: 'maddiecs84', staleReason: null, askedAt: ago(3 * 3_600_000), ...more })

/** Opens TCK-149's pane from the board, with Tick-it answering these approvals (none: the part is left out of the answer). */
async function open($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], approvals?: unknown[]) {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server.find(t => t.key === 'TCK-149')!, { url: URL, ...(approvals === undefined ? {} : { approvals }) })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  await board.unmount()
  return { seen, pane: await $.ui.mount(TICKET) }
}
const texts = async (pane: { find: (q: { type: string; text: RegExp | string }) => Promise<unknown> }, text: RegExp | string) => pane.find({ type: 'Text', text })

test('an open request shows WAITING FOR APPROVAL: subject, items by kind, who may answer, how long, a link, and no answer buttons', async ($, on) => {
  const { pane } = await open($, on, [request({})])
  expect(await texts(pane, 'WAITING FOR APPROVAL')).toBeDefined()
  expect(await texts(pane, 'Ship the picker?')).toBeDefined()
  expect(await texts(pane, '1 pull-request, 2 picture')).toBeDefined()
  expect(await texts(pane, 'Who may answer: maddiecs84')).toBeDefined()
  expect(await texts(pane, 'Waiting 3 hours')).toBeDefined()
  const link = await pane.find({ type: 'Link', text: 'Open the request in Tick-it' })
  expect(JSON.stringify(link)).toContain(`${URL}#ar_a1`)
  expect(await pane.find({ type: 'Button', text: /confirm|reject|rethink/i })).toBeUndefined()
})

test('a stale request shows changed since asked and no waiting line', async ($, on) => {
  const { pane } = await open($, on, [request({ staleReason: 'the pull request changed' })])
  expect(await texts(pane, 'Changed since asked: the pull request changed')).toBeDefined()
  expect(await texts(pane, /Waiting \d/)).toBeUndefined()
  expect(await pane.find({ key: 'approval-waiting' })).toBeUndefined()
})

test('an answered request shows its decision, who it was asked of and the answers, but no answerer or time', async ($, on) => {
  const { pane } = await open($, on, [request({ state: 'rejected', questions: [{ id: 'q1', text: 'Which size?', recommended: 'S', state: 'answered', answer: 'M' }] })])
  expect(await texts(pane, 'APPROVAL ANSWERED')).toBeDefined()
  expect(await texts(pane, 'Decision: rejected')).toBeDefined()
  expect(await texts(pane, 'Asked of: maddiecs84')).toBeDefined()
  expect(await texts(pane, 'Which size? → M')).toBeDefined()
  expect(await texts(pane, 'WAITING FOR APPROVAL')).toBeUndefined()
  expect(await texts(pane, /Waiting \d|Answered by|Answered at/)).toBeUndefined()
})

for (const [name, approvals] of [['no request', []], ['a reply without approvals (an older Tick-it)', undefined]] as const) {
  test(`${name}: the pane shows neither approval section`, async ($, on) => {
    const { pane } = await open($, on, approvals as unknown[] | undefined)
    expect(await texts(pane, 'TCK-149 Migrate orders.shipping_address to JSONB')).toBeDefined()
    expect(await texts(pane, /APPROVAL/)).toBeUndefined()
  })
}

test('the approvals part is asked for only on the ticket read for the pane or the take, never on the board read', async ($, on) => {
  const { seen } = await open($, on, [])
  const includes = seen.ticketCalls.filter(c => c.tool === 'get_ticket' && Array.isArray(c.args.include) && c.args.include.includes('approvals'))
  expect(includes.map(c => c.args.key)).toEqual(['TCK-149'])
  expect(seen.ticketCalls.filter(c => c.tool === 'list_tickets').every(c => c.args.include === undefined)).toBe(true)
})
