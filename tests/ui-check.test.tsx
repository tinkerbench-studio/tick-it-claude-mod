import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, STARTED, typed, finishReview, UI_FILES, BOARD_FILES, PIC } from './helpers'

const inReview = (seen: ReturnType<typeof engine>) => seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')
const looked = (seen: ReturnType<typeof engine>) => seen.ticketCalls.filter(c => c.tool === 'list_screenshots')

test('a UI change whose ticket has no confirmed picture is refused, naming the upload steps and not saying to commit', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('TCK-151 has no confirmed picture in Tick-it')
  expect(moved.deny).toContain('presign_screenshot_upload')
  expect(moved.deny).toContain('confirm_screenshot')
  // drawing-board's own commands, which every repository using it has, never one repository's script names.
  expect(moved.deny).toContain('drawing-board story-shot <storybook-dir> <story-id> shots/before/<name>.png')
  expect(moved.deny).toContain('drawing-board compare-pictures shots/before shots/after shots/compare')
  expect(moved.deny).not.toContain('npm run ui:')
  expect(moved.deny).toContain('run drawing-board browser')
  expect(moved.deny).toContain('do not write a screenshot script of your own')
  expect(moved.deny).toContain('drawing-board:ux-picture skill')
  expect(moved.deny).toContain('Do not commit')
  expect(moved.deny).not.toMatch(/commit them/i)
  expect(moved.deny).not.toContain('docs/change-screenshots')
  expect(looked(seen)[0]?.args).toMatchObject({ repository: 'acme/web-app', ticket: 'TCK-151' })
  expect(inReview(seen)).toBe(false)
})

test('a UI change with a confirmed picture passes with no committed file and whatever the description says', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [PIC], gh: () => ({ exitCode: 1, stdout: '', stderr: 'no pull requests found' }) })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(inReview(seen)).toBe(true)
})

test('the gate runs no git or gh command to look for pictures', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [PIC] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  seen.processes.length = 0
  await finishReview($ as never)
  expect(seen.processes.filter(p => /ls-tree|ls-files|--ignored|body|change-screenshots|design-canvas/.test(p) && p !== 'git ls-files --others --exclude-standard -z')).toEqual([])
  // The only gh call left is the pull request number /tick-it done records, never its description.
  expect(seen.processes.filter(p => p.startsWith('gh ') && p !== 'gh pr view --json number')).toEqual([])
})

test('a canvas board change with no board-beside-story picture is refused, naming how to take and upload them', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [PIC] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('shows no picture named board-beside-story-*')
  expect(moved.deny).toContain('drawing-board annotate --board <Board>.dc.html --theme dark --out reports/design-canvas/dark')
  expect(moved.deny).not.toContain('npm run design-canvas:shots')
  expect(moved.deny).toContain('reports/design-canvas/dark/shots/<Board>-side-by-side.png')
  expect(moved.deny).toContain('reports/design-canvas/light/shots/<Board>-side-by-side.png')
  expect(moved.deny).not.toContain('reports/design-canvas/shots/')
  expect(moved.deny).toContain('confirm_screenshot')
  expect(moved.deny).not.toContain('has no confirmed picture')
  expect(inReview(seen)).toBe(false)
})

test('a canvas board change passes when list_screenshots shows a board-beside-story picture', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [PIC, { key: 'acme/web-app/TCK-151/abc', name: 'board-beside-story-Board.png' }] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(inReview(seen)).toBe(true)
})

test('a canvas board change whose pictures are not named board-beside-story is still refused', async ($, on) => {
  engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [PIC, { key: 'acme/web-app/TCK-151/x', name: 'picker-side-by-side.png' }] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toContain('board-beside-story-*')
})

test('a change that touches no UI path is never refused for pictures and Tick-it is not asked', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: `1\t0\tapps/mcp/src/store.ts\0`, pictures: [] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(looked(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

test('when list_screenshots is down the move goes through', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: 'unreachable' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(inReview(seen)).toBe(true)
})

test('when list_screenshots answers with no list the move goes through', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: 'odd' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(inReview(seen)).toBe(true)
})

test('/tick-it steward refuses a UI change with no pictures for the ticket being built', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const stewarded = (await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-151' })) as { text: string }
  expect(stewarded.text).toContain('has no confirmed picture in Tick-it')
  expect(inReview(seen)).toBe(false)
})

test('/tick-it done refuses a UI change with no pictures too, and the ticket stays taken', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('has no confirmed picture in Tick-it')
  expect(inReview(seen)).toBe(false)
})

test("the gate uses the repository's design.uiPaths when set: a path of theirs is checked, a built-in one no longer is", async ($, on) => {
  const config = [{ branch: 'main', design: { uiPaths: ['src/ui/**'] } }]
  const mine = engine(on, { lines: 5, numstatZ: `1\t0\tsrc/ui/menu.tsx\0`, pictures: [] }, true, {}, { config })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toContain('TCK-151 has no confirmed picture in Tick-it')
  expect(inReview(mine)).toBe(false)
})

test("the gate lets a built-in UI path through when the repository's design.uiPaths does not list it", async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] }, true, {}, { config: [{ branch: 'main', design: { uiPaths: ['src/ui/**'] } }] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(looked(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})
