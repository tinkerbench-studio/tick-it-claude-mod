import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, STARTED, typed } from './helpers'

const OTHER_START = 'Here is the log I mentioned:\nTick-it session s_other999: work on TCK-147 in acme/web-app.\nmore'
const OTHER_CONTINUE = 'Here is the log I mentioned:\nTick-it session s_other999: continue TCK-147 in acme/web-app.\nmore'

/** A later prompt carrying the line: it reaches Claude unchanged, with no brief, and nothing is sent or moved. */
const ignored = async ($: Parameters<typeof start>[0] & { prompt: { submit: (e: never) => Promise<unknown> } }, seen: ReturnType<typeof engine>, text: string, held: string) => {
  const calls = seen.ticketCalls.length
  const out = (await $.prompt.submit(typed(text) as never)) as { context?: string[]; text?: string }
  expect(out.context ?? []).toEqual([])
  expect(out.text ?? text).toBe(text)
  expect(seen.ticketCalls.length).toBe(calls)
  expect(seen.server.find(t => t.key === held)).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
  expect(seen.server.find(t => t.key === 'TCK-147')).not.toMatchObject({ assignee: 'maddiecs84', status: 'In progress' })
}

test('a start line in a later prompt of a started session takes nothing and adds no brief', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ignored($ as never, seen, OTHER_START, 'TCK-151')
})

test('a continue line in a later prompt of a started session is ignored the same way', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ignored($ as never, seen, OTHER_CONTINUE, 'TCK-151')
})

test('a start line after /tick-it take of another ticket is ignored', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-151' })
  await ignored($ as never, seen, OTHER_START, 'TCK-151')
})
