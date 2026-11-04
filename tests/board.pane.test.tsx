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
