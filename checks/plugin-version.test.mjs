import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
const script = new URL('../scripts/plugin-version.mjs', import.meta.url).pathname
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
const write = (dir, file, text) => {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
}
const plugin = version => JSON.stringify({ name: 'tick-it', version })

/** A repository with main at 0.5.0 and a branch that changes `file` and sets `version`; the script's exit status against main. */
const run = (file, version) => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-version-'))
  git(dir, 'init', '-b', 'main')
  write(dir, '.claude-plugin/plugin.json', plugin('0.5.0'))
  write(dir, 'hooks/a.ts', 'a')
  write(dir, 'README.md', 'a')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-b', 'pr')
  write(dir, file, 'changed')
  write(dir, '.claude-plugin/plugin.json', plugin(version))
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'change')
  return spawnSync('node', [script, 'main'], { cwd: dir, encoding: 'utf8' })
}

test('a changed plugin path with the version unchanged fails, naming the version', () => {
  const r = run('hooks/a.ts', '0.5.0')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /version is 0\.5\.0, not above 0\.5\.0/)
})

test('a changed plugin path with a lower version fails', () => {
  assert.equal(run('hooks/a.ts', '0.4.9').status, 1)
})

test('a changed plugin path with a higher version passes, comparing numbers and not text', () => {
  assert.equal(run('hooks/a.ts', '0.5.1').status, 0)
  assert.equal(run('hooks/a.ts', '0.10.0').status, 0)
})

test('no changed plugin path passes with the version unchanged', () => {
  assert.equal(run('README.md', '0.5.0').status, 0)
})

test('the Plugin version rule in .tick-it/config.json names its paths, check, resolve skill and attempts', () => {
  const rule = JSON.parse(read('.tick-it/config.json')).mergeChecks.find(r => r.name === 'Plugin version')
  assert.deepEqual(rule.paths, ['hooks/**', 'skills/**', 'types/**', '.claude-plugin/plugin.json'])
  assert.equal(rule.check, 'Plugin version')
  assert.equal(rule.resolve, '.claude/skills/version-raise/SKILL.md')
  assert.equal(rule.attempts, 2)
  assert.ok(read(rule.resolve).length > 0)
})

test('release.yml runs the script in a job whose check run is Plugin version, and no job needs it', () => {
  const workflow = read('.github/workflows/release.yml')
  const jobs = workflow.split(/^jobs:\n/m)[1].split(/^  (?=[a-z-]+:\n)/m).filter(Boolean)
  const job = jobs.find(j => /^ {4}name: Plugin version$/m.test(j))
  assert.ok(job, 'no job is named Plugin version')
  assert.match(job, /run: node scripts\/plugin-version\.mjs/)
  const id = /^([a-z-]+):/.exec(job)[1]
  for (const other of jobs) assert.doesNotMatch(other.split('\n').filter(l => /^\s+needs:/.test(l)).join('\n'), new RegExp(`\\b${id}\\b|Plugin version`), `a job needs ${id}`)
})

test('the README says a pull request leaves the version and the merge queue check has it raised', () => {
  const readme = read('README.md')
  for (const words of ['A pull request leaves `version` as it is', "merge queue's `Plugin version` check", 'the ticket\'s session raises it']) assert.ok(readme.includes(words), `README no longer says "${words}"`)
})
