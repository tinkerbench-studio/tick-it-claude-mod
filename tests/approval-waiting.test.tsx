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
