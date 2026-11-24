import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { nodeFs } from '../scripts/ui-evidence-check.mjs'
import { pagesOf, storyIds, touched, uncovered, uncoveredLines } from '../scripts/ui-touched.mjs'

const CHECK = new URL('../scripts/ui-evidence-check.mjs', import.meta.url).pathname
const FILES = {
  '.tick-it/config.json': '{"design":{"uiPaths":["apps/web/src/**"]}}',
  '.storybook/preview.ts': "import './setup'\n",
  '.storybook/setup.ts': 'export {}\n',
  'apps/web/src/render.tsx': "import { Pages } from './pages'\n",
  'apps/web/src/pages.tsx': "import { Button } from './components/Button'\n",
  'apps/web/src/components/Button.tsx': 'export const Button = 1\n',
  'apps/web/src/design/page-examples.tsx': 'export const Home = 1\n',
  'apps/web/src/design/buttons.stories.tsx': "import { Button } from '../components/Button'\nexport default { title: 'Pages/Buttons' }\nexport const PrimaryButton = {}\nexport const Plain = {}\n",
  'apps/web/src/design/plain.stories.tsx': "export default { title: 'Plain' }\nexport const Alone = {}\n",
  'scripts/page-shots.mjs': "export const PAGES = {\n  board: { view: 'board' },\n  'board-phone': { view: 'board' },\n  home: { view: 'home', home: true },\n}\nPAGES['ticket-screenshots'] = { view: 'ticket' }\n",
}
const repo = (files = FILES) => {
  const dir = mkdtempSync(join(tmpdir(), 'touched-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

test('a shared component touches every page and the stories that import it, not the story that does not', async () => {
  const found = await touched({ fs: nodeFs(repo()), changed: ['apps/web/src/components/Button.tsx'] })
  assert.deepEqual(found.pages, ['board', 'ticket-screenshots'])
  assert.deepEqual(found.stories.map(s => s.id), ['pages-buttons--primary-button', 'pages-buttons--plain'])
})

test('the stylesheet the preview imports touches every story, and the home page only its own drawing file', async () => {
  const fs = nodeFs(repo())
  assert.equal((await touched({ fs, changed: ['.storybook/setup.ts'] })).stories.length, 3)
  assert.deepEqual((await touched({ fs, changed: ['apps/web/src/design/page-examples.tsx'] })).pages, ['home'])
  assert.deepEqual(await touched({ fs, changed: ['docs/readme.md'] }), { stories: [], pages: [] })
  assert.deepEqual(await touched({ fs: nodeFs(repo({ 'a.txt': 'x' })), changed: ['a.txt'] }), { stories: [], pages: [] })
})

test('a touched story or page needs a dark, light and phone picture; six pictures of one page leave the rest named', async () => {
  const found = await touched({ fs: nodeFs(repo()), changed: ['apps/web/src/components/Button.tsx'] })
  const six = ['ticket-screenshots-dark.png', 'ticket-screenshots-light.png', 'ticket-screenshots-phone-before-after.png', 'board-dark.png', 'board-light.png', 'story-pages-buttons--plain-dark.png']
  assert.deepEqual(uncoveredLines(uncovered(found, six)), [
    'page board has no confirmed picture (needs board-dark, board-light, board-phone)',
    'story pages-buttons--primary-button (apps/web/src/design/buttons.stories.tsx) has no confirmed picture (needs story-pages-buttons--primary-button-dark, -light, -phone)',
    'story pages-buttons--plain (apps/web/src/design/buttons.stories.tsx) has no confirmed picture (needs story-pages-buttons--plain-dark, -light, -phone)',
  ])
  assert.deepEqual(uncovered({ pages: [], stories: [] }, []), { pages: [], stories: [] })
})

test('PAGES and story ids are read as text', () => {
  assert.deepEqual(pagesOf(FILES['scripts/page-shots.mjs']), { board: {}, 'board-phone': {}, home: { home: true }, 'ticket-screenshots': {} })
  assert.deepEqual(storyIds(FILES['apps/web/src/design/buttons.stories.tsx']), ['pages-buttons--primary-button', 'pages-buttons--plain'])
})

test('ui-evidence-check prints the touched stories and pages and fails naming those with no picture', () => {
  const dir = repo()
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'work')
  writeFileSync(join(dir, 'apps/web/src/components/Button.tsx'), 'export const Button = 2\n')
  git('commit', '-qam', 'restyle the button')
  const run = (...a) => spawnSync('node', [CHECK, 'ABC-1', '--base', 'main', ...a], { cwd: dir, encoding: 'utf8' })
  const listed = run()
  assert.equal(listed.status, 0)
  assert.match(listed.stdout, /ABC-1: touches 2 stories and 2 pages\n {2}page board\n {2}page ticket-screenshots\n {2}story pages-buttons--primary-button\n {2}story pages-buttons--plain/)
  const missing = run('--pictures', 'board-dark.png,board-light.png,board-phone.png')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /- page ticket-screenshots has no confirmed picture/)
  assert.match(missing.stderr, /- story pages-buttons--plain \(apps\/web\/src\/design\/buttons\.stories\.tsx\) has no confirmed picture/)
  assert.doesNotMatch(missing.stderr, /page board /)
})
