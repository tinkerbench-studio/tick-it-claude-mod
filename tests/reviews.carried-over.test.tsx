import { expect, test } from 'claude-code/testing'

import { PANE, RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

const EARLIER = 'cafe1234'.repeat(5)
const timeline = [{ type: 'review', round: 1, at: '2026-11-01T10:00:00Z', pastLimit: false, pastBudget: false, agents: [{ skill: 'principal', blocking: 0, optional: 0, verdicts: [], headSha: EARLIER }] }]
const pr = (extra: Record<string, unknown>): Net => ({ timeline, pullRequests: [{ number: 12, state: 'open', draft: false, ci: 'success', behind: false, ...extra }] })

const run = async ($: Parameters<typeof start>[0], on: Parameters<typeof engine>[0], extra: Record<string, unknown>, moveByClaude = true) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS, pr(extra))
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  if (moveByClaude) await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  return seen
}

test('a head that only merged the base, its review carried over: no reviewer starts and the round settles from the pull request', async ($, on) => {
  const seen = await run($, on, { reviewCarriedOver: true })
  expect(seen.spawned).toHaveLength(0)
  expect(seen.recorded.flatMap(r => r.args.runs ?? [])).toHaveLength(0)
})

test('the stewarding pane says the review was carried over from the earlier commit, by short hash', async ($, on) => {
  const seen = await run($, on, { reviewCarriedOver: true })
  expect(seen.spawned).toHaveLength(0)
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /Review carried over from the earlier commit cafe123: the head only merged the base/ })).toBeDefined()
  await pane.unmount()
})

test('reviewCarriedOver false: the round runs as today', async ($, on) => {
  const seen = await run($, on, { reviewCarriedOver: false })
  expect(seen.spawned.length).toBeGreaterThan(0)
})

test('reviewCarriedOver absent (an older Tick-it): the round runs as today', async ($, on) => {
  const seen = await run($, on, {})
  expect(seen.spawned.length).toBeGreaterThan(0)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
})

test('a pull request that cannot be read now never skips the review, even when the last one read said carried over', async ($, on) => {
  const net = pr({ reviewCarriedOver: true })
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  // A first round reads the pull request (carried over, so no reviewer), and the read then fails: the cached flag is stale.
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.spawned).toHaveLength(0)
  net.pullRequests = 'unreachable'
  // Claude's own move to In review starts the round with no command, so only the guard (not settlesClean) sees the failed read.
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-review', repository: 'acme/web-app', key: 'TCK-143', status: 'In review' } as never)
  await $.turn.complete(finishTurn(undefined, 'Pushed.'))
  expect(seen.spawned.length).toBeGreaterThan(0)
})
