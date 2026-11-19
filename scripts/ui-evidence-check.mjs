// The branch side of the UI evidence check, run before review:
//   node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>] [--pictures-under <folder>] [--touches <a,b>] [--new <a,b>] [--repository <owner/name>]
// The UI path globs are `design.uiPaths` of the repository's .tick-it/config.json, the file Tick-it's GitHub App reads
// (--config names another). With none, the built-in tick-it paths of scripts/ui-paths.mjs apply, as at the gate. For a change that touches a UI path it fails when
//  1. the branch commits a picture file (PNG, JPEG, GIF, WebP) under --pictures-under (default docs/change-screenshots/): upload with presign_screenshot_upload and confirm_screenshot; or
//  2. the ticket's uploaded pictures, read from Tick-it with list_screenshots, lack a before or an after for a story or page, in a variant listed in scripts/ui-evidence-required.json
//     (dark, light and 390 px phone: the one list the ux-evidence skill and docs/design-system.md cite). A target is each story or page named by an uploaded picture, plus each --touches
//     name; --new names a target the change adds, which needs its after alone. No picture at all fails too. It names each missing picture.
// The read needs TICKIT_TOKEN (a Tick-it bearer token with tickets:read), and uses TICKIT_MCP_URL (default https://mcp.tick-it.dev/mcp); when Tick-it cannot be reached or there is no token, it fails and says so.
// A change that touches no UI path passes without reading Tick-it.
// Exit 0 when it passes, 1 when evidence is missing or committed, 2 on a wrong call or when Tick-it cannot be read.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { globToRegExp, isUiPath } from './ui-paths.mjs'

const REQUIRED = JSON.parse(readFileSync(new URL('./ui-evidence-required.json', import.meta.url), 'utf8'))
const DEFAULT_PICTURES = 'docs/change-screenshots/'
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const NAME = new RegExp(`^(.+)-(${REQUIRED.variants.join('|')})-(before-after|before|after)\\.(png|jpe?g|gif|webp)$`, 'i')

/** The pictures a change lacks, one line each. pictures: names from list_screenshots; touches: targets that must have pictures; fresh: targets the change adds (after only). */
export function checkPictures({ pictures, touches = [], fresh = [] }) {
  const have = new Map()
  for (const name of pictures) {
    const m = NAME.exec(name)
    if (m) have.set(`${m[1]}|${m[2].toLowerCase()}|${m[3].toLowerCase()}`, true)
  }
  const targets = [...new Set([...pictures.flatMap(n => NAME.exec(n)?.[1] ?? []), ...touches, ...fresh])].sort()
  if (targets.length === 0) return ['no before/after picture is uploaded to Tick-it (list_screenshots): see "Showing a UX change" in docs/design-system.md']
  return targets.flatMap(t =>
    REQUIRED.variants.flatMap(v => {
      const both = have.has(`${t}|${v}|before-after`)
      const missing = REQUIRED.sides.filter(side => !both && !have.has(`${t}|${v}|${side}`) && !(side === 'before' && fresh.includes(t)))
      return missing.length ? [`${t}: no ${missing.join(' or ')} picture for ${v}${v === 'phone' ? ` (${REQUIRED.phoneWidth} px)` : ''} (${t}-${v}-${missing[0]}.png or ${t}-${v}-before-after.png)`] : []
    }),
  )
}

