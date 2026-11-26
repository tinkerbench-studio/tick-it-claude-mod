import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { parseRequired, uncovered, uncoveredLines } from '../scripts/required-pictures.mjs'

const CHECK = new URL('../scripts/ui-evidence-check.mjs', import.meta.url).pathname
const REQUIRED = ['dark', 'light'].flatMap(v => [{ for: 'board', name: `board-${v}` }, { for: 'buttons', name: `buttons-${v}` }])
const OUTPUT = { touched: [{ kind: 'page', id: 'board', file: 'shots.mjs' }, { kind: 'story', id: 'buttons', file: 'b.stories.tsx' }], required: REQUIRED }

test('a picture covers a name as it is, with -before-after, or as a -before and -after pair, and one half does not', () => {
  const missing = pictures => uncovered(REQUIRED, pictures).map(r => r.name)
  assert.deepEqual(missing(['board-dark.png', 'board-light.png', 'buttons-dark.png', 'buttons-light.png']), [])
  assert.deepEqual(missing(['board-dark-before-after.png', 'board-light-before-after.png', 'buttons-dark.png', 'buttons-light.png']), [])
  assert.deepEqual(missing(['board-dark-before.png', 'board-dark-after.png', 'board-light.png', 'buttons-dark.png', 'buttons-light.png']), [])
  assert.deepEqual(missing(['board-dark-before.png', 'board-light.png', 'buttons-dark.png', 'buttons-light.png']), ['board-dark'])
  assert.deepEqual(uncoveredLines(uncovered(REQUIRED, ['board-dark.png', 'board-light.png', 'buttons-dark.png']), OUTPUT.touched), ['story buttons (b.stories.tsx) has no confirmed picture (needs buttons-light)'])
})

test('a value with spaces is the contract, and is shown as plain text; control characters or too many entries are not the contract', () => {
  const spaced = { touched: [{ kind: 'story', id: 'a b', file: 'src/My Component.tsx' }], required: [{ for: 'a b', name: 'a b-dark' }] }
  assert.deepEqual(parseRequired(JSON.stringify(spaced)), spaced)
  assert.deepEqual(uncoveredLines(spaced.required, spaced.touched), ['story a b (src/My Component.tsx) has no confirmed picture (needs a b-dark)'])
  assert.deepEqual(uncoveredLines([{ for: 'x', name: 'n<b>`$' }]), ['x has no confirmed picture (needs n b)'])
  const bad = o => () => parseRequired(JSON.stringify(o))
  assert.throws(bad({ touched: [], required: [{ for: 'a\nb', name: 'n' }] }), /not the contract/)
  assert.throws(bad({ touched: [], required: Array.from({ length: 501 }, () => ({ for: 'a', name: 'n' })) }), /not the contract/)
})

/** A repository whose shared component changed, with a fake required-pictures command (a node file) that prints what it is given. */
function repo(command) {
  const dir = mkdtempSync(join(tmpdir(), 'required-'))
  const files = {
    '.tick-it/config.json': JSON.stringify({ design: { uiPaths: ['ui/**'], requiredPictures: { command } } }),
    'ui/Button.tsx': 'export const Button = 1\n',
    'fake.mjs': `import { readFileSync } from 'node:fs'\nconst paths = readFileSync(0, 'utf8').split('\\n').filter(Boolean)\nif (!paths.includes('ui/Button.tsx')) { console.error('no Button in ' + paths); process.exit(4) }\nconsole.log(${JSON.stringify(JSON.stringify(OUTPUT))})\n`,
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'base')
  writeFileSync(join(dir, 'ui/Button.tsx'), 'export const Button = 2\n')
  return dir
}
const run = (dir, ...args) => spawnSync('node', [CHECK, 'TCK-9', '--base', 'main', ...args], { cwd: dir, encoding: 'utf8' })

test('--required-pictures over a shared-component diff names the touched stories and pages and each required picture with none', () => {
  const ran = run(repo(['node', 'fake.mjs']), '--required-pictures', '--pictures', 'board-dark.png,board-light.png,buttons-dark-before.png,buttons-dark-after.png')
  assert.equal(ran.status, 1)
  assert.match(ran.stdout, /touches 1 stories and 1 pages\n {2}page board\n {2}story buttons/)
  assert.match(ran.stderr, /story buttons \(b\.stories\.tsx\) has no confirmed picture \(needs buttons-light\)/)
  assert.doesNotMatch(ran.stderr, /board/)
})

test('--required-pictures fails naming the command when it cannot run, and passes a shell metacharacter literally', () => {
  // The argument reaches the command as it is: no shell reads it, so the command runs and the pictures it names are missing.
  const literal = run(repo(['node', 'fake.mjs', '; echo $HOME']), '--required-pictures', '--pictures', 'x.png')
  assert.equal(literal.status, 1)
  assert.match(literal.stdout, /touches 1 stories and 1 pages/)
  assert.match(literal.stderr, /needs board-dark, board-light/)
  const gone = run(repo(['no-such-design-tool', 'a; echo $HOME']), '--required-pictures', '--pictures', 'x.png')
  assert.equal(gone.status, 1)
  assert.match(gone.stderr, /the design\.requiredPictures command \(no-such-design-tool a; echo \$HOME\) could not say which pictures are required: /)
})

test('the command may run for 60 seconds by default', async () => {
  const { REQUIRED_TIMEOUT_MS } = await import('../scripts/required-pictures.mjs')
  assert.equal(REQUIRED_TIMEOUT_MS, 60_000)
})
