import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const expect = text => ({ toContain: (words, why) => assert.ok(text.includes(words), why ?? `expected to contain "${words}"`) })

// Run with: node --test checks/*.test.mjs
// The wording below tells Claude to use server features (labels, attachments, retro tools). The server's tests cover the features; these keep the skills telling Claude to use them.

test('retro skill reads the required fixes and looks for repeated kinds of fix', () => {
  const retro = read('skills/retro/SKILL.md')
  expect(retro).toContain('required fixes')
  expect(retro).toContain('repeated kinds of fix')
})

test('retro skill passes the finding to create_ticket when turning a suggestion into a ticket', () => {
  const retro = read('skills/retro/SKILL.md')
  expect(retro).toContain('retroFinding: { epic:')
  expect(retro).toContain('create_ticket')
})

test('retro skill for a milestone compares the priority order, Ready waits and repeated fixes, and changes nothing', () => {
  const retro = read('skills/retro/SKILL.md')
  for (const words of ["A milestone's retrospective", '`get_retrospective` with `milestone`', 'priority order', 'waited Ready', 'repeat', 'changes no code or tickets']) expect(retro).toContain(words)
  for (const tool of ['get_retrospective', 'list_milestones', 'get_ticket_timeline', 'record_retrospective', 'remember']) expect(retro).toContain(`\`${tool}\``)
})

test('plan-epic has Claude reuse the repository’s labels and pass labels to plan_epic', () => {
  const skill = read('skills/plan-epic/SKILL.md')
  for (const words of ['Propose labels', '`list_tickets`', 'reuse the labels', 'every ticket with its `labels`']) expect(skill).toContain(words, `plan-epic no longer says "${words}"`)
})

test('plan-epic has Claude read an epic’s images, link them to the tickets that use them and not invent files', () => {
  const skill = read('skills/plan-epic/SKILL.md')
  for (const words of ['`list_attachments`', '`get_attachment`', '`link_attachment`', 'used by those tickets', 'never invent a file', 'cannot be read here', 'No epic', 'do not describe its contents']) expect(skill).toContain(words, `plan-epic no longer says "${words}"`)
})

test('draft-ticket and plan-epic point to the breakdown rules and the UI-evidence checklist', () => {
  for (const name of ['draft-ticket', 'plan-epic']) {
    const skill = read(`skills/${name}/SKILL.md`)
    expect(skill).toContain('docs/ticket-breakdown.md')
    expect(skill).toContain('UI-evidence checklist')
  }
})

test('plan-epic reads every repository the epic covers by docs/other-repositories.md and names the unreachable ones first', () => {
  const skill = read('skills/plan-epic/SKILL.md')
  for (const words of ['`get_epic`', "organisation's repositories", 'docs/other-repositories.md', 'do not repeat its steps', 'cannot be got is named to the person before any plan is shown', 'nothing is guessed about its code']) expect(skill).toContain(words, `plan-epic no longer says "${words}"`)
})

test('draft-ticket names a repository it cannot get before the draft and guesses nothing', () => {
  const skill = read('skills/draft-ticket/SKILL.md')
  for (const words of ['docs/other-repositories.md', 'cannot be got is named to the person before the draft is shown', 'nothing is guessed about its code']) expect(skill).toContain(words, `draft-ticket no longer says "${words}"`)
})

test('plan-epic and draft-ticket read only a repository epic’s repository unless the change reaches another, and propose without creating', () => {
  for (const name of ['plan-epic', 'draft-ticket']) {
    const skill = read(`skills/${name}/SKILL.md`)
    for (const words of ['only this', 'unless the', 'moving the epic up to the organisation', 'without creating them']) expect(skill).toContain(words, `${name} no longer says "${words}"`)
  }
})

test('plan-epic, revise-plan and draft-ticket name each ticket’s repository', () => {
  expect(read('skills/plan-epic/SKILL.md')).toContain('its `repository`')
  for (const name of ['revise-plan', 'draft-ticket']) expect(read(`skills/${name}/SKILL.md`)).toContain('`repository`')
  expect(read('skills/revise-plan/SKILL.md')).toContain('`create_ticket`')
})

test('the README’s skill section describes reading other repositories', () => {
  const readme = read('README.md')
  for (const words of ['every repository the epic covers', 'docs/other-repositories.md', 'each ticket naming its repository']) expect(readme).toContain(words, `README no longer says "${words}"`)
})
