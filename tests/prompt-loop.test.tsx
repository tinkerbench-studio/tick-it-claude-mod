import { expect, test } from 'claude-code/testing'

import { STARTED, engine, finishTurn, reports, start, typed } from './helpers'
import type { Net } from './helpers'

// TCK-98: a stopped session is told to Claude only when it is this session, and once; plugin prompts that change nothing stop after three.
type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

const TICK = 'mcp__plugin_tick-it_tickit__set_criterion_checked'
const sent = (seen: ReturnType<typeof engine>) => seen.submitted.slice(1)
const stopped = (code: string) => JSON.stringify({ sessionStopped: { session: 's_abc12345', code, resume: 'report reviewing' } })
const tick = ($: Ctx, n: number) => $.tool.call({ tool: TICK, tool_use_id: `tu-${n}`, repository: 'acme/web-app', key: 'TCK-143', criterion: 'c1', checked: true } as never)

/** A session Tick-it started on TCK-143, its ticket taken. */
const begin = async ($: Ctx, on: On, net: Net = {}, diff: { lines: number; remoteHead?: string } = { lines: 10 }) => {
  const seen = engine(on, diff, true, {}, net)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  return seen
}

/** A turn that ends after Tick-it answered a tick with a new instruction, as any future loop would. */
const turn = async ($: Ctx, net: Net, n: number) => {
  net.toolResult = stopped(`code-${n}`)
  await tick($, n)
  await $.turn.complete(finishTurn(undefined, `Nothing has changed ${n}.`))
}

test('a sessionStopped for a different Tick-it session queues no prompt and is a toast only', async ($, on) => {
  const net: Net = { toolResult: JSON.stringify({ sessionStopped: { session: 's_other999', code: 'rounds-exhausted', resume: 'x' } }) }
  const seen = await begin($, on, net)
  for (let i = 0; i < 3; i++) {
    await tick($, i)
    await $.turn.complete(finishTurn(undefined, `Turn ${i}.`))
  }
  expect(sent(seen)).toEqual([])
  expect(seen.toasts.filter(t => t.includes('s_other999') && t.includes('rounds-exhausted'))).toHaveLength(1)
})

test('a sessionStopped for this session queues the prompt once for the same session, code and head', async ($, on) => {
  const net: Net = { toolResult: stopped('rounds-exhausted') }
  const seen = await begin($, on, net)
  for (let i = 0; i < 4; i++) {
    await tick($, i)
    await $.turn.complete(finishTurn(undefined, `Turn ${i}.`))
  }
  expect(sent(seen).filter(t => t.includes('is stopped'))).toHaveLength(1)
})

test('the stopped notice names the code Tick-it sends when there is no reason or note', async ($, on) => {
  const net: Net = { toolResult: stopped('rounds-exhausted') }
  const seen = await begin($, on, net)
  await tick($, 1)
  await $.turn.complete(finishTurn(undefined, 'Ticked.'))
  expect(sent(seen)[0]).toContain('is stopped (rounds-exhausted)')
  expect(sent(seen)[0]).not.toContain('no reason given')
})

test('three plugin-prompt turns in a row that change nothing stop the session and submit no more', async ($, on) => {
  const net: Net = {}
  const seen = await begin($, on, net)
  for (let i = 1; i <= 6; i++) await turn($, net, i)
  // The first turn was the person's start prompt; the next three began with a plugin prompt, and the third of them stopped the loop.
  expect(sent(seen)).toHaveLength(3)
  const stops = reports(seen).filter(r => r.status === 'stopped')
  expect(stops).toHaveLength(1)
  expect(stops[0]).toMatchObject({ stop: { code: 'prompt-loop' }, needsHuman: { kind: 'session-stopped', note: expect.stringContaining('Tick-it says this session') } })
})

test('a prompt a person types ends the stop and starts the count again', async ($, on) => {
  const net: Net = {}
  const seen = await begin($, on, net)
  for (let i = 1; i <= 5; i++) await turn($, net, i)
  expect(sent(seen)).toHaveLength(3)
  await $.prompt.submit(typed('Carry on please.'))
  await turn($, net, 6)
  await turn($, net, 7)
  // The typed prompt is in the list too: three, it, then two plugin prompts.
  expect(sent(seen)).toHaveLength(6)
  expect(reports(seen).filter(r => r.status === 'stopped')).toHaveLength(1)
})

test('a turn a person started resets the count, so two loops either side of it do not stop', async ($, on) => {
  const net: Net = {}
  const seen = await begin($, on, net)
  for (let i = 1; i <= 3; i++) await turn($, net, i)
  await $.prompt.submit(typed('What is going on?'))
  await turn($, net, 4)
  await turn($, net, 5)
  expect(reports(seen).filter(r => r.status === 'stopped')).toEqual([])
})

test('a turn that changed the diff resets the count', async ($, on) => {
  const net: Net = {}
  const diff = { lines: 10 }
  const seen = await begin($, on, net, diff)
  for (let i = 1; i <= 8; i++) {
    diff.lines += 5
    await turn($, net, i)
  }
  expect(reports(seen).filter(r => r.status === 'stopped')).toEqual([])
  expect(sent(seen)).toHaveLength(8)
})

test('a turn that moved HEAD resets the count', async ($, on) => {
  const net: Net = {}
  const diff: { lines: number; headNow?: string } = { lines: 10 }
  const seen = await begin($, on, net, diff)
  await turn($, net, 1)
  await turn($, net, 2)
  diff.headNow = 'cd34'.repeat(10)
  await turn($, net, 3)
  await turn($, net, 4)
  expect(reports(seen).filter(r => r.status === 'stopped')).toEqual([])
})

test('a turn with a tool call that writes resets the count', async ($, on) => {
  const net: Net = {}
  const seen = await begin($, on, net)
  for (let i = 1; i <= 8; i++) {
    await $.tool.call({ tool: 'NotebookEdit', tool_use_id: `nb${i}`, notebook_path: '/repo/a.ipynb' } as never)
    await turn($, net, i)
  }
  expect(reports(seen).filter(r => r.status === 'stopped')).toEqual([])
})

test('an answer that asks to resume ends the stop, so prompts follow again', async ($, on) => {
  const net: Net = {}
  const seen = await begin($, on, net)
  for (let i = 1; i <= 4; i++) await turn($, net, i)
  expect(sent(seen)).toHaveLength(3)
  // The next turn end reports working again, and Tick-it's answer says to resume.
  net.reportAnswers = [{ resume: true }]
  await turn($, net, 5)
  await turn($, net, 6)
  expect(sent(seen).length).toBeGreaterThan(3)
})
