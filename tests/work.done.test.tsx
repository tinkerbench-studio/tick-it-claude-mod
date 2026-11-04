import { expect, test } from 'claude-code/testing'

import { count } from '../hooks/register'
import { RUN, SKILLS, engine, finishTurn, start } from './helpers'
import type { Net } from './helpers'

test('taking, finishing and dropping move the ticket on Tick-it first', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  expect(seen.server.find(t => t.key === 'TCK-147')).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
  // Taking another gives the first back.
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-151' })
  expect(seen.server.find(t => t.key === 'TCK-147')).toMatchObject({ status: 'Ready', assignee: null })
  const dropped = await $.command.run({ ...RUN, command: 'tick-it', args: 'drop' })
  expect(dropped.text).toBe('TCK-151 put back in Ready.')
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'Ready', assignee: null })
})

test('done sends the changed lines since the ticket was taken, counted from the commit it was taken at', async ($, on) => {
  const seen = engine(on, { lines: 612 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-151' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  const base = 'ab12'.repeat(10)
  expect(seen.processes).toContain(`git diff --numstat ${base}`)
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args).toEqual({
    repository: 'acme/web-app',
    key: 'TCK-151',
    status: 'In review',
    changedLines: 612,
    changedFiles: [{ path: 'api/a.ts', lines: 612 }],
  })
  // Dropping sends no count, and the next ticket counts from its own start.
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'drop' })
  expect(seen.ticketCalls.at(-1)?.args).toEqual({ repository: 'acme/web-app', key: 'TCK-147', status: 'Ready', assignee: null })
  expect(seen.processes.filter(p => p.startsWith('git rev-parse'))).toHaveLength(1)
})

test('done records the branch and the open pull request, and a clean round then waits for the merge', async ($, on) => {
  const seen = engine(on, { lines: 10, pr: 42 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.ticketCalls.find(c => c.tool === 'link_pull_request')?.args).toEqual({ repository: 'acme/web-app', key: 'TCK-143', branch: 'tck-151-picker', number: 42 })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(seen.toasts.at(-1)).toContain('were clean')
  expect(seen.toasts.at(-1)).toContain("TCK-143's pull request #42 is still open: it moves to Done when it merges.")
  expect(seen.toasts.at(-1)).not.toContain('try again')
  expect(seen.processes).toContain('gh pr ready 42')
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ key: 'TCK-143', kind: 'review-pull-request', note: expect.stringContaining('#42') })
})

test('a clean round with autoMerge on flags no one for the open pull request', async ($, on) => {
  const seen = engine(on, { lines: 10, pr: 42 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { autoMerge: true })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(seen.processes).toContain('gh pr ready 42')
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
})

test('a clean round flags the open pull request with autoMerge off', async ($, on) => {
  const seen = engine(on, { lines: 10, pr: 42 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { autoMerge: false })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ key: 'TCK-143', kind: 'review-pull-request', note: expect.stringContaining('#42') })
})

test('a clean round flags the open pull request when the settings cannot be read', async ($, on) => {
  const seen = engine(on, { lines: 10, pr: 42 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }, { instructions: 'unreachable' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.ticketCalls.find(c => c.tool === 'set_needs_human')?.args).toMatchObject({ key: 'TCK-143', kind: 'review-pull-request', note: expect.stringContaining('#42') })
})

test('a clean round with no open pull request marks no need', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
})

test('a link_pull_request that fails is kept and sent again on sync', async ($, on) => {
  const net: Net = { linkRefused: true }
  const seen = engine(on, { lines: 10, pr: 42 }, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  const links = () => seen.ticketCalls.filter(c => c.tool === 'link_pull_request')
  expect(links()).toHaveLength(1)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(links()).toHaveLength(2)
  net.linkRefused = false
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(links()).toHaveLength(3)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(links()).toHaveLength(3)
  expect(links()[2]?.args).toEqual({ repository: 'acme/web-app', key: 'TCK-143', branch: 'tck-151-picker', number: 42 })
})

test('a newer link for the same ticket replaces a waiting one', async ($, on) => {
  const net: Net = { linkRefused: true }
  const diff: { lines: number; pr?: number } = { lines: 10 }
  const seen = engine(on, diff, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  // The pull request is opened, and the second link fails too: it replaces the first.
  diff.pr = 42
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  net.linkRefused = false
  const links = () => seen.ticketCalls.filter(c => c.tool === 'link_pull_request')
  const before = links().length
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(
    links()
      .slice(before)
      .map(c => c.args),
  ).toEqual([{ repository: 'acme/web-app', key: 'TCK-143', branch: 'tck-151-picker', number: 42 }])
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(links()).toHaveLength(before + 1)
})

test('a link_pull_request Tick-it answers with an error is not sent again', async ($, on) => {
  const net: Net = { linkRejected: true }
  const seen = engine(on, { lines: 10, pr: 42 }, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(seen.ticketCalls.filter(c => c.tool === 'link_pull_request')).toHaveLength(1)
})

test('done without gh still records the branch', async ($, on) => {
  const seen = engine(on, { lines: 10 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.ticketCalls.find(c => c.tool === 'link_pull_request')?.args).toEqual({ repository: 'acme/web-app', key: 'TCK-143', branch: 'tck-151-picker' })
})
