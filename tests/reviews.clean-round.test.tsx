import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, reports, start } from './helpers'

test('a clean review round takes the ticket to Done on Tick-it', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
})

test('a clean review round with an acceptance check unticked gives Claude a turn to tick it, then asks a person', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, {
    acceptanceItems: [
      { id: 'c1', text: 'It saves', checked: false },
      { id: 'c2', text: 'It loads', checked: true },
    ],
  })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  // Round 1 is clean but a check is unticked: Claude is asked to tick the ones it has met, and nothing is ticked, ended or flagged yet.
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('1 acceptance check is not ticked')
  expect(seen.submitted[0]).toContain('- It saves')
  expect(seen.ticketCalls.some(c => c.tool === 'set_criterion_checked' || c.tool === 'set_needs_human')).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  // Its turn ends and round 2 runs; the check is still unticked, so a person is asked and the ticket stays In review.
  await $.turn.complete(finishTurn(undefined, 'It saves is not met: the step is not stored.'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean'))
  expect(seen.ticketCalls.some(c => c.tool === 'set_criterion_checked')).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(seen.submitted).toHaveLength(1)
  expect(seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => c.args)).toEqual([{ repository: 'acme/web-app', key: 'TCK-143', kind: 'no-clean-round', note: '1 acceptance check is not ticked after a clean round: It saves' }])
})

test('a clean review round whose only unticked check is flagged after-deploy is not held for ticking', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, {
    acceptanceItems: [
      { id: 'c1', text: 'It saves', checked: true },
      { id: 'c2', text: 'Works in production', checked: false, afterDeploy: true },
    ],
  })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.submitted).toHaveLength(0)
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
})

test('the ticking turn is offered again after a fix round: clean, unticked, blocked, fixed, clean, unticked', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, { acceptanceItems: [{ id: 'c1', text: 'It saves', checked: false }] })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.submitted).toHaveLength(1)
  // The ticking turn ends and round 2 finds something to fix.
  await $.turn.complete(finishTurn(undefined, 'Nothing met yet.'))
  await $.turn.complete(finishTurn('agent-2', 'BLOCKING: api/a.ts:4 no test\nVERDICT: changes'))
  expect(seen.submitted).toHaveLength(2)
  await $.turn.complete(finishTurn(undefined, 'Added the test.'))
  // Round 3 is clean with the check still unticked: Claude gets the ticking turn again, and no person is asked yet.
  await $.turn.complete(finishTurn('agent-3', 'VERDICT: clean'))
  expect(seen.submitted).toHaveLength(3)
  expect(seen.submitted[2]).toContain('not ticked')
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
})

test('a clean review round whose acceptance checks cannot be read asks a person instead of going to Done', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  seen.failTicketReads = true
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(seen.submitted).toHaveLength(0)
  expect(seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => (c.args as { kind: string }).kind)).toEqual(['no-clean-round'])
})

test('a clean review round with every acceptance check ticked goes to Done', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, { acceptanceItems: [{ id: 'c1', text: 'It saves', checked: true }] })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human')).toBe(false)
})

test('a round with blocking findings ticks no acceptance checks', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  Object.assign(seen.server.find(t => t.key === 'TCK-143') ?? {}, { acceptanceItems: [{ id: 'c1', checked: false }] })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: the step is not stored\nVERDICT: changes'))
  expect(seen.ticketCalls.some(c => c.tool === 'set_criterion_checked')).toBe(false)
})

const PRINCIPAL_SKILL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }
const TWO_SKILLS = { ...PRINCIPAL_SKILL, '.tick-it/skills/security/SKILL.md': SKILLS['.tick-it/skills/security/SKILL.md'] ?? '' }
const toReview = async ($: Parameters<typeof start>[0] & { command: { run: (e: never) => Promise<unknown> } }) => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' } as never)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' } as never)
}
const noReview = (seen: { ticketCalls: { tool: string; args: unknown }[] }) => seen.ticketCalls.filter(c => c.tool === 'set_needs_human').map(c => c.args)

