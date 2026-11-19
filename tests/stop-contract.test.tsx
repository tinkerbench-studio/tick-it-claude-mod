import { expect, test } from 'claude-code/testing'

import { PANE, RUN, SKILLS, STARTED, engine, finishTurn, reports, start, typed } from './helpers'
import type { Net } from './helpers'

// TCK-79: the mod's side of Tick-it's stop contract: one typed stop call, the backend's round verdict, a check-in before going idle, a resume and a sessionStopped.
type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const served = (reviewBudget: number | null) => ({ sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 }, defaultReviewRounds: { XS: 2, S: 3, M: 5, L: 6 }, maxReviewRounds: 10, reviewRounds: 3, reviewBudget, briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'x', branch: 'b', addToTicket: ['a'] } })
const pr = (extra: Record<string, unknown>) => [{ number: 12, state: 'open', draft: false, ci: 'success', behind: false, ...extra }]
/** What the mod itself asked of Tick-it as a need: a set_needs_human call it made, never the one the fake derives from a report's `needsHuman`. */
const ownNeeds = (seen: ReturnType<typeof engine>) => seen.ticketCalls.filter(c => c.tool === 'set_needs_human' && c.derived !== true)
const sent = (seen: ReturnType<typeof engine>) => seen.submitted.slice(1)
const stops = (seen: ReturnType<typeof engine>) => reports(seen).filter(r => r.status === 'stopped' && r.stop !== undefined)

/** A session Tick-it started on TCK-143, its review begun by /tick-it done. */
const begin = async ($: Ctx, on: On, net: Net = {}) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  return seen
}

const CASES: { code: string; net: Net; run: ($: Ctx, seen: ReturnType<typeof engine>) => Promise<void>; stop: Record<string, unknown>; need: string }[] = [
  {
    code: 'reviewer-no-verdict',
    net: {},
    run: async ($, seen) => {
      await $.turn.complete(finishTurn('agent-1', 'Looks fine to me.'))
      await $.turn.complete(finishTurn(seen.spawned.at(-1)?.agentId, 'Still no verdict.'))
    },
    stop: { code: 'reviewer-no-verdict', skills: ['principal'], round: 1 },
    need: 'principal failed or gave no VERDICT, twice in round 1',
  },
  { code: 'ci-pending', net: { pullRequests: pr({ ci: 'failure', headSha: '0123abc' }) }, run: async $ => void (await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))), stop: { code: 'ci-pending', round: 1 }, need: 'not confirmed' },
  {
    code: 'rounds-exhausted',
    net: { reviewRounds: { XS: 1, S: 3, M: 5, L: 6 } },
    run: async $ => {
      await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
      await $.turn.complete(finishTurn(undefined, 'Tried again.'))
      await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong'))
    },
    stop: { code: 'rounds-exhausted', round: 2 },
    need: '1 blocking finding still open after 2 rounds',
  },
  {
    code: 'budget',
    net: { modConfig: served(3), reviewSpend: { size: 'XS', runs: 2, costUsd: 3, unpriced: 0, lowerBound: false, budget: 3, remaining: 0, overBudget: false } },
    run: async $ => void (await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))),
    stop: { code: 'budget', round: 1 },
    need: 'Review budget $3 reached',
  },
  {
    code: 'pull-request-blocking',
    net: { modConfig: served(1), reviewSpend: { size: 'XS', runs: 1, costUsd: 0.97, unpriced: 0, lowerBound: false, budget: 1, remaining: 0.03, overBudget: false }, pullRequests: pr({ ci: 'failure' }) },
    run: async $ => {
      await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
      await $.turn.complete(finishTurn(undefined, 'Tried.'))
    },
    stop: { code: 'pull-request-blocking', round: 2 },
    need: 'CI is failing on pull request #12',
  },
]

for (const c of CASES) {
  test(`a stop by the mod for ${c.code} is one report_session call with the stop and the need, and no set_needs_human`, async ($, on) => {
    const seen = await begin($, on, c.net)
    await c.run($, seen)
    expect(stops(seen)).toHaveLength(1)
    expect(stops(seen)[0]).toMatchObject({ status: 'stopped', session: 's_abc12345', stop: c.stop, needsHuman: { kind: 'no-clean-round', note: expect.stringContaining(c.need) } })
    expect(ownNeeds(seen)).toEqual([])
  })
}

test('the stop button is one report_session call with person-stopped and the need, and no set_needs_human', async ($, on) => {
  const seen = await begin($, on)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stop-stewarding' })
  expect(stops(seen)).toHaveLength(1)
  expect(stops(seen)[0]).toMatchObject({ status: 'stopped', stop: { code: 'person-stopped', round: 1 }, needsHuman: { kind: 'session-stopped' } })
  expect(ownNeeds(seen)).toEqual([])
  await ui.unmount()
})

