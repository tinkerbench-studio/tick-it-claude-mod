import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const base = {
  sizeBudgets: { XS: 100, S: 100, M: 100, L: 100 },
  defaultReviewRounds: { XS: 3, S: 3, M: 3, L: 3 },
  maxReviewRounds: 10,
}
const lines = { memories: 'SERVED memories.', memoryTools: 'SERVED tools.', deferredTools: 'SERVED deferred.', done: 'SERVED done line.', branch: 'SERVED branch.', addToTicket: ['SERVED add.'] }
const SKILL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }

/** Takes TCK-143, finishes it, and returns the brief text and the first fix prompt. */
async function run($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], net: Net) {
  const seen = engine(on, { lines: 10 }, true, SKILL, net)
  await start($)
  const took = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: wrong'))
  return { brief: JSON.stringify(took.context), fix: seen.submitted[0] ?? '' }
}

test('the brief carries each served beforeReview line before the line that says how to finish, and the fix prompt ends with afterFix', async ($, on) => {
  const { brief, fix } = await run($, on, { modConfig: { ...base, briefLines: { ...lines, beforeReview: ['CHECK one.', 'CHECK two.'], afterFix: 'A fix is a new change.' } } })
  for (const l of ['CHECK one.', 'CHECK two.']) expect(brief).toContain(l)
  expect(brief.indexOf('CHECK one.')).toBeLessThan(brief.indexOf('CHECK two.'))
  expect(brief.indexOf('CHECK two.')).toBeLessThan(brief.indexOf('SERVED done line.'))
  expect(fix.trimEnd().endsWith('A fix is a new change.')).toBe(true)
  expect(fix).toContain('Fix each one within the ticket, then stop.')
})

test('with neither key served the brief and the fix prompt add nothing', async ($, on) => {
  const { brief, fix } = await run($, on, { modConfig: { ...base, briefLines: lines } })
  expect(brief).toContain('SERVED done line.')
  expect(fix).toBe('Round 1 review of TCK-143 found 1 blocking finding. Fix each one within the ticket, then stop. tick-it reviews again when you finish.\n- ' + fix.split('\n- ')[1])
  expect(fix.split('\n')).toHaveLength(2)
})

test('a malformed beforeReview or afterFix is ignored', async ($, on) => {
  const { fix } = await run($, on, { modConfig: { ...base, briefLines: { ...lines, beforeReview: 'not an array', afterFix: ['no'] } } })
  expect(fix.split('\n')).toHaveLength(2)
})
