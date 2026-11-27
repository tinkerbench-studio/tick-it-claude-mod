import { expect, test } from 'claude-code/testing'

import { SKILLS, engine, finishTurn, start, STARTED, typed, reports } from './helpers'

const REQUEST = 'mcp__plugin_tick-it_tickit__request_review'
const RECORD = 'mcp__plugin_tick-it_tickit__record_approval'
const ask = ($: Parameters<Parameters<typeof test>[1]>[0], key = 'TCK-151') => $.tool.call({ tool: REQUEST, tool_use_id: 'tu-r', repository: 'acme/web-app', key, session: 's_abc12345' } as never)
/** What Tick-it hands a waiting session when the request is answered (apps/mcp/src/approval-delivery.ts). */
const ANSWER = 'Tick-it session s_abc12345: continue TCK-151 in acme/web-app.\nApproval request ar_1 (Saved card picker) was answered: confirmed. Items: page v2. Outcome: carry on.'

test('request_review succeeding on the taken ticket reports the session waiting', async ($, on) => {
  const seen = engine(on, { lines: 0 }, true, SKILLS)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($)
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'waiting'])
  expect(reports(seen).at(-1)).toMatchObject({ session: 's_abc12345', repository: 'acme/web-app', status: 'waiting' })
})

test('request_review for another ticket, or one Tick-it refused, reports nothing', async ($, on) => {
  on('tool.call', { tool: REQUEST }, (_$, e) => (e as { key?: string }).key === 'TCK-143' ? { result: 'refused', isError: true } : { result: 'ok' })
  const seen = engine(on, { lines: 0 }, true, SKILLS)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($, 'TCK-143')
  await ask($, 'TCK-144')
  expect(reports(seen).map(r => r.status)).toEqual(['working'])
})

test('a turn that only reads leaves a waiting session waiting', async ($, on) => {
  const seen = engine(on, { lines: 0 }, true, SKILLS)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($)
  await $.turn.complete(finishTurn(undefined, 'Asked for approval.'))
  await $.turn.complete(finishTurn(undefined, 'Read the page again.'))
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'waiting'])
})

test('an answer that arrives with no turn running is a toast, and goes to Claude with the next prompt once', async ($, on) => {
  const instructions: string[] = []
  const seen = engine(on, { lines: 0 }, true, SKILLS, { reportInstructions: instructions })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  // The waiting report brings the answer, after the turn has ended.
  instructions.push(ANSWER)
  await ask($)
  expect(seen.toasts.join(' ')).toContain('Approval request ar_1 (Saved card picker) was answered: confirmed')
  expect(seen.submitted.filter(text => text.includes('Approval request'))).toEqual([])
  const next = await $.prompt.submit(typed('go on'))
  expect('context' in next ? next.context?.join('\n') : '').toContain('Approval request ar_1 (Saved card picker) was answered: confirmed')
  const later = await $.prompt.submit(typed('and then'))
  expect('context' in later ? (later.context ?? []).join('\n') : '').not.toContain('Approval request')
})

test("Claude's own record_approval is not blocked by the mod, and Tick-it's refusal reaches it unchanged", async ($, on) => {
  const refusal = 'Refused: record_approval needs approvals:answer, which only Tick-it’s web app gets.'
  on('tool.call', { tool: RECORD }, () => ({ result: refusal, isError: true }))
  engine(on, { lines: 0 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await $.tool.check({ tool: RECORD, input: { request: 'ar_1', decision: 'confirmed' } })).decision).not.toBe('deny')
  const ran = await $.tool.call({ tool: RECORD, tool_use_id: 'tu-a', request: 'ar_1', decision: 'confirmed' } as never)
  expect(ran).toMatchObject({ result: refusal, isError: true })
  expect('context' in ran ? ran.context : undefined).toBeUndefined()
})

test('a read-only turn still asks Tick-it for the answer with a waiting report, and an answer that comes back is a toast for the next prompt', async ($, on) => {
  const instructions: string[] = []
  const seen = engine(on, { lines: 0 }, true, SKILLS, { reportInstructions: instructions, skip: 120_000 })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($)
  instructions.push(ANSWER)
  await $.turn.complete(finishTurn(undefined, 'Read the page again.'))
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'waiting', 'waiting'])
  expect(seen.toasts.join(' ')).toContain('was answered: confirmed')
  const next = await $.prompt.submit(typed('go on'))
  expect('context' in next ? next.context?.join('\n') : '').toContain('Approval request ar_1')
  expect(reports(seen).at(-1)).toMatchObject({ status: 'working' })
})

