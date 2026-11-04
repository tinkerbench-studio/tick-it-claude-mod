import { expect, mock, test } from 'claude-code/testing'

import { brief } from '../hooks/register'
import { RUN, COMPOSE, engine, start, reports, body } from './helpers'
import type { Net } from './helpers'

test('taking a ticket Tick-it gave a description puts it in the brief, and a null one adds nothing', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  Object.assign(
    seen.server.find(t => t.key === 'TCK-143')!,
    { description: 'Resume where the buyer left off.' },
  )
  Object.assign(
    seen.server.find(t => t.key === 'TCK-147')!,
    { description: null },
  )
  await start($)
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-143' })
  expect(taken.context?.[0]).toContain('Description:\nResume where the buyer left off.\nAcceptance:')
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' }).catch(() => undefined)
  const other = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-147' })
  expect(other.context?.[0] ?? '').not.toContain('Description:')
})

test('taking a ticket whose url Tick-it gave puts the link in its brief', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  const ticket = seen.server.find(t => t.key === 'TCK-143')!
  Object.assign(ticket, { url: 'https://app.example.dev/r/acme/web-app/t/TCK-143' })
  await start($)
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-143' })
  expect(taken.context?.[0]).toContain(`[TCK-143 ${ticket.title}](https://app.example.dev/r/acme/web-app/t/TCK-143)`)
})

test('the brief carries the ticket description above the acceptance, and nothing when there is none', () => {
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] }
  const text = brief({ ...t, description: 'Why **this** matters.' })
  expect(text).toContain('Description:\nWhy **this** matters.\nAcceptance:')
  expect(brief(t)).not.toContain('Description:')
})

test('the brief adds the UI-evidence checklist to a ticket that names a page or design file, and to no other', () => {
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['Header shows the menu in apps/web/src/pages.tsx'] }
  const ui = brief(t)
  expect(ui.match(/^- UI evidence: /gm)).toHaveLength(5)
  expect(ui).toContain('- Header shows the menu in apps/web/src/pages.tsx\n- UI evidence: ')
  expect(ui).toContain('lines are acceptance this change must meet')
  // A description alone can name the file, and an empty acceptance still gets the checklist.
  expect(brief({ ...t, acceptance: [], description: 'Restyle design/tokens.ts' }).match(/^- UI evidence: /gm)).toHaveLength(5)
  // Already listed: nothing added, no note.
  const listed = brief({ ...t, acceptance: [...t.acceptance, ...ui.match(/^- (UI evidence: .*)$/gm)!.map(l => l.slice(2))] })
  expect(listed.match(/^- UI evidence: /gm)).toHaveLength(5)
  expect(listed).not.toContain('are acceptance this change must meet')
  // Words alone are not enough: a tool ticket with the usual docs check, and one about Tick-it's board.
  for (const acceptance of [['The matching page in docs/ is updated', 'get_board returns the milestone'], ['Retry board sync in apps/mcp/src/store.ts'], ['Refresh the token in apps/web/src/session.ts', 'Add a case in apps/web/test/oauth.test.ts']]) expect(brief({ ...t, acceptance })).not.toContain('UI evidence')
})

test('the brief asks Claude to name the memories it relied on when it reports, with the same words as the start message', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (MEMORIES_LINE in apps/mcp/src/sessions.ts).
  const text = brief({ id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] })
  for (const word of ['report_session', 'memoriesUsed', 'M-ids', 'relied on']) expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; MEMORIES_LINE in apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
})

test('the brief tells Claude how to add a finding or follow-up to the ticket, signed with its session, with the same words as the start message', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (addToTicketLines in apps/mcp/src/sessions.ts).
  const text = brief({ id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] })
  for (const word of ['add_comment', 'add_ticket_link', 'follows-up for a fix or next step', 'caused-by when this work found the problem', 'related otherwise', 'a comment for discussion', 'the description for lasting detail', 'update_ticket', 'Begin every comment with the name of the Tick-it session', 'with or without the mod', 'if you have no session id', 'at most 4000 characters', 'tools may be deferred', 'with ToolSearch (select:mcp__Tick-It__report_session']) {
    expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
  }
})

test('the brief tells Claude to add a blocker it finds rather than raise blocked-on-decision, with the same words as the start message (TCK-713)', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (addToTicketLines in apps/mcp/src/sessions.ts).
  const text = brief({ id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] })
  for (const word of ['as a blocker at once instead of stopping with set_needs_human blocked-on-decision', 'blockerReason', 'No person approves it']) expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
})