/** The names of the ticket's confirmed pictures, read from Tick-it's MCP endpoint with list_screenshots. Throws with why it could not. */
export async function listPictures({ repository, ticket, url, token, send = fetch }) {
  if (!token) throw new Error('TICKIT_TOKEN is not set, so Tick-it cannot be asked which pictures are uploaded (list_screenshots)')
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }
  const post = async (body, extra = {}) => {
    let response
    try {
      response = await send(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    } catch (error) {
      throw new Error(`Tick-it could not be reached at ${url}: ${error.message}`)
    }
    if (!response.ok) throw new Error(`Tick-it answered ${response.status} at ${url}${response.status === 401 || response.status === 403 ? ' (check TICKIT_TOKEN)' : ''}`)
    const text = await response.text()
    const data = text.startsWith('{') ? text : (text.split('\n').find(l => l.startsWith('data:')) ?? '').slice(5)
    return { session: response.headers.get('mcp-session-id'), message: data.trim() ? JSON.parse(data) : null }
  }
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ui-evidence-check', version: '1' } } })
  const extra = init.session ? { 'mcp-session-id': init.session } : {}
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra)
  const { message } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_screenshots', arguments: { repository, ticket } } }, extra)
  const result = message?.result
  if (!result || message.error || result.isError) throw new Error(`Tick-it refused list_screenshots: ${message?.error?.message ?? result?.content?.[0]?.text ?? 'no answer'}`)
  let list = result.structuredContent?.screenshots
  if (!Array.isArray(list)) {
    try {
      list = JSON.parse(result.content?.find(b => b.type === 'text')?.text ?? '').screenshots
    } catch {}
  }
  if (!Array.isArray(list)) throw new Error('Tick-it answered list_screenshots with no list of pictures')
  return list.map(p => p?.name).filter(n => typeof n === 'string')
}

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
export function checkEvidence({ changed, added = [], uiPaths, picturesUnder = DEFAULT_PICTURES }) {
  if (!changed.some(p => isUiPath(p, uiPaths))) return []
  const dir = picturesUnder.endsWith('/') ? picturesUnder : `${picturesUnder}/`
  return added
    .filter(f => IMAGE.test(f) && f.startsWith(dir))
    .map(f => `${f} is committed: upload pictures with presign_screenshot_upload and confirm_screenshot instead (scripts/upload-screenshots.mjs)`)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)

export async function main(argv, env = process.env, send = fetch) {
  const [key, ...rest] = argv
  const opt = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
  const list = name => (opt(name) ?? '').split(',').filter(Boolean)
  const options = ['--base', '--config', '--pictures-under', '--touches', '--new', '--repository']
  const badOption = options.some(n => rest.includes(n) && (!opt(n) || opt(n).startsWith('--')))
  if (!/^[A-Za-z]+-[1-9]\d*$/.test(key ?? '') || badOption) {
    console.error(`usage: node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>] [--pictures-under <folder>] [--touches <a,b>] [--new <a,b>] [--repository <owner/name>]`)
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
  let changed, problems
  try {
    const base = git('merge-base', 'HEAD', opt('--base') ?? 'origin/main')[0]
    changed = git('diff', '--name-only', base)
    problems = checkEvidence({ changed, added: git('diff', '--name-only', '--diff-filter=AMR', base), uiPaths, picturesUnder: opt('--pictures-under') })
  } catch (error) {
    console.error(`could not read the change from git (is --base, default origin/main, fetched?): ${error.message.split('\n')[0]}`)
    return 2
  }
  if (!changed.some(p => isUiPath(p, uiPaths))) {
    console.log(`${key}: no UI path changed, nothing to check`)
    return 0
  }
  if (problems.length > 0) {
    console.error(`${key}: pictures are committed:`)
    for (const p of problems) console.error(`- ${p}`)
    return 1
  }
  try {
    const repository = opt('--repository') ?? /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(git('remote', 'get-url', 'origin')[0] ?? '')?.[1]
    if (!repository) throw new Error('the repository is not known: pass --repository <owner/name>')
    const names = await listPictures({ repository, ticket: key, url: env.TICKIT_MCP_URL || 'https://mcp.tick-it.dev/mcp', token: env.TICKIT_TOKEN, send })
    problems = checkPictures({ pictures: names, touches: list('--touches'), fresh: list('--new') })
  } catch (error) {
    console.error(`${key}: could not check the uploaded pictures: ${error.message}`)
    return 2
  }
  if (problems.length > 0) {
    console.error(`${key}: uploaded pictures are missing:`)
    for (const p of problems) console.error(`- ${p}`)
    return 1
  }
  console.log(`${key}: no pictures committed, every required before and after is uploaded`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
