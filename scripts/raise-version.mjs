#!/usr/bin/env node
/**
 * The release job's raise: `node scripts/raise-version.mjs <before> [after]` after a merge to main.
 *
 * When a plugin path (hooks/, skills/, types/, .claude-plugin/plugin.json) differs between <before> and [after] (default HEAD), raises the
 * patch version in the three copies that must agree (`version` in .claude-plugin/plugin.json, `MOD_VERSION` in
 * hooks/state.ts, `modVersion` in tests/contract-fixtures.json) and prints the new version; prints nothing when there is
 * nothing to raise. It only edits files: .github/workflows/release.yml commits, tags and releases.
 * A pull request never changes the version (scripts/plugin-version.mjs fails one that does).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLUGIN_PATHS } from './plugin-version.mjs'

export const FILES = { plugin: '.claude-plugin/plugin.json', state: 'hooks/state.ts', fixtures: 'tests/contract-fixtures.json' }

/** `0.50.20` becomes `0.50.21`. */
export const nextPatch = version => {
  const parts = version.split('.')
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
  return parts.join('.')
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

/** Raises the three copies in `cwd` when a plugin path changed since `before`; the new version, or null. */
export const raise = (before, cwd = process.cwd(), after = 'HEAD') => {
  if (git(cwd, 'diff', '--name-only', `${before}..${after}`, '--', ...PLUGIN_PATHS).trim() === '') return null
  const current = JSON.parse(readFileSync(`${cwd}/${FILES.plugin}`, 'utf8')).version
  const next = nextPatch(current)
  const once = (file, pattern) => {
    const text = readFileSync(`${cwd}/${file}`, 'utf8')
    if (!pattern.test(text)) throw new Error(`${file} has no ${pattern}`)
    return [file, text.replace(pattern, (_, a, b) => `${a}${next}${b}`)]
  }
  // Every copy is read and checked before any is written, so a failure leaves all three as they were.
  const edits = [once(FILES.plugin, /("version": ")[^"]+(")/), once(FILES.state, /(MOD_VERSION = ')[^']+(')/), once(FILES.fixtures, /("modVersion": ")[^"]+(")/)]
  for (const [file, text] of edits) writeFileSync(`${cwd}/${file}`, text)
  return next
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = raise(process.argv[2], process.cwd(), process.argv[3])
  if (next !== null) console.log(next)
}