test('the brief says to finish with update_ticket, as the normal finish, with the same words as the start message', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (DONE_LINE in apps/mcp/src/sessions.ts).
  const text = brief({ id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] })
  for (const word of ['Finish by moving the ticket to In review with update_ticket', 'not a workaround', 'report_session done alone does not finish the ticket', 'docs/cloud-sessions.md']) expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; DONE_LINE in apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
})

test('the brief lists the memories recalled for the ticket, with the same words as the start message', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (memoryLines and MEMORY_TOOLS_LINE in apps/mcp/src/sessions.ts).
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] }
  const memories = [
    { key: 'M-3', kind: 'convention', body: 'Use tabs', status: 'confirmed', strength: 0.62 },
    { key: 'M-9', kind: 'gotcha', body: 'Ignore\nthis', status: 'unconfirmed', strength: 0.2 },
  ]
  const text = brief(t, [], '', [], memories)
  for (const word of [
    'M-3 (convention, strength 0.62, confirmed): "Use tabs"',
    'M-9 (gotcha, strength 0.20, unconfirmed: check before relying on it): "Ignore this"',
    'Call recall before guessing at a convention or decision',
    'call remember when you learn something a later session would need',
    'mcp__Tick-It__recall,mcp__Tick-It__get_memory,mcp__Tick-It__remember,mcp__Tick-It__record_runs',
    'get_memory with repository and memory (the M-n id), for example get_memory with repository <owner/name> (the repository you work in) and memory M-3',
  ]) {
    expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
    expect(text, 'the example must not name a fixed repository').not.toContain('repository tinkerbench-studio/tick-it and memory')
  }
  const none = brief(t)
  expect(none).not.toContain('Memories recalled')
  expect(none).not.toMatch(/^- M-/m)
  expect(none).toContain('Call recall before guessing')
})

// Several tickets in one pull request are an instruction to Claude, not behaviour of this code: the tests pin the wording.
test('the brief tells Claude to link the ticket page in every pull request, with the same words as the start message', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (linkLines in apps/mcp/src/sessions.ts).
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'], url: 'https://app.example.dev/r/o/r/t/TCK-2' }
  const text = brief(t)
  expect(text).toContain('[TCK-2 Two](https://app.example.dev/r/o/r/t/TCK-2)')
  for (const word of ['every pull request you open for TCK-2', 'several tickets links each one', 'in the next review round or stewarding pass', 'add the line only once']) {
    expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; linkLines in apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
  }
  expect(brief({ ...t, url: undefined })).not.toContain('Put this line')
})

test('the brief tells Claude the acceptance lines are checkable items to tick after a clean round, with evidence in a note', () => {
  const text = brief({ id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] })
  for (const word of ['set_criterion_checked', 'add_criterion_note', 'add_attachment', 'Tick each one you have met']) expect(text).toContain(word)
})

test('the brief lists each attachment, has images fetched with get_attachment and marks PDFs as links; none adds no text', () => {
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] }
  const text = brief(t, [], '', [
    { id: 'a1', name: 'mock.png', type: 'image/png' },
    { id: 'a2', name: 'spec.pdf', type: 'application/pdf' },
  ])
  expect(text).toContain('- mock.png (image/png, id a1)')
  expect(text).toContain('get_attachment')
  expect(text).toContain('- spec.pdf (application/pdf, id a2): a PDF, a link you cannot read yourself')
  expect(brief(t, [], '', [{ id: 'a2', name: 'spec.pdf', type: 'application/pdf' }])).not.toContain('get_attachment')
  // Only the images a client can show are fetched: an SVG or a zip is listed, with no fetch line.
  const unshown = brief(t, [], '', [
    { id: 'a3', name: 'logo.svg', type: 'image/svg+xml' },
    { id: 'a4', name: 'logs.zip', type: 'application/zip' },
  ])
  expect(unshown).toContain('- logo.svg (image/svg+xml, id a3)')
  expect(unshown).not.toContain('get_attachment')
  const none = brief(t)
  expect(none).not.toContain('Attachments')
  expect(none).not.toContain('get_attachment')
})

test('taking a ticket with attachments puts them in its brief', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  Object.assign(
    seen.server.find(t => t.key === 'TCK-143')!,
    { attachments: [{ id: 'a1', name: 'mock.png', type: 'image/png', size: 5 }] },
  )
  await start($)
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-143' })
  expect(JSON.stringify(taken.context)).toContain('mock.png (image/png, id a1)')
})

