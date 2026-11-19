import { expect, test } from 'claude-code/testing'

import { UI_EVIDENCE_CHECKLIST, hasUiEvidence, touchesUi, withUiEvidence } from '../hooks/ui-evidence'
import { uiPathsOf } from '../hooks/tickit'
import { isUiPath } from '../scripts/ui-paths.mjs'

test('the UI-evidence checklist is added to the criteria of a ticket that touches apps/web pages or design files, and left off one that does not', () => {
  const page = ['Header shows the account menu on every page in apps/web/src/pages.tsx']
  const added = withUiEvidence(page)
  expect(added).toEqual([...page, ...UI_EVIDENCE_CHECKLIST])
  expect(hasUiEvidence(added)).toBe(true)
  expect(withUiEvidence(added)).toEqual(added)
  expect(withUiEvidence(['Board stays in step'], 'Update design/canvas/board-map.json')).toHaveLength(1 + UI_EVIDENCE_CHECKLIST.length)
  expect(withUiEvidence(['Retry failed D1 writes in apps/mcp/src/store.ts'])).toEqual(['Retry failed D1 writes in apps/mcp/src/store.ts'])
  expect(touchesUi('apps/mcp/src/tools.ts')).toBe(false)
  // Words that Tick-it's own tickets use for the API and docs do not make a ticket a UI ticket.
  for (const text of ['The matching page in docs/ is updated', 'get_board returns the milestone', 'Retry board sync in the component store', 'Take a screenshot of the canvas log', 'Update docs/design-system.md', 'Refresh the token in apps/web/src/session.ts', 'Add a case in apps/web/test/oauth.test.ts', 'Edit docs/design/notes.md', 'Mentions node.css-in-js only']) expect(touchesUi(text)).toBe(false)
  for (const text of ['Edit apps/web/src/pages.tsx', 'Edit ./apps/web/src/design/components.tsx', 'Change ./design/canvas/board-map.json', 'Change /home/user/tick-it/design/canvas/board-map.json', 'Edit /home/user/tick-it/apps/web/src/client.tsx', 'Edit [pages](apps/web/src/pages.tsx)', 'Change design/canvas/board-map.json', 'Fix .storybook/main.ts', 'Add a state to components.stories.tsx', 'Edit style in components.css.ts']) expect(touchesUi(text)).toBe(true)
})

test('the checklist names every deliverable and points to the canvas-sync skill', () => {
  const joined = UI_EVIDENCE_CHECKLIST.join('\n')
  for (const word of ['board-map', 'snapshot', 'canvas-sync skill', 'Storybook story', 'dark, light and mobile (390 px)', 'uploaded to Tick-it', 'confirm_screenshot', 'ticket comment', 'pull request link', 'visible difference', 'by its object key', 'no image markup']) expect(joined).toContain(word)
  expect(joined).not.toContain('`')
})

test("with the repository's design.uiPaths, touchesUi and the checklist follow those globs and not the built-in paths", () => {
  const globs = ['src/ui/**', '**/*.css']
  expect(touchesUi('src/ui/menu.tsx', globs)).toBe(true)
  expect(touchesUi('Restyle ./src/ui/deep/menu.tsx, please.', globs)).toBe(true)
  expect(touchesUi('web/theme.css', globs)).toBe(true)
  // A changed path with brackets or parentheses (Next.js routes) is tested whole, as scripts/ui-evidence-check.mjs does.
  expect(touchesUi('README.md\nsrc/app/(marketing)/about/page.tsx', ['src/app/**/page.tsx'])).toBe(true)
  expect(touchesUi('src/app/[slug]/page.tsx', ['src/app/**/page.tsx'])).toBe(true)
  // The built-in tick-it paths no longer count once the repository sets its own.
  expect(touchesUi('apps/web/src/pages.tsx', globs)).toBe(false)
  expect(touchesUi('src/uix/menu.tsx', globs)).toBe(false)
  expect(withUiEvidence(['Edit src/ui/menu.tsx'], undefined, globs)).toEqual(['Edit src/ui/menu.tsx', ...UI_EVIDENCE_CHECKLIST])
  expect(withUiEvidence(['Edit apps/web/src/pages.tsx'], undefined, globs)).toEqual(['Edit apps/web/src/pages.tsx'])
  // None set (null or empty): the built-in paths apply.
  for (const none of [null, []]) expect(touchesUi('apps/web/src/pages.tsx', none)).toBe(true)
})

test('uiPathsOf reads design.uiPaths from the first config entry that sets any, and null otherwise', () => {
  expect(uiPathsOf({ config: [{ branch: 'main', design: null }, { branch: 'dev', design: { uiPaths: ['src/ui/**'] } }] })).toEqual(['src/ui/**'])
  for (const value of [{}, { config: [] }, { config: [{ branch: 'main', design: {} }] }, { config: [{ design: { uiPaths: [] } }] }, { config: [{ design: { uiPaths: [1] } }] }]) expect(uiPathsOf(value)).toBeNull()
})

test('the gate and the evidence script agree on each glob and path, and on the default rule', () => {
  const cases: [string, string, boolean][] = [
    ['src/ui/**', 'src/ui/deep/menu.tsx', true],
    ['src/*.css', 'src/site.css', true],
    ['src/*.css', 'src/deep/site.css', false],
    ['src/menu?.tsx', 'src/menu1.tsx', true],
    ['src/menu?.tsx', 'src/menu12.tsx', false],
    ['src/ui/**', 'src/server/api.ts', false],
  ]
  for (const [glob, path, expected] of cases) {
    expect(touchesUi(path, [glob])).toBe(expected)
    expect(isUiPath(path, [glob])).toBe(expected)
  }
  for (const path of ['apps/web/src/pages.tsx', 'design/tokens.json', 'x/a.css', 'apps/mcp/src/tools.ts']) expect(isUiPath(path, [])).toBe(touchesUi(path, null))
  expect(isUiPath('apps/web/src/pages.tsx', [])).toBe(true)
})
