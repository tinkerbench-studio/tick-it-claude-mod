import { expect, test } from 'claude-code/testing'

import { RECHECK_LINES, brief } from '../hooks/board'
import { openRounds } from '../hooks/reviews'
import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const GAP = { id: 'f-7', skill: 'principal', file: 'api/a.ts', text: 'no test for expiry', required: true, fixed: false, decision: null }
const run = (round: number, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ agentId: `a${round}`, ticket: 'TCK-1', epic: 'E', round, skill: 'principal', model: 'm', startedAt: round, status: 'done', items, ...extra }) as never
const gap = { severity: 'blocking', file: 'api/a.ts', text: 'no test for expiry' }
const still = { ...gap, open: true }

// Rounds 1 and 2 leave the finding open and the session fixes it each time; round 3 finds it open again.
const rounds = async ($: Parameters<typeof start>[0], on: Parameters<typeof engine>[0], net: Net) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test for expiry\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  await $.turn.complete(finishTurn(undefined, 'Tried a fix.'))
  await $.turn.complete(finishTurn('agent-3', 'FINDING: 1 open still missing\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-4', 'VERDICT: clean', 'claude-sonnet-5-5'))
  await $.turn.complete(finishTurn(undefined, 'Tried a second fix.'))
  seen.submitted.length = 0
  await $.turn.complete(finishTurn('agent-5', 'FINDING: 1 open still missing\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-6', 'VERDICT: clean', 'claude-sonnet-5-5'))
  return seen
}

test('a finding still open after two fix rounds starts no further round and asks a person, naming it', async ($, on) => {
  const seen = await rounds($, on, { findings: [GAP], reviewRounds: { XS: 4, S: 4, M: 4, L: 4 } })
  // One typed report_session carries the stop and the need; no separate set_needs_human.
  expect(seen.ticketCalls.filter(c => c.tool === 'set_needs_human' && c.derived !== true)).toEqual([])
  const stops = seen.ticketCalls.filter(c => c.tool === 'report_session' && c.args.status === 'stopped')
  expect(stops).toHaveLength(1)
  expect(stops[0]?.args).toMatchObject({ stop: { code: 'other', round: 3 }, needsHuman: { kind: 'no-clean-round', note: expect.stringContaining('f-7 [principal] api/a.ts no test for expiry') } })
  expect((stops[0]?.args.needsHuman as { note: string }).note).toContain('still open after 2 fix rounds')
  // No fix is asked for and no round 4 starts.
  expect(seen.submitted).toEqual([])
  expect(seen.spawned).toHaveLength(6)
})

test('a finding a person decided is counted again from the next round: no stop at the third appearance', async ($, on) => {
  const seen = await rounds($, on, { findings: [{ ...GAP, decision: 'fix' }], reviewRounds: { XS: 4, S: 4, M: 4, L: 4 } })
  expect(seen.ticketCalls.filter(c => c.tool === 'set_needs_human')).toEqual([])
  // The fix is asked for and round 4 goes on.
  expect(seen.submitted).toHaveLength(1)
  await $.turn.complete(finishTurn(undefined, 'Fixed after the decision.'))
  expect(seen.spawned).toHaveLength(8)
})

test('openRounds counts the rounds a finding stayed blocking, and starts again after a fixed round or a decision', () => {
  const three = [run(1, [gap]), run(2, [still]), run(3, [still])]
  expect([...openRounds(three, 'TCK-1', 3).values()].map(v => v.rounds)).toEqual([3])
  expect([...openRounds(three, 'TCK-1', 2).values()].map(v => v.rounds)).toEqual([2])
  // A round of the skill that lists no such finding starts the count again.
  expect([...openRounds([...three.slice(0, 2), run(3, []), run(4, [still])], 'TCK-1', 4).values()].map(v => v.rounds)).toEqual([1])
  // A decision first seen in round 3 counts only the rounds after round 2.
  expect([...openRounds([...three, run(4, [still])], 'TCK-1', 4, { 'principal\0api/a.ts\0no test for expiry': 2 }).values()].map(v => v.rounds)).toEqual([2])
  // Another ticket's or another skill's rounds are not this one's.
  expect(openRounds(three, 'TCK-2', 3).size).toBe(0)
})

test('the brief tells the session to re-check each fix, and the merged base', () => {
  const text = brief({ id: 'TCK-1', title: 'T', epic: 'E', size: 'S', acceptance: [] } as never)
  for (const line of RECHECK_LINES) expect(text).toContain(line)
  expect(RECHECK_LINES[0]).toContain("confirm against the finding's text and the current diff that it is fixed")
  expect(RECHECK_LINES[1]).toContain('merge the base branch')
})
