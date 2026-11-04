/**
 * The UI-evidence checklist: acceptance criteria a ticket that changes a page or component carries from the
 * start, so the ux-evidence reviewer finds its deliverables in round 1 and not as blocking findings.
 * The brief adds it, and /tick-it:draft-ticket and /tick-it:plan-epic write it into the criteria
 * (docs/design-system.md, "Showing a UX change").
 */
export const UI_EVIDENCE_CHECKLIST: readonly string[] = [
  "UI evidence: the canvas board, the board's design/canvas/boards/<Board>.map.json (board-map entry) and the canvas snapshot are updated for what changed, and the drawing-board canvas-sync skill's check and compare steps (design-canvas:check, design-canvas:compare) pass",
  'UI evidence: every new or changed component state has a Storybook story',
  'UI evidence: dark, light and mobile (390 px) pictures of what changed are taken, with before/after images (changes outlined) committed in docs/change-screenshots/<TCK-key>',
  'UI evidence: Tick-it posts the ticket comment linking the images with the pull request link, so you do not',
  'UI evidence: the pull request description lists each before/after image by its path as plain text (no image markup) and names every visible difference',
]

/**
 * Paths a ticket that changes what a person sees touches: the web app's pages and components (not its server code or
 * tests), the design system or canvas, a story or a stylesheet. A path may follow a space, a quote, a bracket, "./" or a directory.
 */
const UI_PATH = /(^|[^\w-])apps\/web\/src\/(design\/|(pages|client|links|markdown|pictures|render|style|dropzone)\.tsx?\b)|(?<![\w-]|docs\/)design\/|\.storybook\/|[\w./-]*\.stories\.tsx?\b|[\w./-]*\.css(\.ts)?(?![\w-])/

/** True when the text (file paths, or a ticket's title, description and acceptance) names a web page or component, a design file, a story or a stylesheet. Words alone ("page", "board") do not count: Tick-it's own tickets use them for the API and docs. */
export const touchesUi = (text: string): boolean => UI_PATH.test(text)

/** True when the criteria already carry the checklist (any line beginning "UI evidence:"). */
export const hasUiEvidence = (acceptance: readonly string[]): boolean => acceptance.some(a => a.startsWith('UI evidence:'))

/** The criteria with the checklist added when the ticket touches the UI and does not carry it; unchanged otherwise. */
export const withUiEvidence = (acceptance: readonly string[], text = acceptance.join('\n')): string[] => (touchesUi(text) && !hasUiEvidence(acceptance) ? [...acceptance, ...UI_EVIDENCE_CHECKLIST] : [...acceptance])
