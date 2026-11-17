import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'

// In round 1 security cannot be started (its model and the session's own are both denied); principal starts.
const refuseSecurity = (_model: string | undefined, description: string) => (description.includes(' security ') && description.endsWith('round 1') ? 'background tasks are off' : undefined)
const round = async ($: Parameters<typeof start>[0], on: Parameters<typeof engine>[0], refuse = refuseSecurity) => {
  const seen = engine(on, { lines: 10, refuse }, true, SKILLS)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const done = await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  return { seen, done }
}

test('one reviewer starts and another is refused: the round names the refused skill and its reason', async ($, on) => {
  const { done } = await round($, on)
  expect(done.text).toContain('Round 1: principal reviewing TCK-143 in this session.')
  expect(done.text).toContain('Could not be started, so the round is not clean: security: background tasks are off.')
})

test('the refused reviewer has a failed run with its reason, shown by /tick-it reviews', async ($, on) => {
  const { seen } = await round($, on)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  const report = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(report.text).toMatch(/✗ security\s+round 1.*could not be started: background tasks are off/)
  expect(seen.recorded.flatMap(c => c.args.runs).find(r => r.skill === 'security')).toMatchObject({ status: 'failed', blocking: 1, reason: 'background tasks are off' })
})

test('clean reviewers that ran do not take the ticket to Done while one was refused', async ($, on) => {
  const { seen } = await round($, on)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
})

test('a refused reviewer is not carried forward as clean: it runs again in the next round', async ($, on) => {
  const { seen } = await round($, on)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(seen.spawned.filter(s => s.description.endsWith('round 2')).map(s => s.description.split(' ')[2])).toContain('security')
})
