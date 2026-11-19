import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
const check = new URL('../scripts/plugin-version.mjs', import.meta.url).pathname
const raiser = new URL('../scripts/raise-version.mjs', import.meta.url).pathname
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
const write = (dir, file, text) => {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
}
const copies = version => ({
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'tick-it', version }, null, 2),
  'hooks/state.ts': `export const MOD_VERSION = '${version}'\n`,
  'tests/contract-fixtures.json': `{ "calls": [{ "args": { "modVersion": "${version}" } }] }\n`,
})

/** A repository with main at 0.5.9 and a branch that writes `files` over it. */
const repo = files => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-version-'))
  git(dir, 'init', '-b', 'main')
  for (const [f, t] of Object.entries({ ...copies('0.5.9'), 'hooks/a.ts': 'a', 'README.md': 'a' })) write(dir, f, t)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-b', 'pr')
  for (const [f, t] of Object.entries(files)) write(dir, f, t)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'change')
  return dir
}
const checkIn = dir => spawnSync('node', [check, 'main'], { cwd: dir, encoding: 'utf8' })

test('a pull request that changes a plugin path without changing the version passes', () => {
  for (const file of ['hooks/a.ts', 'skills/x/SKILL.md', 'types/index.d.ts']) assert.equal(checkIn(repo({ [file]: 'changed' })).status, 0, file)
})

test('a pull request that changes the version in any of the three copies fails, naming both versions', () => {
  for (const file of Object.keys(copies('0.5.9'))) {
    const r = checkIn(repo({ [file]: copies('0.5.10')[file] }))
    assert.equal(r.status, 1, file)
    assert.match(r.stderr, /changes the plugin version \(0\.5\.9 on main, /)
  }
})

test('raise-version raises the three copies to the next patch after a merge that changed a plugin path, comparing numbers', () => {
  const dir = repo({ 'hooks/a.ts': 'changed' })
  const r = spawnSync('node', [raiser, 'main'], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '0.5.10')
  for (const [file, text] of Object.entries(copies('0.5.10'))) assert.equal(readFileSync(join(dir, file), 'utf8'), text, file)
})

test('raise-version changes nothing and prints nothing when no plugin path changed', () => {
  const dir = repo({ 'README.md': 'changed' })
  const r = spawnSync('node', [raiser, 'main'], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  for (const [file, text] of Object.entries(copies('0.5.9'))) assert.equal(readFileSync(join(dir, file), 'utf8'), text, file)
})

test('raise-version fails and leaves the other copies alone when a copy has no version to raise', () => {
  const dir = repo({ 'hooks/state.ts': 'export const OTHER = 1\n' })
  const r = spawnSync('node', [raiser, 'main'], { cwd: dir, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /hooks\/state\.ts has no/)
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).version, '0.5.9')
})

test('.tick-it/config.json has no Plugin version merge rule and the skill it used to resolve with is the flow description', () => {
  assert.deepEqual(JSON.parse(read('.tick-it/config.json')).mergeChecks, [])
})

test('release.yml checks a pull request in a job named Plugin version, and its push job raises, commits, tags and releases', () => {
  const workflow = read('.github/workflows/release.yml')
  const jobs = workflow.split(/^jobs:\n/m)[1].split(/^  (?=[a-z-]+:\n)/m).filter(Boolean)
  const job = jobs.find(j => /^ {4}name: Plugin version$/m.test(j))
  assert.ok(job, 'no job is named Plugin version')
  assert.match(job, /run: node scripts\/plugin-version\.mjs/)
  const release = jobs.find(j => /^release:/.test(j))
  assert.ok(release, 'no release job')
  for (const words of ['node scripts/raise-version.mjs "$BEFORE"', 'git commit -am "Raise the plugin version to $version"', 'git push origin HEAD:main', 'gh release create "v$version"']) assert.ok(release.includes(words), `release job no longer has ${words}`)
})

test('the README says a pull request leaves the version and the release job raises it after the merge', () => {
  const readme = read('README.md')
  for (const words of ['A pull request leaves `version` as it is', 'the release job (`.github/workflows/release.yml`) raises the patch version', 'tags the commit `v<version>`']) assert.ok(readme.includes(words), `README no longer says "${words}"`)
})
