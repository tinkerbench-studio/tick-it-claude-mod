import { expect, test } from 'claude-code/testing'

import { RUN, engine, start } from './helpers'

test('an edit that would pass the budget is refused, a small one runs', async ($, on) => {
  const diff = { lines: 90 }
  engine(on, diff)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })

  const small = await $.tool.call({ tool: 'Edit', file_path: '/repo/api/a.ts', old_string: 'a', new_string: 'b' })
  expect(JSON.stringify(small)).not.toContain('refused')

  const big = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/api/b.ts',
    content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
  })
  expect(JSON.stringify(big)).toContain("over TCK-143's XS budget of 100")
  // The refusal offers the three choices: a new ticket, a bigger size, or leave it.
  expect(JSON.stringify(big)).toContain('create_ticket')
  expect(JSON.stringify(big)).toContain('Backlog')
  expect(JSON.stringify(big)).toContain('Raise TCK-143 to S')
  expect(JSON.stringify(big)).toContain('Leave it')
  // create_ticket takes the epic by id, so the guard names it that way.
  expect(JSON.stringify(big)).toContain('with epicId \\"e-checkout\\"')
  expect(JSON.stringify(big)).toContain('blockedBy [\\"TCK-143\\"]')
})

test('raising the ticket to the next size makes the guard measure against the new budget', async ($, on) => {
  const diff = { lines: 90 }
  engine(on, diff)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const write = () => $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(await write())).toContain('refused')
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-9', repository: 'acme/web-app', key: 'TCK-143', size: 'S' } as never)
  expect(JSON.stringify(await write())).not.toContain('refused')
})

test('a refusal at the largest size still offers three choices, with a split in place of a bigger size', async ($, on) => {
  const seen = engine(on, { lines: 1490 })
  const largest = seen.server.find(t => t.key === 'TCK-149')
  if (largest !== undefined) largest.size = 'L'
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-149' })
  const big = await $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(big)).toContain('refused')
  expect(JSON.stringify(big)).toContain('2. Split TCK-149')
  expect(JSON.stringify(big)).toContain('3. Leave it')
})

test('raising the size of a ticket in another repository leaves the guard alone', async ($, on) => {
  engine(on, { lines: 90 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-9', repository: 'acme/other', key: 'TCK-143', size: 'S' } as never)
  const big = await $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(big)).toContain('refused')
})

// The budgets are XS 100, S 300, M 700 and L 1500: each size refuses an edit that takes the diff just past it, and allows one just under.
for (const [size, budget] of [
  ['S', 300],
  ['M', 700],
  ['L', 1500],
] as const) {
  test(`a ${size} ticket refuses an edit that takes the diff past ${budget} changed lines and allows one under it`, async ($, on) => {
    const seen = engine(on, { lines: budget - 50 })
    const ticket = seen.server.find(t => t.key === 'TCK-149')
    if (ticket !== undefined) ticket.size = size
    await start($)
    await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-149' })
    const write = (count: number) => $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: count }, (_, i) => `line ${i}`).join('\n') })
    expect(JSON.stringify(await write(40))).not.toContain('refused')
    expect(JSON.stringify(await write(60))).toContain(`${size} budget of ${budget}`)
  })
}

test('the guard measures against the budget Tick-it serves, not the mod’s copy', async ($, on) => {
  engine(on, { lines: 90 }, true, {}, { modConfig: { sizeBudgets: { XS: 120, S: 120, M: 120, L: 120 }, defaultReviewRounds: { XS: 2, S: 3, M: 5, L: 6 }, maxReviewRounds: 10, briefLines: { memories: 'm', memoryTools: 't', deferredTools: 'd', done: 'f', branch: 'b', addToTicket: ['a'] } } })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const write = (count: number) => $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: count }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(await write(40))).toContain('XS budget of 120')
})

test('a ticket with no epic gets no epic in the new-ticket choice', async ($, on) => {
  const seen = engine(on, { lines: 90 })
  const t = seen.server.find(t => t.key === 'TCK-143')
  expect(t).toBeDefined()
  t!.epic = null
  delete t!.epicId
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const big = await $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(big)).toContain('create_ticket with status Backlog')
  expect(JSON.stringify(big)).not.toContain('in epic')
})

// The guard decides by the epic's id, not its title: a real epic that happens to be titled "Unsorted" is still named.
test('a ticket in an epic titled Unsorted keeps its epic in the new-ticket choice', async ($, on) => {
  const seen = engine(on, { lines: 90 })
  const t = seen.server.find(t => t.key === 'TCK-143')
  expect(t).toBeDefined()
  t!.epic = 'Unsorted'
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const big = await $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(big)).toContain('create_ticket with epicId \\"e-checkout\\" (epic \\"Unsorted\\") with status Backlog')
})

// The guard estimates what an edit adds to the diff, not the edit alone.
const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n')
const taken = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], diff: Parameters<typeof engine>[1]) => {
  engine(on, diff)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
}
const edit = ($: Parameters<Parameters<typeof test>[1]>[0], input: Record<string, unknown>) => $.tool.call({ tool: 'Edit', file_path: '/repo/api/a.ts', ...input } as never)
const refused = (r: unknown) => JSON.stringify(r).includes('refused')

