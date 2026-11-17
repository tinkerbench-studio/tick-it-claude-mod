import { expect, test } from 'claude-code/testing'

import { PANE, RUN, engine, finishTurn, start, PRINCIPAL, STARTED, typed, reports } from './helpers'
import type { Net } from './helpers'

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

const served = {
  sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 },
  defaultReviewRounds: { XS: 2, S: 3, M: 5, L: 6 },
  maxReviewRounds: 10,
  briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'x', branch: 'b', addToTicket: ['a'] },
  reviewRounds: 3,
  reviewBudget: 3,
}
// Round 1 cost the whole $3 budget, so the mod stops itself at the budget with blocking findings open.
const spent: Net = { modConfig: served, reviewSpend: { size: 'XS', runs: 2, costUsd: 3, unpriced: 0, lowerBound: false, budget: 3, remaining: 0, overBudget: false } }

const needsHuman = (seen: ReturnType<typeof engine>) => seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => c.args)
const claudeMovesToReview = ($: Ctx) => $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-again', repository: 'acme/web-app', key: 'TCK-143', status: 'In review' } as never) as Promise<{ deny?: string }>

/** A session Tick-it started on TCK-143, stopped at the budget after round 1 by the mod itself. */
const stoppedByMod = async ($: Ctx, on: On) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, spent)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(seen.spawned).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(1)
  expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped' })
  return seen
}

test('after the mod stopped itself, Claude moving the ticket to In review again has its fix reviewed once', async ($, on) => {
  const seen = await stoppedByMod($, on)
  expect(await claudeMovesToReview($)).not.toHaveProperty('deny')
  expect(seen.spawned).toHaveLength(1)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  // Round 2 starts, over the earlier round's blocking finding.
  expect(seen.spawned).toHaveLength(2)
  expect(seen.spawned[1]?.description).toContain('round 2')
})

test('a clean review of that fix makes the steward done and reports the session done', async ($, on) => {
  const seen = await stoppedByMod($, on)
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean'))
  expect(reports(seen).at(-1)).toMatchObject({ status: 'done', session: 's_abc12345' })
  expect(seen.toasts.some(t => t.includes('reviews were clean'))).toBe(true)
})

test('a review of that fix with blocking findings stops again, asks a person and starts no further round', async ($, on) => {
  const seen = await stoppedByMod($, on)
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong\nVERDICT: changes'))
  expect(seen.spawned).toHaveLength(2)
  expect(seen.submitted).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(2)
  expect(needsHuman(seen).at(-1)).toMatchObject({ key: 'TCK-143', kind: 'no-clean-round' })
  expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped' })
  await $.turn.complete(finishTurn(undefined, 'Nothing more.'))
  expect(seen.spawned).toHaveLength(2)
})

test('stewarding stopped with the stop button is not restarted by a move to In review', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stop-stewarding' })
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  expect(await claudeMovesToReview($)).not.toHaveProperty('deny')
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  expect(seen.spawned).toHaveLength(1)
  expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped', summary: 'Stopped after round 1; TCK-143 stays In review.' })
  await ui.unmount()
})

test('r after the review of a fix made after a stop is a round like any other: it asks for a fix and is not the last', async ($, on) => {
  let costUsd = 3
  const net: Net = { modConfig: served, get reviewSpend() { return { size: 'XS', runs: 2, costUsd, unpriced: 0, lowerBound: false, budget: 3, remaining: 3 - costUsd, overBudget: false } } }
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  costUsd = 0
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong\nVERDICT: changes'))
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  await $.turn.complete(finishTurn(undefined, 'Nothing to fix.'))
  expect(seen.spawned).toHaveLength(3)
  await $.turn.complete(finishTurn('agent-3', 'BLOCKING: still wrong\nVERDICT: changes'))
  // Round 3 is not marked the last one: its findings go to Claude to fix.
  expect(seen.submitted.some(t => t.includes('Round 3 review of TCK-143 found 1 blocking'))).toBe(true)
  await ui.unmount()
})

test('a move to In review for the same key in another repository does not restart stewarding', async ($, on) => {
  const seen = await stoppedByMod($, on)
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-other', repository: 'acme/other', key: 'TCK-143', status: 'In review' } as never)
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  expect(seen.spawned).toHaveLength(1)
})

test('a fix made after a budget stop is the last review even with rounds left and budget in hand: blocking findings stop again, no further round', async ($, on) => {
  let costUsd = 3
  const net: Net = { modConfig: served, get reviewSpend() { return { size: 'XS', runs: 2, costUsd, unpriced: 0, lowerBound: false, budget: 3, remaining: 3 - costUsd, overBudget: false } } }
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(needsHuman(seen)).toHaveLength(1)
  // The budget is raised: a round could now follow a fix, but the review of this fix is the last.
  costUsd = 0
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong\nVERDICT: changes'))
  expect(seen.spawned).toHaveLength(2)
  expect(seen.submitted).toHaveLength(1)
  expect(needsHuman(seen)).toHaveLength(2)
  expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped' })
})

test('the move to In review after a mod stop records the pull request again', async ($, on) => {
  const seen = engine(on, { lines: 10, pr: 42 }, true, PRINCIPAL, spent)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  const before = seen.ticketCalls.filter(c => c.tool === 'link_pull_request').length
  await claudeMovesToReview($)
  const links = seen.ticketCalls.filter(c => c.tool === 'link_pull_request')
  expect(links).toHaveLength(before + 1)
  expect(links.at(-1)?.args).toMatchObject({ key: 'TCK-143', number: 42 })
})

test('s after the review of a fix made after a stop stays stopped: a later move to In review starts no round', async ($, on) => {
  const seen = await stoppedByMod($, on)
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  // Pressed while round 2 reviews, then its reviewer answers: stopped stays stopped.
  await ui.press({ key: 'stop-stewarding' })
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong\nVERDICT: changes'))
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Pushed again.'))
  expect(seen.spawned).toHaveLength(2)
  await ui.unmount()
})

for (const [what, ci] of [['still fails', 'failure'], ['is still pending', 'pending']] as const) {
test(`a pull request that ${what} after the fix when the budget has no room is a stop the mod made: the next fix is reviewed once`, async ($, on) => {
  const net: Net = {
    modConfig: { ...served, reviewBudget: 1 },
    reviewSpend: { size: 'XS', runs: 1, costUsd: 0.97, unpriced: 0, lowerBound: false, budget: 1, remaining: 0.03, overBudget: false },
    pullRequests: [{ number: 12, state: 'open', draft: false, ci: 'failure', behind: false }],
  }
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci, behind: false }]
  await $.turn.complete(finishTurn(undefined, 'Tried.'))
  expect(needsHuman(seen)).toHaveLength(1)
  expect(seen.spawned).toHaveLength(1)
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  expect(seen.spawned).toHaveLength(2)
})
}

test('after the one review of a fix made after a stop blocked again, a further move to In review starts no round: a person is asked', async ($, on) => {
  const seen = await stoppedByMod($, on)
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it and pushed.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong\nVERDICT: changes'))
  expect(needsHuman(seen)).toHaveLength(2)
  await claudeMovesToReview($)
  await $.turn.complete(finishTurn(undefined, 'Pushed once more.'))
  expect(seen.spawned).toHaveLength(2)
})
