import { expect, test } from 'claude-code/testing'

import { PANE, RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

// A pull request that blocks a round whose reviewer found nothing is fixed even when the review budget has no room for another reviewer round (TCK-34).
const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const served = { sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 }, defaultReviewRounds: { XS: 2, S: 3, M: 5, L: 6 }, maxReviewRounds: 10, reviewRounds: 3, reviewBudget: 1, briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'x', branch: 'b', addToTicket: ['a'] } }
const spend = (costUsd: number, budget = 1) => ({ size: 'XS', runs: 1, costUsd, unpriced: 0, lowerBound: false, budget, remaining: budget - costUsd, overBudget: costUsd > budget })
const pr = (extra: Record<string, unknown>) => [{ number: 12, state: 'open', draft: false, ci: 'success', behind: false, ...extra }]

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

/** Round 1: the one reviewer is clean, the pull request's CI fails, and $0.97 of the $1 budget is spent (the next round would overshoot). */
const failingRound = async ($: Ctx, on: On, remaining = spend(0.97)) => {
  const net: Net = { modConfig: served, reviewSpend: remaining, pullRequests: pr({ ci: 'failure' }) }
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  return { net, seen }
}
const needsHuman = (seen: { ticketCalls: { tool: string; args: Record<string, unknown> }[] }) => seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => c.args)
const status = (seen: { server: { key: string; status: string }[] }) => seen.server.find(t => t.key === 'TCK-143')?.status

test('clean reviewers and failing CI ask Claude for the fix although the budget has no room for another round', async ($, on) => {
  const { seen } = await failingRound($, on)
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[ci] CI is failing on pull request #12')
  expect(seen.submitted[0]).toContain('reads the pull request again when you finish')
  expect(needsHuman(seen)).toEqual([])
  expect(seen.toasts.some(t => t.includes('review budget'))).toBe(false)
  expect(status(seen)).toBe('In review')
})

test('after that fix no review agent starts and no spend is recorded; CI passing settles the ticket as clean', async ($, on) => {
  const { net, seen } = await failingRound($, on)
  net.pullRequests = pr({ ci: 'success' })
  await $.turn.complete(finishTurn(undefined, 'Fixed CI.'))
  expect(seen.spawned).toHaveLength(1)
  expect(seen.recorded.some(r => r.args.runs.some(run => run.round > 1))).toBe(false)
  expect(status(seen)).toBe('Done')
  expect(seen.toasts.some(t => t.includes('TCK-143 is Done'))).toBe(true)
  expect(needsHuman(seen)).toEqual([])
  const reported = seen.ticketCalls.filter(c => c.tool === 'report_session').map(c => c.args.status)
  expect(reported.at(-1)).toBe('done')
})

test('after that fix, CI still failing sets no-clean-round and stops without asking for another fix', async ($, on) => {
  const { seen } = await failingRound($, on)
  await $.turn.complete(finishTurn(undefined, 'Tried.'))
  expect(seen.spawned).toHaveLength(1)
  expect(seen.submitted).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(1)
  expect(needsHuman(seen)[0]).toMatchObject({ key: 'TCK-143', kind: 'no-clean-round' })
  expect(String(needsHuman(seen)[0]?.note)).toContain('CI is failing on pull request #12')
  expect(status(seen)).toBe('In review')
})

test('after that fix, CI still pending is never read as clean', async ($, on) => {
  const { net, seen } = await failingRound($, on)
  net.pullRequests = pr({ ci: 'pending' })
  await $.turn.complete(finishTurn(undefined, 'Pushed the fix.'))
  expect(seen.spawned).toHaveLength(1)
  expect(status(seen)).toBe('In review')
  expect(needsHuman(seen)).toHaveLength(1)
  expect(needsHuman(seen)[0]).toMatchObject({ key: 'TCK-143', kind: 'no-clean-round' })
  expect(String(needsHuman(seen)[0]?.note)).toContain('pending')
  expect(seen.toasts.some(t => t.includes('TCK-143 is Done'))).toBe(false)
})

test('where the budget has room, the fix of the pull request is reviewed as before', async ($, on) => {
  const { net, seen } = await failingRound($, on, spend(0.1))
  net.pullRequests = pr({ ci: 'success' })
  await $.turn.complete(finishTurn(undefined, 'Fixed CI.'))
  expect(seen.spawned).toHaveLength(2)
})

test('a round with reviewer findings still stops at the budget', async ($, on) => {
  const net: Net = { modConfig: served, reviewSpend: spend(0.97), pullRequests: pr({ ci: 'failure' }) }
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(seen.submitted).toHaveLength(0)
  expect(needsHuman(seen)).toHaveLength(1)
})

test('r after a pending stop reads the pull request again without a reviewer, and a passing CI then settles it', async ($, on) => {
  const { net, seen } = await failingRound($, on)
  net.pullRequests = pr({ ci: 'pending' })
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  net.pullRequests = pr({ ci: 'success' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  await $.turn.complete(finishTurn(undefined, 'Nothing to fix.'))
  expect(seen.spawned).toHaveLength(1)
  expect(status(seen)).toBe('Done')
})

test('a pull request that is not found after the fix is not read as clean', async ($, on) => {
  const { net, seen } = await failingRound($, on)
  net.pullRequests = []
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(status(seen)).toBe('In review')
  expect(needsHuman(seen)).toHaveLength(1)
  expect(seen.spawned).toHaveLength(1)
})

test('a branch still behind its base after the fix stops without a reviewer', async ($, on) => {
  const { net, seen } = await failingRound($, on)
  net.pullRequests = pr({ ci: 'success', behind: true })
  await $.turn.complete(finishTurn(undefined, 'Fixed CI.'))
  expect(seen.spawned).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(1)
  expect(String(needsHuman(seen)[0]?.note)).toContain('is behind its base')
})

test('with $0.70 of the $1 spent, a pull request still failing after the fix stops without another fix', async ($, on) => {
  const { net, seen } = await failingRound($, on, { ...spend(0.7), runs: 2 })
  net.pullRequests = pr({ ci: 'failure' })
  await $.turn.complete(finishTurn(undefined, 'Tried.'))
  expect(seen.spawned).toHaveLength(1)
  expect(seen.submitted).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(1)
})

test('rounds settled on the pull request alone are not in the average cost: after one, r with $0.60 of $1 spent still starts no reviewer', async ($, on) => {
  const { net, seen } = await failingRound($, on, spend(0.6))
  net.pullRequests = pr({ ci: 'pending' })
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  net.pullRequests = pr({ ci: 'pending' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  await $.turn.complete(finishTurn(undefined, 'Nothing to fix.'))
  expect(seen.spawned).toHaveLength(1)
})
