// Checks a UI change is not carrying committed pictures, before review:
//   node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>]
// The UI path globs come from the repository's .tick-it/ui-evidence.json:
//   { "uiPaths": ["src/**", "**/*.css"], "committedPicturesUnder": ["docs/screenshots/"] }
// uiPaths defaults to none (nothing is a UI path until the repository says so); pictures are uploaded with
// presign_screenshot_upload and confirm_screenshot (scripts/upload-screenshots.mjs), never committed.
// Exit 0 when it passes, 1 when evidence is incomplete, 2 on a wrong call.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** A glob ("**" crosses folders, "*" and "?" stay in one) as a regular expression on a whole path. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export const isUiPath = (path, uiPaths) => uiPaths.some(g => globToRegExp(g).test(path))

/** Reads and checks the config; answers { uiPaths, committedPicturesUnder } or throws with what is wrong. */
export function parseConfig(text) {
  const raw = JSON.parse(text)
  const strings = v => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0)
  if (!strings(raw.uiPaths ?? [])) throw new Error('uiPaths must be a list of glob strings')
  if (!strings(raw.committedPicturesUnder ?? [])) throw new Error('committedPicturesUnder must be a list of folder prefixes')
  return { uiPaths: raw.uiPaths ?? [], committedPicturesUnder: raw.committedPicturesUnder ?? [] }
}

/** The problems with a change's evidence, each naming the offending file; none when it passes. changed: paths touched; added: files added. */
export function checkEvidence({ changed, added = [], config }) {
  if (!changed.some(p => isUiPath(p, config.uiPaths))) return []
  return added
    .filter(f => IMAGE.test(f) && config.committedPicturesUnder.some(dir => f.startsWith(dir)))
    .map(f => `${f} is committed: upload pictures with presign_screenshot_upload and confirm_screenshot instead (scripts/upload-screenshots.mjs)`)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean)

function main(argv) {
  const [key, ...rest] = argv
  const opt = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
  if (!/^[A-Za-z]{3}-[1-9]\d*$/.test(key ?? '')) {
    console.error('usage: node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>]')
    return 2
  }
  const file = opt('--config') ?? '.tick-it/ui-evidence.json'
  let config
  try {
    config = existsSync(file) ? parseConfig(readFileSync(file, 'utf8')) : { uiPaths: [], committedPicturesUnder: [] }
  } catch (error) {
    console.error(`${file}: ${error.message}`)
    return 2
  }
  const base = git('merge-base', 'HEAD', opt('--base') ?? 'origin/main')[0]
  const changed = git('diff', '--name-only', base)
  const problems = checkEvidence({ changed, added: git('diff', '--name-only', '--diff-filter=AMR', base), config })
  if (problems.length === 0) {
    console.log(changed.some(p => isUiPath(p, config.uiPaths)) ? `${key}: UI evidence is complete` : `${key}: no UI path changed, nothing to check`)
    return 0
  }
  console.error(`${key}: UI evidence is incomplete:`)
  for (const p of problems) console.error(`- ${p}`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
