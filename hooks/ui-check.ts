import type { EngineInterface } from 'claude-code'
import { touchesUi } from './ui-evidence'
import { callTickit, repositoryHere } from './tickit'

/** A changed canvas board (copy or map entry), which has a story to draw beside it. */
const BOARD = /(^|\/)design\/canvas\/boards\/[^/]+\.(map\.json|dc\.html)$/
/** A board-beside-story picture, by the name docs/design-system.md gives it. */
const BESIDE_STORY = /(^|\/)board-beside-story-[^/]+$/

/** A confirmed picture of a ticket, as Tick-it's list_screenshots names it. */
export type Picture = { key: string; name: string }

/** What is missing for a UI change to be reviewed: one line each, with how to produce it. Empty when the pictures are there or the change touches no UI. The pictures are the ticket's confirmed ones in Tick-it; the repository and the pull request description are never read. */
export function uiEvidenceProblems(input: { ticket: string; changed: readonly string[]; pictures: readonly Picture[] }): string[] {
  if (!touchesUi(input.changed.join('\n'))) return []
  const how = 'See "Showing a UX change" in docs/design-system.md'
  const problems: string[] = []
  if (input.pictures.length === 0)
    problems.push(
      `${input.ticket} has no confirmed picture in Tick-it (list_screenshots). Take the before from the merge base (git fetch origin && git worktree add ../tick-it-base "$(git merge-base HEAD origin/main)", then npm run ui:shots -- shots/before ../tick-it-base/apps/web/src) and the after from the branch (npm run ui:shots -- shots/after), run npm run ui:compare -- shots/before shots/after shots/compare, then upload each image in shots/compare with presign_screenshot_upload and confirm_screenshot. Do not commit the pictures. ${how}.`,
    )
  const boards = input.changed.filter(p => BOARD.test(p))
  if (boards.length > 0 && !input.pictures.some(p => BESIDE_STORY.test(p.name) || BESIDE_STORY.test(p.key)))
    problems.push(`This branch changes a canvas board or board-map entry (${boards.slice(0, 3).join(', ')}) but list_screenshots shows no picture named board-beside-story-*. Run npm run build-storybook, then npm run design-canvas:shots, copy each reports/design-canvas/shots/<Board>[-light]-side-by-side.png to shots/compare/board-beside-story-<Board>[-light].png (the name the check looks for), and upload those with presign_screenshot_upload and confirm_screenshot. ${how}.`)

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
export async function uiEvidenceRefusal($: EngineInterface, ticket: string, changed: readonly string[]): Promise<string | undefined> {
  if (!touchesUi(changed.join('\n'))) return undefined
  let pictures: Picture[] | null = null
  try {
    const repository = await repositoryHere($)
    if (repository === undefined) return undefined
    const got = await callTickit($, 'list_screenshots', { repository, ticket })
    if (got.ok) pictures = picturesOf(got.value)
  } catch {
    // Tick-it did not answer: nothing is refused.
  }
  if (pictures === null) return undefined
  const problems = uiEvidenceProblems({ ticket, changed, pictures })
  if (problems.length === 0) return undefined

  return `${ticket} changes the UI, so it is not ready for review. Fix ${problems.length === 1 ? 'this' : 'these'}, then move it to In review again:\n${problems.map(p => `- ${p}`).join('\n')}`
}
