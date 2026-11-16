import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
  for (const words of ['`epicId`', '`create_epic`', 'never a new epic title or an owner']) expect(draft).toContain(words, `draft-ticket no longer says "${words}"`)
  for (const name of ['plan-epic', 'retro', 'revise-plan', 'draft-ticket']) {
    const text = read(`skills/${name}/SKILL.md`)
    assert.ok(!/retroFinding: \{ epic:|`milestone` in place of `epic`|with that title|`list_attachments` with that title|with the `id` of each epic/.test(text), `${name} still passes a title`)
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

test('the README says plan-epic takes a design ticket\u2019s checks from the design.workflow doc', () => {
  const readme = read('README.md')
  for (const words of ['`design.uiPaths` takes the design ticket\'s checks from the `design.workflow` doc', 'both read from `get_repository_settings`', 'reads as a doc and never runs', 'a repository with no `design` section gets the default design ticket']) expect(readme).toContain(words, `README no longer says "${words}"`)
})

test('the README’s skill section describes reading other repositories', () => {
  const readme = read('README.md')
  for (const words of ['every repository the epic covers', 'docs/other-repositories.md', 'names one repository']) expect(readme).toContain(words, `README no longer says "${words}"`)
})

test('draft-ticket, plan-epic and review-agents tell the person when the legacy merge-checks file is still there: still read for compatibility, config.json preferred', () => {
  for (const name of ['draft-ticket', 'plan-epic', 'review-agents']) {
    const skill = read(`skills/${name}/SKILL.md`)
    for (const words of ['`.tick-it/merge-checks.json` exists', 'still reads it for compatibility', '`.tick-it/config.json` with `{ "mergeChecks": [...] }` is the preferred file', '`docs/config.md#upgrade` in tinkerbench-studio/tick-it']) expect(skill).toContain(words, `${name} no longer says "${words}"`)
    assert.equal(skill.split('merge-checks.json').length - 1, 1, `${name} should name the legacy file once`)
    assert.ok(!skill.includes('no longer read'), `${name} says the legacy file is no longer read`)
    assert.ok(!/ignored/.test(skill.split('merge-checks.json')[1].slice(0, 300)), `${name} says the legacy file is ignored`)
  }
})

test('draft-ticket and import-github make a new epic first with create_epic and pass epicId, never an epic title or owner', () => {
  const draft = read('skills/draft-ticket/SKILL.md')
  for (const words of ['`create_epic`', '`epicId`', 'the owner goes there', 'never a new epic title or an owner', '`create_ticket` never makes an epic and takes no `owner`', 'Create it only after they agree.** For a new epic, make it first with `create_epic`']) expect(draft).toContain(words, `draft-ticket no longer says "${words}"`)
  const imp = read('skills/import-github/SKILL.md')
  for (const words of ['`create_epic`', '`epicId`', 'First make each new epic with `create_epic`', '`import_tickets` never makes an epic and takes no `owner`', 'never an epic title']) expect(imp).toContain(words, `import-github no longer says "${words}"`)
  for (const skill of [draft, imp]) assert.ok(!/create_ticket[^.]*(makes|creates) (the|an?|a new) epic/.test(skill.replace(/never makes an epic/g, '')), 'a skill tells a tool to make the epic')
})

const ROLES = ['acceptance', 'principal', 'security', 'tests', 'ux-evidence']
const frontMatter = text => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''

test('the plugin ships a base review skill for each role, with nothing left to fill in and nothing of one repository', () => {
  for (const role of ROLES) {
    const base = read(`skills/review-agents/bases/${role}/SKILL.md`)
    assert.match(frontMatter(base), new RegExp(`^name: ${role}$`, 'm'), `${role} base has no name`)
    assert.match(frontMatter(base), /^description: \S/m, `${role} base has no description`)
    assert.match(frontMatter(base), /^model: claude-/m, `${role} base has no model`)
    assert.ok(!/^base:/m.test(frontMatter(base)), `${role} base names a base of its own`)
    assert.ok(base.includes('BLOCKING:'), `${role} base has no blocking rule`)
    // A bracketed placeholder is a rule for a repository to fill in: that belongs in the sample. ![](…) is the one bracket a base may hold.
    assert.deepEqual(base.replaceAll('![](…)', '').match(/\[[^\]]*\]/g) ?? [], [], `${role} base has a placeholder`)
    // What only one repository has: its folders, its commands, its tools.
    for (const own of ['hooks/', 'apps/', 'tests/', 'checks/', 'README.md', 'npm ', 'pytest', 'Storybook', 'origin/main', '/tick-it', 'tinkerbench', 'nookivia']) assert.ok(!base.includes(own), `${role} base names "${own}", which is particular to a repository`)
  }
})

test('each sample names its base, keeps only the repository’s own rules and leaves the rest of the front matter to the base', () => {
  for (const role of ROLES) {
    const sample = read(`skills/review-agents/samples/${role}/SKILL.md`)
    assert.equal(frontMatter(sample), `name: ${role}\nbase: ${role}`, `${role} sample's front matter`)
    assert.ok(existsSync(new URL(`../skills/review-agents/bases/${role}/SKILL.md`, import.meta.url)), `${role} sample names a base that is not shipped`)
    assert.ok(/\[[^\]]+\]/.test(sample), `${role} sample has nothing to fit to the repository`)
    const base = read(`skills/review-agents/bases/${role}/SKILL.md`)
    for (const line of sample.split('\n').filter(line => line.startsWith('- BLOCKING:'))) assert.ok(!base.includes(line), `${role} sample repeats its base: ${line}`)
  }
})

