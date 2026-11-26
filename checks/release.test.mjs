import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
// The check and the raise are tinkerbench-studio/github-actions' version-check and version-raise, tested there. These tests hold release.yml's
// wiring of them, and its list of copies, to this repository.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const PIN = '3b62017c96ef699ebedcd21924707f313a96e8f0 # v1.3.0'
const COPIES = ['.claude-plugin/plugin.json', "hooks/state.ts MOD_VERSION = '([^']+)'", 'tests/contract-fixtures.json "modVersion": "([^"]+)"']
const PATHS = ['/hooks/**', '/skills/**', '/types/**', '/.claude-plugin/plugin.json']

const workflow = read('.github/workflows/release.yml')
const jobs = workflow.split(/^jobs:\n/m)[1].split(/^  (?=[a-z-]+:\n)/m).filter(Boolean)
const job = name => jobs.find(j => new RegExp(`^${name}:`).test(j))

/** The lines of a step's block input (`name: |`) in a job, as written. */
const block = (text, name) => {
  const m = new RegExp(`^( +)${name}: \\|\\n((?:\\1  .*\\n)+)`, 'm').exec(text)
  assert.ok(m, `no ${name} block`)
  return m[2].split('\n').map(line => line.trim()).filter(Boolean)
}

test('the Plugin version job checks a pull request with the shared version-check, pinned, over the three copies', () => {
  const check = job('plugin-version')
  assert.ok(check, 'no plugin-version job')
  assert.match(check, /^ {4}name: Plugin version$/m, 'the job is no longer named Plugin version')
  assert.match(check, /if: github\.event_name == 'pull_request'/)
  assert.match(check, /fetch-depth: 0/)
  assert.ok(check.includes(`uses: tinkerbench-studio/github-actions/version-check@${PIN}`), 'version-check is not pinned to the release this was built for')
  assert.deepEqual(block(check, 'copies'), COPIES)
})

test('the release job raises with the shared version-raise over the plugin paths, then commits, tags and releases, skipping its own raise', () => {
  const release = job('release')
  assert.ok(release, 'no release job')
  assert.ok(release.includes(`uses: tinkerbench-studio/github-actions/version-raise@${PIN}`), 'version-raise is not pinned to the release this was built for')
  assert.deepEqual(block(release, 'copies'), COPIES)
  assert.deepEqual(block(release, 'paths'), PATHS)
  for (const words of [
    'group: release',
    'cancel-in-progress: false',
    'ref: main',
    "grep -q '^Raise the plugin version to '",
    "if: steps.own.outputs.skip != 'true'",
    'before: ${{ github.event.before }}',
    "if: steps.raise.outputs.raised == 'true'",
    'git commit -am "Raise the plugin version to $VERSION"',
    'git push origin HEAD:main',
    'gh release create "v$VERSION"',
  ])
    assert.ok(release.includes(words), `release job no longer has ${words}`)
})

test('each copy release.yml names is in this repository: a JSON copy has a version, a pattern matches its file once, and the three agree', () => {
  const versions = COPIES.map(line => {
    const [file, ...rest] = line.split(/\s+/)
    const text = read(file)
    if (rest.length === 0) return JSON.parse(text).version
    const found = [...text.matchAll(new RegExp(rest.join(' '), 'g'))]
    assert.equal(found.length, 1, `${file} matches its pattern ${found.length} times`)
    return found[0][1]
  })
  assert.match(versions[0], /^\d+\.\d+\.\d+$/)
  assert.deepEqual(new Set(versions).size, 1, `the copies disagree: ${versions.join(', ')}`)
})

test('the deleted scripts are gone and nothing still runs them', () => {
  for (const file of ['.github/workflows/release.yml', '.github/workflows/ci.yml', 'README.md', '.claude/skills/version-raise/SKILL.md'])
    for (const name of ['scripts/raise-version.mjs', 'scripts/plugin-version.mjs']) assert.ok(!read(file).includes(name), `${file} still names ${name}`)
})

test('.tick-it/config.json has no Plugin version merge rule and the skill it used to resolve with is the flow description', () => {
  assert.deepEqual(JSON.parse(read('.tick-it/config.json')).mergeChecks, [])
})

test('the README says a pull request leaves the version and the release job raises it after the merge', () => {
  const readme = read('README.md')
  for (const words of ['A pull request leaves `version` as it is', 'the release job (`.github/workflows/release.yml`) raises the patch version', 'tags the commit `v<version>`', '`version-raise`', '`version-check`']) assert.ok(readme.includes(words), `README no longer says "${words}"`)
})
