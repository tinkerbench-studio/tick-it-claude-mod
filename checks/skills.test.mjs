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
  expect(retro).toContain('retroFinding: { epicId:')
  expect(retro).toContain('create_ticket')
})

test('retro skill for a milestone compares the priority order, Ready waits and repeated fixes, and changes nothing', () => {
  const retro = read('skills/retro/SKILL.md')
  for (const words of ["A milestone's retrospective", '`get_retrospective` with `milestoneId`', 'priority order', 'waited Ready', 'repeat', 'changes no code or tickets']) expect(retro).toContain(words)
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

test('skills pass epic and milestone ids, never titles, for an existing epic or milestone', () => {
  const plan = read('skills/plan-epic/SKILL.md')
  for (const words of ['`milestoneId`', '`list_attachments` with `epicId`', '`epicId` from step 1', 'never its title']) expect(plan).toContain(words, `plan-epic no longer says "${words}"`)
  const retro = read('skills/retro/SKILL.md')
  for (const words of ['`epicId`', '`milestoneId`', 'retroFinding: { epicId:', 'Find the id once']) expect(retro).toContain(words, `retro no longer says "${words}"`)
  const revise = read('skills/revise-plan/SKILL.md')
  for (const words of ['<epic title or id>', 'Find the epic\'s id once', '`list_tickets`, `list_comments`, `get_epic`, `resolve_comment` and `create_ticket` all take `epicId`']) expect(revise).toContain(words, `revise-plan no longer says "${words}"`)
  const draft = read('skills/draft-ticket/SKILL.md')
  for (const words of ['`epicId`', 'a new epic by its title as `epic`']) expect(draft).toContain(words, `draft-ticket no longer says "${words}"`)
  for (const name of ['plan-epic', 'retro', 'revise-plan', 'draft-ticket']) {
    const text = read(`skills/${name}/SKILL.md`)
    assert.ok(!/retroFinding: \{ epic:|`milestone` in place of `epic`|with that title|`list_attachments` with that title/.test(text), `${name} still passes a title`)
  }
})
