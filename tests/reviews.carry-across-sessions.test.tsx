import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const HEAD = 'ab12'.repeat(10)
const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const entry = (round: number, blocking: number, headSha?: string) => ({ type: 'review', round, at: '2026-11-01T10:00:00Z', pastLimit: false, pastBudget: false, agents: [{ skill: 'principal', blocking, optional: 0, verdicts: [], ...(headSha === undefined ? {} : { headSha }) }] })
const spend = (costUsd: number, budget = 3) => ({ size: 'XS', runs: 2, costUsd, unpriced: 0, lowerBound: false, budget, remaining: budget - costUsd, overBudget: costUsd > budget })
const served = { sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 }, defaultReviewRounds: { XS: 4, S: 3, M: 5, L: 6 }, maxReviewRounds: 10, reviewBudget: 3, briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'x', branch: 'b', addToTicket: ['a'] } }

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]
const done = async ($: Ctx) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
}
const run = (on: On, net: Net) => engine(on, { lines: 10 }, true, PRINCIPAL, net)
const roundsSent = (seen: ReturnType<typeof run>) => seen.recorded.flatMap(c => c.args.runs.filter(r => r.skill === 'principal').map(r => r.round))

test('a session whose ticket has 2 recorded rounds starts its first round as round 3 and sends that round with the runs', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 1, 'cafe'), entry(2, 1, 'f00d')] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 3')
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(roundsSent(seen)).toEqual([3])
})

test('a ticket with no recorded rounds starts at round 1', async ($, on) => {
  const seen = run(on, { timeline: [] })
  await done($)
  expect(seen.spawned[0]?.description).toContain('round 1')
})

test('the recorded rounds cannot be read: round 1 and a review, as before', async ($, on) => {
  const seen = run(on, { timeline: 'unreachable' })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 1')
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(roundsSent(seen)).toEqual([1])
})

test('budgetStop divides the spend of every session by the rounds recorded: a round that fits is not stopped, and one that would overshoot is', async ($, on) => {
  // $2.40 of $3 over 4 recorded rounds is $0.60 a round: it fits the $0.60 left. Counted as one round it would not ($2.40).
  const fits = run(on, { modConfig: served, reviewSpend: spend(2.4), timeline: [entry(1, 1), entry(2, 1), entry(3, 1)] })
  await done($)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(fits.spawned).toHaveLength(1)
  expect(fits.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
  expect(fits.submitted[0]).toContain('Round 4 review')
})

test('the same spend with only this session’s round recorded stops: the budget would be overshot', async ($, on) => {
  const seen = run(on, { modConfig: served, reviewSpend: spend(2.4), timeline: [] })
  await done($)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ kind: 'no-clean-round' })
})

test('every applicable skill already reviewed this head with nothing blocking: no reviewer starts and the ticket settles from the pull request', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 1, 'cafe'), entry(2, 0, HEAD)] })
  await done($)
  expect(seen.spawned).toHaveLength(0)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
})

test('a head that differs from the reviewed one is reviewed: the round starts', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0, 'cafe')] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 2')
})

test('a clean round that names no head is not taken for this head: the round starts', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0)] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
})

test('the skill’s newest run decides: a later blocking run on this head is reviewed again', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0, HEAD), entry(2, 2, HEAD)] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 3')
})
