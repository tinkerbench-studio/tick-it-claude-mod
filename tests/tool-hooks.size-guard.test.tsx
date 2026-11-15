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
