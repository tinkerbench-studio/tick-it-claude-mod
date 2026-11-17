import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const work = (agentId: string, ticket: string, repository?: string) => ({ agentId, ticket, kind: 'build', model: 'claude-opus-5-5', status: 'done', durationMs: 1000, ...(repository === undefined ? {} : { repository }) })
const review = (agentId: string, ticket: string, round: number, repository?: string) => ({
  agentId,
  ticket,
  epic: 'E',
  round,
  skill: 'principal',
  model: 'claude-opus-5-5',
  startedAt: 5,
  status: 'done',
  blocking: 1,
  items: [{ severity: 'blocking', text: 'another repository blocker' }],
  findings: ['another repository blocker'],
  ...(repository === undefined ? {} : { repository }),
})
const OTHER = 'git@github.com:acme/other.git\n'

test("a run queued in another repository is not sent by this one's session, and stays in the outbox", async ($, on) => {
  const seen = engine(on, { lines: 0, stored: { outbox: [work('w-other', 'TCK-999', 'acme/other')] } })
  await start($)
  expect(seen.recorded).toEqual([])
  // Still waiting: sync names it, and sends nothing.
  expect((await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })).text).toContain('1 run waits for other repositories.')
  expect(seen.recorded).toEqual([])
})

test('that run is sent when a session starts in its own repository, case aside', async ($, on) => {
  const seen = engine(on, { lines: 0, origin: OTHER, stored: { outbox: [work('w-other', 'TCK-999', 'Acme/Other'), work('w-web', 'TCK-998', 'acme/web-app')] } })
  await start($)
  expect(seen.recorded).toHaveLength(1)
  expect(seen.recorded[0]?.args.repository).toBe('acme/other')
  expect(seen.recorded[0]?.args.runs.map(r => r.agentId)).toEqual(['w-other'])
  // The run of acme/web-app is the one left waiting.
  expect((await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })).text).toContain('1 run waits for other repositories.')
})

test('/tick-it sync names how many runs wait for other repositories', async ($, on) => {
  engine(on, { lines: 0, stored: { outbox: [work('a', 'TCK-1', 'acme/other'), work('b', 'TCK-2', 'acme/third')] } })
  await start($)
  const sync = await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(sync.text).toContain('Nothing waiting to send to Tick-it. 2 runs wait for other repositories.')
  const reviews = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(reviews.text).toContain('2 runs wait for other repositories.')
})

test("a stored run with no repository is sent under the repository of the session that first reads it", async ($, on) => {
  const seen = engine(on, { lines: 0, stored: { outbox: [work('w-old', 'TCK-999')] } })
  await start($)
  expect(seen.recorded).toHaveLength(1)
  expect(seen.recorded[0]?.args.repository).toBe('acme/web-app')
  expect(seen.recorded[0]?.args.runs.map(r => r.agentId)).toEqual(['w-old'])
})

test('review runs of the same key stamped with another repository change neither the round, the blockers nor the carry-forward', async ($, on) => {
  const stored = { reviews: [review('r-other', 'TCK-143', 3, 'acme/other')] }
  const seen = engine(on, { lines: 10, stored }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  // Round 1, not 4; the other repository's blocker is not given to the reviewer; the reviewer runs rather than carrying a verdict forward.
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-143, round 1'])
  expect(seen.spawned[0]?.prompt).not.toContain('another repository blocker')
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.recorded.flatMap(c => c.args.runs).filter(r => r.kind === 'review' || r.skill !== undefined).map(r => r.round)).toContain(1)
})

test("/tick-it reviews lists only this repository's runs", async ($, on) => {
  engine(on, { lines: 0, stored: { reviews: [review('r-other', 'TCK-777', 1, 'acme/other'), review('r-here', 'TCK-143', 1, 'ACME/web-app')] } })
  await start($)
  const report = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(report.text).toContain('TCK-143')
  expect(report.text).not.toContain('TCK-777')
  expect(report.text).toContain('1 review run of other repositories is not listed.')
})

test('a board cached for another repository is not shown before the board is read', async ($, on) => {
  const cached = [{ id: 'TCK-143', title: 'Cached elsewhere', epic: '', size: 'XS', status: 'Ready', acceptance: [] }]
  const net: Net = { listFails: true }
  engine(on, { lines: 0, stored: { tickets: cached, 'tickets-repository': 'acme/other' } }, false, {}, net)
  await start($)
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).not.toContain('Cached elsewhere')
})

test('a board cached for this repository still shows while Tick-it cannot be reached', async ($, on) => {
  const cached = [{ id: 'TCK-143', title: 'Cached here', epic: '', size: 'XS', status: 'Ready', acceptance: [] }]
  const net: Net = { listFails: true }
  engine(on, { lines: 0, stored: { tickets: cached, 'tickets-repository': 'ACME/web-app' } }, false, {}, net)
  await start($)
  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  expect(board.text).toContain('Cached here')
})

test("the record_runs payload keeps the repository as the call's own field, as tests/contract-fixtures.json records it (checks/contract-fixtures.test.mjs reads the fixture)", async ($, on) => {
  const seen = engine(on, { lines: 0, stored: { outbox: [work('w-here', 'TCK-5', 'acme/web-app')] } })
  await start($)
  expect(seen.recorded[0]?.args.repository).toBe('acme/web-app')
  for (const run of seen.recorded[0]?.args.runs ?? []) expect(run).not.toHaveProperty('repository')
})
