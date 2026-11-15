import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start, reports, STARTED, typed } from './helpers'
import type { Net } from './helpers'

test("each finished review run goes to Tick-it's MCP server as it lands, so a cloud session loses nothing when it ends", async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.recorded).toEqual([])

  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test\nVERDICT: changes'))
  expect(seen.recorded).toHaveLength(1)
  const [call] = seen.recorded
  expect(call?.server).toBe('plugin:tick-it:tickit')
  expect(call?.args.session).toBe('session-1')
  // Taking the ticket, Tick-it kept a session for it: its id goes beside the Claude Code one.
  expect(call?.args.tickitSession).toBe('s_taken12345')
  expect(call?.args.repository).toBe('acme/web-app')
  expect(call?.args.runs).toEqual([
    expect.objectContaining({
      agentId: 'agent-1',
      ticket: 'TCK-143',
      skill: 'principal',
      round: 1,
      model: 'claude-opus-5-5',
      durationMs: 95_000,
      usage: { input: 20_000, output: 4_000, cacheRead: 100_000, cacheWrite: 10_000 },
      costUsd: 0.23,
      blocking: 1,
      // Claude Code on a machine: the place is local.
      place: 'local',
    }),
  ])
  // The finding goes with its text, file and line.
  expect(call?.args.runs[0]).toMatchObject({ findings: [{ severity: 'blocking', file: 'api/a.ts', line: 4, text: 'no test' }] })

  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  expect(seen.recorded.map(c => c.args.runs.map(r => r.agentId))).toEqual([['agent-1'], ['agent-2']])
  const report = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(report.text).toContain('Tick-it has every review run.')
})

test('a run Tick-it rejects is dropped with its reason; the runs sent with it are taken', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS, {
    // The first call finds Tick-it down, so both runs go in the second; Tick-it rejects agent-1.
    answer: (_args, call) => (call === 1 ? 'unreachable' : { rejected: [{ agentId: 'agent-1', reason: 'durationMs must be a whole number' }] }),
  })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))

  expect(seen.recorded.map(c => c.args.runs.map(r => r.agentId))).toEqual([['agent-1'], ['agent-1', 'agent-2']])
  const report = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(report.text).toContain('Nothing waiting to send to Tick-it.')
  expect(report.text).toContain('Dropped: 1 run Tick-it rejected, so it is not in its costs.')
  expect(report.text).toContain('✗ TCK-143 principal round 1  durationMs must be a whole number')
  // Dropped means gone from the outbox: it is never sent again.
  expect((await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })).text).toBe('Nothing waiting to send to Tick-it.')
  expect(seen.recorded).toHaveLength(2)
})

test('a call Tick-it fails as a whole drops nothing: every run waits', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS, { answer: () => ({ isError: true, text: 'token expired' }) })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  const report = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(report.text).toContain('2 review runs waiting to send to Tick-it: Tick-it refused the call: token expired.')
  expect(report.text).not.toContain('Dropped')
  expect(seen.recorded.map(c => c.args.runs.length)).toEqual([1, 2])
})

test('a run Tick-it does not answer for stays waiting', async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS, { silent: true })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  const report = await $.command.run({ ...RUN, command: 'tick-it', args: 'reviews' })
  expect(report.text).toContain('1 review run waiting to send to Tick-it: Tick-it did not answer for 1 run.')
})

test('a session Tick-it started sends its s_… id as tickitSession beside the Claude Code id, so the review hold can match the runs', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  await start($)
  await $.prompt.submit(typed(STARTED))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  const call = seen.recorded.at(-1)
  expect(call?.args.session).toBe('session-1')
  expect(call?.args.tickitSession).toBe('s_abc12345')
})

test('a session that took a ticket with no Tick-it session sends only the Claude Code id', async ($, on) => {
  const net: Net = { noSession: true }
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  const call = seen.recorded.at(-1)
  expect(call?.args.session).toBe('session-1')
  expect(call?.args).not.toHaveProperty('tickitSession')
})

test('a cloud session where tickit will not connect falls back to the claude.ai connector', async ($, on) => {
  const net: Net = { only: 'Tick-It' }
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket')).toBe(true)
  expect(seen.ticketCalls.every(c => c.server === 'Tick-It')).toBe(true)
  expect(seen.recorded.length).toBeGreaterThan(0)
  expect(seen.recorded.every(r => r.server === 'Tick-It')).toBe(true)
  // The connector is how a cloud session reaches Tick-it: its runs say so.
  expect(seen.recorded.flatMap(r => r.args.runs).every(r => r.place === 'cloud')).toBe(true)
})

test('a local session signed in only through the claude.ai connector still reports its runs as local', async ($, on) => {
  const net: Net = { only: 'claude.ai Tick-It' }
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.recorded.length).toBeGreaterThan(0)
  expect(seen.recorded.every(r => r.server === 'claude.ai Tick-It')).toBe(true)
  expect(seen.recorded.flatMap(r => r.args.runs).every(r => r.place === 'local')).toBe(true)
})

test('signed out mid-stewarding: runs wait and the mod says how to sign in', async ($, on) => {
  const net: Net = {}
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  net.connected = false
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.recorded).toEqual([])
  const synced = await $.command.run({ ...RUN, command: 'tick-it', args: 'sync' })
  expect(synced.text).toContain('1 review run still waiting: not connected to Tick-it (Tick-it needs you to sign in). Sign in with /mcp')
})

test("the model cannot record review runs itself; Tick-it's other tools stay its to use", async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  const byModel = await $.tool.check({ tool: 'mcp__plugin_tick-it_tickit__record_runs', input: { runs: [] } })
  expect(byModel.decision).toBe('deny')
  const other = await $.tool.check({ tool: 'mcp__plugin_tick-it_tickit__list_tickets', input: {} })
  expect(other.decision).not.toBe('deny')
  const reporting = await $.tool.check({ tool: 'mcp__plugin_tick-it_tickit__report_session', input: {} })
  expect(reporting.decision).toBe('deny')
})
