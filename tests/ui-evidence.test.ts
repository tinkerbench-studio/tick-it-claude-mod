import { expect, test } from 'claude-code/testing'

import { UI_EVIDENCE_CHECKLIST, hasUiEvidence, touchesUi, withUiEvidence } from '../hooks/ui-evidence'

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
  for (const word of ['board-map', 'snapshot', 'canvas-sync skill', 'Storybook story', 'dark, light and mobile (390 px)', 'docs/change-screenshots/<TCK-key>', 'ticket comment', 'pull request link', 'visible difference', 'by its path', 'no image markup']) expect(joined).toContain(word)
  expect(joined).not.toContain('`')
})