test('with no Tick-it session to report to, a stop still asks for the need with set_needs_human, as before', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, { noSession: true, reviewRounds: { XS: 1, S: 3, M: 5, L: 6 } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong'))
  expect(ownNeeds(seen)).toHaveLength(1)
  expect(ownNeeds(seen)[0]?.args).toMatchObject({ kind: 'no-clean-round' })
})

test('a stop report Tick-it did not take is kept and sent again, with its need', async ($, on) => {
  const net: Net = { reportFails: 0 }
  const seen = await begin($, on, net)
  net.reportFails = 1
  await $.turn.complete(finishTurn('agent-1', 'Looks fine.'))
  await $.turn.complete(finishTurn('agent-2', 'Still no verdict.'))
  // The only call that failed was the stop: Tick-it has no need yet.
  expect(stops(seen)).toHaveLength(1)
  expect(seen.ticketCalls.filter(c => c.derived === true)).toEqual([])
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(stops(seen)).toHaveLength(2)
  expect(stops(seen)[1]).toMatchObject({ stop: { code: 'reviewer-no-verdict' }, needsHuman: { kind: 'no-clean-round', note: expect.stringContaining('no VERDICT') } })
  expect(seen.ticketCalls.filter(c => c.derived === true)).toHaveLength(1)
  // Sent once: another sync sends nothing more.
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(stops(seen)).toHaveLength(2)
})

// ---- The round verdict ---------------------------------------------------------

const status = (seen: ReturnType<typeof engine>) => seen.server.find(t => t.key === 'TCK-143')?.status

test('roundVerdict clean: the round is clean although a reviewer listed a blocking finding', async ($, on) => {
  const seen = await begin($, on, { recordExtra: { roundVerdict: 'clean' } })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(status(seen)).toBe('Done')
  expect(sent(seen)).toEqual([])
})

test('roundVerdict blocked: Claude is asked to fix although the reviewer said clean, with the next Tick-it gave', async ($, on) => {
  const seen = await begin($, on, { recordExtra: { roundVerdict: 'blocked', next: 'Fix the stale snapshot.' } })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(status(seen)).toBe('In review')
  expect(sent(seen)).toHaveLength(1)
  expect(sent(seen)[0]).toContain('Round 1 review of TCK-143 found 1 blocking finding')
  expect(sent(seen)[0]).toContain('Fix the stale snapshot.')
})

test('roundVerdict incomplete: the named reviewers run again and the session does not stop', async ($, on) => {
  const net: Net = { recordExtra: { roundVerdict: { verdict: 'incomplete', skills: ['principal'] } } }
  const seen = await begin($, on, net)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.spawned).toHaveLength(2)
  expect(seen.spawned[1]?.prompt).toBe(seen.spawned[0]?.prompt)
  expect(stops(seen)).toEqual([])
  expect(status(seen)).toBe('In review')
  // The rerun answers and Tick-it now reads the round as clean.
  net.recordExtra = { roundVerdict: 'clean' }
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean'))
  expect(status(seen)).toBe('Done')
})

test('roundVerdict running: the round waits: nothing is asked, no reviewer starts and nothing stops', async ($, on) => {
  const seen = await begin($, on, { recordExtra: { roundVerdict: 'running' } })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  expect(seen.spawned).toHaveLength(1)
  expect(sent(seen)).toEqual([])
  expect(stops(seen)).toEqual([])
  expect(status(seen)).toBe('In review')
})

// ---- The check-in before going idle -------------------------------------------------

for (const waitingOn of ['session', 'person', 'queue', 'reviewers', 'nothing']) {
  test(`at turn end on a ticket In review the check-in reads waitingOn ${waitingOn}`, async ($, on) => {
    const seen = await begin($, on, { reportAnswers: [{ waitingOn, next: 'Push the fix and tick the last criterion.' }] })
    const before = reports(seen).length
    await $.turn.complete(finishTurn(undefined, 'Pushed.'))
    expect(reports(seen).length).toBeGreaterThan(before)
    expect(reports(seen).at(-1)).toMatchObject({ status: 'reviewing' })
    expect(sent(seen)).toEqual(waitingOn === 'session' ? ['Push the fix and tick the last criterion.'] : [])
    const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: `Tick-it: waiting on ${waitingOn}.` })).toBeDefined()
    await ui.unmount()
  })
}

