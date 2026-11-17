import { expect, test } from 'claude-code/testing'

import { globMatches, parseSkill } from '../hooks/register'
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

test('globs read as Tick-it reads them: any depth unless the glob starts with /, ** without a / after it matches anything', () => {
  expect(globMatches('src/**', 'apps/web/src/a.ts')).toBe(true)
  expect(globMatches('/src/**', 'apps/web/src/a.ts')).toBe(false)
  expect(globMatches('/src/**', 'src/a.ts')).toBe(true)
  expect(globMatches('a/**/b', 'a/b')).toBe(true)
  expect(globMatches('a/**/b', 'a/x/y/b')).toBe(true)
  expect(globMatches('a**b', 'a/x/b')).toBe(true)
  expect(globMatches('f?.ts', 'x/f1.ts')).toBe(true)
  expect(globMatches('f?.ts', 'x/f/.ts')).toBe(false)
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

test('cannot list: an untracked listing that fails runs every reviewer of the size', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'], failUntracked: true }, true, SKILLS)
  await done($)
  expect(seen.spawned).toHaveLength(3)
  expect(skipped(seen)).toHaveLength(0)
})

test('cannot list: a changed-file listing cut short runs every reviewer of the size', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'], truncateNames: true }, true, SKILLS)
  await done($)
  expect(seen.spawned).toHaveLength(3)
  expect(skipped(seen)).toHaveLength(0)
})

test('a skill with no paths runs even when no file changed, and the ones with paths are skipped', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [] }, true, SKILLS)
  await done($)
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: all on TCK-143, round 1'])
  expect(skipped(seen).map(r => r.skill).sort()).toEqual(['code', 'docs'])
})

test('the base falls back to origin/main, then origin/master, when the one before has no merge base', async ($, on) => {
  const two = { ...skill('docs', 'paths: docs/**'), ...skill('code', 'paths: hooks/*.ts') }
  const seen = engine(on, { lines: 10, changed: ['docs/a.md'], bases: ['origin/master'] }, true, two)
  await done($)
  const bases = seen.processes.filter(p => p.startsWith('git merge-base HEAD ')).map(p => p.split(' ').at(-1))
  expect(bases).toEqual(['origin/HEAD', 'origin/main', 'origin/master'])
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: docs on TCK-143, round 1'])
  expect(skipped(seen).map(r => r.skill)).toEqual(['code'])
})

test('cannot list: git diff --name-only exiting non-zero runs every reviewer of the size', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'], failNames: 'exit' }, true, SKILLS)
  await done($)
  expect(seen.spawned).toHaveLength(3)
  expect(skipped(seen)).toHaveLength(0)
})

test('cannot list: git diff --name-only throwing runs every reviewer of the size', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'], failNames: 'throw' }, true, SKILLS)
  await done($)
  expect(seen.spawned).toHaveLength(3)
  expect(skipped(seen)).toHaveLength(0)
})

test('untracked files are listed with root-relative paths when the session folder is below the root', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [], subdir: 'docs/', untracked: { 'docs/new.md': 'x' } }, true, { ...skill('docs', 'paths: docs/**'), ...skill('code', 'paths: hooks/*.ts') })
  await done($)
  expect(seen.processes.some(p => p.startsWith('git ls-files') && p.includes('--full-name'))).toBe(true)
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: docs on TCK-143, round 1'])
})

test('an untracked file at the root is listed when the session folder is below it, and a reviewer for it runs', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [], subdir: 'docs/', untracked: { 'docs/new.md': 'x', 'README.md': 'y' } }, true, { ...skill('top', 'paths: /README.md'), ...skill('code', 'paths: hooks/*.ts') })
  await done($)
  expect(seen.processes.some(p => p.startsWith('git ls-files') && p.includes(':/'))).toBe(true)
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: top on TCK-143, round 1'])
})

const front = (lines: string) => parseSkill('x', `---\nname: x\n${lines}\n---\nBody.`)

test('paths and sizes are read from an inline list, quoted or not, and from a block list', () => {
  expect(front('paths: ["src/**", "apps/**"]').paths).toEqual(['src/**', 'apps/**'])
  expect(front('paths: [src/**, apps/**]').paths).toEqual(['src/**', 'apps/**'])
  expect(front('paths:\n  - src/**\n  - "apps/**"\nname: y').paths).toEqual(['src/**', 'apps/**'])
  expect(front('sizes: "S, M"').sizes).toEqual(['S', 'M'])
  expect(front('paths: "src/**, docs/**"').paths).toEqual(['src/**', 'docs/**'])
  expect(front('paths: src/**/*.{ts, tsx}').paths).toEqual(['src/**/*.ts', 'src/**/*.tsx'])
  expect(front('sizes: [XS, S]').sizes).toEqual(['XS', 'S'])
  expect(front('sizes:\n  - XS\n  - s').sizes).toEqual(['XS', 'S'])
  expect(front('changes: [authentication, "src/**"]').changes).toEqual({ areas: ['authentication'], globs: ['src/**'] })
})

test('a brace group is written out as one glob per alternative, and a round runs that reviewer for src/a.tsx', async ($, on) => {
  expect(front('paths: src/**/*.{ts,tsx}').paths).toEqual(['src/**/*.ts', 'src/**/*.tsx'])
  expect(front('paths: [src/{a,b}/*.{ts,tsx}, docs/**]').paths).toEqual(['src/a/*.ts', 'src/a/*.tsx', 'src/b/*.ts', 'src/b/*.tsx', 'docs/**'])
  const seen = engine(on, { lines: 10, changed: ['src/a.tsx'] }, true, { ...skill('web', 'paths: src/**/*.{ts,tsx}'), ...skill('docs', 'paths: docs/**') })
  await done($)
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: web on TCK-143, round 1'])
})

test('a glob with a bracket, a brace left open, a quote or a leading ! is left out and listed as unknown', () => {
  const parsed = front('paths: [src/**, "a[1]/*", "!docs/**", b"c]')
  expect(parsed.paths).toEqual(['src/**'])
  expect(parsed.unknownPaths).toEqual(['a[1]/*', '!docs/**', 'b"c'])
  expect(front('paths: src/{ts, lib/**').unknownPaths).toEqual(['src/{ts'])
  expect(front('paths: src/**').unknownPaths).toBeUndefined()
})

test('the round names each skill with unusable paths and the entries', async ($, on) => {
  engine(on, { lines: 10, changed: ['src/a.ts'] }, true, { ...skill('web', 'paths: src/**, !docs/**'), ...skill('api', 'paths: a[1]') })
  const said = await done($)
  expect(said.text).toContain('web lists !docs/** in paths, which can match no path (no bracket, brace, quote or leading ! in a glob), so they are left out.')
  expect(said.text).toContain('api lists a[1] in paths, which can match no path (no bracket, brace, quote or leading ! in a glob), so it runs on every path.')
})

test('a skill whose every path is unusable runs on any changed file and is not skipped', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: ['apps/x.css'] }, true, skill('odd', 'paths: ["a[1]", "!b"]'))
  await done($)
  expect(seen.spawned.map(s => s.description)).toEqual(['tick-it review: odd on TCK-143, round 1'])
  expect(skipped(seen)).toHaveLength(0)
})
