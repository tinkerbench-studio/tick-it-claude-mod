import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, STARTED, typed, reports, finishReview, UI_FILES, BOARD_FILES, IMG, body } from './helpers'

test('a UI change with no before/after image is refused before review, naming the folder and how to make them', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, gh: body('') })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('docs/change-screenshots/TCK-151 has no picture on the branch')
  expect(moved.deny).toContain('git worktree add')
  expect(moved.deny).toContain('npm run ui:shots -- shots/before')
  expect(moved.deny).toContain('npm run ui:compare')
  expect(moved.deny).toContain('Showing a UX change')
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(false)
})

test('a canvas board change with no board-beside-story pictures is refused, naming how to take them', async ($, on) => {
  engine(on, { lines: 5, numstatZ: BOARD_FILES, tree: [IMG], gh: body(IMG) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('neither reports/design-canvas/shots nor docs/change-screenshots/TCK-151 has board-beside-story pictures')
  expect(moved.deny).toContain('npm run design-canvas:shots')
  expect(moved.deny).not.toContain('has no picture on the branch')
})

test('a UI change whose pull request description leaves out an image path is refused, naming the path', async ($, on) => {
  engine(on, { lines: 5, numstatZ: UI_FILES, tree: [IMG, 'docs/change-screenshots/TCK-151/other-before-after.png'], gh: body(IMG) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('does not list this image by path: docs/change-screenshots/TCK-151/other-before-after.png')
  expect(moved.deny).not.toContain(`path: ${IMG}`)
})

test('a UI change with no pull request yet lists every image as missing from its description', async ($, on) => {
  engine(on, { lines: 5, numstatZ: UI_FILES, tree: [IMG], gh: argv => (argv[1] === 'pr' ? { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "tck-151-picker"' } : undefined) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toContain(`by path: ${IMG}`)
})

test('a canvas board change with committed board-beside-story pictures and no reports/ folder goes to review', async ($, on) => {
  const beside = 'docs/change-screenshots/TCK-151/board-beside-story-Board.png'
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, tree: [IMG, beside], gh: body(`${IMG}\n${beside}\n`) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(true)
})

test('a canvas board change whose committed images are not board-beside-story pictures is still refused', async ($, on) => {
  const other = 'docs/change-screenshots/TCK-151/picker-side-by-side.png'
  engine(on, { lines: 5, numstatZ: BOARD_FILES, tree: [IMG, other], gh: body(`${IMG}
${other}
`) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toContain('has board-beside-story pictures')
})

test('a UI change with every picture, the board pictures and a description that lists them goes to review', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, tree: [IMG], shots: ['reports/design-canvas/shots/Board-side-by-side.png'], gh: body(`Changes\n${IMG}\n`) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(true)
})

test('a change that touches no UI path is never refused for pictures', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: `1\t0\tapps/mcp/src/store.ts\0`, gh: body('') })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(true)
})

test('gh that cannot answer leaves the description unchecked, and an after-only image counts as a picture', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, tree: ['docs/change-screenshots/TCK-151/story-after.png'], gh: argv => (argv[1] === 'pr' ? { exitCode: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' } : undefined) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(true)
})

test('/tick-it steward refuses a UI change with no pictures for the ticket being built', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, gh: body('') })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const stewarded = (await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-151' })) as { text: string }
  expect(stewarded.text).toContain('has no picture on the branch')
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(false)
})

test('/tick-it done refuses a UI change with no pictures too, and the ticket stays taken', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, gh: body('') })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('has no picture on the branch')
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(false)
})
