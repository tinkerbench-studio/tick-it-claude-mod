import { expect, test } from 'claude-code/testing'

import { RUN, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const skill = (name: string, front: string) => ({ [`.tick-it/skills/${name}/SKILL.md`]: `---\nname: ${name}\n${front}\n---\nReview.` })
const SKILLS = { ...skill('docs', 'paths: docs/**'), ...skill('code', 'paths: hooks/*.ts'), ...skill('all', '') }
const carried = (seen: ReturnType<typeof engine>) => seen.recorded.flatMap(r => r.args.runs).filter(r => r.round === 2 && typeof r.notApplicable === 'string' && r.notApplicable.includes('carries forward'))
const round2 = (seen: ReturnType<typeof engine>) => seen.spawned.filter(s => s.description.endsWith('round 2')).map(s => s.description.split(' ')[2]).sort()

// Round 1 runs docs, code and all (a ticket changed in both areas); `answers` are their round 1 verdicts.
const roundOne = async ($: Parameters<typeof start>[0], on: Parameters<typeof engine>[0], diff: Parameters<typeof engine>[1], answers: Record<string, string>, net?: Net) => {
  const seen = engine(on, diff, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const [i, s] of seen.spawned.entries()) await $.turn.complete(finishTurn(`agent-${i + 1}`, answers[s.description.split(' ')[2] ?? ''] ?? 'VERDICT: clean'))
  return seen
}
const CHANGED = ['docs/a.md', 'hooks/a.ts']
const blocked = { all: 'BLOCKING: all wrong' }

test('round 2: a reviewer with a blocking finding still open runs, even when no file it reads changed', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: [] }, { docs: 'BLOCKING: docs wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(seen)).toEqual(['docs'])
  expect(carried(seen).map(r => r.skill).sort()).toEqual(['all', 'code'])
})

test('round 2: a clean reviewer runs when a file changed since round 1 matches its paths, and one whose paths match none is carried forward', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: ['hooks/b.ts'] }, blocked)
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  // all has a blocker open; code's glob matches the new file; docs reads nothing that changed.
  expect(round2(seen)).toEqual(['all', 'code'])
  expect(carried(seen)).toMatchObject([{ skill: 'docs', durationMs: 0, notApplicable: expect.stringContaining('its clean verdict carries forward') }])
})

test('round 2: the other way round, a changed docs file runs docs and carries code forward', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: ['docs/x.md'] }, blocked)
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(seen)).toEqual(['all', 'docs'])
  expect(carried(seen).map(r => r.skill)).toEqual(['code'])
})

test('round 2: a reviewer with no paths and a clean verdict runs on any changed file, and is carried forward when nothing changed', async ($, on) => {
  const changed = await roundOne($, on, { lines: 10, changed: CHANGED, since: ['apps/x.css'] }, { docs: 'BLOCKING: docs wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(changed)).toEqual(['all', 'docs'])
})

test('round 2: with nothing changed the clean pathless reviewer is carried forward too', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: [] }, { docs: 'BLOCKING: docs wrong' })
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(carried(seen).map(r => r.skill).sort()).toEqual(['all', 'code'])
})

test('every reviewer clean and none with work left: no reviewer starts, the round settles from the pull request, and the carried-forward verdicts are recorded', async ($, on) => {
  const pr = { number: 12, state: 'open', draft: false, ci: 'failure', behind: false }
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: [] }, {}, { pullRequests: [pr] })
  // Clean reviewers, failing CI: the round is blocking on the pull request alone, so the fix follows.
  expect(seen.submitted).toHaveLength(1)
  const before = seen.spawned.length
  pr.ci = 'success'
  await $.turn.complete(finishTurn(undefined, 'Fixed CI.'))
  expect(seen.spawned.length - before).toBe(0)
  expect(carried(seen).map(r => r.skill).sort()).toEqual(['all', 'code', 'docs'])
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && String(c.args.reason ?? '').includes('no changed file'))).toBe(false)
  // Settled clean on the pull request: nothing asks for another fix or a person.
  expect(seen.submitted.filter(t => t.includes('[ci]'))).toHaveLength(1)
  // Settled clean on the pull request: no stop, no person asked; the round goes on to the acceptance ticks or Done.
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human' && String(c.args.note).includes('not confirmed'))).toBe(false)
  expect(seen.submitted.some(t => t.includes('acceptance check')) || seen.toasts.some(t => t.includes('is Done'))).toBe(true)
})

