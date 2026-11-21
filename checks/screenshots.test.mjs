import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isUiPath as sharedIsUiPath } from '../scripts/ui-paths.mjs'
import { plan, put } from '../scripts/upload-screenshots.mjs'
import { checkEvidence, checkPictures, globToRegExp, isUiPath, listPictures, main, parseConfig } from '../scripts/ui-evidence-check.mjs'

const UPLOAD = new URL('../scripts/upload-screenshots.mjs', import.meta.url).pathname
const CHECK = new URL('../scripts/ui-evidence-check.mjs', import.meta.url).pathname
const SKILL = readFileSync(new URL('../skills/upload-screenshots/SKILL.md', import.meta.url), 'utf8')

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'))
  writeFileSync(join(dir, 'after.png'), 'a')
  writeFileSync(join(dir, 'before.PNG'), 'b')
  writeFileSync(join(dir, 'notes.txt'), 'n')
  mkdirSync(join(dir, 'sub.png'))
  return dir
}

// A fake of the two screenshot tools: answers like Tick-it does and records every call, in order.
const fakeTools = (storeUrl, { failConfirm = [] } = {}) => {
  const calls = []
  return {
    calls,
    presign_screenshot_upload: async args => (calls.push(['presign', args]), { url: `${storeUrl}/${args.name}`, headers: { 'content-type': args.type, 'x-fake': 'yes' } }),
    confirm_screenshot: async args => {
      calls.push(['confirm', args])
      if (failConfirm.includes(args.name)) throw new Error('not uploaded')
      return { ok: true }
    },
  }
}

