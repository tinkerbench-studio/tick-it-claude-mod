import { expect, test } from 'claude-code/testing'

import { PANE, RUN, SKILLS, engine, start } from './helpers'

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
  // The stopped round never ran: r tries round 1 again, not round 2.
  const board = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  await board.press({ key: 'review-again' })
  expect(seen.toasts.some(t => t.includes('Round 1 starts'))).toBe(true)
  expect(seen.toasts.some(t => t.includes('Round 2'))).toBe(false)
  await board.unmount()
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
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /pull request head could not be checked/ })).toBeDefined()
  await pane.unmount()
})

test('a pull request that gives no head commit does not stop the round, and the pane says the head could not be checked', async ($, on) => {
  const { headSha: _head, ...noHead } = pr()
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [noHead], noHeadSha: true })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
  expect(seen.toasts.some(t => t.includes('Tick-it gave no head commit'))).toBe(true)
  const pane = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /Tick-it gave no head commit/ })).toBeDefined()
  await pane.unmount()
})

test('a merged pull request whose head differs does not stop the round', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS, { pullRequests: [pr({ state: 'merged', headSha: OTHER })] })
  await run($)
  expect(seen.spawned.length).toBeGreaterThan(0)
})

// TCK-85: a checkout elsewhere is moved to the pull request's head when that loses nothing.
const BRANCH = 'tck-143-picker'
test('a clean checkout on another commit fetches the branch, checks out the head and starts the reviewers', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'], originHead: OTHER }, true, SKILLS, { pullRequests: [pr({ headSha: OTHER, branch: BRANCH })] })
  await run($)
  expect(seen.processes).toContain(`git fetch origin ${BRANCH}`)
  expect(seen.processes).toContain(`git checkout -B ${BRANCH} ${OTHER}`)
  expect(seen.spawned.length).toBeGreaterThan(0)
})

const refused: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['uncommitted changes', { dirty: true, originHead: OTHER }, { branch: BRANCH }],
  ['unpushed commits', { unpushed: true, originHead: OTHER }, { branch: BRANCH }],
  ['a failed fetch', { fetchFails: true, originHead: OTHER }, { branch: BRANCH }],
  ['an origin head that differs from Tick-it\'s', { originHead: HEAD }, { branch: BRANCH }],
  ['an unsafe branch name', { originHead: OTHER }, { branch: '--upload-pack=x' }],
]
for (const [name, diff, prExtra] of refused) {
  test(`${name} leave the checkout as it was and stop the round`, async ($, on) => {
    const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'], ...diff }, true, SKILLS, { pullRequests: [pr({ headSha: OTHER, ...prExtra })] })
    const out = await run($)
    expect(out.text).toContain('No review started: the checkout is at')
    expect(seen.processes.some(p => p.startsWith('git checkout'))).toBe(false)
    expect(seen.spawned).toEqual([])
  })
}
