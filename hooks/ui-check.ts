import type { EngineInterface } from 'claude-code'
import { touchesUi } from './ui-evidence'
import { globToRegExp, isTestOnlyChange } from '../scripts/ui-paths.mjs'
import { REQUIRED_TIMEOUT_MAX_MS, REQUIRED_TIMEOUT_MS, commandText, parseRequired, plain, uncovered, uncoveredLines } from '../scripts/required-pictures.mjs'
import { callTickit, designHere, repositoryHere } from './tickit'
import type { Design } from './ui-evidence'

/** A confirmed picture of a ticket, as Tick-it's list_screenshots names it. */
export type Picture = { key: string; name: string }

/** A picture's file name: its name, else the last part of its key. */
const fileName = (p: Picture): string => p.name || p.key.split('/').pop() || ''

/**
 * What is missing for a UI change to be reviewed: one line each. Empty when the pictures are there or the change touches
 * none of the repository's UI paths. What is asked for is the repository's own: any one confirmed picture of a UI
 * change, and each picture its design.pictures rules name for the paths the change touches. How to make them is the
 * repository's design workflow doc, never the mod's. The pictures are the ticket's confirmed ones in Tick-it; the
 * repository and the pull request description are never read.
 */
export function uiEvidenceProblems(input: { ticket: string; changed: readonly string[]; pictures: readonly Picture[]; design?: Design | null; requiredLines?: readonly string[] }): string[] {
  const design = input.design ?? null
  if (design === null || !touchesUi(input.changed.join('\n'), design)) return []
  const how = `${design.workflow ? `This repository's design workflow (${design.workflow}) says how to make them` : "This repository's ux-evidence review skill says what they show"}. If a step cannot run, report the command and its error on the ticket rather than writing a screenshot script of your own`
  const problems: string[] = []
  if (input.pictures.length === 0)
    problems.push(`${input.ticket} has no confirmed picture in Tick-it (list_screenshots). Upload the before/after pictures of what changed with presign_screenshot_upload and confirm_screenshot: pictures are uploaded, never committed. ${how}.`)
  for (const rule of design.pictures) {
    const whens = rule.when.map(globToRegExp)
    const touched = input.changed.filter(p => whens.some(g => g.test(p)))
    if (touched.length === 0) continue
    const named = globToRegExp(rule.name)
    if (input.pictures.some(p => named.test(fileName(p)))) continue
    problems.push(`This branch changes ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ` and ${touched.length - 3} more` : ''}, so this repository asks for a picture named ${rule.name}, and list_screenshots shows none.${rule.why === undefined ? '' : ` ${rule.why}`} ${how}.`)
  }
  // Each required picture the repository's design command lists with no confirmed picture, or why the command could not say.
  problems.push(...(input.requiredLines ?? []))
  return problems
}

/** The confirmed pictures from list_screenshots' answer, or null when the answer has no list in it. */
export function picturesOf(value: Record<string, unknown>): Picture[] | null {
  const list = value.screenshots
  if (!Array.isArray(list)) return null
  return list.flatMap(one => {
    if (typeof one !== 'object' || one === null) return []
    const { key, name } = one as { key?: unknown; name?: unknown }
    return [{ key: typeof key === 'string' ? key : '', name: typeof name === 'string' ? name : '' }]
  })
}

/**
 * The lines for the pictures the repository's design.requiredPictures command lists with no confirmed picture. The command runs
 * as an argument list with no shell, the changed paths one per line on stdin. A command that cannot run (non-zero exit, no
 * answer in 60 seconds, output that is not the contract) is a line saying so: it never lets the move through silently.
 */
