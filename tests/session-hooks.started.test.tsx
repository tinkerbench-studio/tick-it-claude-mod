import { expect, test } from 'claude-code/testing'

import { brief } from '../hooks/register'
import { MOD_VERSION } from '../hooks/state'
import { RUN, SKILLS, engine, finishTurn, start, STARTED, typed, reports } from './helpers'
import type { Net } from './helpers'

test('a session Tick-it started takes its ticket from the first message, hands Claude the brief and reports working', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const entered = await $.prompt.submit(typed(STARTED))
  expect('context' in entered ? entered.context?.some(c => c.includes('TCK-151')) : false).toBe(true)
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
  expect(reports(seen)).toEqual([{ repository: 'acme/web-app', session: 's_abc12345', status: 'working', claudeSessionId: 'session-1', modVersion: MOD_VERSION, summary: 'Took TCK-151.' }])
})

test('a started session hands Claude what Tick-it already wants of it, when its first turn ends', async ($, on) => {
  const net: Net = { reportInstructions: ['The pull request for TCK-151 has a merge conflict with main. Merge main in.'] }
  const seen = engine(on, { lines: 0 }, true, {}, net)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect(seen.submitted.filter(t => t.includes('merge conflict with main'))).toEqual([])
  await $.turn.complete(finishTurn(undefined, 'Started.'))
  expect(seen.submitted.filter(t => t.includes('merge conflict with main'))).toEqual(['The pull request for TCK-151 has a merge conflict with main. Merge main in.'])
})

test('instructions wait while a review round runs, rather than racing its agents', async ($, on) => {
  const net: Net = {}
  const seen = engine(on, { lines: 40 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, net)
  await start($)
  await $.prompt.submit(typed(STARTED))
  net.reportInstructions = ['Merge main in and resolve the conflict.']
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.submitted.filter(t => t.includes('Merge main in'))).toEqual([])
  await $.turn.complete(finishTurn(undefined, 'Moved it to review.'))
  expect(seen.submitted.filter(t => t.includes('Merge main in'))).toEqual([])
})

test('instructions the end-of-turn report brings go to Claude in that same turn end', async ($, on) => {
  const net: Net = {}
  const diff = { lines: 0 }
  const seen = engine(on, diff, true, {}, net)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await $.turn.complete(finishTurn(undefined, 'Added the picker.'))
  // A turn that changed nothing sends no working report (TCK-98), so the turn that brings the instruction changed the diff.
  diff.lines = 5
  net.reportInstructions = ['Merge main in and resolve the conflict.']
  net.skip = 120_000
  await $.turn.complete(finishTurn(undefined, 'Added tests.'))
  expect(seen.submitted.filter(t => t.includes('Merge main in'))).toEqual(['Merge main in and resolve the conflict.'])
})

test('a started session submits no prompt of its own when its report brings no instructions', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect(seen.submitted).toEqual([STARTED])
})

test('a started session reports its latest word, at most once a minute, and each change of status at once', async ($, on) => {
  const seen = engine(on, { lines: 40 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  // The engine clock moves a second per read, so these turns fall inside the minute.
  await $.turn.complete(finishTurn(undefined, 'Added the picker.\nMore detail.'))
  await $.turn.complete(finishTurn(undefined, 'Added tests.'))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(reports(seen).map(r => [r.status, r.summary])).toEqual([
    ['working', 'Took TCK-151.'],
    ['reviewing', 'Moved to In review.'],
    ['reviewing', 'Review round 1.'],
    ['done', 'Clean after 1 round.'],
  ])
  expect(reports(seen).at(-1)?.changedLines).toBe(40)
})

test('Claude moving its ticket to In review itself is /tick-it done: changed lines, then the review agents when the turn ends', async ($, on) => {
  const seen = engine(on, { lines: 40 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'tck-151', status: 'In review' } as never)
  expect('context' in moved ? moved.context?.at(-1) : undefined).toBe('tick-it: TCK-151 is In review. When this turn ends tick-it runs its review agents; their blocking findings come back to you to fix.')
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket').at(-1)?.args).toMatchObject({ key: 'TCK-151', status: 'In review', changedLines: 40 })
  expect(seen.spawned).toEqual([])
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-151, round 1'])
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Done')
  expect(reports(seen).map(r => [r.status, r.summary])).toEqual([
    ['working', 'Took TCK-151.'],
    ['reviewing', 'Moved to In review.'],
    ['reviewing', 'Claude moved TCK-151 to In review; its review agents start when this turn ends.'],
    ['reviewing', 'Review round 1.'],
    ['done', 'Clean after 1 round.'],
  ])
  // The turn that finished it counts as building it.
  expect(seen.recorded.flatMap(r => r.args.runs).some(r => r.agentId === 'turn-turn-main-9' && r.kind === 'build' && r.ticket === 'TCK-151')).toBe(true)
})
