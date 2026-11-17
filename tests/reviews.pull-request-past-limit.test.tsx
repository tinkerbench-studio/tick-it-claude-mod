import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

// TCK-76: a round whose reviewers found nothing is settled on the pull request, also past the round limit, and CI that is not confirmed for the checked-out commit is not a finding.
const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const HEAD = 'ab12'.repeat(10)
const OTHER = 'cd34'.repeat(10)
const pr = (extra: Record<string, unknown>) => [{ number: 12, state: 'open', draft: false, ci: 'success', behind: false, headSha: HEAD, ...extra }]
const needsHuman = (seen: { ticketCalls: { tool: string; args: Record<string, unknown> }[] }) => seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => c.args)
const status = (seen: { server: { key: string; status: string }[] }) => seen.server.find(t => t.key === 'TCK-143')?.status
const phases = (seen: { ticketCalls: { tool: string; args: Record<string, unknown> }[] }) => seen.ticketCalls.filter(c => c.tool === 'report_session').map(c => c.args.status)

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

/** Three rounds of reviewer findings, then the further round 4 (past the limit of 3) where the reviewer is clean and the pull request is as given. */
const pastLimit = async ($: Ctx, on: On, net: Net) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, Object.assign(net, { reviewRounds: { XS: 3, S: 3, M: 5, L: 6 } }))
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2, 3]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: still wrong'))
    await $.turn.complete(finishTurn(undefined, 'Tried again.'))
  }
  net.pullRequests = pr({ ci: 'failure' })
  await $.turn.complete(finishTurn('agent-4', 'VERDICT: clean'))
  return seen
}

test('past the round limit a clean round with only failing CI is fixed and read again, not stopped as no-clean-round', async ($, on) => {
  const net: Net = { pullRequests: pr({}) }
  const seen = await pastLimit($, on, net)
  expect(seen.spawned).toHaveLength(4)
  expect(needsHuman(seen)).toEqual([])
  expect(seen.submitted).toHaveLength(4)
  expect(seen.submitted[3]).toContain('[ci] CI is failing on pull request #12')
  expect(seen.submitted[3]).toContain('reads the pull request again when you finish')
  expect(phases(seen)).not.toContain('stopped')
  // The fix passes CI: the round settles on the pull request alone, with no fifth reviewer.
  net.pullRequests = pr({ ci: 'success' })
  await $.turn.complete(finishTurn(undefined, 'Fixed CI.'))
  expect(seen.spawned).toHaveLength(4)
  expect(status(seen)).toBe('Done')
  expect(needsHuman(seen)).toEqual([])
})

test('past the round limit, CI still failing after the fix stops with a note that names the failing CI, not a blocking finding', async ($, on) => {
  const seen = await pastLimit($, on, { pullRequests: pr({}) })
  await $.turn.complete(finishTurn(undefined, 'Tried.'))
  expect(seen.spawned).toHaveLength(4)
  expect(needsHuman(seen)).toHaveLength(1)
  const note = String(needsHuman(seen)[0]?.note)
  expect(note).toContain('CI is failing on pull request #12')
  expect(note).not.toContain('blocking finding')
})

test('past the round limit, a branch behind its base after the fix is named in the note', async ($, on) => {
  const net: Net = { pullRequests: pr({}) }
  const seen = await pastLimit($, on, net)
  net.pullRequests = pr({ ci: 'success', behind: true })
  await $.turn.complete(finishTurn(undefined, 'Fixed CI.'))
  expect(String(needsHuman(seen)[0]?.note)).toContain('pull request #12 is behind its base')
  expect(String(needsHuman(seen)[0]?.note)).not.toContain('blocking finding')
})

test('past the round limit, a finding of a reviewer still stops with the blocking count', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL, { reviewRounds: { XS: 1, S: 3, M: 5, L: 6 }, pullRequests: pr({}) })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: wrong'))
  await $.turn.complete(finishTurn(undefined, 'Tried.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: still wrong'))
  expect(String(needsHuman(seen)[0]?.note)).toBe('1 blocking finding still open after 2 rounds, no clean round.')
})

for (const [what, extra] of [['gives no head commit', { headSha: undefined }], ['names a head other than the checked-out commit', { headSha: OTHER }]] as const) {
  test(`CI failing while Tick-it ${what} is CI not confirmed: no fix is asked for, no blocking note, and the need names the CI`, async ($, on) => {
    const net: Net = { pullRequests: pr({}), noHeadSha: extra.headSha === undefined }
    const seen = engine(on, { lines: 10 }, true, PRINCIPAL, net)
    await start($)
    await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
    await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
    // The head moves (or goes unreported) while the reviewer runs: the round gate passed on the checked-out commit.
    net.pullRequests = pr({ ci: 'failure', ...extra })
    await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
    expect(seen.submitted).toEqual([])
    expect(needsHuman(seen)).toHaveLength(1)
    const note = String(needsHuman(seen)[0]?.note)
    expect(note).toContain('CI of pull request #12 is not confirmed')
    expect(note).not.toContain('blocking')
    expect(status(seen)).toBe('In review')
    // The pull request was read again before the round was called unconfirmed: once at the gate, once more when settling, once more after the second look.
    expect(seen.ticketCalls.filter(c => c.tool === 'list_pull_requests').length).toBeGreaterThanOrEqual(3)
  })
}
