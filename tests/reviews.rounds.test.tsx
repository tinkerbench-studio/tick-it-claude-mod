import { expect, test } from 'claude-code/testing'

import { DEFAULT_ROUNDS, reviewPrompt } from '../hooks/register'
import { PANE, RUN, SKILLS, engine, finishTurn, start, roundThree, noExtraRound, PRINCIPAL, STARTED, typed, reports, body } from './helpers'
import type { Net } from './helpers'

test('a fourth round starts when three rounds still have blocking findings, and stewarding stops if it does too', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { reviewRounds: { XS: 3, S: 3, M: 5, L: 6 } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3, 4]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 4) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.spawned).toHaveLength(4)
  expect(seen.spawned.at(-1)?.description).toContain('round 4')
  expect(seen.submitted).toHaveLength(3)
  expect(seen.submitted[2]).toContain('round 4, is the last')
  expect(reports(seen).some(r => r.summary?.includes('round 4 goes past the limit'))).toBe(true)
  expect(seen.toasts.some(t => t.includes('after 4 rounds. Over to you.'))).toBe(true)
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ key: 'TCK-143', kind: 'no-clean-round', note: '1 blocking finding still open after 4 rounds, no clean round.' })
})

test('an M ticket with a limit of 4 gets rounds 1 to 4, one further round 5, and is then marked no-clean-round', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { reviewRounds: { XS: 2, S: 3, M: 4, L: 6 } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-149' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3, 4, 5]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 5) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.spawned).toHaveLength(5)
  expect(seen.spawned.at(-1)?.description).toContain('round 5')
  expect(seen.submitted).toHaveLength(4)
  expect(seen.submitted[2]).not.toContain('is the last')
  expect(seen.submitted[3]).toContain('round 5, is the last: 4 rounds are the limit')
  expect(reports(seen).some(r => r.summary?.includes('round 5 goes past the limit'))).toBe(true)
  expect(reports(seen).some(r => r.status === 'reviewing' && r.summary === 'Review round 4.')).toBe(true)
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ key: 'TCK-149', kind: 'no-clean-round', note: '1 blocking finding still open after 5 rounds, no clean round.' })
})

test('stewarding a ticket not taken in this session reads the limit of its size from Tick-it as round 1 starts', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { reviewRounds: { XS: 2, S: 3, M: 4, L: 6 } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-149' })
  for (const round of [1, 2, 3, 4]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 4) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.submitted[3]).toContain('round 5, is the last: 4 rounds are the limit')
})

test('when Tick-it cannot say, or says something unusable, the mod keeps the limits it last had', async ($, on) => {
  const net: Net = { reviewRounds: { XS: 2, S: 3, M: 4, L: 6 } }
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-149' })
  // The next read of the settings gives no limit for M and a wrong one for S: M keeps 4.
  net.reviewRounds = { M: 0, S: 2.5 }
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3, 4]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 4) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.submitted[3]).toContain('round 5, is the last: 4 rounds are the limit')
})

test('without reviewRounds from Tick-it, a ticket gets the default limit of its size', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(DEFAULT_ROUNDS).toEqual({ XS: 2, S: 3, M: 5, L: 6 })
  for (const round of [1, 2, 3]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 3) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.spawned).toHaveLength(3)
  expect(seen.submitted[1]).toContain('round 3, is the last: 2 rounds are the limit')
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ kind: 'no-clean-round' })
})

test('no round past the limit starts when round three is clean', async ($, on) => {
  const seen = await roundThree($, on, 'VERDICT: clean')
  noExtraRound(seen)
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'Done' && typeof c.args.reason === 'string' && c.args.reason.trim() !== '')).toBe(true)
})

test('no round past the limit starts when round three has only optional findings', async ($, on) => {
  const seen = await roundThree($, on, 'OPTIONAL: could be nicer\nVERDICT: clean')
  noExtraRound(seen)
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'Done' && typeof c.args.reason === 'string' && c.args.reason.trim() !== '')).toBe(true)
})

