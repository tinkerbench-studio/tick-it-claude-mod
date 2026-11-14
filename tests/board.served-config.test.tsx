import { expect, test } from 'claude-code/testing'

import { MOD_VERSION } from '../hooks/state'
import { RUN, engine, start } from './helpers'
import type { Net } from './helpers'

const served = {
  sizeBudgets: { XS: 11, S: 22, M: 33, L: 44 },
  defaultReviewRounds: { XS: 1, S: 1, M: 1, L: 1 },
  maxReviewRounds: 10,
  briefLines: {
    memories: 'SERVED memories line.',
    memoryTools: 'SERVED memory tools line.',
    deferredTools: 'SERVED deferred.',
    done: 'SERVED done line.',
    branch: 'SERVED branch line.',
    addToTicket: ['SERVED add-to-ticket line.'],
  },
}

test('taking a ticket asks Tick-it for get_mod_config and the brief uses what it says', async ($, on) => {
  const net: Net = { modConfig: served }
  const seen = engine(on, { lines: 10 }, true, {}, net)
  await start($)
  const took = await $.command.run({
    ...RUN,
    command: 'tick-it',
    args: 'take TCK-143',
  })
  expect(seen.ticketCalls.some(c => c.tool === 'get_mod_config' && c.args.key === 'TCK-143' && c.args.modVersion === MOD_VERSION)).toBe(true)
  const text = JSON.stringify(took.context)
  for (const line of ['SERVED memories line.', 'SERVED memory tools line.', 'SERVED done line.', 'SERVED branch line.', 'SERVED add-to-ticket line.']) expect(text).toContain(line)
  expect(text).not.toContain('Finish by moving the ticket to In review')
})

test('taking a ticket shows and briefs the served budget for its size', async ($, on) => {
  const net: Net = {
    modConfig: { ...served, sizeBudgets: { XS: 5, S: 5, M: 5, L: 5 } },
  }
  engine(on, { lines: 10 }, true, {}, net)
  await start($)
  const took = await $.command.run({
    ...RUN,
    command: 'tick-it',
    args: 'take TCK-143',
  })
  expect(took.text).toContain('Budget 5 changed lines')
  expect(JSON.stringify(took.context)).toContain('keep the whole diff under 5 changed lines')
})

test('when Tick-it cannot answer get_mod_config, or answers badly, the mod keeps its own copies', async ($, on) => {
  const net: Net = { modConfig: 'unreachable' }
  engine(on, { lines: 10 }, true, {}, net)
  await start($)
  const took = await $.command.run({
    ...RUN,
    command: 'tick-it',
    args: 'take TCK-143',
  })
  expect(JSON.stringify(took.context)).toContain('Finish by moving the ticket to In review with update_ticket')
  expect(took.text).toMatch(/Budget (100|300|700|1500) changed lines/)
  net.modConfig = { sizeBudgets: { XS: 'many' }, briefLines: {} }
  const again = await $.command.run({
    ...RUN,
    command: 'tick-it',
    args: 'take TCK-143',
  })
  expect(JSON.stringify(again.context)).toContain('Finish by moving the ticket to In review with update_ticket')
})

test('taking a ticket shows the notice get_mod_config answers, and nothing when it is null', async ($, on) => {
  const notice = 'This tick-it mod (0.1.0) is older than Tick-it serves in full (0.25.0). Update it.'
  const net: Net = { modConfig: { ...served, minModVersion: '0.25.0', notice } }
  const seen = engine(on, { lines: 10 }, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(seen.toasts).toEqual([JSON.stringify({ text: `tick-it: ${notice}` })])
  net.modConfig = { ...served, minModVersion: '0.1.0', notice: null }
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(seen.toasts).toEqual([JSON.stringify({ text: `tick-it: ${notice}` })])
})

test('a notice is shown even when the rest of the get_mod_config answer cannot be read', async ($, on) => {
  const net: Net = { modConfig: { notice: 'Update the tick-it mod.' } }
  const seen = engine(on, { lines: 10 }, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(seen.toasts).toEqual([JSON.stringify({ text: 'tick-it: Update the tick-it mod.' })])
})