test('an answer that arrives during a turn is handed over when it ends, and the session reports working', async ($, on) => {
  const instructions: string[] = []
  const seen = engine(on, { lines: 0 }, true, SKILLS, { reportInstructions: instructions })
  await start($)
  await $.prompt.submit(typed(STARTED))
  instructions.push(ANSWER)
  await ask($)
  await $.turn.complete(finishTurn(undefined, 'Asked.'))
  expect(seen.submitted.some(text => text.includes('Approval request ar_1'))).toBe(true)
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'waiting', 'working'])
})

/** The mocked clock: each `clock.every` wait the mod makes stays pending until the test lets a minute pass. */
const minutes = (on: Parameters<typeof engine>[0]) => {
  const waits: { ms: number; pass: () => void }[] = []
  on('clock.every', (_$, e) => new Promise<{ value: undefined }>(resolve => waits.push({ ms: (e as { ms: number }).ms, pass: () => resolve({ value: undefined }) })) as never)
  return {
    waits,
    /** One minute passes: the pending wait ends and the mod's callback runs to its end. */
    pass: async () => {
      const wait = waits.shift()
      wait?.pass()
      await new Promise(resolve => setTimeout(resolve, 20))
    },
  }
}
const idleWaiting = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<typeof engine>[0], instructions: string[] = []) => {
  const diff = { lines: 0 }
  const seen = engine(on, diff, true, SKILLS, { reportInstructions: instructions })
  const clock = minutes(on)
  on('session.end', () => ({ sessionId: 's' }) as never)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($)
  await $.turn.complete(finishTurn(undefined, 'Asked for approval.'))
  return { seen, clock, diff }
}

test('while waiting with no turn running, a waiting report goes once a minute', async ($, on) => {
  const { seen, clock } = await idleWaiting($, on)
  expect(clock.waits.map(w => w.ms)).toEqual([60_000])
  const before = reports(seen).length
  await clock.pass()
  await clock.pass()
  expect(reports(seen).slice(before).map(r => r.status)).toEqual(['waiting', 'waiting'])
})

test('an answer that arrives with no turn running is submitted as a prompt once, the session reports working, and no later prompt carries it', async ($, on) => {
  const instructions: string[] = []
  const { seen, clock } = await idleWaiting($, on, instructions)
  instructions.push(ANSWER)
  await clock.pass()
  expect(seen.submitted.filter(text => text.includes('Approval request ar_1'))).toHaveLength(1)
  expect(reports(seen).at(-1)).toMatchObject({ status: 'working' })
  const later = await $.prompt.submit(typed('and then'))
  expect('context' in later ? (later.context ?? []).join('\n') : '').not.toContain('Approval request')
  expect(seen.submitted.filter(text => text.includes('Approval request ar_1'))).toHaveLength(1)
})

test('the timer stops once the answer is handed over: no report after that', async ($, on) => {
  const instructions: string[] = []
  const { seen, clock } = await idleWaiting($, on, instructions)
  instructions.push(ANSWER)
  await clock.pass()
  const sent = reports(seen).length
  await clock.pass()
  await clock.pass()
  expect(reports(seen)).toHaveLength(sent)
})

test('the timer stops when the session reports a status other than waiting', async ($, on) => {
  const { seen, clock, diff } = await idleWaiting($, on)
  await $.prompt.submit(typed('go on'))
  diff.lines = 12
  await $.turn.complete(finishTurn(undefined, 'Edited the page.'))
  const sent = reports(seen).length
  await clock.pass()
  await clock.pass()
  expect(reports(seen)).toHaveLength(sent)
})

test('the timer stops when the session ends: no report after that', async ($, on) => {
  const { seen, clock } = await idleWaiting($, on)
  await $.session.end({ reason: 'exit' } as never)
  const sent = reports(seen).length
  await clock.pass()
  await clock.pass()
  expect(reports(seen)).toHaveLength(sent)
})