test('review-agents and the README explain how a repository’s skill adds its rules to a base', () => {
  const skill = read('skills/review-agents/SKILL.md')
  for (const words of ['`bases/<name>/SKILL.md` beside this file', 'names with `base` in its front matter', 'Read the base first', "Keep the front matter's `name` and `base`", 'come from the base']) expect(skill).toContain(words, `review-agents no longer says "${words}"`)
  const readme = read('README.md')
  for (const words of ['### Base review skills', '`skills/review-agents/bases/<name>/SKILL.md`', 'base: principal', 'the base first and the repository\'s rules after it', 'The `description`, `model` and `sizes` a skill leaves out are its base\'s', 'reviews by its own rules alone', 'A session without the mod']) expect(readme).toContain(words, `README no longer says "${words}"`)
  for (const role of ROLES) expect(readme).toContain(`\`${role}\``)
  expect(read('hooks/state.ts')).toContain("BASES_DIR = 'skills/review-agents/bases'")
})

test('this repository has no marketplace of its own, and the README installs only from tinkerbench-studio', () => {
  assert.equal(existsSync(new URL('../.claude-plugin/marketplace.json', import.meta.url)), false, 'the tinkerbench-studio marketplace is the only one')
  const readme = read('README.md')
  for (const words of ['### VibeSec-Skill', '`vibesec`', 'BehiSecc/VibeSec-Skill', '/plugin marketplace add tinkerbench-studio/marketplace', '/plugin install vibesec@tinkerbench-studio', 'no copy of it is kept here', 'set `sha` of the `vibesec` entry']) expect(readme).toContain(words, `README no longer says "${words}"`)
  for (const words of ['/plugin marketplace add tinkerbench-studio/marketplace', '/plugin install tick-it@tinkerbench-studio', '/plugin update tick-it@tinkerbench-studio', 'claude plugin marketplace add tinkerbench-studio/marketplace', 'claude plugin marketplace update tinkerbench-studio', 'claude plugin install tick-it@tinkerbench-studio', 'claude plugin update tick-it@tinkerbench-studio']) expect(readme).toContain(words, `README no longer says "${words}"`)
  for (const old of ['@tickit', 'marketplace add tinkerbench-studio/tick-it-claude-mod', 'marketplace update tickit']) assert.ok(!readme.includes(old), `README still says "${old}"`)
})

const AREAS = ['authentication', 'access-control', 'database', 'infrastructure', 'secrets', 'input', 'web', 'dependencies', 'agents', 'personal-data']

