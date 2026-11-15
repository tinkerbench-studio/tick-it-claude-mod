import { expect, test } from 'claude-code/testing'

import { SECURITY_AREAS, areaNudge, changesFor, parseChanges, parseSkill, patchFiles, touchedAreas, unknownChanges, withBase } from '../hooks/register'
import { RUN, engine, finishTurn, start } from './helpers'

const BASE = 'skills/review-agents/bases/security/SKILL.md'
const OWN = '.tick-it/skills/security/SKILL.md'
const AUTH = 'skills/secure-authentication/SKILL.md'
const DB = 'skills/secure-database/SKILL.md'
const base = '---\nname: security\ndescription: Security\nmodel: claude-sonnet-5-5\nsizes: M, L\nchanges: all\n---\nBLOCKING: input used unchecked.'
const own = '---\nname: security\nbase: security\n---\nBLOCKING: our own rule.'
const SKILLS = { [OWN]: own, [BASE]: base, [AUTH]: '---\nname: secure-authentication\ndescription: d\n---\n## Must\n- Passwords are hashed.', [DB]: '---\nname: secure-database\ndescription: d\n---\n## Must\n- Values are bound.' }
const patch = (path: string, ...lines: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`

const done = async ($: Parameters<typeof start>[0], ticket: string) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: `take ${ticket}` })
  return $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
}

test('an XS ticket whose change touches no area is not reviewed by a skill of M and L', async ($, on) => {
  const seen = engine(on, { lines: 10, patch: patch('api/a.ts', 'const label = "Save"') }, true, SKILLS)
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(0)
  expect(said.text).toContain('review a ticket of size XS, and its change touches nothing that runs one whatever the size')
})

test('an XS ticket that changes sign-in is reviewed by security, told what it touches and given that area’s practices', async ($, on) => {
  const seen = engine(on, { lines: 10, numstatZ: '3\t0\tapi/login.ts\0', patch: patch('api/login.ts', 'const ok = await bcrypt.compare(password, row.hash)') }, true, SKILLS)
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(1)
  const prompt = seen.spawned[0]?.prompt ?? ''
  expect(prompt).toContain('What this change touches')
  expect(prompt).toContain('authentication (api/login.ts)')
  expect(prompt).toContain("TCK-143 is size XS, outside this skill's sizes (M, L): you run because of what the change touches")
  expect(prompt).toContain('### authentication (tick-it:secure-authentication)\n## Must\n- Passwords are hashed.')
  expect(prompt).not.toContain('Values are bound.')
  // The base and the repository's own rules still come first.
  expect(prompt.indexOf('BLOCKING: input used unchecked.')).toBeLessThan(prompt.indexOf('What this change touches'))
  expect(said.text).toContain('security runs for what the change touches: authentication.')
})

test('a path alone puts a change in an area: a migration with no SQL keyword in the patch', async ($, on) => {
  const seen = engine(on, { lines: 10, numstatZ: '1\t0\tmigrations/0042_add_flag.sql\0' }, true, SKILLS)
  await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.prompt).toContain('database (migrations/0042_add_flag.sql)')
  expect(seen.spawned[0]?.prompt).toContain('Values are bound.')
})

test('an untracked file counts by its content', async ($, on) => {
  const seen = engine(on, { lines: 10, untracked: { 'api/users.ts': 'db.prepare(`SELECT id FROM users WHERE id = ?`)' } }, true, SKILLS)
  await done($, 'TCK-143')
  expect(seen.spawned[0]?.prompt).toContain('database (api/users.ts)')
})

test('changes: none on the repository’s skill leaves it to size alone, whatever the base lists', async ($, on) => {
  const seen = engine(on, { lines: 10, numstatZ: '3\t0\tapi/login.ts\0' }, true, { ...SKILLS, [OWN]: own.replace('base: security', 'base: security\nchanges: none') })
  await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(0)
})

test('a repository lists the areas that run its skill, and its own globs beside them', async ($, on) => {
  const listed = { ...SKILLS, [OWN]: own.replace('base: security', 'base: security\nchanges: database, src/billing/**') }
  const auth = engine(on, { lines: 10, numstatZ: '3\t0\tapi/login.ts\0' }, true, listed)
  await done($, 'TCK-143')
  expect(auth.spawned).toHaveLength(0)
})

test('a repository’s own glob in changes runs the skill and is named to the reviewer', async ($, on) => {
  const listed = { ...SKILLS, [OWN]: own.replace('base: security', 'base: security\nchanges: database, src/billing/**') }
  const seen = engine(on, { lines: 10, numstatZ: '3\t0\tsrc/billing/invoice.ts\0' }, true, listed)
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(1)
  expect(seen.spawned[0]?.prompt).toContain('src/billing/** (src/billing/invoice.ts)')
  expect(said.text).toContain('security runs for what the change touches: src/billing/**.')
})

test('a skill running for its size is still told what the change touches, without the note on sizes', async ($, on) => {
  const seen = engine(on, { lines: 10, numstatZ: '3\t0\tapi/login.ts\0' }, true, SKILLS)
  const sized = seen.server.find(t => t.key === 'TCK-143')
  if (sized !== undefined) sized.size = 'M'
  const said = await done($, 'TCK-143')
  const prompt = seen.spawned[0]?.prompt ?? ''
  expect(prompt).toContain('authentication (api/login.ts)')
  expect(prompt).toContain('Passwords are hashed.')
  expect(prompt).not.toContain('outside this skill')
  expect(said.text).not.toContain('runs for what the change touches')
})

test('a skill with no changes, and a base with none, runs by size as before and reads no patch', async ($, on) => {
  const seen = engine(on, { lines: 10, numstatZ: '3\t0\tapi/login.ts\0' }, true, { [OWN]: '---\nname: security\nsizes: M, L\n---\nLook for injection.' })
  await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(0)
  expect(seen.processes.some(p => p.includes('-U0'))).toBe(false)
})

test('a skill that reviewed a ticket for what it touched reviews the next round too, though the fix left the area', async ($, on) => {
  const diff = { lines: 10, numstatZ: '3\t0\tapi/login.ts\0' }
  const seen = engine(on, diff, true, SKILLS)
  await done($, 'TCK-143')
  await $.turn.complete(finishTurn(seen.spawned[0]?.agentId, 'BLOCKING: api/login.ts:3 the password is compared in plain text\nVERDICT: changes', 'claude-sonnet-5-5') as never)
  // The fix moved the code out of the file whose name put the change in the area.
  diff.numstatZ = '3\t0\tapi/a.ts\0'
  await $.turn.complete(finishTurn(undefined, 'Fixed.') as never)
  expect(seen.spawned).toHaveLength(2)
  expect(seen.spawned[1]?.prompt).toContain('the password is compared in plain text')
})

test('an entry of changes that is no area and no glob is named when the round starts', async ($, on) => {
  const seen = engine(on, { lines: 10, numstatZ: '3\t0\tapi/login.ts\0' }, true, { ...SKILLS, [OWN]: own.replace('base: security', 'base: security\nchanges: authentication, databse') })
  const said = await done($, 'TCK-143')
  expect(seen.spawned).toHaveLength(1)
  expect(said.text).toContain('security lists databse in changes, which is no area')
})

test('changes is read from the front matter: areas, all, none and globs', () => {
  expect(parseChanges(undefined)).toBeUndefined()
  expect(parseChanges('')).toBeUndefined()
  expect(parseChanges('all')?.areas).toEqual(SECURITY_AREAS.map(a => a.name))
  expect(parseChanges('none')).toEqual({ areas: [], globs: [] })
  expect(parseChanges('Database, authentication terraform/** .env')).toEqual({ areas: ['authentication', 'database'], globs: ['terraform/**', '.env'] })
  expect(unknownChanges('all, databse, src/**')).toEqual(['databse'])
  const merged = withBase(parseSkill('security', own), parseSkill('security', base))
  expect(merged.changes?.areas).toHaveLength(SECURITY_AREAS.length)
  expect(withBase(parseSkill('security', own.replace('base: security', 'base: security\nchanges: database')), parseSkill('security', base)).changes?.areas).toEqual(['database'])
})

const areasOf = (path: string, lines = '') => touchedAreas([{ path, lines }]).map(t => t.area)

test('the kinds of change the owner named each land in their area', () => {
  // Authentication.
  expect(areasOf('src/auth/session.ts')).toContain('authentication')
  expect(areasOf('src/user.ts', 'const token = jwt.verify(raw, key)')).toContain('authentication')
  // SQL.
  expect(areasOf('src/store.ts', 'db.prepare("UPDATE tickets SET size = ? WHERE id = ?")')).toContain('database')
  expect(areasOf('migrations/0007_roles.sql')).toContain('database')
  // Permissions and roles.
  expect(areasOf('src/permissions.ts')).toContain('access-control')
  expect(areasOf('src/members.ts', "if (member.role !== 'owner') throw new Refused('owner only')")).toContain('access-control')
  // Infrastructure configuration.
  for (const path of ['terraform/main.tf', '.github/workflows/ci.yml', 'Dockerfile', 'apps/api/wrangler.toml', 'docker-compose.yml', '.env.production']) expect(areasOf(path)).toContain('infrastructure')
})

test('the other areas are read from words and paths', () => {
  expect(areasOf('src/run.ts', "execSync('git ' + branch)")).toContain('input')
  expect(areasOf('src/page.ts', 'el.innerHTML = name')).toContain('web')
  expect(areasOf('src/keys.ts', 'const key = process.env.STRIPE_SECRET_KEY')).toContain('secrets')
  expect(areasOf('package-lock.json')).toContain('dependencies')
  expect(areasOf('package.json', '    "left-pad": "^1.3.0",')).toContain('dependencies')
  expect(areasOf('hooks/reviews.ts', 'await $.agent.spawn({ prompt })')).toContain('agents')
  expect(areasOf('src/export.ts', 'const dateOfBirth = row.date_of_birth')).toContain('personal-data')
})

test('what is not a security change touches nothing', () => {
  expect(areasOf('src/button.tsx', '<div role="button" className="primary">Save</div>')).toEqual([])
  expect(areasOf('src/author.ts', 'export const authorName = (a: Author) => a.name')).toEqual([])
  // A version bump is not a dependency, and a script is not one either.
  expect(areasOf('package.json', '  "version": "0.31.0",\n    "test": "node --test"')).toEqual([])
  // Prose changes no sign-in, whatever it says and wherever it is filed.
  expect(areasOf('docs/guide.md', 'Enter your password and select a role from the list')).toEqual([])
  expect(areasOf('docs/auth/guide.md')).toEqual([])
  expect(areasOf('LICENSE', 'Permission is hereby granted')).toEqual([])
  // A test's words do not count, but a test filed in an area does by its path.
  expect(areasOf('src/cart.test.ts', "await signIn('a@example.com', 'password')")).toEqual([])
  expect(areasOf('src/auth/session.test.ts')).toContain('authentication')
})

test('a patch is read by file: added and removed lines, a new file, a deleted one', () => {
  const files = patchFiles(`${patch('src/a.ts', 'one', 'two')}diff --git a/src/gone.ts b/src/gone.ts\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-const password = 1\ndiff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\n`)
  expect(files).toEqual([
    { path: 'src/a.ts', lines: 'one\ntwo' },
    { path: 'src/gone.ts', lines: 'const password = 1' },
    { path: 'src/new.ts', lines: 'hello' },
  ])
})

test('changesFor keeps only the areas a skill lists, and its globs that a changed path matches', () => {
  const touched = touchedAreas([{ path: 'api/login.ts', lines: '' }, { path: 'db/schema.sql', lines: '' }])
  expect(changesFor(undefined, touched, ['api/login.ts'])).toEqual([])
  expect(changesFor(parseChanges('database'), touched, ['api/login.ts', 'db/schema.sql']).map(t => t.area)).toEqual(['database'])
  expect(changesFor(parseChanges('api/**'), touched, ['api/login.ts', 'db/schema.sql'])).toEqual([{ area: 'api/**', files: ['api/login.ts'] }])
})

test('the first edit of a ticket in an area names its skill once; a later edit there says nothing', async ($, on) => {
  engine(on, { lines: 10 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const edit = (file_path: string, new_string: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string } as never) as Promise<{ context?: string[] }>
  const first = await edit('/repo/api/login.ts', 'const ok = verify(password)')
  expect(first.context?.join('\n')).toContain(areaNudge(['authentication']))
  expect((await edit('/repo/api/login.ts', 'const ok = verify(password, hash)')).context ?? []).toEqual([])
  // Another area is named when an edit first lands in it.
  expect((await edit('/repo/api/store.ts', 'db.prepare("DELETE FROM carts WHERE id = ?")')).context?.join('\n')).toContain('tick-it:secure-database')
  expect((await edit('/repo/api/label.ts', 'const label = "Save"')).context ?? []).toEqual([])
})

test('an edit with no ticket taken is not nudged', async ($, on) => {
  engine(on, { lines: 10 })
  await start($)
  const ran = (await $.tool.call({ tool: 'Edit', file_path: '/repo/api/login.ts', old_string: 'x', new_string: 'password' } as never)) as { context?: string[] }
  expect(ran.context ?? []).toEqual([])
})
