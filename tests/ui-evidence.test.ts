import { expect, test } from 'claude-code/testing'

import { hasUiEvidence, touchesUi, withUiEvidence, type Design } from '../hooks/ui-evidence'
import { designOf } from '../hooks/tickit'
import { isTestOnlyChange, isUiPath, patchLines } from '../scripts/ui-paths.mjs'

/** A repository's design section, as the mod reads it from get_repository_settings. */
const designWith = (uiPaths: string[], more: Partial<Design> = {}): Design => ({ uiPaths, checklist: [], pictures: [], workflow: null, ...more })
const CHECKLIST = ['UI evidence: a before/after picture of each changed screen', 'UI evidence: the pull request names every visible difference']

test('with no design section, nothing is a UI change and no checklist is added: the mod has no built-in paths or lines', () => {
  for (const text of ['Edit apps/web/src/pages.tsx', 'Change design/canvas/board-map.json', 'Fix .storybook/main.ts', 'Add a state to components.stories.tsx', 'web/theme.css']) {
    expect(touchesUi(text)).toBe(false)
    expect(touchesUi(text, null)).toBe(false)
    expect(touchesUi(text, designWith([]))).toBe(false)
    expect(withUiEvidence([text])).toEqual([text])
    expect(isUiPath(text, [])).toBe(false)
  }
})

test("the checklist is the repository's own design.checklist, added to a ticket that touches its UI paths and lacks it", () => {
  const design = designWith(['src/ui/**', '**/*.css'], { checklist: CHECKLIST })
  const added = withUiEvidence(['Edit src/ui/menu.tsx'], undefined, design)
  expect(added).toEqual(['Edit src/ui/menu.tsx', ...CHECKLIST])
  expect(hasUiEvidence(added)).toBe(true)
  expect(withUiEvidence(added, undefined, design)).toEqual(added)
  expect(withUiEvidence(['Retry failed writes in src/server/store.ts'], undefined, design)).toEqual(['Retry failed writes in src/server/store.ts'])
  // UI paths but no checklist: nothing is added.
  expect(withUiEvidence(['Edit src/ui/menu.tsx'], undefined, designWith(['src/ui/**']))).toEqual(['Edit src/ui/menu.tsx'])
})

test("touchesUi follows the repository's design.uiPaths globs", () => {
  const design = designWith(['src/ui/**', '**/*.css'])
  expect(touchesUi('src/ui/menu.tsx', design)).toBe(true)
  expect(touchesUi('Restyle ./src/ui/deep/menu.tsx, please.', design)).toBe(true)
  expect(touchesUi('web/theme.css', design)).toBe(true)
  // A changed path with brackets or parentheses (Next.js routes) is tested whole, as scripts/ui-evidence-check.mjs does.
  expect(touchesUi('README.md\nsrc/app/(marketing)/about/page.tsx', designWith(['src/app/**/page.tsx']))).toBe(true)
  expect(touchesUi('src/app/[slug]/page.tsx', designWith(['src/app/**/page.tsx']))).toBe(true)
  expect(touchesUi('apps/web/src/pages.tsx', design)).toBe(false)
  expect(touchesUi('src/uix/menu.tsx', design)).toBe(false)
  // Words alone do not count.
  for (const text of ['The matching page in docs/ is updated', 'Retry board sync in the component store']) expect(touchesUi(text, design)).toBe(false)
})

test('designOf reads the design section of the first config entry that sets uiPaths, with its checklist, pictures and workflow', () => {
  const pictures = [{ when: ['design/canvas/boards/*.dc.html'], name: 'board-beside-story-*', why: 'Run the shots.' }]
  expect(designOf({ config: [{ branch: 'main', design: null }, { branch: 'dev', design: { workflow: 'docs/ux.md', uiPaths: ['src/ui/**'], checklist: CHECKLIST, pictures } }] })).toEqual({
    uiPaths: ['src/ui/**'],
    checklist: CHECKLIST,
    pictures,
    workflow: 'docs/ux.md',
  })
  expect(designOf({ config: [{ design: { uiPaths: ['a/**'] } }] })).toEqual({ uiPaths: ['a/**'], checklist: [], pictures: [], workflow: null })
  // A malformed picture rule is skipped, never guessed at.
  expect(designOf({ config: [{ design: { uiPaths: ['a/**'], pictures: [{ when: [], name: 'x' }, { when: ['a'], name: '' }, { when: ['a'], name: 'ok-*' }] } }] })?.pictures).toEqual([{ when: ['a'], name: 'ok-*' }])
  for (const value of [{}, { config: [] }, { config: [{ branch: 'main', design: {} }] }, { config: [{ design: { uiPaths: [] } }] }, { config: [{ design: { uiPaths: [1] } }] }, { config: [{ design: { checklist: CHECKLIST } }] }]) expect(designOf(value)).toBeNull()
})

test('the gate and the evidence script agree on each glob and path, and that no globs means no UI path', () => {
  const cases: [string, string, boolean][] = [
    ['src/ui/**', 'src/ui/deep/menu.tsx', true],
    ['src/*.css', 'src/site.css', true],
    ['src/*.css', 'src/deep/site.css', false],
    ['src/menu?.tsx', 'src/menu1.tsx', true],
    ['src/menu?.tsx', 'src/menu12.tsx', false],
    ['src/ui/**', 'src/server/api.ts', false],
  ]
  for (const [glob, path, expected] of cases) {
    expect(touchesUi(path, designWith([glob]))).toBe(expected)
    expect(isUiPath(path, [glob])).toBe(expected)
  }
  for (const path of ['apps/web/src/pages.tsx', 'design/tokens.json', 'x/a.css', 'apps/mcp/src/tools.ts']) expect(isUiPath(path, [])).toBe(touchesUi(path, null))
})

test('a story or .storybook/ change that only waits, asserts or comments is test-only; any other line makes it a UI change', () => {
  const testLines = ["import { configure } from 'storybook/test';", '', '// wait for the iframe (NOK-925).', 'configure({ asyncUtilTimeout: 10_000 });'].join('\n')
  expect(isTestOnlyChange('.storybook/preview.ts', testLines)).toBe(true)
  expect(isTestOnlyChange('stories/pages/AdminPage.stories.tsx', "// wait\nawait waitFor(() => expect(doc.querySelector('.rail')).toBeTruthy());")).toBe(true)
  // A line that is not a test line, in the same file, makes it a UI change.
  expect(isTestOnlyChange('stories/pages/AdminPage.stories.tsx', "await waitFor(() => expect(a).toBe(b));\nexport const Empty: Story = { args: { rows: [] } };")).toBe(false)
  expect(isTestOnlyChange('stories/pages/AdminPage.stories.tsx', '  <p class="note">New copy</p>')).toBe(false)
  // Only stories and .storybook/ can be test-only: a stylesheet or page never is, and a file with no lines to read is not.
  expect(isTestOnlyChange('apps/web/src/pages.tsx', '// a comment')).toBe(false)
  expect(isTestOnlyChange('assets/site.css', '/* a comment */')).toBe(false)
  expect(isTestOnlyChange('stories/a.stories.tsx', '')).toBe(false)
  expect(isTestOnlyChange('stories/a.stories.tsx', undefined)).toBe(false)
  const patch = ['diff --git a/x.stories.tsx b/x.stories.tsx', '--- a/x.stories.tsx', '+++ b/x.stories.tsx', '@@ -1 +1 @@', '-old', '+await waitFor(() => 1)'].join('\n')
  expect(patchLines(patch).get('x.stories.tsx')).toBe('old\nawait waitFor(() => 1)')
})
