import { expect, test } from 'claude-code/testing'

import { SKILLS, engine, finishTurn, start, STARTED, typed, reports } from './helpers'

const REQUEST = 'mcp__plugin_tick-it_tickit__request_review'
const RECORD = 'mcp__plugin_tick-it_tickit__record_approval'
const ask = ($: Parameters<Parameters<typeof test>[1]>[0], key = 'TCK-151') => $.tool.call({ tool: REQUEST, tool_use_id: 'tu-r', repository: 'acme/web-app', key, session: 's_abc12345' } as never)
/** What Tick-it hands a waiting session when the request is answered (apps/mcp/src/approval-delivery.ts). */
const ANSWER = 'Tick-it session s_abc12345: continue TCK-151 in acme/web-app.\nApproval request ar_1 (Saved card picker) was answered: confirmed. Items: page v2. Outcome: carry on.'

/** The once-a-minute check the mod arms while a session waits on an approval (TCK-95). */
const poll = (seen: ReturnType<typeof engine>) => {
  const timer = seen.timers.find(t => t.ms === 60_000)
  if (timer === undefined) throw new Error('no once-a-minute timer was armed')
  return timer.tick()
}

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

test('an answer that arrives with no turn running is a toast, and goes to Claude with a prompt the mod submits, once', async ($, on) => {
  const instructions: string[] = []
  const seen = engine(on, { lines: 0 }, true, SKILLS, { reportInstructions: instructions })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  // The waiting report brings the answer, after the turn has ended.
  instructions.push(ANSWER)
  await ask($)
  expect(seen.toasts.join(' ')).toContain('Approval request ar_1 (Saved card picker) was answered: confirmed')
  // A tool call cannot start a turn: the answer is kept, and the next minute's check submits it.
  expect(seen.submitted.filter(text => text.includes('Approval request'))).toEqual([])
  await poll(seen)
  expect(seen.submitted.filter(text => text.includes('Approval request ar_1 (Saved card picker) was answered: confirmed'))).toEqual([ANSWER])
  expect(reports(seen).at(-1)).toMatchObject({ status: 'working' })
  await $.prompt.submit(typed('and then'))
  expect(seen.contexts.at(-1)?.join('\n')).not.toContain('Approval request')
  await poll(seen)
  expect(seen.submitted.filter(text => text.includes('Approval request ar_1'))).toEqual([ANSWER])
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

test('a read-only turn still asks Tick-it for the answer with a waiting report, and an answer that comes back starts a turn of its own', async ($, on) => {
  const instructions: string[] = []
  const seen = engine(on, { lines: 0 }, true, SKILLS, { reportInstructions: instructions, skip: 120_000 })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($)
  instructions.push(ANSWER)
  await $.turn.complete(finishTurn(undefined, 'Read the page again.'))
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'waiting', 'waiting', 'working'])
  expect(seen.toasts.join(' ')).toContain('was answered: confirmed')
  expect(seen.submitted.filter(text => text.includes('Approval request ar_1'))).toEqual([ANSWER])
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

/** A session that asked for an approval and ended its turn: idle, waiting, with nothing yet answered. */
const waitingIdle = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const instructions: string[] = []
  const seen = engine(on, { lines: 0 }, true, SKILLS, { reportInstructions: instructions })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await ask($)
  await $.turn.complete(finishTurn(undefined, 'Asked for approval.'))
  return { seen, instructions }
}

test('an idle waiting session sends a waiting report once a minute', async ($, on) => {
  const { seen } = await waitingIdle($, on)
  const before = reports(seen).length
  await poll(seen)
  await poll(seen)
  expect(reports(seen).slice(before).map(r => r.status)).toEqual(['waiting', 'waiting'])
  expect(seen.submitted.filter(text => text.includes('Approval request'))).toEqual([])
})

test('an answer the once-a-minute report brings is submitted as a prompt once, the session reports working, and later minutes send nothing', async ($, on) => {
  const { seen, instructions } = await waitingIdle($, on)
  await poll(seen)
  instructions.push(ANSWER)
  await poll(seen)
  expect(seen.toasts.join(' ')).toContain('Approval request ar_1 (Saved card picker) was answered: confirmed')
  expect(seen.submitted.filter(text => text.includes('Approval request ar_1'))).toEqual([ANSWER])
  expect(reports(seen).at(-1)).toMatchObject({ status: 'working' })
  instructions.length = 0
  const after = reports(seen).length
  await $.turn.complete(finishTurn(undefined, 'Carried on.'))
  const atEnd = reports(seen).length
  await poll(seen)
  await poll(seen)
  expect(reports(seen).length).toBe(atEnd)
  expect(atEnd).toBeGreaterThanOrEqual(after)
})

test('the minute check sends nothing while a turn runs', async ($, on) => {
  const { seen } = await waitingIdle($, on)
  await $.prompt.submit(typed('look at the page'))
  const before = reports(seen).length
  await poll(seen)
  expect(reports(seen).length).toBe(before)
})

test('the minute check sends nothing for a session that is not waiting', async ($, on) => {
  const seen = engine(on, { lines: 0 }, true, SKILLS)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  const before = reports(seen).length
  await poll(seen)
  expect(reports(seen).length).toBe(before)
})

test('the minute check stops when the session ends', async ($, on) => {
  on('session.end', () => ({ sessionId: 'session-1' }))
  const { seen } = await waitingIdle($, on)
  await $.session.end({ reason: 'other' } as never)
  const before = reports(seen).length
  await poll(seen)
  expect(reports(seen).length).toBe(before)
})