export async function requiredLines($: EngineInterface, command: readonly string[], changed: readonly string[], pictures: readonly Picture[]): Promise<string[]> {
  const named = commandText(command)
  const unable = (why: string) => [`The repository's design.requiredPictures command (${named}) could not say which pictures are required: ${why}. Fix the command, or ask its owner, then move the ticket to In review again.`]
  try {
    let set = NaN
    try {
      set = Number(await $.env.get('TICK_IT_REQUIRED_TIMEOUT_MS'))
    } catch {
      // Unreadable: the default stands.
    }
    const ms = Number.isFinite(set) && set > 0 ? Math.min(set, REQUIRED_TIMEOUT_MAX_MS) : REQUIRED_TIMEOUT_MS
    const started = Date.now()
    let ran
    try {
      // The engine kills the child and rejects when timeoutMs passes (its default is 30 seconds, so the 60 is asked for).
      ran = await $.process.run([...command], { stdin: `${changed.join('\n')}\n`, timeoutMs: ms })
    } catch (error) {
      if (Date.now() - started >= ms * 0.9) return unable(`it did not finish in ${ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`}`)
      throw error
    }
    if (ran.isStdoutTruncated) return unable('its output was longer than the engine keeps')
    if (ran.exitCode !== 0) return unable(`it exited with ${ran.exitCode}${plain(ran.stderr) === '' ? '' : `: ${plain(ran.stderr)}`}`)
    let found: ReturnType<typeof parseRequired>
    try {
      found = parseRequired(ran.stdout)
    } catch (error) {
      // Its own fixed wording: it names no value the command printed.
      return unable((error as Error).message)
    }
    return uncoveredLines(uncovered(found.required, pictures.map(fileName)), found.touched)
  } catch (error) {
    return unable(plain(error instanceof Error ? error.message : String(error)))
  }
}

/**
 * The refusal text for a ticket going to review with a UI change and missing pictures, or undefined.
 * Pictures live in Tick-it, so it asks Tick-it (list_screenshots) and runs no git or gh command to look for them.
 * Never throws. A check that cannot run refuses, with the reason, and never passes silently: Tick-it not answering
 * get_repository_settings (with no design held for this repository) or list_screenshots, an answer with no list of
 * pictures, and git not listing the changed files (allChanged is then the reason, a string). Not checked at all:
 * a directory that is not a GitHub repository, and a repository whose settings answer with no design section.
 */
export async function uiEvidenceRefusal($: EngineInterface, ticket: string, allChanged: readonly string[] | string, content: readonly { path: string; lines: string }[] = []): Promise<string | undefined> {
  const stop = (what: string, why: string) => `${ticket} cannot go to review: the UI evidence check could not run, because ${what} (${why}). Move it to In review again once that works.`
  // A story or .storybook/ change that only waits, asserts or comments is a test change: it shows nothing a person sees, so it needs no pictures.
  const lines = new Map(content.map(f => [f.path, f.lines]))
  const changed = typeof allChanged === 'string' ? [] : allChanged.filter(p => !isTestOnlyChange(p, lines.get(p)))
  let pictures: Picture[] | null
  let design: Design | null
  try {
    const repository = await repositoryHere($)
    if (repository === undefined) return undefined
    // The repository's own design section decides what a UI change is (design.uiPaths, the same globs scripts/ui-evidence-check.mjs reads) and what it must carry; with none, nothing is asked.
    const got = await designHere($, repository)
    if (typeof got === 'string') return stop("the repository's design settings could not be read", got)
    design = got
    if (design === null) return undefined
    if (typeof allChanged === 'string') return stop('git could not list the changed files', allChanged)
    if (!touchesUi(changed.join('\n'), design)) return undefined
    const listed = await callTickit($, 'list_screenshots', { repository, ticket })
    if (!listed.ok) return stop("the ticket's pictures could not be listed (list_screenshots)", listed.why)
    pictures = picturesOf(listed.value)
    if (pictures === null) return stop("the answer from list_screenshots could not be read", 'it had no list of pictures')
  } catch (error) {
    return stop('the check itself failed', error instanceof Error ? error.message : String(error))
  }
  const required = design?.requiredPictures?.command
  const problems = uiEvidenceProblems({ ticket, changed, pictures, design, requiredLines: required === undefined ? [] : await requiredLines($, required, changed, pictures) })
  if (problems.length === 0) return undefined

  return `${ticket} changes the UI, so it is not ready for review. Fix ${problems.length === 1 ? 'this' : 'these'}, then move it to In review again:\n${problems.map(p => `- ${p}`).join('\n')}`
}
