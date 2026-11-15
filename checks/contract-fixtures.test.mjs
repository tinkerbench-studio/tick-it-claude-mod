import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

// Run with: node --test checks/*.test.mjs
// tests/contract-fixtures.json is what Tick-it's CI checks against the server's tool schemas. These keep it complete: every tool the hooks call has a recorded call, and every answer belongs to a call.
const fixtures = JSON.parse(readFileSync(new URL('../tests/contract-fixtures.json', import.meta.url), 'utf8'))
const source = readdirSync(new URL('../hooks/', import.meta.url))
  .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  .map(f => readFileSync(new URL(`../hooks/${f}`, import.meta.url), 'utf8'))
  .join('\n')

test('every Tick-it tool the hooks call has a recorded call', () => {
  const called = new Set(fixtures.calls.map(c => c.tool))
  const named = [...source.matchAll(/(?:callTickit|sendTickit)\(\$, '([a-z_]+)'/g)].map(m => m[1])
  for (const constant of ['AGENTS_TOOL', 'RECORD_TOOL', 'REPORT_TOOL']) {
    const value = new RegExp(`${constant} = '([a-z_]+)'`).exec(source)?.[1]
    assert.ok(value, `${constant} not found`)
    named.push(value)
  }
  for (const tool of named) assert.ok(called.has(tool), `${tool} is called by the hooks but has no call in tests/contract-fixtures.json`)
})

test('every recorded answer is for a recorded call', () => {
  const called = new Set(fixtures.calls.map(c => c.tool))
  for (const a of fixtures.answers) assert.ok(called.has(a.tool), `${a.tool} has an answer but no call`)
})

test("the version sent with get_mod_config is the plugin's version, and the fixture records it", () => {
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const state = readFileSync(new URL('../hooks/state.ts', import.meta.url), 'utf8')
  assert.equal(/MOD_VERSION = '([^']+)'/.exec(state)?.[1], plugin.version)
  const call = fixtures.calls.find(c => c.tool === 'get_mod_config')
  assert.equal(call.args.modVersion, plugin.version)
})

test('the get_mod_config answer records notice, which the mod reads and shows', () => {
  const answer = fixtures.answers.find(a => a.tool === 'get_mod_config').answer
  assert.ok('notice' in answer, 'notice is missing from the get_mod_config answer')
  assert.match(source, /v\.notice/)
})

test('the board is read slim and get_ticket names the parts it reads (a reply over 50,000 characters never reaches the mod)', () => {
  const lists = fixtures.calls.filter(c => c.tool === 'list_tickets')
  assert.ok(lists.length > 0)
  for (const c of lists) assert.equal(c.args.slim, true, 'list_tickets must be called with slim: true')
  const gets = fixtures.calls.filter(c => c.tool === 'get_ticket')
  assert.ok(gets.some(c => Array.isArray(c.args.include) && c.args.include.length === 0), 'get_ticket include: [] is not recorded')
  for (const c of gets) assert.ok(Array.isArray(c.args.include), 'every get_ticket call records include')
})
