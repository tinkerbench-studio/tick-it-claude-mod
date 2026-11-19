import { readFileSync, readdirSync } from 'node:fs'
import { expect, test } from 'claude-code/testing'

const DIR = 'skills/review-agents/bases'
const RULE = 'Severity is decided once, when you first raise a finding: BLOCKING if it would block at any later round, OPTIONAL otherwise. A finding you raised as OPTIONAL, or said was not required, is not raised as BLOCKING later unless the code or text it names changed since, or a criterion was added that requires it; the finding then says which.'

test('every base carries the one shared severity paragraph, word for word', () => {
  const names = readdirSync(DIR)
  expect(names.sort()).toEqual(['acceptance', 'principal', 'security', 'tests', 'ux-evidence'])
  for (const name of names) expect(readFileSync(`${DIR}/${name}/SKILL.md`, 'utf8').split('\n').filter(l => l === `- ${RULE}`), name).toHaveLength(1)
})

test('the review-agents skill tells a repository to keep the rule in its fitted copies', () => {
  const skill = readFileSync('skills/review-agents/SKILL.md', 'utf8')
  expect(skill).toContain('The severity rule')
  expect(skill).toContain('copy that bullet in word for word')
})