test('the plugin ships a secure-coding skill for each security area, for the writer and the reviewer, with nothing of one repository', () => {
  const areas = read('hooks/security-areas.ts')
  assert.deepEqual([...areas.matchAll(/^    name: '([a-z-]+)',$/gm)].map(m => m[1]), AREAS, 'the areas of hooks/security-areas.ts and their skills differ')
  for (const area of AREAS) {
    const skill = read(`skills/secure-${area}/SKILL.md`)
    assert.match(frontMatter(skill), new RegExp(`^name: secure-${area}$`, 'm'), `secure-${area} has no name`)
    assert.match(frontMatter(skill), /^description: Secure-coding practices for .+ Use before .+ when reviewing/m, `secure-${area}'s description does not say when to use it`)
    // The reviewer reads a broken "Must" as blocking and a "Should" as optional: each skill has both, and says so.
    for (const words of ['## Before you', '## Must', '## Should', '## Check before review', 'the security reviewer checks a change in this area against the same rules', 'A "Must" that the change breaks is a blocking finding']) expect(skill).toContain(words, `secure-${area} no longer says "${words}"`)
    assert.ok(skill.split('\n').filter(line => line.startsWith('- **')).length >= 8, `secure-${area} has fewer than eight Must rules`)
    for (const own of ['hooks/', 'apps/', 'checks/', 'npm run', '/tick-it', 'tinkerbench', 'nookivia', 'Tick-it']) assert.ok(!skill.includes(own), `secure-${area} names "${own}", which is particular to a repository`)
    // A skill it points to is one the plugin ships.
    for (const [, other] of skill.matchAll(/`tick-it:secure-([a-z-]+)`/g)) assert.ok(AREAS.includes(other), `secure-${area} points to tick-it:secure-${other}, which is not shipped`)
  }
})

test('the security base runs for what a change touches as well as for its size, and the docs say how', () => {
  const base = read('skills/review-agents/bases/security/SKILL.md')
  assert.match(frontMatter(base), /^sizes: M, L$/m)
  assert.match(frontMatter(base), /^changes: all$/m, 'the security base no longer runs for every security area')
  expect(base).toContain('on one of any size whose change touches a security area')
  // No other base runs outside its sizes.
  for (const role of ROLES.filter(role => role !== 'security')) assert.ok(!/^changes:/m.test(frontMatter(read(`skills/review-agents/bases/${role}/SKILL.md`))), `${role} base lists changes`)
  const own = read('.tick-it/skills/security/SKILL.md')
  assert.match(frontMatter(own), /^changes: [a-z-]+(, [a-z-]+)*$/m, 'this repository\'s security skill lists no changes')
  for (const area of /^changes: (.*)$/m.exec(frontMatter(own))[1].split(', ')) assert.ok(AREAS.includes(area), `this repository's security skill lists "${area}", which is no area`)
  const skill = read('skills/review-agents/SKILL.md')
  for (const words of ['a ticket of any size whose change touches a security area', 'The `changes` of the `security` base is `all`', '`changes: none` for size alone']) expect(skill).toContain(words, `review-agents no longer says "${words}"`)
  const readme = read('README.md')
  for (const words of ['### Security areas', '### Secure-coding skills', '`changes: none` turns it off', 'security runs for what the change touches', 'and not its `changes`', 'once per area for a ticket']) expect(readme).toContain(words, `README no longer says "${words}"`)
  for (const area of AREAS) expect(readme).toContain(`| \`${area}\` |`)
  for (const area of AREAS) expect(readme).toContain(`\`tick-it:secure-${area}\``)
})

test('every skill that writes ticket text names another repository’s ticket as owner/name#KEY and its pull request as owner/name#n', () => {
  for (const name of ['draft-ticket', 'import-github', 'plan-epic', 'periodic-retro', 'retro', 'revise-plan', 'review-agents']) {
    const skill = read(`skills/${name}/SKILL.md`)
    for (const words of ["name another repository's ticket as `owner/name#KEY` and its pull request as `owner/name#n`", 'never a bare key or `#n`', 'a bare one always means this repository']) expect(skill).toContain(words, `${name} no longer says "${words}"`)
  }
})

test('README and the plan-epic skill describe the date hold: marker, refusal and clearing itself', () => {
  const readme = read('README.md')
  for (const words of ['is refused with that date', 'with `Waiting until <date>` under the title of a ticket whose `notBefore` hold is still in the future', 'a held Backlog or Ready ticket is refused with its date, as `/tick-it take` refuses it', 'every 15 minutes', 'clears a hold itself once its date passes', 'the release rule allows it (no open blocker or question, autoReady on, its epic in a prioritised milestone, an approved plan, no need)', 'otherwise leaving it in the Backlog']) expect(readme).toContain(words, `README no longer says "${words}"`)
  expect(read('skills/plan-epic/SKILL.md')).toContain('`notBefore` date', 'plan-epic skill no longer mentions the date hold')
})
