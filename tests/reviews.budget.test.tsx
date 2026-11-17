import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

// What get_mod_config serves for TCK-143 (size XS): the lines the mod needs, with the ticket's rounds and budget.
const served = (extra: Record<string, unknown>) => ({
  sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 },
  defaultReviewRounds: { XS: 2, S: 3, M: 5, L: 6 },
  maxReviewRounds: 10,
  briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'x', branch: 'b', addToTicket: ['a'] },
  ...extra,
})
const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const spend = (costUsd: number, budget = 3) => ({ size: 'XS', runs: 2, costUsd, unpriced: 0, lowerBound: false, budget, remaining: budget - costUsd, overBudget: costUsd > budget })

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

/** Takes TCK-143 and starts round 1, whose reviewer answers with a blocking finding. */
const roundOne = async ($: Ctx, on: On, net: Net) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  return seen
}

const needsHuman = (seen: Awaited<ReturnType<typeof roundOne>>) => seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => c.args)

// ---- get_mod_config: the ticket's rounds and budget ------------------------------

test('taking a ticket calls get_mod_config with the repository and the ticket key', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, { modConfig: served({ reviewRounds: 4, reviewBudget: 3 }) })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(seen.ticketCalls.find(c => c.tool === 'get_mod_config')?.args).toMatchObject({ repository: 'acme/web-app', key: 'TCK-143' })
})

test("a reviewRounds from get_mod_config is the ticket's round limit, over the repository's settings", async ($, on) => {
  // The settings say 2 for an XS ticket: the ticket's own 4 is the limit.
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, { reviewRounds: { XS: 2, S: 3, M: 5, L: 6 }, modConfig: served({ reviewRounds: 4, reviewBudget: null }) })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3, 4, 5]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 5) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.spawned).toHaveLength(5)
  expect(seen.submitted[2]).not.toContain('is the last')
  expect(seen.submitted[3]).toContain('round 5, is the last: 4 rounds are the limit')
})

// Null, missing and not a whole number of 1 or more: the repository's settings give the limit (3 for an XS ticket here).
for (const [given, extra] of [
  ['null', { reviewRounds: null }],
  ['missing', {}],
  ['not a whole number', { reviewRounds: 2.5 }],
  ['below 1', { reviewRounds: 0 }],
] as const) {
  test(`a reviewRounds from get_mod_config that is ${given} leaves the limit to the settings and defaults`, async ($, on) => {
    const seen = engine(on, { lines: 10 }, true, PRINCIPAL, { reviewRounds: { XS: 3, S: 3, M: 5, L: 6 }, modConfig: served(extra) })
    await start($)
    await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
    await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
    for (const round of [1, 2, 3]) {
      await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
      if (round < 3) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
    }
    // The settings' 3 rounds: the fix after round 3 is told round 4 is the last.
    expect(seen.submitted[2]).toContain('round 4, is the last: 3 rounds are the limit')
  })
}

// ---- the budget stops a round ------------------------------------------------------

test('a round whose expected cost fits what remains starts, and one that does not is not started', async ($, on) => {
  // Round 1 cost $1 of a $3 budget: an average round fits the $2 left, so the fix and round 2 follow.
  const fits = await roundOne($, on, { modConfig: served({ reviewRounds: 3, reviewBudget: 3 }), reviewSpend: spend(1) })
  expect(fits.submitted).toHaveLength(1)
  expect(fits.submitted[0]).toContain('found 1 blocking finding')
  expect(needsHuman(fits)).toEqual([])
})

test('a round whose cost, as the average of the rounds so far, is more than the remaining budget is not started', async ($, on) => {
  // $2.50 over one round against $0.50 left: another round would overshoot.
  const seen = await roundOne($, on, { modConfig: served({ reviewRounds: 3, reviewBudget: 3 }), reviewSpend: spend(2.5) })
  expect(seen.submitted).toHaveLength(0)
  expect(seen.spawned).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(1)
})

test('with the budget reached and blocking findings open, the steward stops, the ticket stays In review and a person is asked', async ($, on) => {
  const seen = await roundOne($, on, { modConfig: served({ reviewRounds: 3, reviewBudget: 3 }), reviewSpend: spend(3) })
  expect(seen.submitted).toHaveLength(0)
  const asked = needsHuman(seen)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ key: 'TCK-143', kind: 'no-clean-round' })
  expect(String(asked[0]?.note)).toContain('$3')
  expect(String(asked[0]?.note)).toContain('1 blocking finding still open')
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status !== 'In progress' && c.args.status !== 'In review')).toBe(false)
  expect(seen.toasts.some(t => t.includes('$3 review budget'))).toBe(true)
})

