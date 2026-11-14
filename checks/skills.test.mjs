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
  for (const words of ['`get_epic`', '`list_repositories`', "organisation's repositories", 'docs/other-repositories.md', 'do not repeat its steps', 'cannot be got is named to the person before any plan is shown', 'stop and ask before step 7', 'the suggested move of the epic up to the organisation', 'nothing is guessed about its code']) expect(skill).toContain(words, `plan-epic no longer says "${words}"`)
})

test('draft-ticket names a repository it cannot get before the draft and guesses nothing', () => {
  const skill = read('skills/draft-ticket/SKILL.md')
  for (const words of ['docs/other-repositories.md', 'cannot be got is named to the person before the draft is shown', 'nothing is guessed about its code', 'follow it, do not repeat its steps']) expect(skill).toContain(words, `draft-ticket no longer says "${words}"`)
})

test('plan-epic and draft-ticket read only a repository epic’s repository unless the change reaches another, and propose without creating', () => {
  for (const name of ['plan-epic', 'draft-ticket']) {
    const skill = read(`skills/${name}/SKILL.md`)
    for (const words of ['repository, unless the', 'reaches another', 'moving the epic up to the organisation', 'without creating them']) expect(skill).toContain(words, `${name} no longer says "${words}"`)
  }
})

test('plan-epic, revise-plan and draft-ticket name each ticket’s repository', () => {
  const planEpic = read('skills/plan-epic/SKILL.md')
  for (const words of ['`plan_epic` takes one `repository` per call', '`create_ticket` (each with its `repository`)', "pass only this repository's tickets"]) expect(planEpic).toContain(words, `plan-epic no longer says "${words}"`)
  expect(read('skills/revise-plan/SKILL.md')).toContain("Name each new ticket's `repository` in `create_ticket`")
  expect(read('skills/revise-plan/SKILL.md')).toContain('get one you do not have by `docs/other-repositories.md`')
  expect(read('skills/draft-ticket/SKILL.md')).toContain('each with its `repository`')
})

test('plan-epic and draft-ticket keep another repository’s tickets out of the creating calls and show them apart', () => {
  const planEpic = read('skills/plan-epic/SKILL.md')
  for (const words of ['make no ticket for a repository whose code you did not read', 'one call per repository under the same title', 'a ticket cannot wait with `after` on a ticket of another call', 'the proposed tickets of another repository']) expect(planEpic).toContain(words, `plan-epic no longer says "${words}"`)
  const draft = read('skills/draft-ticket/SKILL.md')
  for (const words of ['the proposed tickets of another repository with the move of the epic, shown apart', 'nor, for a repository epic, one in another repository before the epic has been moved up to the organisation']) expect(draft).toContain(words, `draft-ticket no longer says "${words}"`)
  for (const words of ['Once one call has succeeded, keep the title', 'stop and report which repositories have tickets and which do not', 'and do not retitle']) expect(planEpic).toContain(words, `plan-epic no longer says "${words}"`)
  const readme = read('README.md')
  for (const words of ['one call per repository', 'each ticket is created with its repository', 'a new ticket from a split names its repository', 'a repository it cannot get is named before the draft is shown']) expect(readme).toContain(words, `README no longer says "${words}"`)
})

test('the README’s skill section describes reading other repositories', () => {
  const readme = read('README.md')
  for (const words of ['every repository the epic covers', 'docs/other-repositories.md', 'names one repository']) expect(readme).toContain(words, `README no longer says "${words}"`)
})

test('draft-ticket, plan-epic and review-agents tell the person when the legacy merge-checks file is still there, without repeating the upgrade steps', () => {
  for (const name of ['draft-ticket', 'plan-epic', 'review-agents']) {
    const skill = read(`skills/${name}/SKILL.md`)
    for (const words of ['`.tick-it/merge-checks.json` exists', 'no longer read', '`docs/config.md#upgrade` in tinkerbench-studio/tick-it']) expect(skill).toContain(words, `${name} no longer says "${words}"`)
    assert.equal(skill.split('merge-checks.json').length - 1, 1, `${name} should name the legacy file once`)
    assert.ok(!skill.includes('mergeChecks'), `${name} repeats the upgrade steps`)
  }
})

test('draft-ticket and import-github make a new epic first with create_epic and pass epicId, never an epic title or owner', () => {
  const draft = read('skills/draft-ticket/SKILL.md')
  for (const words of ['`create_epic`', '`epicId`', 'the owner goes there', 'never a new epic title or an owner', '`create_ticket` never makes an epic and takes no `owner`']) expect(draft).toContain(words, `draft-ticket no longer says "${words}"`)
  const imp = read('skills/import-github/SKILL.md')
  for (const words of ['`create_epic`', '`epicId`', '`import_tickets` never makes one']) expect(imp).toContain(words, `import-github no longer says "${words}"`)
  for (const skill of [draft, imp]) assert.ok(!/create_ticket[^.]*(makes|creates) the epic/.test(skill) && !skill.includes('epic named in'), 'a skill tells a tool to make the epic')
})
