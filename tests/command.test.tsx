import { expect, test } from 'claude-code/testing'

import { RUN, engine, start, reports } from './helpers'
import type { Net } from './helpers'

test('/tick-it add creates the ticket on Tick-it', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const added = await $.command.run({ ...RUN, command: 'tick-it', args: 'add S Rate limit the login route' })
  expect(added.text).toBe('Added TCK-205 Rate limit the login route (S).')
  expect(seen.server.at(-1)).toMatchObject({ title: 'Rate limit the login route', size: 'S' })
})

test('/tick-it attach sends a file to a note, as base64 with its name and type, text and binary alike', async ($, on) => {
  const png = btoa('\x89PNG\r\n\x1a\n\x00\xff')
  const seen = engine(on, { lines: 0, untracked: { 'run.log': 'ok ✓\nfailed: 0\n', 'report.json': '{"a":1}', 'my notes/a  b.txt': 'x' }, binary: { 'shots/shot.png': png } })
  await start($)
  const attached = await $.command.run({ ...RUN, command: 'tick-it', args: 'attach tck-143 note1 run.log' })
  expect(attached.text).toBe('Attached run.log (text/plain, 17 bytes) to note note1 on TCK-143.')
  const sent = () => seen.ticketCalls.filter(c => c.tool === 'add_attachment')
  expect(sent()[0]?.args).toMatchObject({ repository: 'acme/web-app', ticket: 'TCK-143', note: 'note1', name: 'run.log', type: 'text/plain' })
  expect(new TextDecoder().decode(Uint8Array.from(atob(String(sent()[0]?.args.content)), c => c.charCodeAt(0)))).toBe('ok ✓\nfailed: 0\n')
  await $.command.run({ ...RUN, command: 'tick-it', args: 'attach TCK-143 note1 report.json' })
  expect(sent()[1]?.args).toMatchObject({ name: 'report.json', type: 'application/json' })
  const shot = await $.command.run({ ...RUN, command: 'tick-it', args: 'attach TCK-143 note1 shots/shot.png' })
  expect(shot.text).toBe('Attached shot.png (image/png, 10 bytes) to note note1 on TCK-143.')
  expect(sent()[2]?.args).toMatchObject({ name: 'shot.png', type: 'image/png', content: png })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'attach TCK-143 note1 my notes/a  b.txt' })
  expect(sent()[3]?.args).toMatchObject({ name: 'a  b.txt', type: 'text/plain' })
})

test('/tick-it attach says what is wrong: no arguments, an empty file, one over 3 MB', async ($, on) => {
  const seen = engine(on, { lines: 0, untracked: { 'empty.log': '' }, binary: { 'big.bin': btoa('x'.repeat(3_000_001)) } })
  await start($)
  const run = async (args: string) => (await $.command.run({ ...RUN, command: 'tick-it', args })).text
  expect(await run('attach TCK-143')).toBe('Usage: /tick-it attach <id> <note> <file>')
  expect(await run('attach TCK-143 note1 empty.log')).toBe('Could not attach empty.log: it is empty.')
  expect(await run('attach TCK-143 note1 big.bin')).toBe('Could not attach big.bin: it is over 3 MB.')
  expect(seen.ticketCalls.filter(c => c.tool === 'add_attachment')).toEqual([])
})

test('/tick-it attach reports Tick-it being unreachable, sending nothing', async ($, on) => {
  const net: Net = { connected: true }
  const seen = engine(on, { lines: 0, untracked: { 'run.log': 'x' } }, true, {}, net)
  await start($)
  net.connected = false
  expect((await $.command.run({ ...RUN, command: 'tick-it', args: 'attach TCK-143 note1 run.log' })).text).toContain('Could not attach run.log: not connected to Tick-it')
  expect(seen.ticketCalls.filter(c => c.tool === 'add_attachment')).toEqual([])
})

test('/tick-it with no known command lists the upload-screenshots skill beside the other skills', async ($, on) => {
  engine(on, { lines: 0 })
  await start($)
  const usage = await $.command.run({ ...RUN, command: 'tick-it', args: '' })
  expect(usage.text).toContain('/tick-it:upload-screenshots <id> <dir>')
  expect(usage.text).toContain('/tick-it:review-agents')
})
