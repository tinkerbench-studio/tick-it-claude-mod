import { expect, test } from 'claude-code/testing'

import { count, usd } from '../hooks/register'
import { RUN, SKILLS, engine, finishTurn, start } from './helpers'

test('a built ticket is stewarded: reviewers from .tick-it/skills, a fix round, then Done, with each reviewer timed and costed', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })

  const done = await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(done.text).toContain('Round 1: principal, security reviewing TCK-143')
  // The migrations skill is for M and L tickets only.
  expect(seen.spawned.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  expect(seen.spawned[0]?.prompt).toContain('Check the tests prove each decision.')
  expect(seen.spawned[0]?.prompt).toContain('Expired session falls back to step 1')

  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test for expiry\nOPTIONAL: rename x\nVERDICT: changes'))
  expect(seen.submitted).toEqual([])
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[principal] BLOCKING: api/a.ts:4 no test for expiry')

  // The main session fixes them; its turn ending starts round 2.
  await $.turn.complete(finishTurn(undefined, 'Added the expiry test.'))
  expect(seen.spawned).toHaveLength(4)
  await $.turn.complete(finishTurn('agent-3', 'VERDICT: clean'))
  await $.turn.complete(finishTurn('agent-4', 'VERDICT: clean', 'claude-sonnet-5-5'))
  expect(seen.toasts.some(t => t.includes('TCK-143 is Done'))).toBe(true)

  const board = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews TCK-143' })
  // Opus 5.5: 20K x $4 + 4K x $20 + 100K x $0.20 + 10K x $5 per million = $0.23; Sonnet 5.5: $0.125.
  // The expected text comes from the same Intl formats the mod uses (ICU's compact casing differs between builds).
  expect(board.text).toContain(`principal          round 1  1 blocking, 1 optional  1m 35s · ${count.format(134_000)} tokens · ${usd.format(0.23)}  claude-opus-5-5`)
  expect(board.text).toContain(`security           2 runs  3m 10s · ${count.format(268_000)} tokens · ${usd.format(0.25)}`)
  expect(board.text).toContain(`All review agents  6m 20s · ${count.format(536_000)} tokens · ${usd.format(0.71)}`)
})

test('a ticket with no review skills is Done without review', async ($, on) => {
  const seen = engine(on, { lines: 10 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  const done = await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(done.text).toBe('TCK-147 moved to In review.\nNo review skills in .tick-it/skills. TCK-147 is Done without review. /tick-it:review-agents sets some up.')
  expect(seen.spawned).toEqual([])
})

test("review skills that are there but not for the ticket's size say so", async ($, on) => {
  engine(on, { lines: 10 }, true, { '.tick-it/skills/migrations/SKILL.md': SKILLS['.tick-it/skills/migrations/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  const done = await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(done.text).toContain('None of the review skills in .tick-it/skills (migrations) review a ticket of size XS. TCK-147 is Done without review.')
})

test('in a repository with no commit yet, changed lines count what it tracks and the new files', async ($, on) => {
  const seen = engine(on, { lines: 7, noCommit: true })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.processes).toContain('git diff --numstat 4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args.changedLines).toBe(7)
})

test("a reviewer Claude Code will not start says why, and one whose model it refuses runs on the session's", async ($, on) => {
  const seen = engine(on, { lines: 10, refuse: model => (model === 'claude-sonnet-5-5' ? 'model not available' : undefined) }, true, {
    '.tick-it/skills/security/SKILL.md': SKILLS['.tick-it/skills/security/SKILL.md'] ?? '',
  })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.spawned.map(a => a.model)).toEqual([undefined])
})

test('when Claude Code refuses every reviewer, the reason is kept', async ($, on) => {
  engine(on, { lines: 10, refuse: () => 'background tasks are off' }, true, { '.tick-it/skills/security/SKILL.md': SKILLS['.tick-it/skills/security/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  const done = await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(done.text).toContain('No reviewer could be started: security: background tasks are off (TCK-147)')
})

test('new files count their lines, read directly, and a ticket goes to review with them', async ($, on) => {
  const seen = engine(on, { lines: 2, untracked: { 'calc.py': 'a\nb\nc\n', 'notes.txt': 'one line, no newline' } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args.changedLines).toBe(6)
  expect(seen.processes.some(p => p.startsWith('wc') || p.startsWith('cat'))).toBe(false)
})

test('a ticket goes to review with its lines per file: tracked, renamed, binary, odd names and new', async ($, on) => {
  const seen = engine(on, {
    lines: 0,
    numstatZ: '3\t1\tapi/a.ts\0' + '2\t2\t\0docs/old/b.md\0docs/new/b.md\0' + '4\t0\t\0sub/f.ts\0f.ts\0' + '-\t-\tlogo.png\0' + '1\t1\tdocs/café.md\0',
    untracked: { 'calc.py': 'a\nb\nc\n' },
  })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  const sent = seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args
  expect(sent?.changedFiles).toEqual([
    { path: 'api/a.ts', lines: 4 },
    { path: 'docs/new/b.md', lines: 4 },
    { path: 'f.ts', lines: 4 },
    { path: 'calc.py', lines: 3 },
    { path: 'docs/café.md', lines: 2 },
    { path: 'logo.png', lines: 0 },
  ])
  // changedLines is still counted from the plain numstat and the new files.
  expect(sent?.changedLines).toBe(3)
  expect(seen.processes).toContain(`git diff --numstat -z ${'ab12'.repeat(10)}`)
})

test('the files sent stay within what update_ticket accepts: the largest 5000, no path over 500 characters', async ($, on) => {
  const many = Array.from({ length: 5002 }, (_, i) => `1\t0\tsrc/f${i}.ts\0`).join('')
  const seen = engine(on, { lines: 1, numstatZ: `${many}9\t0\t${'x'.repeat(501)}\0` })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  const files = seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args.changedFiles as { path: string; lines: number }[]
  expect(files).toHaveLength(5000)
  expect(files.every(f => f.path.length <= 500)).toBe(true)
})

test('a failure to collect files still moves the ticket to review, with its changed lines', async ($, on) => {
  const seen = engine(on, { lines: 9, failFiles: true })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  const done = await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(done.text).toContain('TCK-147 moved to In review.')
  const sent = seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args
  expect(sent?.changedFiles).toBeUndefined()
  expect(sent?.changedLines).toBe(9)
})

test('review skills still in .tickit/skills, where they were before, are found', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tickit/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-147, round 1'])
})
