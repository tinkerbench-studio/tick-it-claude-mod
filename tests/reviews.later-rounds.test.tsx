import { expect, test } from 'claude-code/testing'

import { RUN, engine, finishTurn, start } from './helpers'

const skill = (name: string, front: string) => ({ [`.tick-it/skills/${name}/SKILL.md`]: `---\nname: ${name}\n${front}\n---\nReview.` })
const SKILLS = { ...skill('docs', 'paths: docs/**'), ...skill('code', 'paths: hooks/*.ts'), ...skill('all', '') }
const carried = (seen: ReturnType<typeof engine>) => seen.recorded.flatMap(r => r.args.runs).filter(r => r.round === 2 && typeof r.notApplicable === 'string' && r.notApplicable.includes('carries forward'))
const round2 = (seen: ReturnType<typeof engine>) => seen.spawned.filter(s => s.description.endsWith('round 2')).map(s => s.description.split(' ')[2]).sort()

// Round 1 runs docs, code and all (a ticket changed in both areas); `answers` are their round 1 verdicts.
const roundOne = async ($: Parameters<typeof start>[0], on: Parameters<typeof engine>[0], diff: Parameters<typeof engine>[1], answers: Record<string, string>) => {
  const seen = engine(on, diff, true, SKILLS)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const [i, s] of seen.spawned.entries()) await $.turn.complete(finishTurn(`agent-${i + 1}`, answers[s.description.split(' ')[2] ?? ''] ?? 'VERDICT: clean'))
  return seen
}

test('round 2: a reviewer with a blocking finding still open runs, even when no file it reads changed', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: [] }, { docs: 'BLOCKING: docs wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(seen)).toEqual(['docs'])
})

test('round 2: a reviewer whose paths match a file changed since round 1 runs, the pathless one runs on any changed file', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: ['hooks/b.ts'] }, { docs: 'BLOCKING: docs wrong', code: 'BLOCKING: code wrong', all: 'BLOCKING: all wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(seen)).toEqual(['all', 'code', 'docs'])
})

test('round 2: a clean reviewer whose files did not change is recorded as skipped with that reason and carries its verdict forward', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: ['hooks/b.ts'] }, { code: 'BLOCKING: code wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  // code has a blocker open and a matching file; all (no paths) runs for the changed file; docs read nothing that changed.
  expect(round2(seen)).toEqual(['all', 'code'])
  expect(carried(seen)).toMatchObject([{ skill: 'docs', durationMs: 0, notApplicable: expect.stringContaining('its clean verdict carries forward') }])
})

test('the round that would move the ticket to Done counts carried-forward verdicts: it is clean with only the reviewer that had work left', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: ['hooks/b.ts'] }, { code: 'BLOCKING: code wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  await $.turn.complete(finishTurn('agent-4', 'VERDICT: clean'))
  await $.turn.complete(finishTurn('agent-5', 'VERDICT: clean'))
  expect(round2(seen)).toEqual(['all', 'code'])
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human' && c.args.kind === 'no-clean-round')).toBe(false)
  expect(seen.submitted.some(t => t.includes('round 3'))).toBe(false)
  expect(seen.spawned.some(s => s.description.endsWith('round 3'))).toBe(false)
})

test('round 2 with every reviewer clean and no file changed starts no reviewer and settles from the pull request, not as Done without review', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: [] }, { all: 'BLOCKING: all wrong' })
  const before = seen.spawned.length
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  // The pathless reviewer has a blocker open and runs; the others carry forward.
  expect(seen.spawned.length - before).toBe(1)
  expect(carried(seen).map(r => r.skill).sort()).toEqual(['code', 'docs'])
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'Done' && String(c.args.reason).includes('no changed file'))).toBe(false)
})

test('round 2 cannot list the files changed since round 1: every applicable reviewer runs', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: null }, { docs: 'BLOCKING: x' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(seen)).toEqual(['all', 'code', 'docs'])
  expect(carried(seen)).toHaveLength(0)
})

test('steward starting round 1 again runs every applicable reviewer, whatever an earlier round left clean', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: ['docs/a.md', 'hooks/a.ts'], since: [] }, {})
  const before = seen.spawned.length
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.spawned.length - before).toBe(3)
  expect(carried(seen)).toHaveLength(0)
})
