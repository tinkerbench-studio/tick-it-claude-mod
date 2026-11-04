import { expect, test } from 'claude-code/testing'

import { brief } from '../hooks/register'
import { PANE, RUN, COMPOSE, engine, start } from './helpers'

test('with no pane available, /tick-it board prints the board as text', async ($, on) => {
  engine(on, { lines: 0 }, false)
  await start($)
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).toContain('Ready (4)')
  expect(board.text).toContain('TCK-147  Add address validation service client  XS')
})

test('pressing a ticket in the board pane takes it', async ($, on) => {
  engine(on, { lines: 0 })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tick-it', surface, ...PANE })
    await ui.press({ key: 'TCK-147' })
    expect((await ui.find({ key: 'open-TCK-147' }))?.text).toContain('◆')
    await ui.unmount()
  }
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find(s => s.id === 'tick-it:brief')?.text).toContain('TCK-147')
})

test("pressing a ticket's key in the board pane opens its details without taking it", async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  expect(seen.opened).toContain('tick-it-ticket')
  expect((await board.find({ key: 'open-TCK-149' }))?.text).not.toContain('◆')
  await board.unmount()

  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  expect(await pane.find({ type: 'Text', text: 'TCK-149 Migrate orders.shipping_address to JSONB' })).toBeDefined()
  await pane.unmount()
})

test("the ticket pane starts a Claude Code session on a ticket that is not taken, and links to it", async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  await board.unmount()
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  expect(await pane.find({ type: 'Link', text: 'Open the new session' })).toBeUndefined()
  await pane.press({ key: 'start-session' })
  expect(seen.ticketCalls.find(c => c.tool === 'start_session')?.args).toEqual({ repository: 'acme/web-app', key: 'TCK-149', place: 'local' })
  expect(seen.toasts.at(-1)).toContain('started a session on TCK-149')
  expect(await pane.find({ type: 'Link', text: 'Open the new session' })).toBeDefined()
  await pane.unmount()
})

test("the ticket pane lists what the ticket waits on and blocks; pressing one shows that ticket, one off the board links to its page", async ($, on) => {
  const seen = engine(on, { lines: 0 })
  Object.assign(seen.server[3]!, { blockedBy: ['TCK-147', 'TCK-900'], blocks: ['TCK-151'], url: 'https://app.tick-it.dev/r/acme/web-app/t/TCK-149' })
  await start($)
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'open-TCK-149' })
  await board.unmount()
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-149', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  expect(await pane.find({ type: 'Text', text: 'WAITING ON' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'BLOCKS' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Add address validation service client' })).toBeDefined()
  expect(await pane.find({ type: 'Link', text: 'TCK-900' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).toContain('https://app.tick-it.dev/r/acme/web-app/t/TCK-900')
  await pane.press({ key: 'ref-TCK-151-open' })
  expect(await pane.find({ type: 'Text', text: 'TCK-151 Saved cards: list + delete endpoint' })).toBeDefined()
  await pane.unmount()
})
