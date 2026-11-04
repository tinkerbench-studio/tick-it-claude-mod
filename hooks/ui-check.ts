import type { EngineInterface } from 'claude-code'
import { touchesUi } from './ui-evidence'

/** The pictures `ui:compare` writes and a session commits, per ticket. */
export const SHOTS_DIR = 'docs/change-screenshots'
/** Where `design-canvas:shots` writes the board-beside-story pictures (not committed: reports/ is ignored). */
export const BOARD_SHOTS_DIR = 'reports/design-canvas/shots'
const IMAGE = /\.(png|jpe?g|webp|gif)$/i
/** A changed canvas board (copy or map entry), which has a story to draw beside it. */
const BOARD = /(^|\/)design\/canvas\/boards\/[^/]+\.(map\.json|dc\.html)$/

/** What is missing for a UI change to be reviewed: one line each, with how to produce it. Empty when the evidence is there or the change touches no UI. */
export function uiEvidenceProblems(input: { ticket: string; changed: readonly string[]; committed: readonly string[]; boardShots: readonly string[]; /** The pull request description; '' for a branch with no pull request yet; null when it could not be read (the description is then not checked). */ description: string | null }): string[] {
  if (!touchesUi(input.changed.join('\n'))) return []
  const folder = `${SHOTS_DIR}/${input.ticket}`
  const how = 'See "Showing a UX change" in docs/design-system.md'
  const problems: string[] = []
  const images = input.committed.filter(p => p.startsWith(`${folder}/`) && IMAGE.test(p))
  if (images.length === 0)
    problems.push(
      `${folder} has no picture on the branch (before/after images from ui:compare; a story the change adds may carry its after alone). Take the before from the merge base (git fetch origin && git worktree add ../tick-it-base "$(git merge-base HEAD origin/main)", then npm run ui:shots -- shots/before ../tick-it-base/apps/web/src) and the after from the branch (npm run ui:shots -- shots/after), run npm run ui:compare -- shots/before shots/after ${folder}, then commit them there. ${how}.`,
    )
  const boards = input.changed.filter(p => BOARD.test(p))
  // The pictures may sit in the ignored reports folder or be committed beside the before/after images (board-beside-story-*.png).
  const besideStory = input.boardShots.some(p => p.endsWith('-side-by-side.png')) || images.some(p => /board-beside-story|side-by-side/i.test(p))
  if (boards.length > 0 && !besideStory) problems.push(`This branch changes a canvas board or board-map entry (${boards.slice(0, 3).join(', ')}) but neither ${BOARD_SHOTS_DIR} nor ${folder} has board-beside-story pictures. Run npm run build-storybook, then npm run design-canvas:shots. ${how}.`)
  const missing = images.filter(p => !(input.description ?? '').includes(p))
  if (input.description !== null && images.length > 0 && missing.length > 0) problems.push(`The pull request description does not list ${missing.length === 1 ? 'this image' : 'these images'} by path: ${missing.join(', ')}. Open the pull request if there is none, then list each one per line as plain text (no image markup) and name every visible difference. ${how}.`)

  return problems
}

/** Runs a command and returns its output lines, or null when it cannot run or fails. */
async function lines($: EngineInterface, argv: string[]): Promise<string[] | null> {
  try {
    const ran = await $.process.run(argv)
    return ran.exitCode === 0 ? ran.stdout.split('\n').filter(l => l !== '') : null
  } catch {
    return null
  }
}

/**
 * The refusal text for a ticket going to review with a UI change and missing evidence, or undefined.
 * Never throws and lets a change through when git cannot answer: a check that cannot run must not stop a ticket.
 * The pull request description is read with gh; with no pull request yet, every listed image is missing from it.
 */
export async function uiEvidenceRefusal($: EngineInterface, ticket: string, changed: readonly string[]): Promise<string | undefined> {
  if (!touchesUi(changed.join('\n'))) return undefined
  const committed = await lines($, ['git', 'ls-tree', '-r', '--name-only', 'HEAD', '--', `${SHOTS_DIR}/${ticket}`])
  const boardShots = await lines($, ['git', 'ls-files', '--cached', '--others', '--ignored', '--exclude-standard', '--', BOARD_SHOTS_DIR])
  // Git that cannot answer lets the move through; so does gh that cannot (not installed, not signed in): only its description is then left unchecked.
  if (committed === null || boardShots === null) return undefined
  let description: string | null = null
  try {
    const ran = await $.process.run(['gh', 'pr', 'view', '--json', 'body'])
    if (ran.exitCode === 0) description = (JSON.parse(ran.stdout) as { body?: unknown }).body?.toString() ?? ''
    else if (/no pull requests? found/i.test(ran.stderr)) description = ''
  } catch {
    // gh did not start, or printed no JSON: the description is not checked.
  }
  const problems = uiEvidenceProblems({ ticket, changed, committed, boardShots, description })
  if (problems.length === 0) return undefined

  return `${ticket} changes the UI, so it is not ready for review. Fix ${problems.length === 1 ? 'this' : 'these'}, then move it to In review again:\n${problems.map(p => `- ${p}`).join('\n')}`
}
