import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, STARTED, typed, finishReview, UI_FILES, BOARD_FILES, PIC, DESIGN_CONFIG } from './helpers'

/** The repository's design section, which the gate reads: without it nothing is a UI change. */
const DESIGNED = { config: DESIGN_CONFIG }

const inReview = (seen: ReturnType<typeof engine>) => seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')
const looked = (seen: ReturnType<typeof engine>) => seen.ticketCalls.filter(c => c.tool === 'list_screenshots')

test('a UI change whose ticket has no confirmed picture is refused, naming the upload steps and not saying to commit', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('TCK-151 has no confirmed picture in Tick-it')
  expect(moved.deny).toContain('presign_screenshot_upload')
  expect(moved.deny).toContain('confirm_screenshot')
  // The repository's own workflow doc, never a tool or command of the mod's.
  expect(moved.deny).toContain("This repository's design workflow (docs/design-system.md) says how to make them")
  expect(moved.deny).toContain('rather than writing a screenshot script of your own')
  expect(moved.deny).not.toMatch(/drawing-board|npm run|storybook|design-canvas/i)
  expect(moved.deny).toContain('never committed')
  expect(moved.deny).not.toContain('docs/change-screenshots')
  expect(looked(seen)[0]?.args).toMatchObject({ repository: 'acme/web-app', ticket: 'TCK-151' })
  expect(inReview(seen)).toBe(false)
})

test('a UI change with a confirmed picture passes with no committed file and whatever the description says', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [PIC], gh: () => ({ exitCode: 1, stdout: '', stderr: 'no pull requests found' }) }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(inReview(seen)).toBe(true)
})

test('the gate runs no git or gh command to look for pictures', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [PIC] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  seen.processes.length = 0
  await finishReview($ as never)
  expect(seen.processes.filter(p => /ls-tree|ls-files|--ignored|body|change-screenshots|design-canvas/.test(p) && p !== 'git ls-files --others --exclude-standard -z')).toEqual([])
  // The only gh call left is the pull request number /tick-it done records, never its description.
  expect(seen.processes.filter(p => p.startsWith('gh ') && p !== 'gh pr view --json number')).toEqual([])
})

test('a canvas board change with no board-beside-story picture is refused, naming how to take and upload them', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [PIC] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  // The rule is the repository's design.pictures: its name glob and its why, said as given.
  expect(moved.deny).toContain('This branch changes design/canvas/boards/Board.map.json, so this repository asks for a picture named board-beside-story-*, and list_screenshots shows none.')
  expect(moved.deny).toContain('Run the board shots and copy each to board-beside-story-<Board>.png.')
  expect(moved.deny).not.toMatch(/drawing-board|npm run|design-canvas/i)
  expect(moved.deny).not.toContain('has no confirmed picture')
  expect(inReview(seen)).toBe(false)
})

test('a canvas board change passes when list_screenshots shows a board-beside-story picture', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [PIC, { key: 'acme/web-app/TCK-151/abc', name: 'board-beside-story-Board.png' }] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(inReview(seen)).toBe(true)
})

test('a canvas board change whose pictures are not named board-beside-story is still refused', async ($, on) => {
  engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [PIC, { key: 'acme/web-app/TCK-151/x', name: 'picker-side-by-side.png' }] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toContain('board-beside-story-*')
})

test('a change that touches no UI path is never refused for pictures and Tick-it is not asked', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: `1\t0\tapps/mcp/src/store.ts\0`, pictures: [] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(looked(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

/** A UI change whose gate cannot run: refused with the reason, and the ticket not moved. */
const refusedFor = async ($: Parameters<typeof start>[0], seen: ReturnType<typeof engine>, ...reasons: string[]) => {
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('TCK-151 cannot go to review: the UI evidence check could not run, because')
  for (const reason of reasons) expect(moved.deny).toContain(reason)
  expect(moved.deny).not.toContain('has no confirmed picture')
  expect(inReview(seen)).toBe(false)
}

test('when list_screenshots answers with an error the move is refused, naming the reason', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: 'unreachable' }, true, {}, DESIGNED)
  await refusedFor($, seen, "the ticket's pictures could not be listed (list_screenshots)", 'Tick-it is down')
})

