import { expect, test } from 'claude-code/testing'

import { withTickit } from '../hooks/reviews'
import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const HEAD = 'ab12'.repeat(10)
const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const finding = (id: string, skill: string, extra: Record<string, unknown> = {}) => ({ id, skill, file: 'api/a.ts', line: 4, text: 'no test for expiry', required: true, fixed: false, ...extra })
const entry = (round: number, blocking: number, headSha?: string) => ({ type: 'review', round, at: '2026-11-01T10:00:00Z', pastLimit: false, pastBudget: false, agents: [{ skill: 'principal', blocking, optional: 0, verdicts: [], ...(headSha === undefined ? {} : { headSha }) }] })
const run = (on: Parameters<Parameters<typeof test>[1]>[1], net: Net) => engine(on, { lines: 10 }, true, PRINCIPAL, net)
const done = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
}

test('a session with no local review state gives the reviewer the ticket’s open required findings of its skill, and only those', async ($, on) => {
  const seen = run(on, { timeline: [], findings: [finding('f1', 'principal'), finding('f2', 'security'), finding('f3', 'principal', { fixed: true }), finding('f4', 'principal', { required: false })] })
  await done($)
  expect(seen.spawned[0]?.prompt).toContain('1. api/a.ts:4 no test for expiry')
  expect(seen.spawned[0]?.prompt).not.toContain('2. ')
})

test('the FINDING verdict on a Tick-it finding is sent in record_runs with its Tick-it id', async ($, on) => {
  const seen = run(on, { timeline: [], findings: [finding('f1', 'principal')] })
  await done($)
  await $.turn.complete(finishTurn('agent-1', 'FINDING: 1 fixed the expiry test is added\nVERDICT: clean'))
  const sent = seen.recorded.flatMap(c => c.args.runs).find(r => r.agentId === 'agent-1')
  expect(sent).toMatchObject({ verdicts: [{ finding: 'f1', file: 'api/a.ts', text: 'no test for expiry', verdict: 'fixed' }] })
})

test('a skill with an open Tick-it finding is not carried forward, and a head already reviewed clean does not settle while one is open', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0, HEAD)], findings: [finding('f1', 'principal')] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.prompt).toContain('1. api/a.ts:4 no test for expiry')
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).not.toBe('Done')
})

test('a finding already in local state is not given twice, and takes the Tick-it id', () => {
  const local = [{ file: 'api/a.ts', line: 4, text: 'no test for expiry' }]
  expect(withTickit(local, [{ id: 'f1', file: 'api/a.ts', line: 4, text: 'no test for expiry' }, { id: 'f2', text: 'other' }])).toEqual([{ ...local[0], id: 'f1' }, { id: 'f2', text: 'other' }])
  expect(withTickit(local)).toEqual(local)
})
