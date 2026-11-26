import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const workflow = read('.github/workflows/release.yml')
const jobs = workflow.split(/^jobs:\n/m)[1].split(/^ {2}(?=[a-z-]+:\n)/m).filter(Boolean)
const pin = '@3b62017c96ef699ebedcd21924707f313a96e8f0 # v1.3.0'
const uses = (job, action) => job.includes(`uses: tinkerbench-studio/github-actions/${action}${pin}`)
/** The copies a job passes to its action, one entry a line, from the `copies: |` block. */
const copiesOf = job => (/^ {10}copies: \|\n((?: {12}.*\n)+)/m.exec(job)?.[1] ?? '').split('\n').map(l => l.trim()).filter(Boolean)
const check = jobs.find(j => /^ {4}name: Plugin version$/m.test(j))
const release = jobs.find(j => /^release:/.test(j))

test('release.yml checks a pull request with version-check in a job named Plugin version', () => {
  assert.ok(check, 'no job is named Plugin version')
  assert.ok(uses(check, 'version-check'), 'the Plugin version job does not run version-check at the pin')
  assert.match(check, /fetch-depth: 0/)
})

test('release.yml raises with version-raise at the same pin, then commits, tags and releases, skipping its own raise commit, one run at a time', () => {
  assert.ok(release, 'no release job')
  assert.ok(uses(release, 'version-raise'), 'the release job does not run version-raise at the pin')
  for (const words of ['/hooks/**', '/skills/**', '/types/**', '/.claude-plugin/plugin.json', 'before: ${{ github.event.before }}', 'group: release', 'cancel-in-progress: false', 'ref: main', "grep -q '^Raise the plugin version to '", 'git commit -am "Raise the plugin version to $VERSION"', 'git push origin HEAD:main', 'gh release create "v$VERSION"']) assert.ok(release.includes(words), `release job no longer has ${words}`)
})

test('the scripts the shared actions replaced are gone', () => {
  for (const file of ['scripts/raise-version.mjs', 'scripts/plugin-version.mjs']) assert.ok(!existsSync(new URL(`../${file}`, import.meta.url)), `${file} is back`)
})

test('the copies release.yml names are the same in both jobs and agree in the repository, each pattern matching its file once', () => {
  const copies = copiesOf(check)
  assert.equal(copies.length, 3)
  assert.deepEqual(copiesOf(release), copies)
  const versions = copies.map(line => {
    const [file, pattern] = line.split(/\s+(.*)/s)
    const text = read(file)
    if (!pattern) return JSON.parse(text).version
    const found = [...text.matchAll(new RegExp(pattern, 'g'))]
    assert.equal(found.length, 1, `${file}: ${pattern} matches ${found.length} times`)
    return found[0][1]
  })
  versions.forEach((v, i) => assert.match(String(v), /^\d+\.\d+\.\d+$/, `${copies[i]} has no version`))
  assert.equal(new Set(versions).size, 1, `the copies disagree: ${versions}`)
})

test('.tick-it/config.json has no Plugin version merge rule and the skill it used to resolve with is the flow description', () => {
  assert.deepEqual(JSON.parse(read('.tick-it/config.json')).mergeChecks, [])
})

test('the README says a pull request leaves the version and the release job raises it after the merge', () => {
  const readme = read('README.md')
  for (const words of ['A pull request leaves `version` as it is', 'the release job (`.github/workflows/release.yml`) raises the patch version', 'tags the commit `v<version>`']) assert.ok(readme.includes(words), `README no longer says "${words}"`)
})
