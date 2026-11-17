import { expect, test } from 'claude-code/testing'

import { RUN, SKILLS, engine, finishTurn, start } from './helpers'

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

test('a round whose only BLOCKING line says none settles as clean', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: **None.**\nVERDICT: clean'))
  expect(seen.server.find(t => t.key === 'TCK-143')?.status).toBe('Done')
})
