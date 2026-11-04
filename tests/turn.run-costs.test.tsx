import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'

test('a main-loop turn on a taken ticket is recorded as a build turn, priced like the reviews', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.turn.complete(finishTurn(undefined, 'No ticket yet.'))
  expect(seen.recorded).toEqual([])
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete(finishTurn(undefined, 'Wrote the session step.'))
  expect(seen.recorded.flatMap(c => c.args.runs)).toEqual([
    {
      place: 'local',
      agentId: 'turn-turn-main-23',
      ticket: 'TCK-143',
      kind: 'build',
      model: 'claude-opus-5-5',
      status: 'done',
      durationMs: 95_000,
      startedAt: expect.any(Number),
      usage: { input: 20_000, output: 4_000, cacheRead: 100_000, cacheWrite: 10_000 },
      costUsd: 0.23,
    },
  ])
})

test('a main-loop turn fixing a review round is recorded as a fix turn of that round', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: a.ts:1 wrong'))
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  const runs = seen.recorded.flatMap(c => c.args.runs)
  expect(runs.map(r => [r.kind ?? 'review', r.ticket, r.round])).toEqual([
    ['review', 'TCK-143', 1],
    ['fix', 'TCK-143', 1],
  ])
  // A fix says when it began, on this machine's clock like the reviews, so Tick-it can tell a fix no review has seen.
  expect(typeof runs.find(r => r.kind === 'fix')?.startedAt).toBe('number')
})
