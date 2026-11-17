import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, start } from './helpers'

const HEAD = 'ab12'.repeat(10)
const OTHER = 'cd34'.repeat(10)
const pr = (extra: Record<string, unknown> = {}) => ({ number: 12, state: 'open', draft: false, ci: 'success', headSha: HEAD, ...extra })

const run = async ($: Parameters<typeof start>[0] & { command: { run: (e: never) => Promise<unknown> } }) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  return $.command.run({ ...RUN, command: 'tick-it', args: 'done' }) as Promise<{ text?: string }>
}

test('a checkout that is not the pull request head starts no reviewer, records no run, and names both commits', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [pr({ headSha: OTHER })] })
  const out = await run($)
  expect(out.text).toContain(`the checkout is at ${HEAD}`)
  expect(out.text).toContain(`pull request #12 is at ${OTHER}`)
  expect(seen.spawned).toEqual([])
  expect(seen.recorded).toEqual([])
})

test('a checkout at the pull request head starts the reviewers as before', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [pr()] })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
})

test('an empty diff against the base starts no reviewer and says so', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [] }, true, SKILLS, { pullRequests: [pr()] })
  const out = await run($)
  expect(out.text).toContain('git diff against the base branch is empty')
  expect(seen.spawned).toEqual([])
  expect(seen.recorded).toEqual([])
})

test('a ticket with no pull request is reviewed as today', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [] })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
  expect(seen.toasts.some(t => t.includes('could not be checked'))).toBe(false)
})

test('when Tick-it cannot be read the round runs and the pane says the head could not be checked', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: 'unreachable' })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
  expect(seen.toasts.some(t => t.includes('pull request head could not be checked'))).toBe(true)
})

test('a pull request that gives no head commit does not stop the round, and the pane says the head could not be checked', async ($, on) => {
  const { headSha: _head, ...noHead } = pr()
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [noHead] })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
  expect(seen.toasts.some(t => t.includes('Tick-it gave no head commit'))).toBe(true)
})

test('a merged pull request whose head differs does not stop the round', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [pr({ state: 'merged', headSha: OTHER })] })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
})