// A fake object store that records each PUT and refuses the names in `refuse`.
const store = async (refuse = []) => {
  const puts = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const name = req.url.slice(1)
      puts.push({ name, method: req.method, type: req.headers['content-type'], fake: req.headers['x-fake'], body: Buffer.concat(chunks).toString() })
      res.statusCode = refuse.includes(name) ? 403 : 200
      res.end()
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { puts, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

const run = (script, args) => new Promise(resolve => {
  const child = spawn('node', [script, ...args])
  let out = ''
  let err = ''
  child.stdout.on('data', d => (out += d))
  child.stderr.on('data', d => (err += d))
  child.on('close', status => resolve({ status, out, err }))
})

// The skill's own sequence, driven against the fake of the two tools: plan, presign each, put, confirm what was printed.
const followSkill = async ({ dir, tools }) => {
  const planned = JSON.parse((await run(UPLOAD, ['plan', dir])).out)
  const presigned = []
  for (const { name, type } of planned) {
    const answer = await tools.presign_screenshot_upload({ repository: 'o/r', ticket: 'TCK-1', name, type })
    presigned.push({ name, url: answer.url, headers: answer.headers })
  }
  const file = join(mkdtempSync(join(tmpdir(), 'presigned-')), 'presigned.json')
  writeFileSync(file, JSON.stringify(presigned))
  const sent = await run(UPLOAD, ['put', dir, file])
  for (const { name } of JSON.parse(sent.out).confirm) await tools.confirm_screenshot({ repository: 'o/r', ticket: 'TCK-1', name })
  return sent
}

test('the skill names its steps in order and never commits pictures', () => {
  const steps = SKILL.split('\n').filter(l => /^\d\. /.test(l))
  assert.equal(steps.length, 4)
  steps.forEach((l, n) => assert.ok(l.includes(['upload-screenshots.mjs plan', 'presign_screenshot_upload', 'upload-screenshots.mjs put', 'confirm_screenshot'][n]), `step ${n + 1}`))
  for (const phrase of ['Only then is a picture confirmed', 'Never commit the pictures', 'ui-evidence-check.mjs', 'list_screenshots']) assert.ok(SKILL.includes(phrase), phrase)
  assert.match(SKILL, /^argument-hint: <ticket key> <picture folder>$/m)
})

test('plan lists only the picture files of the folder, and exits 2 for a folder that is not there', async () => {
  assert.deepEqual(plan(folder()), [{ name: 'after.png', type: 'image/png' }, { name: 'before.PNG', type: 'image/png' }])
  assert.deepEqual(plan(mkdtempSync(join(tmpdir(), 'empty-'))), [])
  assert.equal((await run(UPLOAD, ['plan', '/nonexistent-folder'])).status, 2)
})

test('the upload sequence stores each picture through the two tools: presign, PUT with its headers, then confirm', async () => {
  const fake = await store()
  const tools = fakeTools(fake.url)
  const sent = await followSkill({ dir: folder(), tools })
  fake.close()
  assert.equal(sent.status, 0)
  assert.deepEqual(fake.puts, [
    { name: 'after.png', method: 'PUT', type: 'image/png', fake: 'yes', body: 'a' },
    { name: 'before.PNG', method: 'PUT', type: 'image/png', fake: 'yes', body: 'b' },
  ])
  assert.deepEqual(tools.calls.filter(c => c[0] === 'confirm').map(c => c[1]), [
    { repository: 'o/r', ticket: 'TCK-1', name: 'after.png' },
    { repository: 'o/r', ticket: 'TCK-1', name: 'before.PNG' },
  ])
  assert.deepEqual(tools.calls[0], ['presign', { repository: 'o/r', ticket: 'TCK-1', name: 'after.png', type: 'image/png' }])
})

test('a picture whose PUT was refused exits 1, is named, and is never confirmed', async () => {
  const fake = await store(['after.png'])
  const tools = fakeTools(fake.url)
  const sent = await followSkill({ dir: folder(), tools })
  fake.close()
  assert.equal(sent.status, 1)
  assert.match(sent.err, /after\.png: PUT answered 403/)
  assert.deepEqual(tools.calls.filter(c => c[0] === 'confirm').map(c => c[1].name), ['before.PNG'])
})

test('put refuses what it cannot send: a name with a path, no url, a non-picture, a missing file, a bad presigned file', async () => {
  const never = async () => assert.fail('must not PUT')
  const dir = folder()
  const refused = await put(dir, [{ name: '../x.png', url: 'https://x' }, { name: 'after.png' }, { name: 'notes.txt', url: 'https://x' }, null], never)
  assert.equal(refused.confirm.length, 0)
  assert.deepEqual(refused.failed.map(f => f.name), ['../x.png', 'after.png', 'notes.txt', 'undefined'])
  assert.ok(refused.failed.every(f => f.reason === 'not a picture file name with a url'))
  const missing = await put(dir, [{ name: 'gone.png', url: 'https://x' }], async (url, init) => ({ ok: true, status: 200, init }))
  assert.equal(missing.confirm.length, 0)
  assert.match(missing.failed[0].reason, /ENOENT/)
  const headerless = await put(dir, [{ name: 'after.png', url: 'https://x' }], async (url, init) => ({ ok: Object.keys(init.headers).length === 0, status: 200 }))
  assert.deepEqual(headerless.confirm, [{ name: 'after.png' }])
  const bad = join(mkdtempSync(join(tmpdir(), 'bad-')), 'presigned.json')
  writeFileSync(bad, '{"not":"an array"}')
  assert.equal((await run(UPLOAD, ['put', dir, bad])).status, 2)
  assert.equal((await run(UPLOAD, ['put', dir, '/nonexistent.json'])).status, 2)
  assert.equal((await run(UPLOAD, [])).status, 2)
})

test('the evidence check reads the UI path globs from design.uiPaths of the config', () => {
  const uiPaths = parseConfig('{"mergeChecks":[],"design":{"uiPaths":["src/ui/**","**/*.css"]}}')
  assert.deepEqual(uiPaths, ['src/ui/**', '**/*.css'])
  assert.equal(isUiPath('src/ui/deep/a.tsx', uiPaths), true)
  assert.equal(isUiPath('a/b/site.css', uiPaths), true)
  assert.equal(isUiPath('src/server/a.ts', uiPaths), false)
  assert.equal(globToRegExp('a/*.ts').test('a/b/c.ts'), false)
  const added = ['docs/shots/after.png', 'docs/shots/notes.md', 'docs/shots-old/x.png', 'elsewhere/after.png']
  assert.deepEqual(checkEvidence({ changed: ['src/ui/a.tsx'], added, uiPaths, picturesUnder: 'docs/shots' }), [
    'docs/shots/after.png is committed: upload pictures with presign_screenshot_upload and confirm_screenshot instead (scripts/upload-screenshots.mjs)',
  ])
  assert.equal(checkEvidence({ changed: ['src/ui/a.tsx'], added: ['docs/change-screenshots/a.png'], uiPaths }).length, 1)
  assert.deepEqual(checkEvidence({ changed: ['src/server/a.ts'], added, uiPaths, picturesUnder: 'docs/shots' }), [])
  assert.deepEqual(checkEvidence({ changed: ['src/ui/a.tsx'], added, uiPaths: parseConfig('{"mergeChecks":[]}'), picturesUnder: 'docs/shots' }), [])
  for (const bad of ['{"design":{"uiPaths":"src"}}', 'null', '[]']) assert.throws(() => parseConfig(bad))
})

test('the evidence check command reads the change from git and exits 0, 1 or 2', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' })
  const check = (...a) => spawnSync('node', [CHECK, ...a], { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, '.tick-it'))
  writeFileSync(join(repo, '.tick-it/config.json'), '{"design":{"uiPaths":["src/ui/**"]}}')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'work')
  mkdirSync(join(repo, 'src/ui'), { recursive: true })
  writeFileSync(join(repo, 'src/ui/a.tsx'), 'x')
  git('add', '.')
  git('commit', '-qm', 'ui')
  mkdirSync(join(repo, 'docs/shots'), { recursive: true })
  writeFileSync(join(repo, 'docs/shots/after.png'), 'p')
  git('add', '.')
  git('commit', '-qm', 'picture')
  const failing = check('ABC-1', '--base', 'main', '--pictures-under', 'docs/shots')
  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /docs\/shots\/after\.png is committed/)
  git('rm', '-q', '-r', 'docs/shots')
  git('commit', '-qm', 'no picture')
  assert.equal(check('not a key').status, 2)
  assert.equal(check('ABC-1', '--base').status, 2)
  assert.equal(check('ABC-1', '--base', 'no-such-ref').status, 2)
  writeFileSync(join(repo, 'bad.json'), 'not json')
  assert.equal(check('ABC-1', '--base', 'main', '--config', 'bad.json').status, 2)
  // With no configuration file nothing is a UI path, so the same branch passes.
  assert.match(check('ABC-1', '--base', 'main', '--config', 'missing.json').stdout, /no UI path changed/)
})

