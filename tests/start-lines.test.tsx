import { expect, test } from 'claude-code/testing'

import { BREAKDOWN_LINE, CONTINUE_LINE, START_LINE } from '../hooks/state'
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

test('a start line for another repository leaves the session to record and report for itself, and says so: its calls are allowed, nothing is taken, and taking a ticket later denies them again', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  const entered = await $.prompt.submit(typed(LINE.replace('acme/web-app', 'acme/other')))
  expect('context' in entered ? entered.context?.join(' ') : '').toContain('so it did not take TCK-151. The mod records and reports nothing for it: record its runs and report the session yourself')
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('allow')
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready')
  expect(reports(seen)).toEqual([])
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-151' })
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

const CONTINUE = 'Tick-it session s_abc12345: continue TCK-151 in acme/web-app.'
const WRAPPED_CONTINUE = `[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]\n<routine-fire-payload>\nThe following was supplied by the caller.\n\n    ${CONTINUE}\n    Merge main in.\n</routine-fire-payload>`

test('a continue line is found plain, indented and in a routine-fire-payload block, with the start line patterns, and a mention mid-sentence is not', () => {
  expect(CONTINUE_LINE.exec(CONTINUE)?.slice(1)).toEqual(['s_abc12345', 'TCK-151', 'acme/web-app'])
  expect(CONTINUE_LINE.exec(WRAPPED_CONTINUE)?.[2]).toBe('TCK-151')
  expect(CONTINUE_LINE.exec(`\t${CONTINUE}`)?.[3]).toBe('acme/web-app')
  expect(CONTINUE_LINE.test('Tick-it session s_abc12345: continue AB-7 in acme/web-app.')).toBe(false)
  expect(CONTINUE_LINE.test(`The first line reads: ${CONTINUE}`)).toBe(false)
  expect(START_LINE.test(CONTINUE)).toBe(false)
})

const REASONS: Record<(typeof TOOLS)[number], string> = {
  record_runs: 'tick-it records review runs itself, from what each review agent spent.',
  report_review_agents: 'tick-it reports the repository’s review agents itself, from its .tick-it/skills.',
  report_session: 'tick-it reports the session’s progress itself.',
}

for (const [name, text] of [['plain', CONTINUE], ['indented', `    ${CONTINUE}`], ['in a routine-fire-payload block', WRAPPED_CONTINUE]] as const) {
  test(`a continue line ${name} takes the ticket without moving it, reports working to its session, and keeps the session's own calls the mod's`, async ($, on) => {
    const seen = engine(on, { lines: 0 }, true, SKILLS)
    on('tool.check', () => ({ decision: 'allow' as const }))
    const ticket = seen.server.find(t => t.key === 'TCK-151')
    if (ticket !== undefined) ticket.status = 'In review'
    await start($)
    const entered = await $.prompt.submit(typed(text))
    expect('context' in entered ? entered.context?.some(c => c.includes('TCK-151')) : false).toBe(true)
    expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In review', assignee: null })
    expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket')).toEqual([])
    expect(reports(seen)).toEqual([{ repository: 'acme/web-app', session: 's_abc12345', status: 'working', claudeSessionId: 'session-1', summary: 'Continuing TCK-151.' }])
    for (const tool of TOOLS) {
      const denied = await check($, tool)
      expect(denied.decision).toBe('deny')
      expect('reason' in denied ? denied.reason : '').toBe(REASONS[tool])
      expect('reason' in denied ? denied.reason : '').not.toContain('did not take a ticket')
    }
  })
}

test('a continue session starts the review of the ticket already In review when its turn ends, and the mod records and reports it', async ($, on) => {
  const seen = engine(on, { lines: 40 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  const ticket = seen.server.find(t => t.key === 'TCK-151')
  if (ticket !== undefined) ticket.status = 'In review'
  await start($)
  await $.prompt.submit(typed(CONTINUE))
  await $.turn.complete(finishTurn(undefined, 'Merged main.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-151, round 1'])
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'reviewing', 'reviewing', 'done'])
  const reviewRun = seen.recorded.flatMap(r => r.args.runs.map(run => ({ ...run, tickitSession: (r.args as { tickitSession?: string }).tickitSession }))).find(run => run.skill === 'principal')
  expect(reviewRun).toMatchObject({ ticket: 'TCK-151', skill: 'principal', round: 1, tickitSession: 's_abc12345', headSha: 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12' })
  // Only the clean round's move to Done: no write of In review (and its changed lines) or In progress.
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket').map(c => (c.args as { status?: string }).status)).toEqual(['Done'])
})

test('a continue line for another repository takes nothing and leaves the session to record and report for itself', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  const entered = await $.prompt.submit(typed(CONTINUE.replace('acme/web-app', 'acme/other')))
  expect('context' in entered ? entered.context?.join(' ') : '').toContain('so it did not take TCK-151. The mod records and reports nothing for it')
  for (const tool of TOOLS) expect((await check($, tool)).decision).toBe('allow')
  expect(reports(seen)).toEqual([])
})

test('a continue session on a ticket that is Ready to merge reports working, then done when its turn ends, and the ticket is not moved', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  const ticket = seen.server.find(t => t.key === 'TCK-151')
  if (ticket !== undefined) ticket.status = 'Ready to merge'
  await start($)
  await $.prompt.submit(typed(CONTINUE))
  await $.turn.complete(finishTurn(undefined, 'Merged main in.'))
  expect(reports(seen).map(r => r.status)).toEqual(['working', 'done'])
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket')).toEqual([])
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready to merge')
})

test('a message with a start line and a continue line is a start line', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  await $.prompt.submit(typed(`${LINE}\n${CONTINUE.replace('s_abc12345', 's_other123')}`))
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In progress' })
  expect(reports(seen).map(r => r.session)).toEqual(['s_abc12345'])
})

test('a continue session whose ticket status Tick-it cannot confirm at the turn end is not reported done', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  const ticket = seen.server.find(t => t.key === 'TCK-151')
  if (ticket !== undefined) ticket.status = 'Ready to merge'
  await start($)
  await $.prompt.submit(typed(CONTINUE))
  seen.failTicketReads = true
  await $.turn.complete(finishTurn(undefined, 'Merged main in.'))
  expect(reports(seen).map(r => r.status)).toEqual(['working'])
})

test('a continue line that carries an approval answer takes the ticket without moving it and reports working, and its turn does not end the session as done', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  const ticket = seen.server.find(t => t.key === 'TCK-151')
  if (ticket !== undefined) ticket.status = 'In progress'
  await start($)
  await $.prompt.submit(typed(`${CONTINUE}\nApproval request ar_1 (Saved card picker) was answered: confirmed. Items: page v2. Outcome: carry on.`))
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket')).toEqual([])
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In progress' })
  await $.turn.complete(finishTurn(undefined, 'Carried on.'))
  expect(reports(seen).map(r => r.status)).toEqual(['working'])
})
