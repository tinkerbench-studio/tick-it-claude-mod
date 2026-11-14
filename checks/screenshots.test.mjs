import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { plan, put, uploadScreenshots } from '../scripts/upload-screenshots.mjs'
import { checkEvidence, globToRegExp, isUiPath, parseConfig } from '../scripts/ui-evidence-check.mjs'

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'))
  writeFileSync(join(dir, 'after.png'), 'a')
  writeFileSync(join(dir, 'before.PNG'), 'b')
  writeFileSync(join(dir, 'notes.txt'), 'n')
  mkdirSync(join(dir, 'sub.png'))
  return dir
}

// A fake of the two screenshot tools: records every call and answers like Tick-it does.
const fakeTools = ({ failConfirm = [] } = {}) => {
  const calls = []
  return {
    calls,
    presign_screenshot_upload: async args => (calls.push(['presign', args]), { url: `https://store.example/${args.name}`, headers: { 'content-type': args.type } }),
    confirm_screenshot: async args => {
      calls.push(['confirm', args])
      if (failConfirm.includes(args.name)) throw new Error('not uploaded')
      return { ok: true }
    },
  }
}

test('plan lists only the picture files of the folder', () => {
  assert.deepEqual(plan(folder()), [{ name: 'after.png', type: 'image/png' }, { name: 'before.PNG', type: 'image/png' }])
})

test('upload presigns, PUTs with the given headers, then confirms each picture of the ticket', async () => {
  const tools = fakeTools()
  const puts = []
  const send = async (url, init) => (puts.push([url, init.method, init.headers, String(init.body)]), { ok: true, status: 200 })
  const result = await uploadScreenshots({ repository: 'o/r', ticket: 'TCK-1', dir: folder(), tools, send })
  assert.deepEqual(result, { confirmed: ['after.png', 'before.PNG'], failed: [] })
  assert.deepEqual(tools.calls[0], ['presign', { repository: 'o/r', ticket: 'TCK-1', name: 'after.png', type: 'image/png' }])
  assert.deepEqual(tools.calls.filter(c => c[0] === 'confirm').map(c => c[1]), [
    { repository: 'o/r', ticket: 'TCK-1', name: 'after.png' },
    { repository: 'o/r', ticket: 'TCK-1', name: 'before.PNG' },
  ])
  assert.deepEqual(puts[0], ['https://store.example/after.png', 'PUT', { 'content-type': 'image/png' }, 'a'])
})

test('a picture whose PUT failed is reported and never confirmed', async () => {
  const tools = fakeTools()
  const send = async url => (url.endsWith('after.png') ? { ok: false, status: 403 } : { ok: true, status: 200 })
  const result = await uploadScreenshots({ repository: 'o/r', ticket: 'TCK-1', dir: folder(), tools, send })
  assert.deepEqual(result.failed, [{ name: 'after.png', reason: 'PUT answered 403' }])
  assert.deepEqual(result.confirmed, ['before.PNG'])
  assert.equal(tools.calls.some(c => c[0] === 'confirm' && c[1].name === 'after.png'), false)
})

test('a failed confirm is reported, and put refuses a name with a path', async () => {
  const send = async () => ({ ok: true, status: 200 })
  const result = await uploadScreenshots({ repository: 'o/r', ticket: 'TCK-1', dir: folder(), tools: fakeTools({ failConfirm: ['before.PNG'] }), send })
  assert.deepEqual(result.failed, [{ name: 'before.PNG', reason: 'confirm failed: not uploaded' }])
  const refused = await put(folder(), [{ name: '../x.png', url: 'https://x' }], async () => assert.fail('must not PUT'))
  assert.equal(refused.confirm.length, 0)
  assert.equal(refused.failed.length, 1)
})

test('the evidence check reads the UI path globs from configuration', () => {
  const config = parseConfig('{"uiPaths":["src/ui/**","**/*.css"],"committedPicturesUnder":["docs/shots/"]}')
  assert.equal(isUiPath('src/ui/deep/a.tsx', config.uiPaths), true)
  assert.equal(isUiPath('a/b/site.css', config.uiPaths), true)
  assert.equal(isUiPath('src/server/a.ts', config.uiPaths), false)
  assert.equal(globToRegExp('a/*.ts').test('a/b/c.ts'), false)
  const added = ['docs/shots/after.png', 'docs/shots/notes.md', 'elsewhere/after.png']
  assert.deepEqual(checkEvidence({ changed: ['src/ui/a.tsx'], added, config }), [
    'docs/shots/after.png is committed: upload pictures with presign_screenshot_upload and confirm_screenshot instead (scripts/upload-screenshots.mjs)',
  ])
  // A change with no UI path is not checked, whatever it adds; a repository with no globs checks nothing.
  assert.deepEqual(checkEvidence({ changed: ['src/server/a.ts'], added, config }), [])
  assert.deepEqual(checkEvidence({ changed: ['src/ui/a.tsx'], added, config: parseConfig('{}') }), [])
  assert.throws(() => parseConfig('{"uiPaths":"src"}'), /uiPaths/)
})
