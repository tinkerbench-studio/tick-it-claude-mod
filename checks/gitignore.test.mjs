import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
const root = new URL('..', import.meta.url).pathname

test('.gitignore at the repository root ignores node_modules/', () => {
  const lines = readFileSync(`${root}.gitignore`, 'utf8').split('\n').map(l => l.trim())
  assert.ok(lines.includes('node_modules/'), '.gitignore must list node_modules/')
})

test('no tracked path is under node_modules/', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
  const bad = tracked.filter(p => p === 'node_modules' || p.startsWith('node_modules/') || p.includes('/node_modules/'))
  assert.deepEqual(bad, [], `git ls-files lists paths under node_modules/: ${bad.join(', ')}`)
})