for (const [name, first, second] of [
  ['a turn that ended with a reason other than answer', { ...finishTurn('agent-1', 'VERDICT: clean'), reason: 'error' as never }, { ...finishTurn('agent-2', 'VERDICT: clean'), reason: 'error' as never }],
  ['an answer with no VERDICT line', finishTurn('agent-1', 'I could not read the diff.'), finishTurn('agent-2', 'I could not read the diff.')],
  ['VERDICT: changes with no readable BLOCKING line', finishTurn('agent-1', 'Looks wrong.\nVERDICT: changes'), finishTurn('agent-2', 'Looks wrong.\nVERDICT: changes')],
] as const) {
  test(`${name} is not a clean review: the reviewer is run again once, then a person is asked and the ticket stays In review`, async ($, on) => {
    const seen = engine(on, { lines: 10 }, true, PRINCIPAL_SKILL)
    await toReview($)
    await $.turn.complete(first as never)
    expect(seen.spawned).toHaveLength(2)
    expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
    expect(noReview(seen)).toEqual([])
    await $.turn.complete(second as never)
    expect(seen.spawned).toHaveLength(2)
    expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
    expect(noReview(seen)).toEqual([{ repository: 'acme/web-app', key: 'TCK-143', kind: 'no-clean-round', note: 'principal failed or gave no VERDICT, twice in round 1: not a clean review, so the round is not read as clean.' }])
    expect(seen.submitted).toHaveLength(0)
    // The mod itself stopped (stoppedBy mod, not the stop button): a later move to In review has its fix reviewed once, which a stop button stop would not.
    expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped' })
    await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-again', repository: 'acme/web-app', key: 'TCK-143', status: 'In review' } as never)
    await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
    expect(seen.spawned).toHaveLength(3)
    expect(seen.spawned[2]?.description).toContain('round 2')
  })
}

test('a reviewer that failed is started again in the same round, and a clean second answer settles the round as clean', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL_SKILL)
  await toReview($)
  await $.turn.complete({ ...finishTurn('agent-1', ''), reason: 'error' as never } as never)
  expect(seen.spawned).toHaveLength(2)
  expect(seen.spawned[1]?.prompt).toBe(seen.spawned[0]?.prompt)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
  expect(noReview(seen)).toEqual([])
})

test('a round with one clean reviewer and one failed reviewer is not clean', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, TWO_SKILLS)
  await toReview($)
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  await $.turn.complete({ ...finishTurn('agent-2', 'VERDICT: clean'), reason: 'error' as never } as never)
  await $.turn.complete({ ...finishTurn('agent-3', 'VERDICT: clean'), reason: 'error' as never } as never)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(noReview(seen)).toEqual([{ repository: 'acme/web-app', key: 'TCK-143', kind: 'no-clean-round', note: 'security failed or gave no VERDICT, twice in round 1: not a clean review, so the round is not read as clean.' }])
  // Stopped by the mod itself, so a later move to In review has its fix reviewed once.
  expect(reports(seen).at(-1)).toMatchObject({ status: 'stopped' })
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-again', repository: 'acme/web-app', key: 'TCK-143', status: 'In review' } as never)
  await $.turn.complete(finishTurn(undefined, 'Fixed it.'))
  expect(seen.spawned.filter(s => s.description.endsWith('round 2')).length).toBeGreaterThan(0)
})

test('a reviewer that failed twice does not hide another reviewer\'s BLOCKING lines: they go to Claude to fix, and nobody is asked yet', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, TWO_SKILLS)
  await toReview($)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test\nVERDICT: changes'))
  await $.turn.complete({ ...finishTurn('agent-2', 'VERDICT: clean'), reason: 'error' as never } as never)
  await $.turn.complete({ ...finishTurn('agent-3', 'VERDICT: clean'), reason: 'error' as never } as never)
  expect(seen.submitted.join('\n')).toContain('[principal] BLOCKING: api/a.ts:4 no test')
  expect(noReview(seen)).toEqual([])
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
})

test('a reviewer whose agent was lost is not started again: the round stops for a person, and the note does not say twice', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, TWO_SKILLS)
  await toReview($)
  seen.unlisted = ['agent-2']
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(seen.spawned).toHaveLength(2)
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('In review')
  expect(noReview(seen)).toEqual([{ repository: 'acme/web-app', key: 'TCK-143', kind: 'no-clean-round', note: 'security failed or gave no VERDICT in round 1: not a clean review, so the round is not read as clean.' }])
})

test('a round whose only BLOCKING line says none settles as clean', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: **None.**\nVERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
})