test('the evidence script runs with node alone: its folder holds the shared module it imports, and nothing else is needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-'))
  cpSync(new URL('../scripts/', import.meta.url), join(dir, 'scripts'), { recursive: true })
  const ran = spawnSync('node', [join(dir, 'scripts/ui-evidence-check.mjs'), 'not a key'], { cwd: dir, encoding: 'utf8' })
  assert.equal(ran.status, 2)
  assert.match(ran.stderr, /^usage: node scripts\/ui-evidence-check\.mjs/)
  assert.deepEqual([...readFileSync(CHECK, 'utf8').matchAll(/^import .* from '(.*)'/gm)].map(m => m[1]).filter(s => !s.startsWith('node:')), ['./ui-paths.mjs'])
  assert.equal(isUiPath('apps/web/src/pages.tsx', []), true)
  assert.equal(isUiPath, sharedIsUiPath)
})

// A fake of Tick-it's MCP endpoint: answers initialize, the initialized notice and list_screenshots, and records each method it was asked.
const tickit = names => {
  const asked = []
  const send = async (_url, init) => {
    const body = JSON.parse(init.body)
    asked.push(body.method === 'tools/call' ? `${body.params.name} ${body.params.arguments.repository} ${body.params.arguments.ticket} ${init.headers.authorization}` : body.method)
    const result = body.method === 'tools/call' ? { structuredContent: { screenshots: names.map(name => ({ name })) } } : {}
    return new Response(body.id === undefined ? '' : `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200, headers: { 'mcp-session-id': 's1' } })
  }
  return { asked, send }
}
const required = ['dark', 'light', 'phone']

test('checkPictures fails an after-only or before-only picture, naming each, and passes when every before and after is there', () => {
  const side = (t, s) => required.map(v => `${t}-${v}-${s}.png`)
  assert.deepEqual(checkPictures({ pictures: [...side('pages-ticket', 'before'), ...side('pages-ticket', 'after')] }), [])
  assert.deepEqual(checkPictures({ pictures: required.map(v => `story-row-${v}-before-after.png`) }), [])
  assert.deepEqual(checkPictures({ pictures: side('pages-ticket', 'after') }), required.map(v => `pages-ticket: no before picture for ${v}${v === 'phone' ? ' (390 px)' : ''} (pages-ticket-${v}-before.png or pages-ticket-${v}-before-after.png)`))
  assert.deepEqual(checkPictures({ pictures: side('pages-ticket', 'before') }).map(l => l.split(' picture')[0]), required.map(() => 'pages-ticket: no after'))
  // One variant short: only that one is named. A named page with no pictures fails; none at all fails.
  assert.equal(checkPictures({ pictures: [...side('a', 'before'), ...side('a', 'after').slice(0, 2)] }).length, 1)
  assert.equal(checkPictures({ pictures: side('a', 'after'), touches: ['b'] }).filter(l => l.startsWith('b:')).length, 3)
  assert.match(checkPictures({ pictures: ['board-beside-story-Menu.png'] })[0], /no before\/after picture is uploaded/)
  // A target the change adds needs its after alone.
  assert.deepEqual(checkPictures({ pictures: side('new-story', 'after'), fresh: ['new-story'] }), [])
})

test('listPictures asks Tick-it for list_screenshots, and fails saying so when it has no token or cannot be reached', async () => {
  const fake = tickit(['a-dark-after.png'])
  assert.deepEqual(await listPictures({ repository: 'o/r', ticket: 'ABC-1', url: 'http://x/mcp', token: 'tok', send: fake.send }), ['a-dark-after.png'])
  assert.deepEqual(fake.asked, ['initialize', 'notifications/initialized', 'list_screenshots o/r ABC-1 Bearer tok'])
  await assert.rejects(listPictures({ repository: 'o/r', ticket: 'ABC-1', url: 'http://x/mcp', send: fake.send }), /TICKIT_TOKEN is not set/)
  await assert.rejects(listPictures({ repository: 'o/r', ticket: 'ABC-1', url: 'http://x/mcp', token: 't', send: async () => { throw new Error('ECONNREFUSED') } }), /could not be reached at http:\/\/x\/mcp: ECONNREFUSED/)
  await assert.rejects(listPictures({ repository: 'o/r', ticket: 'ABC-1', url: 'http://x/mcp', token: 't', send: async () => new Response('no', { status: 401 }) }), /answered 401.*TICKIT_TOKEN/)
})

test('the evidence check reads uploaded pictures for a UI change, and never reads Tick-it for a change with no UI path', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, '.tick-it'))
  writeFileSync(join(repo, '.tick-it/config.json'), '{"design":{"uiPaths":["src/ui/**"]}}')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('remote', 'add', 'origin', 'https://github.com/o/r.git')
  git('checkout', '-qb', 'work')
  mkdirSync(join(repo, 'src/server'), { recursive: true })
  writeFileSync(join(repo, 'src/server/a.ts'), 'x')
  git('add', '.')
  git('commit', '-qm', 'server')
  const cwd = process.cwd()
  process.chdir(repo)
  const log = []
  const keep = { out: console.log, err: console.error }
  console.log = (...a) => log.push(a.join(' '))
  console.error = (...a) => log.push(a.join(' '))
  const run = async (names, env = { TICKIT_TOKEN: 'tok' }) => {
    const fake = tickit(names)
    log.length = 0
    return { status: await main(['ABC-1', '--base', 'main'], env, fake.send), asked: fake.asked, log: log.join('\n') }
  }
  try {
    const none = await run(['a-dark-after.png'])
    assert.equal(none.status, 0)
    assert.deepEqual(none.asked, [])
    assert.match(none.log, /no UI path changed/)
    mkdirSync(join(repo, 'src/ui'), { recursive: true })
    writeFileSync(join(repo, 'src/ui/a.tsx'), 'x')
    git('add', '.')
    git('commit', '-qm', 'ui')
    const names = s => required.map(v => `pages-ticket-${v}-${s}.png`)
    const afterOnly = await run(names('after'))
    assert.equal(afterOnly.status, 1)
    assert.equal(afterOnly.asked.length, 3)
    assert.match(afterOnly.log, /pages-ticket: no before picture for dark/)
    const beforeOnly = await run(names('before'))
    assert.equal(beforeOnly.status, 1)
    assert.match(beforeOnly.log, /pages-ticket: no after picture for phone \(390 px\)/)
    const both = await run([...names('before'), ...names('after')])
    assert.equal(both.status, 0)
    assert.match(both.log, /every required before and after is uploaded/)
    const noToken = await run(names('after'), {})
    assert.equal(noToken.status, 2)
    assert.match(noToken.log, /could not check the uploaded pictures: TICKIT_TOKEN is not set/)
  } finally {
    process.chdir(cwd)
    console.log = keep.out
    console.error = keep.err
  }
})

test('the required list is one file that the script reads, and the README and the skill name', () => {
  const list = JSON.parse(readFileSync(new URL('../scripts/ui-evidence-required.json', import.meta.url), 'utf8'))
  assert.deepEqual(list.variants, required)
  assert.deepEqual(list.sides, ['before', 'after'])
  assert.ok(readFileSync(CHECK, 'utf8').includes('ui-evidence-required.json'))
  assert.ok(SKILL.includes('ui-evidence-required.json'))
})
