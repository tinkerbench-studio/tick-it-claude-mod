#!/usr/bin/env node
/**
 * The "Plugin version" merge check: `node scripts/plugin-version.mjs [base]`.
 *
 * Fails when a pull request changes the plugin's version: `version` in .claude-plugin/plugin.json, `MOD_VERSION` in
 * hooks/state.ts or `modVersion` in tests/contract-fixtures.json differ from the base's. A change to hooks/, skills/,
 * types/ or plugin.json passes with the version as it is: the release job raises it after the merge
 * (scripts/raise-version.mjs, .github/workflows/release.yml).
 * The base is the first argument, else origin/$GITHUB_BASE_REF, else origin/main.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_PATHS = ['hooks', 'skills', 'types', '.claude-plugin/plugin.json']

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const at = (ref, file) => git('show', `${ref}:${file}`)
const versions = ref => [
  JSON.parse(at(ref, '.claude-plugin/plugin.json')).version,
  /MOD_VERSION = '([^']+)'/.exec(at(ref, 'hooks/state.ts'))?.[1],
  /"modVersion": "([^"]+)"/.exec(at(ref, 'tests/contract-fixtures.json'))?.[1],
]

/** What is wrong, or null when the check passes. */
export const problem = base => {
  const [old, now] = [versions(base), versions('HEAD')]
  return old.every((v, i) => v === now[i]) ? null : `This pull request changes the plugin version (${old[0]} on ${base}, ${now[0]} here). Leave it: the release job raises it after the merge (.claude/skills/version-raise/SKILL.md).`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? `origin/${process.env.GITHUB_BASE_REF || 'main'}`
  const why = problem(base)
  if (why !== null) console.error(why)
  process.exit(why === null ? 0 : 1)
}
