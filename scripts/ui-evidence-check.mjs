// The branch side of the UI evidence check: a UI change must not commit its pictures, and must have uploaded a before and an after of each thing it touches:
//   node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>] [--pictures-under <folder>] [--repository <owner/name>]
// The UI path globs are `design.uiPaths` of the repository's .tick-it/config.json, the file Tick-it's GitHub App reads
// (--config names another). With none, the built-in tick-it paths of scripts/ui-paths.mjs apply, as at the gate.
// A change that touches no UI path passes at once, without asking Tick-it. For one that does, it fails when:
// 1. a picture file (PNG, JPEG, GIF, WebP) is added or changed under --pictures-under (default docs/change-screenshots/): upload with
//    presign_screenshot_upload and confirm_screenshot (scripts/upload-screenshots.mjs), never commit;
// 2. a story (*.stories.tsx) or page (a pages/ folder, or pages.tsx) the change touches lacks a before or an after picture for a variant
//    listed in scripts/ui-evidence-required.json (the one list; the check reads no other). It reads the ticket's uploaded pictures from
//    Tick-it (list_screenshots, over the MCP server at TICKIT_MCP_URL, default https://mcp.tick-it.dev/mcp, with the token in TICKIT_TOKEN)
//    and names each missing one. A picture counts when its name holds the story or page, the variant and "before" or "after"
//    (<page>-dark-before-after.png from ui:compare counts as both);
// 3. Tick-it cannot be reached, or there is no TICKIT_TOKEN: it fails and says so; it never passes unchecked.
// Exit 0 when it passes, 1 when evidence is missing, committed or unreadable, 2 on a wrong call.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
import { globToRegExp, isTestOnlyChange, isUiPath, patchLines } from './ui-paths.mjs'

const DEFAULT_PICTURES = 'docs/change-screenshots/'
const DEFAULT_MCP = 'https://mcp.tick-it.dev/mcp'
export const REQUIRED = JSON.parse(readFileSync(new URL('./ui-evidence-required.json', import.meta.url), 'utf8'))
const IMAGE = /\.(png|jpe?g|gif|webp)$/i

export { globToRegExp, isUiPath, main }

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

const slug = text => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-')

/** The stories and pages a change touches, as slugs: a story's file name without ".stories", a page's file name (pages/<name>.tsx, or pages.tsx). */
export function subjectsOf(changed) {
  const names = changed.flatMap(p => {
    const base = p.split('/').pop().replace(/\.[^.]+$/, '')
    if (/\.stories\.[jt]sx?$/.test(p)) return [base.replace(/\.stories$/, '')]
    return /(^|\/)pages?\/[^/]+\.[jt]sx?$/.test(p) || /(^|\/)pages\.[jt]sx?$/.test(p) ? [base] : []
  })
  return [...new Set(names.map(slug))]
}

/** One line for each missing picture: a touched subject with no before or after among the uploaded names, for each required variant. */
export function missingPictures({ subjects, names, variants = REQUIRED.variants }) {
  const tokens = names.map(n => `-${slug(n.replace(/\.[^.]+$/, ''))}-`)
  return subjects.flatMap(subject =>
    variants.flatMap(variant =>
      ['before', 'after'].filter(side => !tokens.some(t => t.includes(`-${subject}-`) && t.includes(`-${variant}-`) && t.includes(`-${side}-`))).map(side => `${subject} has no ${side} picture for ${variant} uploaded to Tick-it`),
    ),
  )
}

/** The names of the ticket's uploaded pictures, from list_screenshots over the MCP server. Throws with why it could not. */
export async function readPictures({ url, token, repository, ticket, send = fetch }) {
  let id = 0
  let session
  const rpc = async (method, params, notify = false) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session } : {}) }
    const res = await send(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++id }) }) })
    if (!res.ok) throw new Error(`Tick-it answered ${res.status}${res.status === 401 ? ' (the token was refused)' : ''}`)
    session = res.headers.get('mcp-session-id') ?? session
    if (notify) return undefined
    const text = await res.text()
    const line = (res.headers.get('content-type') ?? '').includes('event-stream') ? text.split('\n').find(l => l.startsWith('data:'))?.slice(5) : text
    const body = JSON.parse(line ?? 'null')
    if (body?.error) throw new Error(body.error.message ?? 'Tick-it refused the call')
    return body?.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ui-evidence-check', version: '1' } })
  await rpc('notifications/initialized', {}, true)
  const result = await rpc('tools/call', { name: 'list_screenshots', arguments: { repository, ticket } })
  const text = result?.content?.find(b => b.type === 'text')?.text
  const value = result?.structuredContent ?? (text ? JSON.parse(text) : null)
  if (result?.isError || !Array.isArray(value?.screenshots)) throw new Error(result?.isError ? (text ?? 'list_screenshots was refused') : 'list_screenshots gave no list')
  return value.screenshots.map(s => String(s?.name ?? ''))
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)

async function main(argv, env = process.env, send = fetch) {
  const [key, ...rest] = argv
  const opt = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
  const badOption = ['--base', '--config', '--pictures-under', '--repository'].some(n => rest.includes(n) && (!opt(n) || opt(n).startsWith('--')))
  if (!/^[A-Za-z]+-[1-9]\d*$/.test(key ?? '') || badOption) {
    console.error('usage: node scripts/ui-evidence-check.mjs <TCK-key> [--base <ref>] [--config <file>] [--pictures-under <folder>] [--repository <owner/name>]')
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
  const touchesUi = p => isUiPath(p, uiPaths) && !isTestOnlyChange(p, lines.get(p))
  if (!changed.some(touchesUi)) {
    console.log(`${key}: no UI path changed, nothing to check`)
    return 0
  }
  const subjects = subjectsOf(changed.filter(touchesUi))
  const repository = opt('--repository') ?? /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(git('remote', 'get-url', 'origin').at(0) ?? '')?.[1]
  if (!repository) {
    console.error('which repository is the ticket in? Pass --repository <owner/name>')
    return 2
  }
  if (!env.TICKIT_TOKEN) problems.push('cannot check the uploaded pictures: no TICKIT_TOKEN is set, so Tick-it (list_screenshots) was not asked')
  else {
    try {
      problems.push(...missingPictures({ subjects, names: await readPictures({ url: env.TICKIT_MCP_URL || DEFAULT_MCP, token: env.TICKIT_TOKEN, repository, ticket: key, send }) }))
    } catch (error) {
      problems.push(`cannot check the uploaded pictures: Tick-it could not be reached or refused list_screenshots (${error.message})`)
    }
  }
  if (problems.length === 0) {
    console.log(`${key}: no pictures committed, and a before and an after are uploaded for ${subjects.length} stories and pages in ${REQUIRED.variants.join(', ')}`)
    return 0
  }
  console.error(`${key}: the UI evidence is not complete:`)
  for (const p of problems) console.error(`- ${p}`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
