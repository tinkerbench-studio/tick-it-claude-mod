import { expect, test } from 'claude-code/testing'

import { PANE, RUN, SKILLS, STARTED, engine, finishTurn, start, typed } from './helpers'

const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const old = { agentId: 'old-agent', ticket: 'TCK-143', epic: 'One-page checkout', round: 1, skill: 'principal', model: 'm', startedAt: 1, status: 'running', claudeSession: 'session-0' }
type Ctx = Parameters<Parameters<typeof test>[1]>[0]
const report = async ($: Ctx) => (await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews TCK-143' })).text ?? ''
const sentAgents = (seen: ReturnType<typeof engine>) => seen.recorded.flatMap(c => c.args.runs.map(r => r.agentId))
const begin = async ($: Ctx) => {
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
}

test('a running run of another session is failed at session.start and never sent, and r then starts the next round', async ($, on) => {
  const seen = engine(on, { lines: 10, stored: { reviews: [old] } }, true, PRINCIPAL)
  seen.listedExtra = ['old-agent']
  await start($)
  expect(await report($)).toContain('✗ principal')
  await begin($)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  expect(seen.toasts.at(-1)).toContain('starts when this turn ends')
  await $.turn.complete(finishTurn(undefined, 'Nothing to fix.'))
  expect(seen.spawned).toHaveLength(2)
  expect(sentAgents(seen)).not.toContain('old-agent')
  await ui.unmount()
})

test('a running run of this session whose agent is no longer listed is failed when r is pressed, and the round is not still being reviewed', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await begin($)
  seen.unlisted = ['agent-1']
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  expect(seen.toasts.at(-1)).not.toContain('still being reviewed')
  expect(await report($)).toContain('✗ principal')
  expect(sentAgents(seen)).not.toContain('agent-1')
  await ui.unmount()
})

test('a run whose agent is still listed as running is left running, and r says the round is being reviewed', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await begin($)
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await ui.press({ key: 'review-again' })
  expect(seen.toasts.at(-1)).toContain('still being reviewed')
  expect(await report($)).toContain('running')
  await ui.unmount()
})

test('settleRound settles a round whose remaining running run has no live agent', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  await begin($)
  seen.unlisted = ['agent-2']
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test\nVERDICT: changes'))
  expect(seen.submitted.join('\n')).toContain('[principal] BLOCKING: api/a.ts:4 no test')
  expect(await report($)).toContain('fixing, round 1')
})

test('/tick-it steward over a round with a reviewer still running fails that run; its late answer changes nothing and sends nothing', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await begin($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.spawned).toHaveLength(2)
  expect(await report($)).toMatch(/✗ principal\s+round 1/)
  const submitted = seen.submitted.length
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: late\nVERDICT: changes'))
  expect(seen.submitted).toHaveLength(submitted)
  expect(seen.spawned).toHaveLength(2)
  expect(sentAgents(seen)).not.toContain('agent-1')
  expect(await report($)).toMatch(/✗ principal\s+round 1/)
})
