#!/usr/bin/env node
/**
 * The "Plugin version" merge check: `node scripts/plugin-version.mjs [base]`.
 *
 * Fails when a plugin path (hooks/, skills/, types/, .claude-plugin/plugin.json) differs from the base and `version` in
 * .claude-plugin/plugin.json is not above the base's. A pull request does not raise the version itself: the merge queue
 * rebases the head onto main, this check fails there, and the ticket's session raises it (.claude/skills/version-raise).
 * The base is the first argument, else origin/$GITHUB_BASE_REF, else origin/main.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_PATHS = ['hooks', 'skills', 'types', '.claude-plugin/plugin.json']

/** True when `a` is above `b`, comparing the dot-separated numbers one by one. */
export const isAbove = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const versionAt = ref => JSON.parse(git('show', `${ref}:.claude-plugin/plugin.json`)).version

/** What is wrong, or null when the check passes. */
export const problem = base => {
  const changed = git('diff', '--name-only', `${base}...HEAD`, '--', ...PLUGIN_PATHS).trim()
  if (changed === '') return null
  const old = versionAt(base)
  const now = JSON.parse(git('show', 'HEAD:.claude-plugin/plugin.json')).version
  return isAbove(now, old) ? null : `The plugin changed but version is ${now}, not above ${old} on ${base}. Raise it (.claude/skills/version-raise/SKILL.md).`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? `origin/${process.env.GITHUB_BASE_REF || 'main'}`
  const why = problem(base)
  if (why !== null) console.error(why)
  process.exit(why === null ? 0 : 1)
}
