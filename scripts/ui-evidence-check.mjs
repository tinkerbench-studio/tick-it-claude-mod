// The branch side of the UI evidence check: a UI change must not commit its pictures, before review:
//   node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>] [--pictures-under <folder>]
// The UI path globs are `design.uiPaths` of the repository's .tick-it/config.json, the file Tick-it's GitHub App reads
// (--config names another). With none, no path is a UI path and the check passes, as at the gate. A picture file (PNG, JPEG, GIF, WebP)
// a UI change adds or changes under --pictures-under (default docs/change-screenshots/) is committed, and fails the check:
// upload pictures with presign_screenshot_upload and confirm_screenshot (scripts/upload-screenshots.mjs).
// Whether pictures are uploaded is read from Tick-it (list_screenshots) by the mod's gate at /tick-it done, not here, and
// that gate reads the same globs and default rule from scripts/ui-paths.mjs.
// A <name>-before / <name>-after picture pair under --pictures-under whose bytes are identical fails too, naming the pair:
// the sample does not show the change (tinkerbench-studio/tick-it#TCK-1615 refuses the same pair at upload).
// Exit 0 when it passes, 1 when pictures are committed or a pair is identical, 2 on a wrong call.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { globToRegExp, isTestOnlyChange, isUiPath, patchLines } from './ui-paths.mjs'

const DEFAULT_PICTURES = 'docs/change-screenshots/'
const IMAGE = /\.(png|jpe?g|gif|webp)$/i

export { globToRegExp, isUiPath }

/** Reads .tick-it/config.json's design.uiPaths; answers the list (empty when the file gives none) or throws with what is wrong. */
export function parseConfig(text) {
  const raw = JSON.parse(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object')
  const paths = raw.design?.uiPaths ?? []
  if (!Array.isArray(paths) || !paths.every(s => typeof s === 'string' && s.length > 0)) throw new Error('design.uiPaths must be a list of glob strings')
  return paths
}

/** The problems with a change's evidence, each naming the offending file; none when it passes. changed: paths touched; added: files the change adds, changes or renames. */
export function checkEvidence({ changed, added = [], uiPaths, picturesUnder = DEFAULT_PICTURES, lines = new Map() }) {
  // A story or .storybook/ change that only waits, asserts or comments is a test change, not a UI one (isTestOnlyChange).
  if (!changed.some(p => isUiPath(p, uiPaths) && !isTestOnlyChange(p, lines.get(p)))) return []
  const dir = picturesUnder.endsWith('/') ? picturesUnder : `${picturesUnder}/`
  return added
    .filter(f => IMAGE.test(f) && f.startsWith(dir))
    .map(f => `${f} is committed: upload pictures with presign_screenshot_upload and confirm_screenshot instead (scripts/upload-screenshots.mjs)`)
}

/** Each <name>-after picture in a folder whose bytes equal its <name>-before; answers a problem line per pair. */
export function identicalPairs(dir, names, read = f => readFileSync(`${dir}/${f}`)) {
  const stem = (f, side) => f.match(new RegExp(`^(.*)-${side}\\.(png|jpe?g|gif|webp)$`, 'i'))
  return names.flatMap(after => {
    const m = stem(after, 'after')
    const before = m && names.find(n => stem(n, 'before')?.[1] === m[1])
    return before && read(before).equals(read(after)) ? [`${before} and ${after} are identical: the sample does not show the change`] : []
  })
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)

function main(argv) {
  const [key, ...rest] = argv
  const opt = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
  const badOption = ['--base', '--config', '--pictures-under'].some(n => rest.includes(n) && (!opt(n) || opt(n).startsWith('--')))
  if (!/^[A-Za-z]+-[1-9]\d*$/.test(key ?? '') || badOption) {
    console.error('usage: node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>] [--pictures-under <folder>]')
    return 2
  }
  const file = opt('--config') ?? '.tick-it/config.json'
  let uiPaths
  try {
    uiPaths = existsSync(file) ? parseConfig(readFileSync(file, 'utf8')) : []
  } catch (error) {
    console.error(`${file}: ${error.message}`)
    return 2
  }
  let changed, problems, lines
  try {
    const base = git('merge-base', 'HEAD', opt('--base') ?? 'origin/main')[0]
    changed = git('diff', '--name-only', base)
    lines = patchLines(git('diff', '-U0', '--no-color', '--no-ext-diff', base).join('\n'))
    problems = checkEvidence({ changed, added: git('diff', '--name-only', '--diff-filter=AMR', base), uiPaths, picturesUnder: opt('--pictures-under'), lines })
  } catch (error) {
    console.error(`could not read the change from git (is --base, default origin/main, fetched?): ${error.message.split('\n')[0]}`)
    return 2
  }
  const folder = opt('--pictures-under') ?? DEFAULT_PICTURES
  if (existsSync(folder)) problems.push(...identicalPairs(folder, readdirSync(folder).filter(f => IMAGE.test(f))))
  if (problems.length === 0) {
    console.log(changed.some(p => isUiPath(p, uiPaths) && !isTestOnlyChange(p, lines.get(p))) ? `${key}: no pictures committed` : `${key}: no UI path changed, nothing to check`)
    return 0
  }
  console.error(`${key}: the picture evidence fails:`)
  for (const p of problems) console.error(`- ${p}`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
