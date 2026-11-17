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

test('with neither key served the brief and the fix prompt are what they were: nothing is added', async ($, on) => {
  const { brief, fix } = await run($, on, { modConfig: { ...base, briefLines: lines } })
  // The size line is followed at once by the line that asks for review, with no line between.
  expect(brief).toMatch(/refusal\.\\nWhen it is built and its checks pass, move TCK-143 to In review/)
  expect(brief).not.toContain('CHECK')
  expect(fix).toBe('Round 1 review of TCK-143 found 1 blocking finding. Fix each one within the ticket, then stop. tick-it reviews again when you finish.\n- ' + '[principal] BLOCKING: wrong')
})

const NOTHING = 'Round 1 review of TCK-143 found 1 blocking finding. Fix each one within the ticket, then stop. tick-it reviews again when you finish.\n- [principal] BLOCKING: wrong'

for (const [name, odd] of [['not an array and a list', { beforeReview: 'not an array', afterFix: ['no'] }], ['empty or blank', { beforeReview: ['', '  ', 4], afterFix: '   ' }]] as const) {
  test(`a beforeReview and afterFix that are ${name} leave the brief and the fix prompt as they are`, async ($, on) => {
    const { brief, fix } = await run($, on, { modConfig: { ...base, briefLines: { ...lines, ...odd } } })
    expect(brief).toMatch(/refusal\.\\nWhen it is built and its checks pass, move TCK-143 to In review/)
    expect(fix).toBe(NOTHING)
  })
}

test('the brief carries a served wake line before the line that says how to finish', async ($, on) => {
  const served = await run($, on, { modConfig: { ...base, briefLines: { ...lines, wake: 'SERVED wake: subscribe to your pull request.' } } })
  expect(served.brief).toContain('SERVED wake: subscribe to your pull request.')
  expect(served.brief.indexOf('SERVED wake')).toBeLessThan(served.brief.indexOf('When it is built and its checks pass'))
})

for (const [name, extra] of [['no wake line', {}], ['a blank wake line', { wake: '   ' }]] as const) {
  test(`an older Tick-it that serves ${name} leaves the brief without it`, async ($, on) => {
    const { brief } = await run($, on, { modConfig: { ...base, briefLines: { ...lines, ...extra } } })
    expect(brief).not.toContain('wake')
    expect(brief).toMatch(/refusal\.\\nWhen it is built and its checks pass, move TCK-143 to In review/)
  })
}
