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
  // $2.40 of $3 over the rounds in progress (the 3 recorded, then round 4) is $0.60 a round: it fits the $0.60 left. Counted as one round it would not ($2.40).
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

test('a reviewer that was refused at this head (recorded with a blocking count) is not read as clean in a later session: it runs', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 1, HEAD)] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
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
  expect(seen.spawned[0]?.description).toContain('round 2')
})

test('the skill’s newest run decides: a later blocking run on this head is reviewed again', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0, HEAD), entry(2, 2, HEAD)] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 3')
})

test('a run recorded as not applicable counts as reviewed on this head only: no reviewer starts on it, and one on another head is reviewed', async ($, on) => {
  const seen = run(on, { timeline: [{ ...entry(1, 0), agents: [{ skill: 'principal', blocking: 0, optional: 0, verdicts: [], notApplicable: 'Nobody sees this change.', headSha: HEAD }] }] })
  await done($)
  expect(seen.spawned).toHaveLength(0)
})

test('a not-applicable run on an earlier head does not skip the review of this one', async ($, on) => {
  const seen = run(on, { timeline: [{ ...entry(1, 0), agents: [{ skill: 'principal', blocking: 0, optional: 0, verdicts: [], notApplicable: 'Nobody sees this change.', headSha: 'cafe' }] }] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
})

test('round numbers repeat across sessions: the entries are counted, and the newest entry of a skill decides', async ($, on) => {
  // As on TCK-29: three entries all numbered 1, so the next round is 4; the last one is clean on this head, an older blocking one does not count.
  const seen = run(on, { timeline: [entry(1, 1, 'cafe'), entry(1, 1, 'f00d'), entry(1, 0, HEAD)] })
  await done($)
  expect(seen.spawned).toHaveLength(0)
})

test('with entries all numbered 1, the first round is the number of entries plus one', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 1, 'cafe'), entry(1, 1, 'f00d'), entry(1, 1, 'beef')] })
  await done($)
  expect(seen.spawned[0]?.description).toContain('round 4')
})

test('budgetStop counts entries, not distinct round numbers: three entries numbered 1 fit $0.80 left of $3', async ($, on) => {
  const seen = run(on, { modConfig: served, reviewSpend: spend(2.2), timeline: [entry(1, 1), entry(1, 1), entry(1, 1)] })
  await done($)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
})

test('from a command, a head already reviewed clean with an unticked check is reviewed as before (a command cannot ask Claude to tick it)', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0, HEAD)] })
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, { acceptanceItems: [{ id: 'c1', text: 'It saves', checked: false }] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 2')
})

test('from a command, a head already reviewed clean with a failing pull request is reviewed as before', async ($, on) => {
  const seen = run(on, { timeline: [entry(1, 0, HEAD)], pullRequests: [{ number: 7, state: 'open', draft: true, ci: 'failure' }] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
})

test('with two applicable skills, one clean on this head and one with no run on it still starts a review', async ($, on) => {
  const second = '---\nname: second\ndescription: another\n---\nLook.\n'
  const seen = engine(on, { lines: 10 }, true, { ...PRINCIPAL, '.tick-it/skills/second/SKILL.md': second }, { timeline: [entry(1, 0, HEAD)] })
  await done($)
  expect(seen.spawned.length).toBeGreaterThan(0)
})

test('budgetStop with the timeline unreadable divides by this session’s own round', async ($, on) => {
  const seen = run(on, { modConfig: served, reviewSpend: spend(2.4), timeline: 'unreachable' })
  await done($)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ kind: 'no-clean-round' })
})

test('a head reviewed clean with uncommitted edits since is reviewed again: the commit alone does not say what was reviewed', async ($, on) => {
  const seen = engine(on, { lines: 10, dirty: true }, true, PRINCIPAL, { timeline: [entry(1, 0, HEAD)] })
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.description).toContain('round 2')
})

test('runs the outbox has not sent yet still count: a second start in the session never reuses a round number', async ($, on) => {
  const seen = run(on, { timeline: [] })
  await done($)
  expect(seen.spawned[0]?.description).toContain('round 1')
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.spawned.at(-1)?.description).toContain('round 2')
})

test('with the timeline unreadable too, a second start in the session still never reuses a round number', async ($, on) => {
  const seen = run(on, { timeline: 'unreachable' })
  await done($)
  expect(seen.spawned[0]?.description).toContain('round 1')
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.spawned.at(-1)?.description).toContain('round 2')
})
