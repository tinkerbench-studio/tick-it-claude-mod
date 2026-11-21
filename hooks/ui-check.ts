import type { EngineInterface } from 'claude-code'
import { touchesUi } from './ui-evidence'
import { isTestOnlyChange } from '../scripts/ui-paths.mjs'
import { callTickit, repositoryHere, uiPathsHere } from './tickit'
import type { UiPaths } from './ui-evidence'

/** A changed canvas board (copy or map entry), which has a story to draw beside it. */
const BOARD = /(^|\/)design\/canvas\/boards\/[^/]+\.(map\.json|dc\.html)$/
/** A board-beside-story picture, by the name docs/design-system.md gives it. */
const BESIDE_STORY = /(^|\/)board-beside-story-[^/]+$/

/** A confirmed picture of a ticket, as Tick-it's list_screenshots names it. */
export type Picture = { key: string; name: string }

/** What is missing for a UI change to be reviewed: one line each, with how to produce it. Empty when the pictures are there or the change touches no UI. The pictures are the ticket's confirmed ones in Tick-it; the repository and the pull request description are never read. */
export function uiEvidenceProblems(input: { ticket: string; changed: readonly string[]; pictures: readonly Picture[]; uiPaths?: UiPaths }): string[] {
  if (!touchesUi(input.changed.join('\n'), input.uiPaths ?? null)) return []
  const how =
    'Every command named here ships with the drawing-board package, in every repository that uses it: run it as the project does (npx drawing-board <command>, or the project\'s own script for it). If one cannot start a browser, run drawing-board browser, set what it names ("Which Chromium" in the drawing-board README), and report the command and its error on the ticket; do not write a screenshot script of your own. See the drawing-board:ux-picture skill and the design workflow doc that get_repository_settings names'
  const problems: string[] = []
  if (input.pictures.length === 0)
    problems.push(
      `${input.ticket} has no confirmed picture in Tick-it (list_screenshots). Take the before from the merge base (git fetch origin && git worktree add ../base "$(git merge-base HEAD origin/main)", then build its Storybook there) and the after from the branch: drawing-board story-shot <storybook-dir> <story-id> shots/before/<name>.png for each story the change touches (the same into shots/after from the branch's build; drawing-board page-shots for pages, where the project has a pages() hook). Run drawing-board compare-pictures shots/before shots/after shots/compare, then upload each image in shots/compare with presign_screenshot_upload and confirm_screenshot. Do not commit the pictures. ${how}.`,
    )
  const boards = input.changed.filter(p => BOARD.test(p))
  if (boards.length > 0 && !input.pictures.some(p => BESIDE_STORY.test(p.name) || BESIDE_STORY.test(p.key)))
    problems.push(`This branch changes a canvas board or board-map entry (${boards.slice(0, 3).join(', ')}) but list_screenshots shows no picture named board-beside-story-*. Build Storybook, then run drawing-board annotate --board <Board>.dc.html --theme dark --out reports/design-canvas/dark and the same with --theme light --out reports/design-canvas/light, copy each reports/design-canvas/dark/shots/<Board>-side-by-side.png to shots/compare/board-beside-story-<Board>.png and each reports/design-canvas/light/shots/<Board>-side-by-side.png to shots/compare/board-beside-story-<Board>-light.png (the name the check looks for), and upload those with presign_screenshot_upload and confirm_screenshot. ${how}.`)

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
 * The refusal text for a ticket going to review with a UI change and missing pictures, or undefined.
 * Pictures live in Tick-it, so it asks Tick-it (list_screenshots) and runs no git or gh command to look for them.
 * Never throws and lets a change through when Tick-it cannot answer: a check that cannot run must not stop a ticket.
 */
export async function uiEvidenceRefusal($: EngineInterface, ticket: string, allChanged: readonly string[], content: readonly { path: string; lines: string }[] = []): Promise<string | undefined> {
  // A story or .storybook/ change that only waits, asserts or comments is a test change: it shows nothing a person sees, so it needs no pictures.
  const lines = new Map(content.map(f => [f.path, f.lines]))
  const changed = allChanged.filter(p => !isTestOnlyChange(p, lines.get(p)))
  let pictures: Picture[] | null = null
  let uiPaths: UiPaths = null
  try {
    const repository = await repositoryHere($)
    if (repository === undefined) return undefined
    // The repository's own design.uiPaths decide what a UI change is, the same globs scripts/ui-evidence-check.mjs reads.
    uiPaths = await uiPathsHere($, repository)
    if (!touchesUi(changed.join('\n'), uiPaths)) return undefined
    const got = await callTickit($, 'list_screenshots', { repository, ticket })
    if (got.ok) pictures = picturesOf(got.value)
  } catch {
    // Tick-it did not answer: nothing is refused.
  }
  if (pictures === null) return undefined
  const problems = uiEvidenceProblems({ ticket, changed, pictures, uiPaths })
  if (problems.length === 0) return undefined

  return `${ticket} changes the UI, so it is not ready for review. Fix ${problems.length === 1 ? 'this' : 'these'}, then move it to In review again:\n${problems.map(p => `- ${p}`).join('\n')}`
}