test('with the diff over budget an edit that only removes lines is not refused', async ($, on) => {
  // b and c are lines the ticket added: removing them shrinks the diff.
  await taken($, on, { lines: 120, files: { '/repo/api/a.ts': 'a\nb\nc' }, base: { 'api/a.ts': 'a' } })
  expect(refused(await edit($, { old_string: 'a\nb\nc', new_string: 'a' }))).toBe(false)
})

test('with the diff over budget an edit that adds lines is still refused', async ($, on) => {
  await taken($, on, { lines: 120, files: { '/repo/api/a.ts': 'a' }, base: { 'api/a.ts': 'a' } })
  const r = await edit($, { old_string: 'a', new_string: 'a\nb\nc' })
  expect(JSON.stringify(r)).toContain("over TCK-143's XS budget of 100")
  expect(JSON.stringify(r)).toContain('about 122 lines')
})

test('a write outside the repository is not refused whatever its size', async ($, on) => {
  await taken($, on, { lines: 90 })
  expect(refused(await $.tool.call({ tool: 'Write', file_path: '/tmp/scratch/notes.md', content: lines(40) }))).toBe(false)
})

test('a write to a path git ignores is not refused', async ($, on) => {
  await taken($, on, { lines: 90, ignored: ['/repo/dist/out.js'] })
  expect(refused(await $.tool.call({ tool: 'Write', file_path: '/repo/dist/out.js', content: lines(40) }))).toBe(false)
  // A path git does not ignore still counts.
  expect(refused(await $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: lines(40) }))).toBe(true)
})

test('rewriting lines the ticket added counts the growth of the diff, not twice the lines', async ($, on) => {
  // The file holds 6 lines the ticket added; rewriting them is 12 lines on their own, but the diff against the base grows by none.
  const added = lines(6, 'new')
  await taken($, on, { lines: 95, files: { '/repo/api/a.ts': `keep\n${added}` }, base: { 'api/a.ts': 'keep' } })
  expect(refused(await edit($, { old_string: added, new_string: lines(6, 'rewritten') }))).toBe(false)
})

test('replace_all is counted for every occurrence in the file', async ($, on) => {
  const text = Array.from({ length: 10 }, () => 'x').join('\n')
  await taken($, on, { lines: 90, files: { '/repo/api/a.ts': text }, base: { 'api/a.ts': text } })
  // One occurrence is 2 lines and runs; ten are 20 and pass the budget.
  expect(refused(await edit($, { old_string: 'x', new_string: 'y' }))).toBe(false)
  expect(JSON.stringify(await edit($, { old_string: 'x', new_string: 'y', replace_all: true }))).toContain('about 110 lines')
})

test('a MultiEdit is guarded as the sum of its edits, with the same three choices', async ($, on) => {
  const text = 'a\nb\nc\nd'
  await taken($, on, { lines: 90, files: { '/repo/api/a.ts': text }, base: { 'api/a.ts': text } })
  const multi = (edits: unknown[]) => $.tool.call({ tool: 'MultiEdit', file_path: '/repo/api/a.ts', edits } as never)
  expect(refused(await multi([{ old_string: 'a', new_string: 'a1' }, { old_string: 'b', new_string: 'b1' }]))).toBe(false)
  const big = await multi(Array.from({ length: 6 }, (_, i) => ({ old_string: 'abcd'[i % 4] ?? 'a', new_string: `${'abcd'[i % 4]}${i}` })).slice(0, 4).concat([{ old_string: 'a', new_string: lines(6) }]))
  expect(JSON.stringify(big)).toContain("over TCK-143's XS budget of 100")
  expect(JSON.stringify(big)).toContain('create_ticket')
  expect(JSON.stringify(big)).toContain('Raise TCK-143 to S')
  expect(JSON.stringify(big)).toContain('Leave it')
})

test('when the base text cannot be read the guard falls back to the edit alone and does not throw', async ($, on) => {
  await taken($, on, { lines: 90, files: { '/repo/api/a.ts': 'a' } })
  expect(refused(await edit($, { old_string: 'a', new_string: lines(12) }))).toBe(true)
  expect(refused(await edit($, { old_string: 'a', new_string: 'b' }))).toBe(false)
})

test('when git show fails to run the guard falls back to the edit alone and does not throw', async ($, on) => {
  await taken($, on, { lines: 90, files: { '/repo/api/a.ts': 'a' }, throwShow: true })
  expect(refused(await edit($, { old_string: 'a', new_string: lines(12) }))).toBe(true)
  expect(refused(await edit($, { old_string: 'a', new_string: 'b' }))).toBe(false)
})

test('when the file cannot be read the edit is estimated by its own lines, not let through', async ($, on) => {
  // The base is readable but the file's text is not: the edit is not measured as no change.
  await taken($, on, { lines: 90, base: { 'api/a.ts': 'a' } })
  expect(refused(await edit($, { old_string: 'a', new_string: lines(12) }))).toBe(true)
  expect(refused(await edit($, { old_string: 'a', new_string: 'b' }))).toBe(false)
})
