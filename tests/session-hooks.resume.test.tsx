import { expect, test } from 'claude-code/testing'

import { RUN, PRINCIPAL_ONLY, engine, finishTurn, start, reports } from './helpers'

const BASE = 'cd12'.repeat(10)
const ticket = { id: 'TCK-143', title: 'Persist checkout step in session', epic: 'One-page checkout', epicId: 'e-checkout', size: 'XS', status: 'In progress', acceptance: ['Step stored'] }
const started = { id: 's_abc12345', repository: 'acme/web-app', ticket: 'TCK-143', status: 'working', reportedAt: 0, claudeSession: 'session-1' }
const saved = (over: Record<string, unknown> = {}) => ({ claudeSession: 'session-1', repository: 'acme/web-app', current: 'TCK-143', baseCommit: BASE, steward: null, reviewNext: null, ...over })
const store = (over: Record<string, unknown> = {}) => ({ tickets: [ticket], 'started-session': started, 'resume-state': saved(over) })
const WRITE = { tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 140 }, (_, i) => `line ${i}`).join('\n') }
const UPDATE = 'mcp__plugin_tick-it_tickit__update_ticket'
const check = ($: Parameters<typeof start>[0] & { tool: { check: (e: never) => Promise<{ decision?: string }> } }, tool: string) => $.tool.check({ tool: `mcp__plugin_tick-it_tickit__${tool}`, input: { session: 's_abc12345', runs: [] } } as never)

test('a resumed session keeps its taken ticket: the size guard refuses an edit over its budget', async ($, on) => {
  engine(on, { lines: 0, stored: store() })
  await start($)
  expect(JSON.stringify(await $.tool.call(WRITE as never))).toContain("over TCK-143's XS budget of 100")
})

test('a resumed session moves to review itself: its review agents start when the turn ends and report_session is sent, from the restored base commit', async ($, on) => {
  const again = engine(on, { lines: 4, stored: store() }, true, PRINCIPAL_ONLY)
  await start($)
  await $.tool.call({ tool: UPDATE, tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-143', status: 'In review' } as never)
  expect(again.ticketCalls.filter(c => c.tool === 'update_ticket').at(-1)?.args).toMatchObject({ status: 'In review', changedLines: 4 })
  // Measured from the commit the ticket was taken at, never HEAD at the resume.
  const diffs = again.processes.filter(p => p.startsWith('git diff --numstat'))
  expect(diffs.length).toBeGreaterThan(0)
  expect(diffs.every(p => p.endsWith(` ${BASE}`))).toBe(true)
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(again.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-143, round 1'])
  expect(reports(again).some(r => r.status === 'reviewing')).toBe(true)
})

test('a steward in phase fixing is restored and the next turn end starts the next round', async ($, on) => {
  const steward = { ticket: 'TCK-143', round: 1, phase: 'fixing', maxRounds: 3 }
  const seen = engine(on, { lines: 4, stored: store({ current: null, baseCommit: null, steward }) }, true, PRINCIPAL_ONLY)
  seen.server.find(t => t.key === 'TCK-143')!.status = 'In review'
  await start($)
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-143, round 2'])
})

test('a steward in phase reviewing is restored as fixing, so its round runs again when the next turn ends', async ($, on) => {
  const steward = { ticket: 'TCK-143', round: 2, phase: 'reviewing', maxRounds: 3 }
  const seen = engine(on, { lines: 4, stored: store({ current: null, baseCommit: null, steward }) }, true, PRINCIPAL_ONLY)
  seen.server.find(t => t.key === 'TCK-143')!.status = 'In review'
  await start($)
  await $.turn.complete(finishTurn(undefined, 'Carried on.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-143, round 2'])
})

for (const [name, over] of [
  ['another Claude session', { claudeSession: 'session-2' }],
  ['another repository', { repository: 'acme/other' }],
] as const) {
test(`${name} restores none of the taken ticket, base commit or stewarding`, async ($, on) => {
  const steward = { ticket: 'TCK-143', round: 1, phase: 'fixing', maxRounds: 3 }
  const seen = engine(on, { lines: 0, stored: store({ ...over, steward }) }, true, PRINCIPAL_ONLY)
  await start($)
  expect(JSON.stringify(await $.tool.call(WRITE as never))).not.toContain('refused')
  await $.turn.complete(finishTurn(undefined, 'Nothing to steward.'))
  expect(seen.spawned).toEqual([])
})
}

test("a resumed session with a started session but no taken ticket may record_runs and report_session itself", async ($, on) => {
  engine(on, { lines: 0, stored: store({ current: null, baseCommit: null }) })
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  expect((await check($, 'record_runs')).decision).not.toBe('deny')
  expect((await check($, 'report_session')).decision).not.toBe('deny')
})

test('a resumed session with its ticket restored still has record_runs and report_session denied', async ($, on) => {
  engine(on, { lines: 0, stored: store() })
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  expect((await check($, 'record_runs')).decision).toBe('deny')
  expect((await check($, 'report_session')).decision).toBe('deny')
})

for (const command of ['done', 'drop']) {
  test(`/tick-it ${command} clears the stored taken ticket and base commit: a session started again restores neither`, async ($, on) => {
    engine(on, { lines: 4, stored: store() }, true, PRINCIPAL_ONLY)
    await start($)
    await $.command.run({ ...RUN, command: 'tick-it', args: command })
    // Started again from the store as the command left it (the same store, a new session.start).
    await start($)
    expect(JSON.stringify(await $.tool.call(WRITE as never))).not.toContain('refused')
  })
}

const kept = async (on: Parameters<typeof engine>[0], stored: Record<string, unknown> = {}, skills = PRINCIPAL_ONLY) => {
  const map = new Map<string, unknown>()
  const seen = engine(on, { lines: 4, stored, kept: map }, true, skills)
  return { map, seen, state: () => map.get('resume-state') as Record<string, unknown> | undefined }
}

test('taking a ticket keeps it and its base commit in the store, stamped with the session and repository', async ($, on) => {
  const { state } = await kept(on)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(state()).toMatchObject({ claudeSession: 'session-1', repository: 'acme/web-app', current: 'TCK-143', baseCommit: 'ab12'.repeat(10), steward: null, reviewNext: null })
})

test('a stewarding round keeps the steward in the store as it changes', async ($, on) => {
  const { state } = await kept(on)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(state()).toMatchObject({ current: null, baseCommit: null, steward: { ticket: 'TCK-143', round: 1, phase: 'reviewing' } })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: wrong'))
  expect(state()).toMatchObject({ steward: { ticket: 'TCK-143', round: 1, phase: 'fixing' } })
})

test("Claude's own move to In review keeps reviewNext in the store until the turn ends", async ($, on) => {
  const { state } = await kept(on, store())
  await start($)
  await $.tool.call({ tool: UPDATE, tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-143', status: 'In review' } as never)
  expect(state()).toMatchObject({ current: null, baseCommit: null, reviewNext: 'TCK-143' })
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(state()).toMatchObject({ reviewNext: null })
})

test('a reviewNext kept in the store has its review agents start when the next turn ends', async ($, on) => {
  const { seen } = await kept(on, store({ current: null, baseCommit: null, reviewNext: 'TCK-143' }))
  seen.server.find(t => t.key === 'TCK-143')!.status = 'In review'
  await start($)
  await $.turn.complete(finishTurn(undefined, 'Carried on.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-143, round 1'])
})
