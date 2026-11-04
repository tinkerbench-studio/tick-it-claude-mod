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

test('CI turning failing raises one toast and opens the board, again only after it left failing', async ($, on) => {
  const net: Net = { pullRequests: [{ number: 12, state: 'open', draft: true, ci: 'pending' }] }
  const seen = engine(on, { lines: 12 }, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)

  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'success' }]
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1 } as never)

  net.pullRequests = [{ number: 12, state: 'merged', draft: false, ci: null }]
  await $.turn.complete({ turnId: 't2b', reason: 'answer', answer: 'ok', durationMs: 1 } as never)

  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'failure' }]
  await $.turn.complete({ turnId: 't2c', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
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
})

test('the band stays empty with no ticket taken', async ($, on) => {
  engine(on, { lines: 0 })
  await start($)
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /\/100/ })).toBeUndefined()
  await ui.unmount()
})

test('the band is the key, title, status, diff and Board, and the key opens the ticket pane', async ($, on) => {
  const net: Net = {
    pullRequests: [{ number: 12, state: 'open', draft: false, ci: 'success', mergeQueue: { position: 1 } }],
    milestones: [{ title: 'Checkout launch before the holiday freeze', dueOn: null, epics: [{ title: 'One-page checkout', tickets: 2, done: 0 }], tickets: 2, done: 0 }],
  }
  const seen = engine(on, { lines: 12 }, true, {}, net)
  Object.assign(seen.server[0]!, { labels: ['checkout', 'api'], description: 'Keep the **step** across reloads.', url: 'https://app.tick-it.dev/r/acme/web-app/t/TCK-143' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)

  const band = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: '12/100' })).toBeDefined()
  expect(await band.find({ key: 'board' })).toBeDefined()
  expect(await band.find({ key: 'done' })).toBeUndefined()
  expect(await band.find({ key: 'pull-request' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /#12|◇/ })).toBeUndefined()
  await band.press({ key: 'ticket' })
  expect(seen.opened.filter(id => id === 'tick-it-ticket')).toHaveLength(1)
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'desktop', component: 'Pane', requestId: 'tick-it-ticket', props: { title: 'TCK-143', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const)
  expect(await pane.find({ type: 'Text', text: 'XS · One-page checkout · Checkout launch before the holiday freeze' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'checkout · api' })).toBeDefined()
  expect(await pane.find({ type: 'Link', text: 'Open in Tick-it' })).toBeDefined()
  expect(await pane.find({ type: 'Link', text: 'Open PR on GitHub' })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: 'Keep the **step** across reloads.' })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: '- GET /checkout resumes at stored step' })).toBeDefined()
  await pane.unmount()
})
