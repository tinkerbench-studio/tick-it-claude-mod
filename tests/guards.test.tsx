import { expect, test } from 'claude-code/testing'

import { RUN, COMPOSE, engine, finishTurn, start, typed } from './helpers'
import type { Net } from './helpers'

const UPDATE = 'mcp__plugin_tick-it_tickit__update_ticket'
const run = ($: Parameters<typeof start>[0], args: string) => $.command.run({ ...RUN, command: 'tick-it', args })

test('a start line naming this repository in another letter case takes the ticket', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const entered = await $.prompt.submit(typed('Tick-it session s_abc12345: work on TCK-151 in Acme/Web-App.'))
  expect('context' in entered ? entered.context?.some(c => c.includes('TCK-151')) : false).toBe(true)
  expect('context' in entered ? entered.context?.some(c => c.includes('did not take')) : true).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In progress' })
})

test('a continue line naming this repository in another letter case takes the ticket', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  const ticket = seen.server.find(t => t.key === 'TCK-151')
  if (ticket !== undefined) ticket.status = 'In review'
  await start($)
  const entered = await $.prompt.submit(typed('Tick-it session s_abc12345: continue TCK-151 in Acme/Web-App.'))
  expect('context' in entered ? entered.context?.some(c => c.includes('TCK-151')) : false).toBe(true)
  expect('context' in entered ? entered.context?.some(c => c.includes('did not take')) : true).toBe(false)
})

test('update_ticket to In progress with assignee me, naming this repository in another letter case, is a take', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const taken = await $.tool.call({ tool: UPDATE, tool_use_id: 'tu-1', repository: 'ACME/Web-App', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  expect('context' in taken ? (taken.context ?? [])[0] : '').toBe('tick-it: TCK-147 is yours.')
  expect((await $.prompt.compose(COMPOSE)).sections.some(s => s.id === 'tick-it:brief' && s.text.includes('TCK-147'))).toBe(true)
  expect(seen.server.find(t => t.key === 'TCK-147')).toMatchObject({ status: 'In progress' })
})

test('update_ticket with a new size, naming this repository in another letter case, resizes the guard', async ($, on) => {
  engine(on, { lines: 90 })
  await start($)
  await run($, 'take TCK-143')
  const write = () => $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(await write())).toContain('refused')
  await $.tool.call({ tool: UPDATE, tool_use_id: 'tu-9', repository: 'Acme/WEB-app', key: 'TCK-143', size: 'S' } as never)
  expect(JSON.stringify(await write())).not.toContain('refused')
})

for (const status of ['Done', 'Superseded', 'Dropped']) {
  test(`/tick-it take of a ${status} ticket moves nothing and says it is finished`, async ($, on) => {
    const seen = engine(on, { lines: 0 })
    const ticket = seen.server.find(t => t.key === 'TCK-147')
    if (ticket !== undefined) ticket.status = status
    await start($)
    const taken = await run($, 'take TCK-147')
    expect(taken.text).toContain('TCK-147 is finished')
    expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket')).toEqual([])
    expect(seen.server.find(t => t.key === 'TCK-147')).toMatchObject({ status, assignee: null })
  })
}

test('/tick-it take with no key answers with the usage line and calls no Tick-it tool', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const before = seen.ticketCalls.length
  expect((await run($, 'take')).text).toBe('Usage: /tick-it take <id>')
  expect((await run($, 'take   ')).text).toBe('Usage: /tick-it take <id>')
  expect(seen.ticketCalls.length).toBe(before)
})

for (const [name, diff] of [
  ['main when origin/HEAD is not set', { branch: 'main' }],
  ['master when origin/HEAD is not set', { branch: 'master' }],
  ["origin/HEAD's branch", { branch: 'develop', defaultBranch: 'develop' }],
] as const) {
  test(`/tick-it done on ${name} links no branch, and the ticket still moves to In review`, async ($, on) => {
    const seen = engine(on, { lines: 5, pr: 42, ...diff })
    await start($)
    await run($, 'take TCK-143')
    await run($, 'done')
    expect(seen.ticketCalls.filter(c => c.tool === 'link_pull_request')).toEqual([])
    expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  })
}

test('/tick-it done on a feature branch still links it, even when another branch is the default', async ($, on) => {
  const seen = engine(on, { lines: 5, pr: 42, branch: 'main', defaultBranch: 'develop' })
  await start($)
  await run($, 'take TCK-143')
  await run($, 'done')
  expect(seen.ticketCalls.find(c => c.tool === 'link_pull_request')?.args).toMatchObject({ key: 'TCK-143', branch: 'main' })
})

test('/tick-it done still moves the ticket when git rev-parse for the branch throws', async ($, on) => {
  const seen = engine(on, { lines: 5, pr: 42, branchThrows: true })
  await start($)
  await run($, 'take TCK-143')
  await run($, 'done')
  expect(seen.ticketCalls.filter(c => c.tool === 'link_pull_request')).toEqual([])
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
})

test('more than 100 waiting runs go in calls of at most 100, and a failed call leaves only its own runs waiting', async ($, on) => {
  let down = true
  let failing = 0
  const net: Net = { answer: (_args, call) => (down ? 'unreachable' : call === failing ? { isError: true, text: 'busy' } : {}) }
  const seen = engine(on, { lines: 5 }, true, {}, net)
  await start($)
  await run($, 'take TCK-143')
  // Signed out: each main-loop turn queues a run that cannot leave.
  for (let i = 0; i < 120; i++) await $.turn.complete(finishTurn(undefined, 'x'.repeat(i + 1)))
  const sentBefore = seen.recorded.length
  down = false
  failing = sentBefore + 1
  await run($, 'sync')
  const sizes = seen.recorded.slice(sentBefore).map(c => c.args.runs.length)
  expect(sizes).toHaveLength(2)
  expect(Math.max(...sizes)).toBeLessThanOrEqual(100)
  expect(sizes[0]).toBe(100)
  // The first call failed: its 100 runs wait; the second call's runs left.
  expect((await run($, 'reviews')).text).toContain('100 review runs waiting to send to Tick-it')
})
