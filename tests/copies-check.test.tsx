import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, STARTED, typed, finishReview } from './helpers'

const WITH = { 'package.json': JSON.stringify({ scripts: { 'copies:check': 'node scripts/copies-check.mjs' } }), 'node_modules/.bin/npm': '' }
const WITHOUT_MODULES = { 'package.json': WITH['package.json'] }
const NONE = { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'node_modules/.bin/npm': '' }
const HITS = 'README.md:12: still names `old_tool`\ndocs/tools-a.md:3: still names `old_tool`'

const inReview = (seen: ReturnType<typeof engine>) => seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')
const ranCheck = (seen: ReturnType<typeof engine>) => seen.processes.filter(p => p === 'npm run copies:check')

test('a failing copies:check refuses the move, shows the hits it printed and leaves the ticket as it is', async ($, on) => {
  const seen = engine(on, { lines: 5, copies: { exitCode: 1, stdout: HITS, stderr: '' } }, true, WITH)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('stale-copy check (npm run copies:check) fails')
  expect(moved.deny).toContain('README.md:12: still names `old_tool`')
  expect(moved.deny).toContain('docs/tools-a.md:3')
  expect(ranCheck(seen)).toHaveLength(1)
  expect(inReview(seen)).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('In progress')
})

test('/tick-it done and /tick-it steward refuse a failing copies:check too, and the ticket stays taken', async ($, on) => {
  const seen = engine(on, { lines: 5, copies: { exitCode: 1, stdout: HITS, stderr: '' } }, true, WITH)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('README.md:12')
  const stewarded = (await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-151' })) as { text: string }
  expect(stewarded.text).toContain('README.md:12')
  expect(inReview(seen)).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('In progress')
})

test('a passing copies:check lets the move through', async ($, on) => {
  const seen = engine(on, { lines: 5, copies: { exitCode: 0, stdout: 'no stale copies', stderr: '' } }, true, WITH)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(ranCheck(seen)).toHaveLength(1)
  expect(inReview(seen)).toBe(true)
})

test('a repository with no copies:check script moves to review as today and nothing is run', async ($, on) => {
  const seen = engine(on, { lines: 5, copies: { exitCode: 1, stdout: HITS, stderr: '' } }, true, NONE)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(ranCheck(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

test('a repository with no package.json moves to review as today', async ($, on) => {
  const seen = engine(on, { lines: 5 })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(ranCheck(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

test('with no node_modules the check is not run, the move goes through and the pane says it could not run', async ($, on) => {
  const seen = engine(on, { lines: 5, copies: { exitCode: 1, stdout: HITS, stderr: '' } }, true, WITHOUT_MODULES)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('could not run: node_modules is missing')
  expect(ranCheck(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

test('a check that cannot be started does not refuse the move and the pane says it could not run', async ($, on) => {
  const seen = engine(on, { lines: 5, copies: 'throw' }, true, WITH)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('could not run: it could not be started')
  expect(inReview(seen)).toBe(true)
})

test('a check that times out does not refuse the move and the pane says it could not run', async ($, on) => {
  on('env.get', (_$, e) => ({ value: e.name === 'TICK_IT_COPIES_TIMEOUT_MS' ? '20' : undefined }))
  const seen = engine(on, { lines: 5, copies: 'hang' }, true, WITH)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('could not run: it did not finish')
  expect(inReview(seen)).toBe(true)
})

test("Claude's own move to review is told when the check could not run", async ($, on) => {
  const seen = engine(on, { lines: 5, copies: 'throw' }, true, WITH)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = (await finishReview($ as never)) as { deny?: string; context?: string[] }
  expect(moved.deny).toBeUndefined()
  expect(moved.context?.join('\n') ?? '').toContain('could not run')
  expect(inReview(seen)).toBe(true)
})
