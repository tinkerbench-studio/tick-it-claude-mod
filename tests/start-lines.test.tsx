import { expect, test } from 'claude-code/testing'

import { BREAKDOWN_LINE, START_LINE } from '../hooks/state'
import { RUN, SKILLS, engine, finishTurn, start, typed, reports } from './helpers'

const LINE = 'Tick-it session s_abc12345: work on TCK-151 in acme/web-app.'
/** The first message of a scheduled session: the line arrives indented inside a routine-fire-payload block. */
const WRAPPED = `[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]\n<routine-fire-payload>\nThe following was supplied by the caller of this routine's API fire endpoint.\n\n    ${LINE}\n    Recognise a session's start line\n\n    The tick-it mod takes the ticket.\n</routine-fire-payload>`

test('a start line is found whatever the ticket prefix, and no other shape of key', () => {
  expect(START_LINE.exec('Tick-it session s_abc12345: work on TCK-151 in acme/web-app.')?.[2]).toBe('TCK-151')
  expect(START_LINE.exec('Tick-it session s_abc12345: work on NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(START_LINE.test('Tick-it session s_abc12345: work on AB-7 in acme/web-app.')).toBe(false)
  expect(START_LINE.test('Tick-it session s_abc12345: work on ABCD-7 in acme/web-app.')).toBe(false)
})

test('a breakdown or analysis line is found whatever the ticket prefix', () => {
  expect(BREAKDOWN_LINE.exec('Tick-it session s_abc12345: break down NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.exec('Tick-it session s_abc12345: analyse suggestions of NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.exec('Tick-it session s_abc12345: check NEW-7 after deploy in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.test('Tick-it session s_abc12345: break down NE-7 in acme/web-app.')).toBe(false)
})

const BREAK = 'Tick-it session s_abc12345: break down NEW-7 in acme/web-app.'
const WRAPPED_BREAK = `[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]\n<routine-fire-payload>\nThe following was supplied by the caller.\n\n    ${BREAK}\n    Big one\n</routine-fire-payload>`

test('a breakdown, analysis or check line indented by spaces or tabs, as a routine-fire-payload delivers it, is found', () => {
  expect(BREAKDOWN_LINE.exec(WRAPPED_BREAK)?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.exec('x\n\tTick-it session s_abc12345: analyse suggestions of NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.exec('x\n    Tick-it session s_abc12345: check NEW-7 after deploy in acme/web-app.')?.[2]).toBe('NEW-7')
})

test('a flush breakdown line is still found, and a sentence that mentions it mid-line is not', () => {
  expect(BREAKDOWN_LINE.exec(`${BREAK}\nMore.`)?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.test(`The first line reads: ${BREAK}`)).toBe(false)
  expect(BREAKDOWN_LINE.test(`> ${BREAK}`)).toBe(false)
})

test('a breakdown session started with the indented line is armed and reports for itself', async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  const report = (session: string) => $.tool.check({ tool: 'mcp__plugin_tick-it_tickit__report_session', input: { session } })
  expect((await report('s_abc12345')).decision).toBe('deny')
  await $.prompt.submit(typed(WRAPPED_BREAK))
  expect((await report('s_abc12345')).decision).not.toBe('deny')
  expect((await report('s_other123')).decision).toBe('deny')
})

test('a start line indented by spaces or tabs, as a routine-fire-payload delivers it, is found', () => {
  expect(START_LINE.exec(WRAPPED)?.[2]).toBe('TCK-151')
  expect(START_LINE.exec(`\t${LINE}`)?.[3]).toBe('acme/web-app')
})

test('a flush start line is still found, and a sentence that mentions it mid-line is not', () => {
  expect(START_LINE.exec(`${LINE}\nMore.`)?.[2]).toBe('TCK-151')
  expect(START_LINE.test(`The first line reads: ${LINE}`)).toBe(false)
  expect(START_LINE.test(`> ${LINE}`)).toBe(false)
})

test('a session started with the indented line is recorded as started and reports', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const entered = await $.prompt.submit(typed(WRAPPED))
  expect('context' in entered ? entered.context?.some(c => c.includes('TCK-151')) : false).toBe(true)
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In progress' })
  expect(reports(seen)).toEqual([{ repository: 'acme/web-app', session: 's_abc12345', status: 'working', claudeSessionId: 'session-1', summary: 'Took TCK-151.' }])
})

test('moving the ticket of an indented-line session to review starts its review agents and ends clean', async ($, on) => {
  const seen = engine(on, { lines: 40 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.prompt.submit(typed(WRAPPED))
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'tck-151', status: 'In review' } as never)
  expect(seen.spawned).toEqual([])
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-151, round 1'])
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'reviewing', 'reviewing', 'reviewing', 'done'])
})

const TOOLS = ['record_runs', 'report_session', 'report_review_agents'] as const
const check = ($: Parameters<Parameters<typeof test>[1]>[0], tool: string) => $.tool.check({ tool: `mcp__plugin_tick-it_tickit__${tool}`, input: { session: 's_abc12345', runs: [] } })

test('a denied record_runs, report_session or agents report while no ticket is current says the mod took no ticket', async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  for (const tool of TOOLS) {
    const denied = await check($, tool)
    expect(denied.decision).toBe('deny')
    expect('reason' in denied ? denied.reason : '').toContain('The mod did not take a ticket in this session')
  }
})

test('a start line that does not match leaves the ticket untaken, and a session that took one keeps the plain deny reasons', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  await $.prompt.submit(typed(`The first line reads: ${LINE}`))
  expect(seen.server.find(t => t.key === 'TCK-151')).not.toMatchObject({ status: 'In progress' })
  expect(reports(seen)).toEqual([])
  const untaken = await check($, 'record_runs')
  expect('reason' in untaken ? untaken.reason : '').toContain('did not take a ticket')

  await $.prompt.submit(typed(WRAPPED))
  const reasons: Record<string, string> = {
    record_runs: 'tick-it records review runs itself, from what each review agent spent.',
    report_review_agents: 'tick-it reports the repository’s review agents itself, from its .tick-it/skills.',
    report_session: 'tick-it reports the session’s progress itself.',
  }
  for (const [tool, reason] of Object.entries(reasons)) {
    const denied = await check($, tool)
    expect(denied.decision).toBe('deny')
    expect('reason' in denied ? denied.reason : '').toBe(reason)
  }
})

test('a start line whose ticket the mod could not take leaves the session to report for itself: its calls are allowed, and taking the ticket later denies them again', async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  await $.prompt.submit(typed('Tick-it session s_abc12345: work on TCK-999 in acme/web-app.'))
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('allow')
  await $.prompt.submit(typed(WRAPPED))
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('deny')
})

test('a session whose start line failed and that then takes its ticket with /tick-it take keeps the deny reasons', async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  await $.prompt.submit(typed('Tick-it session s_abc12345: work on TCK-999 in acme/web-app.'))
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('allow')
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-151' })
  const denied = await check($, 'record_runs')
  expect(denied.decision).toBe('deny')
  expect('reason' in denied ? denied.reason : '').toBe('tick-it records review runs itself, from what each review agent spent.')
})

test('a start line for another repository than the folder’s origin takes nothing and leaves the session to report for itself, until a ticket is taken', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  const submitted = await $.prompt.submit(typed(LINE.replace('acme/web-app', 'acme/other')))
  expect(JSON.stringify(submitted)).toContain('it records and reports for itself')
  expect(seen.server.find(t => t.key === 'TCK-151')).not.toMatchObject({ status: 'In progress' })
  expect(reports(seen)).toEqual([])
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('allow')
  await $.prompt.submit(typed('Tick-it session s_abc12345: work on TCK-151 in acme/web-app.'))
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('deny')
})
