import { expect, test } from 'claude-code/testing'

import { parseSkill, reviewPrompt, withBase } from '../hooks/register'
import { RUN, engine, start } from './helpers'

const BASE = 'skills/review-agents/bases/principal/SKILL.md'
const OWN = '.tick-it/skills/principal/SKILL.md'
const base = '---\nname: principal\ndescription: A second principal engineer\nmodel: claude-opus-5-5\nsizes: S, M, L\n---\nBLOCKING: a bug.'
const own = '---\nname: principal\nbase: principal\n---\nBLOCKING: hooks live in hooks/.'

const done = async ($: Parameters<typeof start>[0], ticket: string) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: `take ${ticket}` })
  return $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
}

test('a skill that names a base is reviewed with the base first and its own rules after, on the base’s model', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { [OWN]: own, [BASE]: base })
  const said = await done($, 'TCK-149')
  expect(seen.spawned).toHaveLength(1)
  const prompt = seen.spawned[0]?.prompt ?? ''
  expect(prompt).toContain('adds this repository\'s rules to tick-it\'s "principal" base')
  expect(prompt.indexOf('BLOCKING: a bug.')).toBeGreaterThan(-1)
  expect(prompt.indexOf('BLOCKING: hooks live in hooks/.')).toBeGreaterThan(prompt.indexOf('BLOCKING: a bug.'))
  expect(prompt).toContain('where the two differ these are the ones to follow')
  expect(seen.spawned[0]?.model).toBe('claude-opus-5-5')
  expect(said.text).not.toContain('no such base')
})

test('the sizes a skill leaves out are its base’s: an XS ticket is not reviewed by a base of S and up', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { [OWN]: own, [BASE]: base })
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(0)
  expect(said.text).toContain('review a ticket of size XS')
})

test('a base the plugin does not have leaves the skill to its own rules, and the round says so', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { [OWN]: own.replace('base: principal', 'base: nonesuch') })
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.prompt).toContain('Follow this review skill (.tick-it/skills/principal):\nBLOCKING: hooks live in hooks/.')
  expect(seen.spawned[0]?.prompt).not.toContain('base')
  expect(said.text).toContain('principal (base "nonesuch") reviews by the repository\'s own rules alone')
})

test('a base name that is not a folder name is never read as a path', async ($, on) => {
  // Unchecked, this name would resolve to a file that is there (the fake file system finds the repository's own skill from .tick-it on) and be read as the base.
  const seen = engine(on, { lines: 10 }, true, { [OWN]: own.replace('base: principal', 'base: ../../../.tick-it/skills/principal'), [BASE]: base })
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.prompt).not.toContain('BLOCKING: a bug.')
  expect(seen.spawned[0]?.prompt).toContain('Follow this review skill (.tick-it/skills/principal):\nBLOCKING: hooks live in hooks/.')
  expect(seen.spawned[0]?.prompt).not.toContain('The base:')
  expect(said.text).toContain('reviews by the repository\'s own rules alone')
})

test('a skill with no base is prompted as before', () => {
  const skill = parseSkill('security', '---\nname: security\n---\nLook for injection.')
  expect(skill.base).toBeUndefined()
  const prompt = reviewPrompt({ id: 'TCK-1', title: 't', epic: 'e', acceptance: [] } as never, skill, 1)
  expect(prompt).toContain('Follow this review skill (.tick-it/skills/security):\nLook for injection.')
})

test('a skill keeps the description, model and sizes it sets, and its own name and paths', () => {
  const merged = withBase(parseSkill('principal', '---\nname: mine\ndescription: Ours\nmodel: claude-sonnet-5-5\nsizes: L\npaths: hooks/**\nbase: principal\n---\nOwn.'), { ...parseSkill('principal', base), paths: ['docs/**'] })
  expect(merged).toMatchObject({ name: 'mine', description: 'Ours', model: 'claude-sonnet-5-5', sizes: ['L'], paths: ['hooks/**'], body: 'Own.', baseBody: 'BLOCKING: a bug.' })
  const bare = withBase(parseSkill('principal', own), parseSkill('principal', base))
  expect(bare).toMatchObject({ name: 'principal', description: 'A second principal engineer', model: 'claude-opus-5-5', sizes: ['S', 'M', 'L'] })
  expect(bare.paths).toBeUndefined()
})

test('the reviewer prompt names the ticket’s size', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { [OWN]: own.replace('base: principal', 'base: nonesuch') })
  await done($, 'TCK-143')
  expect(seen.spawned[0]?.prompt).toContain('Ticket size: XS.')
})

const ticket = { id: 'TCK-1', title: 't', epic: 'e', acceptance: [] } as never
const skill = { name: 'principal', body: 'Look.' } as never

test('reviewPrompt points the reviewer at the diff against the named base, not git diff HEAD', () => {
  const prompt = reviewPrompt(ticket, skill, 1, [], undefined, undefined, 'origin/main')
  expect(prompt).toContain('git diff $(git merge-base origin/main HEAD)')
  expect(prompt).toContain('against its base branch origin/main')
  expect(prompt).not.toContain('against HEAD')
  expect(prompt).not.toContain('git diff HEAD')
})

test('with no base branch found the prompt keeps the working-tree wording', () => {
  expect(reviewPrompt(ticket, skill, 1)).toContain('Review the change in the working tree against HEAD (git diff HEAD and the untracked files)')
})

test('a round on committed work with a clean working tree tells the reviewer to read the base diff', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [], bases: ['origin/main'] }, true, { [OWN]: own.replace('base: principal\n', ''), [BASE]: base })
  await done($, 'TCK-143')
  const prompt = seen.spawned[0]?.prompt ?? ''
  expect(prompt).toContain('git diff $(git merge-base origin/main HEAD)')
  expect(prompt).not.toContain('git diff HEAD')
})
