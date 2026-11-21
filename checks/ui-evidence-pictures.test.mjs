import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { REQUIRED, missingPictures, subjectsOf } from '../scripts/ui-evidence-check.mjs'

const CHECK = new URL('../scripts/ui-evidence-check.mjs', import.meta.url).pathname
const ALL = names => REQUIRED.variants.flatMap(v => names.flatMap(n => ['before', 'after'].map(side => `${n}-${v}-${side}.png`)))

// A fake Tick-it MCP server: answers list_screenshots with `names`, and records each tool it was called for.
const tickit = async (names, { status = 200, stream = false } = {}) => {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const rpc = JSON.parse(body)
      calls.push({ method: rpc.method, auth: req.headers.authorization, args: rpc.params?.arguments })
      if (status !== 200) return res.writeHead(status).end()
      if (rpc.id === undefined) return res.writeHead(202).end()
      const result = rpc.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ screenshots: names.map(name => ({ key: `o/r/ABC-1/${name}`, name })) }) }] } : { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
      const answer = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })
      res.writeHead(200, { 'mcp-session-id': 's1', 'content-type': stream ? 'text/event-stream' : 'application/json' }).end(stream ? `event: message\ndata: ${answer}\n\n` : answer)
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { calls, url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => server.close() }
}

// A repository whose branch changes `files` (and a UI path glob of src/ui/**), checked as ABC-1.
const branch = files => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, '.tick-it'))
  writeFileSync(join(repo, '.tick-it/config.json'), '{"design":{"uiPaths":["src/ui/**"]}}')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'work')
  for (const f of files) {
    mkdirSync(join(repo, f, '..'), { recursive: true })
    writeFileSync(join(repo, f), 'x')
  }
  git('add', '.')
  git('commit', '-qm', 'change')
  return repo
}

const check = (repo, env) =>
  new Promise(resolve => {
    const child = spawn('node', [CHECK, 'ABC-1', '--base', 'main', '--repository', 'o/r'], { cwd: repo, env: { PATH: process.env.PATH, ...env } })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('close', status => resolve({ status, out, err }))
  })

const UI = ['src/ui/Board.stories.tsx', 'src/ui/pages/ticket.tsx']

test('required variants are listed once, in scripts/ui-evidence-required.json, and the script and the skill name them', () => {
  assert.deepEqual(REQUIRED.variants, ['dark', 'light', 'phone'])
  const script = readFileSync(CHECK, 'utf8')
  assert.match(script, /scripts\/ui-evidence-required\.json/)
  assert.doesNotMatch(script, /\['dark', 'light', 'phone'\]/)
  const skill = readFileSync(new URL('../skills/upload-screenshots/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /ui-evidence-required\.json/)
  for (const v of REQUIRED.variants) assert.ok(skill.includes(v), `the skill names ${v}`)
  const header = script.split('import ')[0]
  for (const phrase of ['list_screenshots', 'TICKIT_TOKEN', 'ui-evidence-required.json', 'without asking Tick-it']) assert.ok(header.includes(phrase), phrase)
})

test('the touched stories and pages are the subjects, and each missing before or after is named', () => {
  assert.deepEqual(subjectsOf(['a/Board.stories.tsx', 'apps/web/src/pages.tsx', 'apps/web/src/pages/Ticket Page.tsx', 'a/style.css']), ['board', 'pages', 'ticket-page'])
  assert.deepEqual(missingPictures({ subjects: ['board'], names: ALL(['board']) }), [])
  assert.deepEqual(missingPictures({ subjects: ['board'], names: ['board-dark-before-after.png', 'board-light-before-after.png', 'board-phone-before-after.png'] }), [])
  assert.deepEqual(missingPictures({ subjects: ['board'], names: ALL(['board']).filter(n => n !== 'board-phone-after.png') }), ['board has no after picture for phone uploaded to Tick-it'])
})

test('after-only fails, naming each missing before', async () => {
  const fake = await tickit(ALL(['board', 'ticket']).filter(n => n.includes('-after')))
  const ran = await check(branch(UI), { TICKIT_TOKEN: 't', TICKIT_MCP_URL: fake.url })
  fake.close()
  assert.equal(ran.status, 1)
  for (const subject of ['board', 'ticket']) for (const v of REQUIRED.variants) assert.ok(ran.err.includes(`${subject} has no before picture for ${v}`), `${subject} ${v}`)
  assert.doesNotMatch(ran.err, /no after picture/)
})

test('before-only fails, naming each missing after', async () => {
  const fake = await tickit(ALL(['board', 'ticket']).filter(n => n.includes('-before')))
  const ran = await check(branch(UI), { TICKIT_TOKEN: 't', TICKIT_MCP_URL: fake.url })
  fake.close()
  assert.equal(ran.status, 1)
  for (const subject of ['board', 'ticket']) for (const v of REQUIRED.variants) assert.ok(ran.err.includes(`${subject} has no after picture for ${v}`), `${subject} ${v}`)
  assert.doesNotMatch(ran.err, /no before picture/)
})

test('both present passes, asking list_screenshots for the ticket with the token (also over an event stream)', async () => {
  for (const stream of [false, true]) {
    const fake = await tickit(ALL(['board', 'ticket']), { stream })
    const ran = await check(branch(UI), { TICKIT_TOKEN: 'secret', TICKIT_MCP_URL: fake.url })
    fake.close()
    assert.equal(ran.status, 0, ran.err)
    const call = fake.calls.find(c => c.method === 'tools/call')
    assert.deepEqual(call.args, { repository: 'o/r', ticket: 'ABC-1' })
    assert.equal(call.auth, 'Bearer secret')
  }
})

test('a change with no UI path passes without reading Tick-it', async () => {
  const fake = await tickit([])
  const ran = await check(branch(['src/server/a.ts']), { TICKIT_TOKEN: 't', TICKIT_MCP_URL: fake.url })
  fake.close()
  assert.equal(ran.status, 0)
  assert.match(ran.out, /no UI path changed/)
  assert.deepEqual(fake.calls, [])
})

test('no token, a refused token or an unreachable Tick-it fails and says so, never passes', async () => {
  const fake = await tickit(ALL(['board', 'ticket']))
  const noToken = await check(branch(UI), { TICKIT_MCP_URL: fake.url })
  assert.equal(noToken.status, 1)
  assert.match(noToken.err, /no TICKIT_TOKEN/)
  assert.deepEqual(fake.calls, [])
  fake.close()
  const refused = await tickit([], { status: 401 })
  const bad = await check(branch(UI), { TICKIT_TOKEN: 't', TICKIT_MCP_URL: refused.url })
  refused.close()
  assert.equal(bad.status, 1)
  assert.match(bad.err, /could not be reached or refused list_screenshots \(Tick-it answered 401/)
  const down = await check(branch(UI), { TICKIT_TOKEN: 't', TICKIT_MCP_URL: 'http://127.0.0.1:1/mcp' })
  assert.equal(down.status, 1)
  assert.match(down.err, /could not be reached/)
})
