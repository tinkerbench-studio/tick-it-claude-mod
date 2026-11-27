import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RUN, SKILLS, STARTED, engine, finishTurn, reports, start, typed } from './helpers'
import type { Net } from './helpers'

// TCK-94: a head no review has seen, and a done report Tick-it refuses, end in the mod's own move, never in a loop.
type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type Run = Parameters<typeof test>[1]

const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const UNSEEN = 'head 1234567 is one no review has seen. Run the review skills on it and record the round with record_runs.'
const BEHIND = 'Tick-it refused the done report: the open pull request conflicts with main or is behind it. Nothing was written.'
const sent = (seen: ReturnType<typeof engine>) => seen.submitted.slice(1)
const stops = (seen: ReturnType<typeof engine>) => reports(seen).filter(r => r.status === 'stopped' && r.stop !== undefined)

/** TCK-143 taken, its first round clean: the steward is done and the ticket is In review. */
const reviewed = async ($: Ctx, on: On, net: Net) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
  const wrote: string[] = []
  on('fs.write', (_$, e) => (wrote.push(e.text), { value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'TICK_IT_LOG' ? 'debug' : undefined }))
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  return { seen, wrote }
}

const check = (name: string, run: Run) => test(name, run)

check('Tick-it answering a done report with the unseen-head instruction starts a round itself, logged as head-unseen', async ($, on) => {
  const net: Net = {}
  const { seen, wrote } = await reviewed($, on, net)
  expect(seen.spawned).toHaveLength(1)
  net.reportAnswers = [{ instructions: [UNSEEN] }]
  await $.turn.complete(finishTurn(undefined, 'Merged main and pushed.'))
  expect(seen.spawned).toHaveLength(2)
  expect(seen.spawned[1]?.description).toContain('round 2')
  expect(wrote.join('')).toMatch(/round-started ticket=TCK-143 round=2 why=head-unseen/)
  // The instruction asks for what the session may not do (record_runs): it is not handed to Claude.
  expect(sent(seen).join('\n')).not.toContain('no review has seen')
})

check('a done report Tick-it refuses is handed to the session with the refusal text', async ($, on) => {
  const net: Net = {}
  const { seen } = await reviewed($, on, net)
  net.doneRefusal = BEHIND
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  expect(sent(seen)).toHaveLength(1)
  expect(sent(seen)[0]).toContain('is behind it')
  expect(sent(seen)[0]).toContain('merge the base')
  expect(seen.spawned).toHaveLength(1)
})

check('the same refusal for the same head is handed over once; a repeat reports the session stopped with a need', async ($, on) => {
  const net: Net = {}
  const { seen } = await reviewed($, on, net)
  net.doneRefusal = BEHIND
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  await $.turn.complete(finishTurn(undefined, 'Could not.'))
  expect(sent(seen)).toHaveLength(1)
  expect(stops(seen).at(-1)).toMatchObject({ status: 'stopped', stop: { code: 'done-refused-repeated' } })
  expect(seen.ticketCalls.filter(c => c.tool === 'set_needs_human' && c.args.kind === 'session-stopped')).toHaveLength(1)
  // Stopped: no further turn hands the instruction over.
  await $.turn.complete(finishTurn(undefined, 'Still no.'))
  expect(sent(seen)).toHaveLength(1)
})

check('the same unseen-head answer for the same head and runs is acted on once; a repeat reports the session stopped with a need', async ($, on) => {
  const net: Net = {}
  const { seen } = await reviewed($, on, net)
  net.reportAnswers = [{ instructions: [UNSEEN] }]
  await $.turn.complete(finishTurn(undefined, 'Merged main and pushed.'))
  expect(seen.spawned).toHaveLength(2)
  // The round's reviewer ends without a record Tick-it takes into account: the same answer comes again for the same head.
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean'))
  await $.turn.complete(finishTurn(undefined, 'Nothing changed.'))
  await $.turn.complete(finishTurn(undefined, 'Still nothing.'))
  expect(seen.spawned.length).toBeLessThanOrEqual(3)
  expect(stops(seen).at(-1)).toMatchObject({ stop: { code: 'unseen-head-repeated' } })
  expect(sent(seen).join('\n')).not.toContain('no review has seen')
})
