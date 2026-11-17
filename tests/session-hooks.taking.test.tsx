import { expect, test } from 'claude-code/testing'

import { brief } from '../hooks/register'
import { RUN, COMPOSE, SKILLS, engine, finishTurn, start, STARTED, typed, reports, UI_FILES } from './helpers'

test('Claude taking a ticket itself is /tick-it take: the brief, then progress to its session, then the review agents', async ($, on) => {
  const seen = engine(on, { lines: 12 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  const taken = await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  const context = 'context' in taken ? (taken.context ?? []) : []
  expect(context[0]).toBe('tick-it: TCK-147 is yours.')
  expect(context[1]).toContain('Timeouts fall back to unvalidated')
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.some(s => s.id === 'tick-it:brief' && s.text.includes('TCK-147'))).toBe(true)
  await $.turn.complete(finishTurn(undefined, 'Wrapped the client.'))
  expect(reports(seen).at(-1)).toMatchObject({ session: 's_taken12345', status: 'working', summary: 'Wrapped the client.' })
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-2', repository: 'acme/web-app', key: 'TCK-147', status: 'In review' } as never)
  await $.turn.complete(finishTurn(undefined, 'Done.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-147, round 1'])
})

test('Claude taking a ticket in another repository is left alone', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  await start($)
  const calls = seen.ticketCalls.length
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/other', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  expect(seen.ticketCalls.length).toBe(calls)
  expect((await $.prompt.compose(COMPOSE)).sections.some(s => s.id === 'tick-it:brief')).toBe(false)
})

test('a ticket Claude moved to In review where the hook did not see it is stewarded when the turn ends', async ($, on) => {
  const seen = engine(on, { lines: 12 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  // Moved on Tick-it with no tool.call the mod heard.
  seen.server.find(t => t.key === 'TCK-147')!.status = 'In review'
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket').at(-1)?.args).toMatchObject({ key: 'TCK-147', status: 'In review', changedLines: 12 })
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-147, round 1'])
})

test('a UI change moved to In review where the hook did not see it is refused at the turn end, and Claude is told what is missing', async ($, on) => {
  const seen = engine(on, { lines: 12, numstatZ: UI_FILES }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  seen.server.find(t => t.key === 'TCK-147')!.status = 'In review'
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(seen.spawned).toEqual([])
  expect(seen.submitted.some(t => t.includes('changes the UI') && t.includes('has no confirmed picture in Tick-it'))).toBe(true)
  // The same refusal at the next turn end is not sent again.
  const sent = seen.submitted.length
  await $.turn.complete(finishTurn(undefined, 'Still no pictures.'))
  expect(seen.submitted.length).toBe(sent)
})

test('Claude moving another ticket, or its own somewhere else, is left alone', async ($, on) => {
  const seen = engine(on, { lines: 40 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  const calls = seen.ticketCalls.length
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-147', status: 'In review' } as never)
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-2', repository: 'acme/web-app', key: 'TCK-151', title: 'Saved cards' } as never)
  expect(seen.ticketCalls.length).toBe(calls)
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(seen.spawned).toEqual([])
})

const takeBrief = async ($: Parameters<typeof start>[0] & { tool: { call: (e: never) => Promise<unknown> }; prompt: { compose: (e: never) => Promise<{ sections: { id: string; text: string }[] }> } }) => {
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  return (await $.prompt.compose(COMPOSE as never)).sections.find(s => s.id === 'tick-it:brief')?.text ?? ''
}

test("the brief a taken ticket gets uses the repository's design.uiPaths, fetched from Tick-it, for the UI-evidence checklist", async ($, on) => {
  const config = [{ branch: 'main', design: { uiPaths: ['src/ui/**'] } }]
  const mine = engine(on, { lines: 12 }, true, {}, { config })
  mine.server.find(t => t.key === 'TCK-147')!.acceptance = ['Edit src/ui/x.tsx']
  await start($)
  expect((await takeBrief($ as never)).match(/^- UI evidence: /gm)).toHaveLength(5)
})

test("a ticket naming a built-in UI path gets no checklist when the repository's design.uiPaths does not list it, and gets it when none are set", async ($, on) => {
  const set = engine(on, { lines: 12 }, true, {}, { config: [{ branch: 'main', design: { uiPaths: ['src/ui/**'] } }] })
  set.server.find(t => t.key === 'TCK-147')!.acceptance = ['Edit apps/web/src/pages.tsx']
  await start($)
  expect(await takeBrief($ as never)).not.toContain('UI evidence')
})

test('with no design.uiPaths set, the brief of a ticket naming a built-in UI path carries the checklist', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  seen.server.find(t => t.key === 'TCK-147')!.acceptance = ['Edit apps/web/src/pages.tsx']
  await start($)
  expect((await takeBrief($ as never)).match(/^- UI evidence: /gm)).toHaveLength(5)
})

test('Claude moving a same-key ticket of another repository to In review leaves the taken ticket alone', async ($, on) => {
  const seen = engine(on, { lines: 12 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  const calls = seen.ticketCalls.length
  const ran = await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-2', repository: 'acme/other', key: 'TCK-147', status: 'In review' } as never)
  expect(ran).not.toHaveProperty('deny')
  expect(seen.server.find(t => t.key === 'TCK-147')?.status).toBe('In progress')
  expect(seen.ticketCalls.slice(calls).map(c => c.tool)).not.toContain('link_pull_request')
  // The call goes on as Claude made it (the test harness runs no real call): the mod sends no update_ticket of its own, with changed lines or a pull request.
  expect(seen.ticketCalls.slice(calls).filter(c => c.tool === 'update_ticket')).toEqual([])
  expect(seen.ticketCalls.slice(calls).filter(c => c.tool === 'report_session')).toEqual([])
  await $.turn.complete(finishTurn(undefined, 'Done.'))
  expect(seen.spawned).toEqual([])
})

test('Claude moving its ticket to In review with the repository in another letter case still finishes it', async ($, on) => {
  const seen = engine(on, { lines: 12 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-2', repository: 'Acme/Web-App', key: 'TCK-147', status: 'In review' } as never)
  await $.turn.complete(finishTurn(undefined, 'Done.'))
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket').at(-1)?.args).toMatchObject({ key: 'TCK-147', status: 'In review', changedLines: 12 })
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-147, round 1'])
})
