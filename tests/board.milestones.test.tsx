import { expect, test } from 'claude-code/testing'

import { boardStops, milestoneLine, nextMilestone, pickMilestone } from '../hooks/register'
import { PANE, RUN, engine, start } from './helpers'

test('milestoneLine, pickMilestone and nextMilestone', () => {
  const a = { title: 'v1', dueOn: '2026-11-06', epics: [], tickets: 9, done: 3 }
  const b = { title: 'v2', dueOn: null, epics: [], tickets: 0, done: 0 }
  expect(milestoneLine(a)).toBe('v1 · 3/9 done · due Nov 6')
  expect(milestoneLine(b)).toBe('v2 · 0/0 done')
  expect(pickMilestone([], null)).toBeUndefined()
  expect(pickMilestone([a, b], 'gone')?.title).toBe('v1')
  expect(nextMilestone([a, b], null)).toBe('v2')
  expect(nextMilestone([a, b], 'v2')).toBe('v1')
  expect(nextMilestone([], null)).toBeNull()
})

test('the board pane shows the milestone header and m cycles the milestones, showing their tickets', async ($, on) => {
  const milestones = [
    { title: 'Checkout', dueOn: '2026-11-06', epics: [{ title: 'One-page checkout', tickets: 2, done: 0 }], tickets: 2, done: 1 },
    { title: 'Addresses', dueOn: null, epics: [{ title: 'Address autocomplete', tickets: 2, done: 0 }], tickets: 2, done: 0 },
  ]
  engine(on, { lines: 10 }, true, {}, { milestones })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Checkout · 1\/2 done · due Nov 6/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-143/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-147/ })).toBeUndefined()
  await ui.press({ key: 'milestone-next' })
  expect(await ui.find({ type: 'Text', text: /Addresses · 0\/2 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-147/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-143/ })).toBeUndefined()
  await ui.unmount()
})

test('with no milestones the board pane has no header and shows every ticket', async ($, on) => {
  engine(on, { lines: 10 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'milestone' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /TCK-143/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-147/ })).toBeDefined()
  await ui.unmount()
})

test('tickets in no milestone get a last stop on the m cycle, and a single milestone has no m button', async ($, on) => {
  const one = { title: 'Checkout', dueOn: null, epics: [{ title: 'One-page checkout', tickets: 2, done: 0 }], tickets: 2, done: 0 }
  const list = [
    { epic: 'One-page checkout', status: 'Ready' },
    { epic: 'Unsorted', status: 'Done' },
    { epic: 'Unsorted', status: 'Ready' },
  ] as never
  expect(boardStops([], list)).toEqual([])
  expect(boardStops([one], [{ epic: 'One-page checkout', status: 'Ready' }] as never)).toEqual([one])
  expect(boardStops([one], list).at(-1)).toMatchObject({ title: 'No milestone', tickets: 2, done: 1, epics: [{ title: 'Unsorted', tickets: 2, done: 1 }] })

  engine(on, { lines: 10 }, true, {}, { milestones: [one] })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  // The fake board has tickets in other epics, so the stop exists and the epic's tickets are the first view.
  expect(await ui.find({ type: 'Button', text: /TCK-147/ })).toBeUndefined()
  await ui.press({ key: 'milestone-next' })
  expect(await ui.find({ type: 'Text', text: /No milestone · 0\/\d+ done/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-147/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /TCK-143/ })).toBeUndefined()
  await ui.unmount()
})
