import { expect, test } from 'claude-code/testing'

import { globMatches } from '../hooks/register'
import { RUN, engine, start, reports } from './helpers'

const skill = (name: string, front: string) => ({ [`.tick-it/skills/${name}/SKILL.md`]: `---\nname: ${name}\n${front}\n---\nReview.` })
const SKILLS = { ...skill('docs', 'paths: docs/**, README.md'), ...skill('code', 'paths: hooks/*.ts'), ...skill('all', '') }

const done = async ($: Parameters<typeof start>[0]) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  return $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
}
const skipped = (seen: ReturnType<typeof engine>) => seen.recorded.flatMap(r => r.args.runs).filter(r => r.notApplicable !== undefined)

test('globs: ** crosses folders, * stays in one, a glob with no slash matches the name anywhere', () => {
  expect(globMatches('docs/**', 'docs/a/b.md')).toBe(true)
  expect(globMatches('hooks/*.ts', 'hooks/a/b.ts')).toBe(false)
  expect(globMatches('README.md', 'apps/x/README.md')).toBe(true)
  expect(globMatches('docs/**', 'src/docs.md')).toBe(false)
})

test('match: a reviewer runs when a changed file matches its paths, one that matches none is skipped with the reason', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['hooks/a.ts'] }, true, SKILLS)
  await done($)
  expect(seen.spawned.map(s => s.description).sort()).toEqual(['tick-it review: all on TCK-143, round 1', 'tick-it review: code on TCK-143, round 1'])
  expect(skipped(seen)).toMatchObject([{ skill: 'docs', round: 1, durationMs: 0, notApplicable: expect.stringContaining('No changed file matches its paths') }])
})

test('no match: with no changed file matching, the skipped reviewers are recorded and only the pathless one runs', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'] }, true, SKILLS)
  await done($)
  expect(seen.spawned).toHaveLength(1)
  expect(skipped(seen).map(r => r.skill).sort()).toEqual(['code', 'docs'])
})

test('none apply: the ticket moves to Done with a reason', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'] }, true, { ...skill('docs', 'paths: docs/**'), ...skill('code', 'paths: hooks/*.ts') })
  await done($)
  expect(seen.spawned).toHaveLength(0)
  expect(skipped(seen)).toHaveLength(2)
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'Done')?.args.reason).toContain('no changed file matches the paths')
  expect(reports(seen).some(r => r.status === 'done')).toBe(true)
})

test('cannot list: every reviewer that matches the size runs and none is skipped', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: null }, true, SKILLS)
  await done($)
  expect(seen.spawned).toHaveLength(3)
  expect(skipped(seen)).toHaveLength(0)
})

test('uncommitted and untracked files count as changed', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [], untracked: { 'docs/new.md': 'x' } }, true, { ...skill('docs', 'paths: docs/**'), ...skill('code', 'paths: hooks/*.ts') })
  await done($)
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: docs on TCK-143, round 1'])
  expect(skipped(seen).map(r => r.skill)).toEqual(['code'])
})
