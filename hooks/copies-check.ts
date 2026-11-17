import type { EngineInterface } from 'claude-code'

/** The script a repository adds to its package.json to have the mod run it before a ticket goes to review. */
export const COPIES_SCRIPT = 'copies:check'
/** How long the check may run before it counts as one that could not run; TICK_IT_COPIES_TIMEOUT_MS sets it in milliseconds (a test shortens it). */
export const COPIES_TIMEOUT_MS = 120_000
/** The most of the check's output shown in the refusal. */
const MAX_OUTPUT = 4000

/** What the stale-copy check came to: nothing to run, passed, failed with its output, or could not run (with why). */
export type CopiesResult = { kind: 'none' } | { kind: 'passed' } | { kind: 'failed'; output: string } | { kind: 'unrun'; why: string }

/**
 * Runs the repository's own `copies:check` script (npm run copies:check) when its package.json has one.
 * A repository without the script is not checked. A check that cannot be started (no node_modules, npm missing, a timeout) is `unrun`, never a failure: it must not stop a ticket.
 */
export async function runCopiesCheck($: EngineInterface): Promise<CopiesResult> {
  let script: unknown
  try {
    if (!(await $.fs.exists('package.json'))) return { kind: 'none' }
    const scripts = (JSON.parse(String(await $.fs.read('package.json'))) as { scripts?: Record<string, unknown> } | null)?.scripts
    script = scripts?.[COPIES_SCRIPT]
  } catch {
    return { kind: 'none' }
  }
  if (typeof script !== 'string' || script.trim() === '') return { kind: 'none' }
  try {
    if (!(await $.fs.exists('node_modules'))) return { kind: 'unrun', why: 'node_modules is missing (npm install first)' }
    let set = NaN
    try {
      set = Number(await $.env.get('TICK_IT_COPIES_TIMEOUT_MS'))
    } catch {
      // Unreadable: the default stands.
    }
    const timeoutMs = Number.isFinite(set) && set > 0 ? set : COPIES_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), timeoutMs)
    })
    const ran = await Promise.race([$.process.run(['npm', 'run', COPIES_SCRIPT]), late]).finally(() => clearTimeout(timer))
    if (ran === 'late') return { kind: 'unrun', why: `it did not finish in ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}` }
    // The shell's "command not found": npm itself did not start.
    if (ran.exitCode === 127) return { kind: 'unrun', why: 'npm could not be started' }
    if (ran.exitCode === 0) return { kind: 'passed' }
    const output = `${ran.stdout}\n${ran.stderr}`.trim()
    return { kind: 'failed', output: output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n… (output cut)` : output }
  } catch (error) {
    return { kind: 'unrun', why: `it could not be started: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The refusal for a ticket whose repository's copies:check fails: the hits it printed, and the ticket stays as it is. */
export function copiesRefusal(ticket: string, output: string): string {
  return `${ticket} is not ready for review: the repository's stale-copy check (npm run ${COPIES_SCRIPT}) fails. Fix each hit it lists, run it again until it exits 0, then move ${ticket} to In review again:\n${output === '' ? '(it printed nothing)' : output}`
}

/** The line saying the check could not run, shown with a move that went through. */
export function copiesNote(why: string): string {
  return `The stale-copy check (npm run ${COPIES_SCRIPT}) could not run: ${why}. Run it yourself before review.`
}
