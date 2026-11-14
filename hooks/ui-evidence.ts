/**
 * The UI-evidence checklist: acceptance criteria a ticket that changes a page or component carries from the
 * start, so the ux-evidence reviewer finds its deliverables in round 1 and not as blocking findings.
 * The brief adds it, and /tick-it:draft-ticket and /tick-it:plan-epic write it into the criteria
 * (docs/design-system.md, "Showing a UX change").
 */
export const UI_EVIDENCE_CHECKLIST: readonly string[] = [
  "UI evidence: the canvas board, the board's design/canvas/boards/<Board>.map.json (board-map entry) and the canvas snapshot are updated for what changed, and the drawing-board canvas-sync skill's check and compare steps (design-canvas:check, design-canvas:compare) pass",
  'UI evidence: every new or changed component state has a Storybook story',
  'UI evidence: dark, light and mobile (390 px) pictures of what changed are taken, with before/after images (changes outlined) uploaded to Tick-it with presign_screenshot_upload and confirm_screenshot, not committed',
  'UI evidence: Tick-it posts the ticket comment linking the images with the pull request link, so you do not',
  'UI evidence: the pull request description lists each before/after image by its object key as plain text (no image markup) and names every visible difference',
]

/**
 * Paths a ticket that changes what a person sees touches: the web app's pages and components (not its server code or
 * tests), the design system or canvas, a story or a stylesheet. A path may follow a space, a quote, a bracket, "./" or a directory.
 */
const UI_PATH = /(^|[^\w-])apps\/web\/src\/(design\/|(pages|client|links|markdown|pictures|render|style|dropzone)\.tsx?\b)|(?<![\w-]|docs\/)design\/|\.storybook\/|[\w./-]*\.stories\.tsx?\b|[\w./-]*\.css(\.ts)?(?![\w-])/

/** A glob ("**" crosses folders, "*" and "?" stay in one) as a regular expression on a whole path: the same reading as globToRegExp in scripts/ui-evidence-check.mjs. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** The repository's UI globs (design.uiPaths of .tick-it/config.json, as get_repository_settings gives them in config) when any are set; null otherwise, which means the built-in paths. */
export type UiPaths = readonly string[] | null

/** The path-like words of a text: split at spaces, quotes, brackets and commas, with a leading "./" and trailing punctuation dropped. */
const wordsOf = (text: string): string[] => text.split(/[\s"'`()[\],;<>]+/).map(w => w.replace(/^\.\//, '').replace(/[.:]+$/, '')).filter(w => w !== '')

/**
 * True when the text (file paths, or a ticket's title, description and acceptance) names a web page or component, a design file, a story or a stylesheet.
 * With the repository's design.uiPaths it is a word of the text matching one of those globs; with none, the built-in tick-it paths.
 * Words alone ("page", "board") do not count: Tick-it's own tickets use them for the API and docs.
 */
export const touchesUi = (text: string, uiPaths: UiPaths = null): boolean => {
  if (uiPaths === null || uiPaths.length === 0) return UI_PATH.test(text)
  const globs = uiPaths.map(globToRegExp)
  // Each line whole first (the gate passes one changed path a line, and a path may hold brackets or parentheses, as Next.js routes do), then the words of prose.
  return [...text.split('\n').map(l => l.trim()), ...wordsOf(text)].some(w => w !== '' && globs.some(g => g.test(w)))
}

/** True when the criteria already carry the checklist (any line beginning "UI evidence:"). */
export const hasUiEvidence = (acceptance: readonly string[]): boolean => acceptance.some(a => a.startsWith('UI evidence:'))

/** The criteria with the checklist added when the ticket touches the UI and does not carry it; unchanged otherwise. */
export const withUiEvidence = (acceptance: readonly string[], text = acceptance.join('\n'), uiPaths: UiPaths = null): string[] => (touchesUi(text, uiPaths) && !hasUiEvidence(acceptance) ? [...acceptance, ...UI_EVIDENCE_CHECKLIST] : [...acceptance])