test('when Tick-it cannot be reached for list_screenshots the move is refused, naming the reason', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: 'throws' }, true, {}, DESIGNED)
  await refusedFor($, seen, "the ticket's pictures could not be listed (list_screenshots)", 'could not reach Tick-it')
})

test('when there is no token for list_screenshots the move is refused, naming the reason', async ($, on) => {
  const net: { connected?: boolean; config: unknown[] } = { config: DESIGN_CONFIG }
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] }, true, {}, net)
  await start($)
  await $.prompt.submit(typed(STARTED))
  // The first answer holds the design; then the person is signed out.
  await finishReview($ as never)
  net.connected = false
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain("the ticket's pictures could not be listed (list_screenshots)")
  expect(moved.deny).toContain('not connected to Tick-it')
  expect(moved.deny).not.toContain('has no confirmed picture')
  expect(inReview(seen)).toBe(false)
})

test('when list_screenshots answers with no list the move is refused, saying the answer could not be read', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: 'odd' }, true, {}, DESIGNED)
  await refusedFor($, seen, 'the answer from list_screenshots could not be read', 'it had no list of pictures')
})

test('when the design settings cannot be read and none was held the move is refused, naming why', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [PIC] }, true, {}, { instructions: 'unreachable' })
  await refusedFor($, seen, "the repository's design settings could not be read", 'Tick-it is down')
  expect(looked(seen)).toEqual([])
})

test('when git cannot list the changed files the move is refused, naming the reason', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [PIC], failDiff: true }, true, {}, DESIGNED)
  await refusedFor($, seen, 'git could not list the changed files', "git diff against the ticket's base failed")
  expect(looked(seen)).toEqual([])
})

test('a directory that is not a GitHub repository is not checked, even when git cannot list the changes', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [], failDiff: true, origin: 'ssh://example.com/x' }, true, {}, { instructions: 'unreachable' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(looked(seen)).toEqual([])
})

test('/tick-it steward refuses a UI change with no pictures for the ticket being built', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const stewarded = (await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-151' })) as { text: string }
  expect(stewarded.text).toContain('has no confirmed picture in Tick-it')
  expect(inReview(seen)).toBe(false)
})

test('/tick-it done refuses a UI change with no pictures too, and the ticket stays taken', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] }, true, {}, DESIGNED)
  await start($)
  await $.prompt.submit(typed(STARTED))
  const done = (await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })) as { text: string }
  expect(done.text).toContain('has no confirmed picture in Tick-it')
  expect(inReview(seen)).toBe(false)
})

test("the gate uses the repository's design.uiPaths: a path of theirs is checked", async ($, on) => {
  const config = [{ branch: 'main', design: { uiPaths: ['src/ui/**'] } }]
  const mine = engine(on, { lines: 5, numstatZ: `1\t0\tsrc/ui/menu.tsx\0`, pictures: [] }, true, {}, { config })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toContain('TCK-151 has no confirmed picture in Tick-it')
  expect(inReview(mine)).toBe(false)
})

test("the gate lets a path through that the repository's design.uiPaths does not list", async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: UI_FILES, pictures: [] }, true, {}, { config: [{ branch: 'main', design: { uiPaths: ['src/ui/**'] } }] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(looked(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

test('a repository with no design section is never asked for pictures, and Tick-it is not asked for them', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(looked(seen)).toEqual([])
  expect(inReview(seen)).toBe(true)
})

test('a design section with no picture rules asks for one picture of a UI change, and its refusal names no workflow it does not have', async ($, on) => {
  const seen = engine(on, { lines: 5, numstatZ: BOARD_FILES, pictures: [] }, true, {}, { config: [{ branch: 'main', design: { uiPaths: ['apps/web/src/**', 'design/**'] } }] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const moved = await finishReview($ as never)
  expect(moved.deny).toContain('TCK-151 has no confirmed picture in Tick-it')
  expect(moved.deny).toContain("This repository's ux-evidence review skill says what they show")
  expect(moved.deny).not.toContain('board-beside-story')
  expect(moved.deny).not.toContain('design workflow (')
  expect(inReview(seen)).toBe(false)
})