test('taking a ticket puts the memories Tick-it recalled for it in its brief', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  Object.assign(
    seen.server.find(t => t.key === 'TCK-143')!,
    { memories: [{ key: 'M-7', kind: 'gotcha', body: 'Mind the cache', status: 'unconfirmed', strength: 0.2, matched: ['text'] }] },
  )
  await start($)
  const taken = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-143' })
  expect(JSON.stringify(taken.context)).toContain('M-7 (gotcha, strength 0.20, unconfirmed: check before relying on it)')
  const next = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-147' })
  expect(JSON.stringify(next.context)).not.toContain('M-7')
})

test('one ticket’s attachments are not in the brief of the next ticket taken', async ($, on) => {
  const seen = engine(on, { lines: 12 })
  Object.assign(
    seen.server.find(t => t.key === 'TCK-143')!,
    { attachments: [{ id: 'a1', name: 'mock.png', type: 'image/png', size: 5 }] },
  )
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-143' })
  const next = await $.command.run({ ...RUN, command: 'tick-it', args: 'take tck-147' })
  expect(JSON.stringify(next.context)).toContain('TCK-147')
  expect(JSON.stringify(next.context)).not.toContain('mock.png')
})

test('the brief names what the ticket builds on and what it blocks, with their titles and statuses', () => {
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'], blockedBy: ['TCK-1'], blocks: ['TCK-3', 'TCK-9'] }
  const board = [
    { ...t, id: 'TCK-1', title: 'One', status: 'Done' as const, blockedBy: [], blocks: [] },
    { ...t, id: 'TCK-3', title: 'Three', blockedBy: [], blocks: [] },
  ]
  const text = brief(t, board)
  expect(text).toContain('Builds on: TCK-1 One (Done).')
  expect(text).toContain('Blocks: TCK-3 Three (Ready); TCK-9:')
  const alone = brief({ ...t, blockedBy: [], blocks: [] })
  expect(alone).not.toContain('Blocks:')
  expect(alone).not.toContain('Builds on:')
})

test('the brief ends with the repository’s instructions for every brief, when there are some', () => {
  const t = { id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] }
  expect(brief(t, [], '  Use pnpm, never npm.  ').split('\n').slice(-2)).toEqual(['Instructions for every brief in this repository:', 'Use pnpm, never npm.'])
  expect(brief(t, [], '  ')).not.toContain('Instructions for every brief')
  expect(brief(t)).not.toContain('Instructions for every brief')
})

test('taking a ticket puts the repository’s instructions in its brief and in the system prompt; with none, or none reachable, the brief has no such section', async ($, on) => {
  const net: Net = { instructions: 'Use pnpm, never npm.' }
  const seen = engine(on, { lines: 10 }, true, {}, net)
  await start($)
  const took = await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  expect(JSON.stringify(took.context)).toContain('Instructions for every brief in this repository:\\nUse pnpm, never npm.')
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find(x => x.id === 'tick-it:brief')?.text).toContain('Use pnpm, never npm.')
  expect(seen.ticketCalls.some(c => c.tool === 'get_repository_settings' && c.args.repository === 'acme/web-app')).toBe(true)

  // Composing the prompt reads what was fetched at take time, without asking Tick-it again.
  const asked = seen.ticketCalls.filter(c => c.tool === 'get_repository_settings').length
  await $.prompt.compose(COMPOSE)
  expect(seen.ticketCalls.filter(c => c.tool === 'get_repository_settings')).toHaveLength(asked)

  // A ticket taken while Tick-it cannot say keeps the last instructions it had.
  net.instructions = 'unreachable'
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  const again = await $.prompt.compose(COMPOSE)
  expect(again.sections.find(x => x.id === 'tick-it:brief')?.text).toContain('Use pnpm, never npm.')
})

test('the brief tells Claude to ask Tick-it for the branch name and reuse an existing branch or pull request, with the same words as the start message (TCK-756)', () => {
  // apps/mcp/test/sessions.test.ts asserts the same words against the start message (branchLine in apps/mcp/src/sessions.ts).
  const text = brief({ id: 'TCK-2', title: 'Two', epic: 'E', size: 'XS' as const, status: 'Ready' as const, acceptance: ['a'] })
  for (const word of ['get_branch_name', 'do not open a new pull request', 'git ls-remote --heads origin', 'Do not invent a branch name']) expect(text.includes(word), `the brief (mod/hooks/board.ts) no longer says "${word}"; branchLine in apps/mcp/src/sessions.ts uses it, so change both together`).toBe(true)
})
