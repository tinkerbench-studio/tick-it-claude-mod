import { expect, test } from 'claude-code/testing'

import { BAND, PANE, RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

// The stewarding band line and pane heading show the ticket's spend against its budget next to the rounds (TCK-1279). The figures are the ones the steward kept: the pane calls no Tick-it tool.
const served = (reviewBudget: number | null) => ({ sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 }, defaultReviewRounds: { XS: 2, S: 3, M: 5, L: 6 }, maxReviewRounds: 10, reviewRounds: 4, reviewBudget, briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'x', branch: 'b', addToTicket: ['a'] } })
const spend = (costUsd: number) => ({ size: 'XS', runs: 1, costUsd, unpriced: 0, lowerBound: false, budget: 3, remaining: Math.max(0, 3 - costUsd), overBudget: costUsd > 3 })
const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

/** Stewards TCK-143 through a blocking round 1, so the steward has read reviewSpend, then returns the board pane's stewarding section and the band line. */
const lines = async ($: Ctx, on: On, net: Net) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  const callsBefore = seen.ticketCalls.length
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  const heading = (await pane.find({ key: 'steward' }))?.text ?? ''
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...BAND })
  const bandText = (await band.find({ type: 'Box' }))?.text ?? ''
  await band.unmount()
  // Showing either line asks Tick-it for nothing.
  expect(seen.ticketCalls.length).toBe(callsBefore)
  return { heading, bandText }
}

test('under budget: the heading shows the spend after the rounds, as $x/$y', async ($, on) => {
  const { heading } = await lines($, on, { modConfig: served(3), reviewSpend: spend(1) })
  expect(heading).toContain('round 1/4 · $1.00/$3 · ')
  expect(heading).not.toContain('over')
})

test('at or over budget: the spend is marked over, exactly at the budget too', async ($, on) => {
  for (const cost of [3, 3.4]) {
    const { heading } = await lines($, on, { modConfig: served(3), reviewSpend: spend(cost) })
    expect(heading).toContain(`round 1/4 · $${cost.toFixed(2)}/$3 over · `)
  }
})

test('no budget: both lines read exactly as with the round limit alone', async ($, on) => {
  const { heading, bandText } = await lines($, on, { modConfig: served(null), reviewSpend: spend(1) })
  expect(heading).toContain('round 1/4 · ')
  expect(heading).not.toContain('/$')
  expect(bandText).not.toContain('/$')
})

test('spend unknown (reviewSpend null): both lines read as with the round limit alone', async ($, on) => {
  const { heading, bandText } = await lines($, on, { modConfig: served(3), reviewSpend: null })
  expect(heading).toContain('round 1/4 · ')
  expect(heading).not.toContain('/$')
  expect(bandText).not.toContain('/$')
})