test('the check-in submits the same next once in a row, and a different one again', async ($, on) => {
  const net: Net = { reportAnswers: [{ waitingOn: 'session', next: 'Do the thing.' }] }
  const seen = await begin($, on, net)
  await $.turn.complete(finishTurn(undefined, 'Tried.'))
  await $.turn.complete(finishTurn(undefined, 'Could not.'))
  await $.turn.complete(finishTurn(undefined, 'Could not again.'))
  expect(sent(seen)).toEqual(['Do the thing.'])
  net.reportAnswers = [{ waitingOn: 'session', next: 'Do another thing.' }]
  await $.turn.complete(finishTurn(undefined, 'Done that.'))
  expect(sent(seen)).toEqual(['Do the thing.', 'Do another thing.'])
})

test('a Tick-it that answers no waitingOn leaves the session idle as it was', async ($, on) => {
  const seen = await begin($, on)
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  expect(sent(seen)).toEqual([])
})

// ---- A resume instruction --------------------------------------------------------------

const stoppedByMod = async ($: Ctx, on: On, net: Net = {}) => {
  const seen = await begin($, on, net)
  await $.turn.complete(finishTurn('agent-1', 'Looks fine to me.'))
  await $.turn.complete(finishTurn(seen.spawned.at(-1)?.agentId, 'Still none.'))
  expect(stops(seen)).toHaveLength(1)
  return seen
}

test('a resume in the answer starts the next round when the mod stopped, acknowledged by the reviewing report', async ($, on) => {
  const net: Net = {}
  const seen = await stoppedByMod($, on, net)
  net.reportAnswers = [{ resume: true }]
  await $.turn.complete(finishTurn(undefined, 'Ticked the last criterion.'))
  // The check-in's answer asked to resume: a turn of nothing to fix carries round 2 in.
  expect(sent(seen).at(-1)).toContain('round 2 starts when you finish')
  await $.turn.complete(finishTurn(undefined, 'Nothing to fix.'))
  expect(seen.spawned.at(-1)?.description).toContain('round 2')
  expect(reports(seen).at(-1)).toMatchObject({ status: 'reviewing', summary: 'Review round 2.' })
})

test('a resume in the answer is ignored with a note in the pane when the person pressed stop', async ($, on) => {
  const net: Net = {}
  const seen = await begin($, on, net)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stop-stewarding' })
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  net.reportAnswers = [{ resume: true }]
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  expect(seen.spawned).toHaveLength(1)
  expect(sent(seen)).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Tick-it asked to resume, but you stopped stewarding/ })).toBeDefined()
  await ui.unmount()
})

test('the stall: no verdict from the reviewer in round 1, the last criterion ticked, a resume returned: round 2 starts and no person is asked again', async ($, on) => {
  const net: Net = { toolResult: JSON.stringify({ ticket: { key: 'TCK-143' } }) }
  const seen = await stoppedByMod($, on, net)
  const needs = seen.ticketCalls.filter(c => c.derived === true).length
  expect(needs).toBe(1)
  // Forty seconds later the session ticks the last criterion; Tick-it clears the need and says to resume.
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__set_criterion_checked', tool_use_id: 'tu-tick', repository: 'acme/web-app', key: 'TCK-143', criterion: 'c1', checked: true } as never)
  net.reportAnswers = [{ resume: true }]
  await $.turn.complete(finishTurn(undefined, 'Ticked it. Pushed.'))
  await $.turn.complete(finishTurn(undefined, 'Nothing to fix.'))
  expect(seen.spawned.at(-1)?.description).toContain('round 2')
  expect(seen.ticketCalls.filter(c => c.derived === true)).toHaveLength(needs)
  expect(ownNeeds(seen)).toEqual([])
  expect(stops(seen)).toHaveLength(1)
})

// ---- sessionStopped ---------------------------------------------------------------------

for (const tool of ['set_criterion_checked', 'add_criterion_note']) {
  test(`a sessionStopped in the answer of ${tool} is queued for Claude and shown in the pane`, async ($, on) => {
    const seen = await stoppedByMod($, on, { toolResult: JSON.stringify({ sessionStopped: { reason: 'Its latest session is stopped, not done' } }) })
    await $.tool.call({ tool: `mcp__plugin_tick-it_tickit__${tool}`, tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-143' } as never)
    await $.turn.complete(finishTurn(undefined, 'Ticked.'))
    expect(sent(seen).some(t => t.includes('Tick-it session s_abc12345 on TCK-143 is stopped') && t.includes('Do not tell the person it will merge') && t.includes('press'))).toBe(true)
    const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Tick-it says its session is stopped: Its latest session is stopped, not done/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a sessionStopped in the answer of record_runs is queued for Claude', async ($, on) => {
  const seen = await stoppedByMod($, on, { recordExtra: { sessionStopped: true } })
  await $.turn.complete(finishTurn(undefined, 'Carrying on.'))
  expect(sent(seen).some(t => t.includes('is stopped') && t.includes('Do not tell the person it will merge'))).toBe(true)
})
