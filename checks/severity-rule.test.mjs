import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
const DIR = new URL('../skills/review-agents/bases/', import.meta.url)
const RULE = 'Severity is decided once, when you first raise a finding: BLOCKING if it would block at any later round, OPTIONAL otherwise. A finding you raised as OPTIONAL, or said was not required, is not raised as BLOCKING later unless the code or text it names changed since, or a criterion was added that requires it; the finding then says which.'

test('every base carries the one shared severity paragraph, word for word', () => {
  const names = readdirSync(DIR).sort()
  assert.deepEqual(names, ['acceptance', 'principal', 'security', 'tests', 'ux-evidence'])
  for (const name of names) {
    const lines = readFileSync(new URL(`${name}/SKILL.md`, DIR), 'utf8').split('\n')
    assert.equal(lines.filter(l => l === `- ${RULE}`).length, 1, name)
  }
})

test('the review-agents skill tells a repository to keep the rule in its fitted copies', () => {
  const skill = readFileSync(new URL('../skills/review-agents/SKILL.md', import.meta.url), 'utf8')
  assert.ok(skill.includes('The severity rule'))
  assert.ok(skill.includes('copy that bullet in word for word'))
})