test('a fix already made is still reviewed once before the budget stops the steward', async ($, on) => {
  const net: Net = { modConfig: served({ reviewRounds: 3, reviewBudget: 3 }), reviewSpend: spend(1) }
  const seen = await roundOne($, on, net)
  // Round 1 left room: Claude fixes, and round 2 reviews that fix, though the budget is used up by then.
  expect(seen.submitted).toHaveLength(1)
  net.reviewSpend = spend(3)
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(seen.spawned).toHaveLength(2)
  expect(needsHuman(seen)).toEqual([])
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong'))
  // Round 2's fix is reviewed already; no further fix is asked for and the person is.
  expect(seen.submitted).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(1)
  expect(String(needsHuman(seen)[0]?.note)).toContain('$3')
})

// ---- no budget, no spend, no ticket read: the round limit alone ---------------------

const byRoundsAlone = async ($: Ctx, on: On, net: Net, unreachable = false) => {
  // XS has 2 rounds: rounds 1 to 3 run, and the note counts the three.
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  if (unreachable) seen.failTicketReads = true
  for (const round of [1, 2, 3]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 3) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.spawned).toHaveLength(3)
  expect(needsHuman(seen)[0]?.note).toBe('1 blocking finding still open after 3 rounds, no clean round.')
  return seen
}

test('with reviewBudget null the steward goes by the round limit alone and does not read the spend', async ($, on) => {
  const seen = await byRoundsAlone($, on, { modConfig: served({ reviewRounds: 2, reviewBudget: null }), reviewSpend: spend(99) })
  expect(seen.ticketCalls.filter(c => c.tool === 'get_ticket' && c.args.include === undefined)).toHaveLength(0)
})

test('with reviewSpend null (costs cannot be seen) the steward goes by the round limit alone', async ($, on) => {
  await byRoundsAlone($, on, { modConfig: served({ reviewRounds: 2, reviewBudget: 3 }), reviewSpend: null })
})

test('with get_ticket unreachable the steward goes by the round limit alone', async ($, on) => {
  await byRoundsAlone($, on, { modConfig: served({ reviewRounds: 2, reviewBudget: 3 }), reviewSpend: spend(99) }, true)
})

// ---- every get_ticket names the parts it reads ---------------------------------------

test('every get_ticket the hooks send names the parts it reads: the status, the unticked checks, the held-back reason and the review spend ask for the core only', async ($, on) => {
  const net: Net = { modConfig: served({ reviewRounds: 3, reviewBudget: 3 }), reviewSpend: spend(1), timeline: [], acceptanceItems: true }
  const seen = await roundOne($, on, net)
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  await $.turn.complete(finishTurn('agent-2', 'OPTIONAL: a nit\nVERDICT: clean'))
  const reads = seen.ticketCalls.filter(c => c.tool === 'get_ticket')
  expect(reads.length).toBeGreaterThan(2)
  for (const c of reads) expect(Array.isArray(c.args.include)).toBe(true)
  // Only the attachments and memories of a taken ticket, and the findings a round gives its reviewers (TCK-48), are more than the core.
  for (const c of reads.filter(c => (c.args.include as string[]).length > 0)) expect([['attachments', 'memories'], ['findings']]).toContainEqual(c.args.include)
  expect(reads.filter(c => (c.args.include as string[]).length === 0).length).toBeGreaterThan(1)
  // The unticked checks were read (the fake gives acceptanceItems, none ticked) and asked for with the core only.
  expect(seen.submitted.join('\n')).toContain('Step stored in session on each transition')
})

test('the status read when a turn of a taken ticket ends asks for the core only', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, {})
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const before = seen.ticketCalls.length
  await $.turn.complete(finishTurn(undefined, 'Working on it.'))
  const reads = seen.ticketCalls.slice(before).filter(c => c.tool === 'get_ticket')
  expect(reads.length).toBeGreaterThan(0)
  for (const c of reads) expect(c.args.include).toEqual([])
})
