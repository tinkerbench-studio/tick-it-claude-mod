import { expect, test } from 'claude-code/testing'

import { brief } from '../hooks/register'
import { BAND, RUN, COMPOSE, engine, start } from './helpers'
import type { Net } from './helpers'

test('taking a ticket puts its brief in the system prompt and the band', async ($, on) => {
  engine(on, { lines: 12 })
  await start($)

  const before = await $.prompt.compose(COMPOSE)
  expect(before.sections.some(s => s.id === 'tick-it:brief')).toBe(false)

  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-143' })
  expect(taken.text).toContain('TCK-143 Persist checkout step in session')
  expect(taken.context?.[0]).toContain('Expired session falls back to step 1')

  const after = await $.prompt.compose(COMPOSE)
  const brief = after.sections.find(s => s.id === 'tick-it:brief')
  expect(brief?.scope).toBe('session')
  expect(brief?.text).toContain('under 100 changed lines')
  expect(brief?.text).toContain('(epic: One-page checkout)')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tick-it', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '12/100' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band shows the pull request and CI after each turn, and the last one with why when a read fails', async ($, on) => {
  const net: Net = { pullRequests: [{ number: 12, state: 'open', draft: true, ci: 'pending' }] }
  const seen = engine(on, { lines: 12 }, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '#12 draft · CI running · 12 lines' })).toBeDefined()
  await ui.unmount()

  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'success' }]
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const again = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await again.find({ type: 'Text', text: '#12 open · CI passing · 12 lines' })).toBeDefined()
  await again.unmount()

  net.pullRequests = [{ number: 12, state: 'merged', draft: false, ci: null }]
  await $.turn.complete({ turnId: 't2b', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const merged = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await merged.find({ type: 'Text', text: '#12 merged · no CI yet · 12 lines' })).toBeDefined()
  await merged.unmount()

  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'failure' }]
  await $.turn.complete({ turnId: 't2c', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const red = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await red.find({ type: 'Text', text: '#12 open · CI failing · 12 lines' })).toBeDefined()
  await red.unmount()
  expect(seen.toasts.filter(t => t.includes('CI is failing on #12 open'))).toHaveLength(1)
  await $.turn.complete({ turnId: 't2d', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  expect(seen.toasts.filter(t => t.includes('CI is failing'))).toHaveLength(1)
  expect(seen.toasts.find(t => t.includes('CI is failing'))).toContain('CI is failing on #12 open for TCK-143.')
  expect(seen.opened.filter(id => id === 'tick-it-board')).toHaveLength(1)
  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'success' }]
  await $.turn.complete({ turnId: 't2e', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'failure' }]
  await $.turn.complete({ turnId: 't2f', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  expect(seen.toasts.filter(t => t.includes('CI is failing'))).toHaveLength(2)
  expect(seen.opened.filter(id => id === 'tick-it-board')).toHaveLength(2)

  net.pullRequests = 'unreachable'
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const failed = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await failed.find({ type: 'Text', text: /#12 open · CI failing · 12 lines \(last read; Tick-it is down\)/ })).toBeDefined()
  await failed.unmount()
})

test('a failed first read says the pull request was not read, not that there is none', async ($, on) => {
  engine(on, { lines: 12 }, true, {}, { pullRequests: 'unreachable' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'pull request not read yet (Tick-it is down)' })).toBeDefined()
  await ui.unmount()
})

test('the band stays empty with no ticket taken', async ($, on) => {
  engine(on, { lines: 0 })
  await start($)
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /\/100/ })).toBeUndefined()
  await ui.unmount()
})