test('the round that would move the ticket to Done is clean with carried-forward verdicts: only the reviewer with work left answers', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: ['hooks/b.ts'] }, blocked)
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  await $.turn.complete(finishTurn('agent-4', 'VERDICT: clean'))
  await $.turn.complete(finishTurn('agent-5', 'VERDICT: clean'))
  expect(round2(seen)).toEqual(['all', 'code'])
  expect(seen.spawned.some(s => s.description.endsWith('round 3'))).toBe(false)
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human' && c.args.kind === 'no-clean-round')).toBe(false)
  // Round 2 reads as clean with docs carried forward: it is settled (Done, or asking to tick the checks), not sent back for a fix.
  expect(seen.submitted.length).toBe(1)
  expect(seen.toasts.some(t => t.includes('is Done') || t.includes('acceptance check'))).toBe(true)
})

test('round 2 cannot list the files changed since round 1: every applicable reviewer runs', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: null }, blocked)
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(round2(seen)).toEqual(['all', 'code', 'docs'])
  expect(carried(seen)).toHaveLength(0)
})

test('steward starting round 1 again runs every applicable reviewer, whatever an earlier round left clean', async ($, on) => {
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: [] }, {})
  const before = seen.spawned.length
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.spawned.length - before).toBe(3)
  expect(carried(seen)).toHaveLength(0)
})

test('the ticking turn changes no file: round 2 carries every verdict forward and asks a person about the unticked check, not about a budget', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: CHANGED, since: [] }, true, skill('all', ''))
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, { acceptanceItems: [{ id: 'c1', text: 'It saves', checked: false }] })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.submitted[0]).toContain('1 acceptance check is not ticked')
  const before = seen.spawned.length
  await $.turn.complete(finishTurn(undefined, 'Could not tick it.'))
  expect(seen.spawned.length - before).toBe(0)
  expect(carried(seen).map(r => r.skill)).toEqual(['all'])
  const need = seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args
  expect(need).toMatchObject({ kind: 'no-clean-round', note: expect.stringContaining('acceptance check is not ticked') })
  expect(String(need?.note)).not.toContain('budget')
})

test('every verdict carried forward while CI is still pending after the fix: settled as any round whose reviewers found nothing (pending is not failing), never as a budget stop', async ($, on) => {
  const pr = { number: 12, state: 'open', draft: false, ci: 'failure', behind: false }
  const seen = await roundOne($, on, { lines: 10, changed: CHANGED, since: [] }, {}, { pullRequests: [pr] })
  pr.ci = 'pending'
  await $.turn.complete(finishTurn(undefined, 'Pushed a CI fix.'))
  expect(seen.spawned.filter(s => s.description.endsWith('round 2'))).toHaveLength(0)
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human' && String(c.args.note).includes('budget has no room'))).toBe(false)
})

test('round 2: a reviewer whose round 1 run failed has no clean verdict to carry, so it runs again with no blocker and no changed file', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: CHANGED, since: [] }, true, SKILLS)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const [i, s] of seen.spawned.entries()) {
    const name = s.description.split(' ')[2]
    await $.turn.complete(name === 'docs' ? { ...finishTurn(`agent-${i + 1}`, 'crashed'), reason: 'error' as never } : finishTurn(`agent-${i + 1}`, name === 'all' ? 'BLOCKING: all wrong' : 'VERDICT: clean'))
  }
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  // docs failed (nothing to carry forward) and all has a blocker open; code was clean and nothing changed.
  expect(round2(seen)).toEqual(['all', 'docs'])
  expect(carried(seen).map(r => r.skill)).toEqual(['code'])
})
