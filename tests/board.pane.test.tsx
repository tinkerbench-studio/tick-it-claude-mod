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
    expect((await ui.find({ key: 'TCK-147' }))?.text).toContain('◆')
    await ui.unmount()
  }
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find(s => s.id === 'tick-it:brief')?.text).toContain('TCK-147')
})