test('r in the stewarding pane starts the next round when the turn ends, after the rounds ran out too', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, { reviewRounds: { XS: 3, S: 3, M: 5, L: 6 } })
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3, 4]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 4) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  expect(seen.spawned).toHaveLength(4)

  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  expect(seen.toasts.at(-1)).toContain('tick-it: Round 5 starts when this turn ends.')
  expect(reports(seen).at(-1)).toMatchObject({ status: 'fixing', summary: 'Round 5 starts when this turn ends.' })
  expect(seen.spawned).toHaveLength(4)
  // The session is idle, so a turn of nothing to fix is started for the round to follow.
  expect(seen.submitted.at(-1)).toContain('There is nothing to fix')
  await $.turn.complete(finishTurn(undefined, 'Fixed the rest.'))
  expect(seen.spawned).toHaveLength(5)
  await ui.unmount()
})

test('a suggested breakdown holds the next fix round and is offered to the person instead', async ($, on) => {
  const net: Net = {}
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  net.reportInstructions = ['Tick-it suggests breaking TCK-143 down: its last 3 review rounds in a row each ended with blocking findings. Do not start another fix round.']
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  await $.turn.complete(finishTurn(undefined, 'Tried to fix it.'))
  expect(seen.spawned).toHaveLength(1)
  expect(seen.submitted.filter(t => t.includes('Tick-it suggests breaking TCK-143'))).toHaveLength(1)

  // r while Claude writes the offer waits for that turn's end: no turn of nothing to fix is queued, and round 2 starts when it ends.
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  expect(seen.submitted.filter(t => t.includes('There is nothing to fix'))).toEqual([])
  await $.turn.complete(finishTurn(undefined, 'Offered the breakdown.'))
  expect(seen.spawned).toHaveLength(2)
  await ui.unmount()
})

test('s in the stewarding pane stops stewarding, leaves the ticket In review and reports it', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))

  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stop-stewarding' })
  expect(seen.toasts.at(-1)).toContain('tick-it: Stopped after round 1; TCK-143 stays In review.')
  expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped', summary: 'Stopped after round 1; TCK-143 stays In review.' })
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  expect(seen.spawned).toHaveLength(1)
  await ui.unmount()
})

test('r while reviewers are still running waits, and a stop pressed before the last one answers keeps the ticket In review', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))

  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stop-stewarding' })
  await ui.press({ key: 'review-again' })
  expect(seen.toasts.at(-1)).toContain('still being reviewed')
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(seen.spawned).toHaveLength(2)
  await ui.unmount()
})

test("r after s in the middle of a fix turn sends no extra prompt: that turn's end starts the round", async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: still wrong'))
  const asked = seen.submitted.length

  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stop-stewarding' })
  await ui.press({ key: 'review-again' })
  expect(seen.submitted).toHaveLength(asked)
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  expect(seen.spawned).toHaveLength(2)
  await ui.unmount()
})

test('reviewPrompt and the round limit use the same words as the cloud procedure', async ($, on) => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the cloud procedure (STEWARD in apps/mcp/src/sessions.ts).
  const prompt = reviewPrompt({ id: 'TCK-1', title: 'T', epic: 'E', acceptance: ['A'] } as never, { name: 'security', body: 'Look.' } as never, 1)
  for (const word of ['BLOCKING:', 'OPTIONAL:', 'VERDICT: clean']) {
    expect(prompt.includes(word), `reviewPrompt (mod/hooks/reviews.ts) no longer says "${word}"; the cloud procedure in apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
  }
  // The limit is the ticket size's (reviewRounds), here 4 for M: the mod's fix prompt says what startText says for the same limit.
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { reviewRounds: { XS: 2, S: 3, M: 4, L: 6 } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-149' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3, 4]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    if (round < 4) await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  const asked = seen.submitted[3] ?? ''
  for (const phrase of ['4 rounds are the limit', 'round 5, is the last']) {
    expect(asked.includes(phrase), `the mod's fix prompt (mod/hooks/reviews.ts) no longer says "${phrase}" for a limit of 4; the cloud procedure (apps/mcp/src/sessions.ts) says "4 rounds of review" and "round 5 ... goes past the limit", so change both together`).toBe(true)
  }
})
