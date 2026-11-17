import { expect, test } from 'claude-code/testing'

import { pullRequestFindings } from '../hooks/register'
import { RUN, SKILLS, engine, finishTurn, start, PR, cleanRoundWith, staleBranch } from './helpers'
import type { Net } from './helpers'

const HEAD = 'ab12'.repeat(10)

test('a pull request with failing CI, a stale branch or a conflict makes a round blocking; one in the merge queue leaves its branch alone', () => {
  expect(pullRequestFindings(null, HEAD)).toEqual([])
  expect(pullRequestFindings({ ...PR, headSha: HEAD }, HEAD)).toEqual([])
  // Failing CI is a blocking finding that sends the session to the failing checks.
  const failing = pullRequestFindings({ ...PR, headSha: HEAD, ci: 'failure' }, HEAD)
  expect(failing).toHaveLength(1)
  expect(failing[0]).toContain('gh run view <run> --log-failed')
  // Tick-it already told the session about this head commit: the finding points at that instruction instead of starting a second fix.
  const told = pullRequestFindings({ ...PR, headSha: HEAD, ci: 'failure', ciInstructed: true }, HEAD)
  expect(told[0]).toContain('already told this session')
  expect(told[0]).toContain('do not start a second fix')
  // Pending or unreported CI is not failing.
  expect(pullRequestFindings({ ...PR, headSha: HEAD, ci: 'pending' }, HEAD)).toEqual([])
  expect(pullRequestFindings({ ...PR, headSha: HEAD, ci: null }, HEAD)).toEqual([])
  // Behind or conflicting: merge the base in, never rewrite history.
  for (const stale of [{ behind: true }, { conflicting: true }]) {
    const found = pullRequestFindings({ ...PR, headSha: HEAD, ...stale }, HEAD)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('never rebase or force-push')
  }
  // In the queue the branch is the queue's: no finding about being behind or conflicting.
  expect(pullRequestFindings({ ...PR, headSha: HEAD, behind: true, conflicting: true, queued: true }, HEAD)).toEqual([])
  // CI still fails in the queue, and a closed or merged pull request adds nothing.
  expect(pullRequestFindings({ ...PR, headSha: HEAD, ci: 'failure', behind: true, queued: true }, HEAD)).toHaveLength(1)
  expect(pullRequestFindings({ ...PR, headSha: HEAD, state: 'merged', ci: 'failure', behind: true }, HEAD)).toEqual([])
})

test('clean reviewers do not make a round clean while CI fails: the fix prompt names the checks, and a told session is not sent a second fix', async ($, on) => {
  const seen = await cleanRoundWith($, on, { ci: 'failure' })
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[ci] CI is failing on pull request #12')
  expect(seen.submitted[0]).toContain('gh pr checks 12')
  expect(seen.toasts.some(t => t.includes('TCK-143 is Done'))).toBe(false)
})

test('a CI failure Tick-it already instructed is not fixed a second time: the prompt points at its instruction, and the turn it starts ends in the next round', async ($, on) => {
  const seen = await cleanRoundWith($, on, { ci: 'failure', ciInstructed: true })
  // One prompt, so a turn follows whose end starts the next round; it says to follow Tick-it's instruction, not to fix separately.
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('already told this session')
  expect(seen.submitted[0]).toContain('do not start a second fix')
  await $.turn.complete(finishTurn(undefined, 'Fixed it from the instruction.'))
  expect(seen.spawned).toHaveLength(4)
})

test('a CI failure Tick-it instructed alongside a stale branch: the one prompt carries the branch, not a second CI fix', async ($, on) => {
  const seen = await cleanRoundWith($, on, { ci: 'failure', ciInstructed: true, behind: true })
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[base]')
  expect(seen.submitted[0]).toContain('[ci]')
  expect(seen.submitted[0]).toContain('do not start a second fix')
})

test('a branch behind its base is blocking: merge the base in, never rewrite history', ($, on) => staleBranch($, on, { behind: true }))

test('a branch conflicting with its base is blocking: merge the base in, never rewrite history', ($, on) => staleBranch($, on, { mergeState: 'conflicting' }))

test('a pull request in the merge queue is left to the queue: behind or conflicting adds nothing, so the round is clean', async ($, on) => {
  const seen = await cleanRoundWith($, on, { behind: true, mergeState: 'conflicting', mergeQueue: { base: 'main', place: 1, of: 1, state: 'updating', pullRequest: 12 } })
  expect(seen.submitted).toEqual([])
  expect(seen.toasts.some(t => t.includes('TCK-143 is Done'))).toBe(true)
})

test('a pull request that cannot be read leaves the round blocking until Claude has checked it with gh', async ($, on) => {
  const seen = await cleanRoundWith($, on, 'unreachable')
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[pull-request] Tick-it could not read the pull request')
})

test('reviewer findings come first: a failing pull request is added only once the reviewers found nothing', async ($, on) => {
  const net: Net = { pullRequests: [{ number: 12, state: 'open', draft: false, ci: 'failure' }] }
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  expect(seen.submitted[0]).toContain('[principal] BLOCKING: api/a.ts:4 no test')
  expect(seen.submitted[0]).not.toContain('[ci]')
})
