import { expect, test } from 'claude-code/testing'

import { findingLine, findingRows, parseFinding, roundFindings, count } from '../hooks/register'
import { PANE, RUN, engine, finishTurn, start, PRINCIPAL, STARTED, typed } from './helpers'

test('parseFinding takes a file and line from a finding when it starts with one', () => {
  expect(parseFinding('BLOCKING: src/a.ts:12 Off by one')).toEqual({ severity: 'blocking', file: 'src/a.ts', line: 12, text: 'Off by one' })
  expect(parseFinding('BLOCKING: Node.js crashes on start')).toEqual({ severity: 'blocking', text: 'Node.js crashes on start' })
  expect(parseFinding('BLOCKING: `api/a.ts` - no test')).toEqual({ severity: 'blocking', file: 'api/a.ts', text: 'no test' })
  expect(parseFinding('BLOCKING: a.ts:12-30 loop')).toEqual({ severity: 'blocking', file: 'a.ts', line: 12, text: 'loop' })
  expect(parseFinding(`BLOCKING: ${'x'.repeat(3000)}`).text).toHaveLength(2000)
  expect(parseFinding('OPTIONAL: Rename x to count')).toEqual({ severity: 'optional', text: 'Rename x to count' })
})

test('roundFindings lists one round by severity with file and line, and matches the run counts', () => {
  const run = (round: number, skill: string, items: { severity: 'blocking' | 'optional'; file?: string; line?: number; text: string }[]) => ({ agentId: `${skill}-${round}`, ticket: 'TCK-1', epic: 'E', round, skill, model: 'm', startedAt: 0, status: 'done', blocking: items.filter(i => i.severity === 'blocking').length, optional: items.filter(i => i.severity === 'optional').length, items }) as const
  const runs = [
    run(1, 'tests', [{ severity: 'blocking', file: 'a.ts', line: 1, text: 'old' }]),
    run(2, 'tests', [
      { severity: 'blocking', file: 'src/a.ts', line: 12, text: 'Off by one' },
      { severity: 'optional', text: 'Rename it' },
    ]),
    run(2, 'security', [{ severity: 'blocking', text: 'No check' }]),
  ]
  const blocking = roundFindings([...runs], 2, 'blocking')
  expect(blocking).toEqual([
    { skill: 'tests', text: 'src/a.ts:12 Off by one' },
    { skill: 'security', text: 'No check' },
  ])
  expect(blocking.length).toBe(runs.filter(r => r.round === 2).reduce((n, r) => n + r.blocking, 0))
  expect(roundFindings([...runs], 2, 'optional')).toEqual([{ skill: 'tests', text: 'Rename it' }])
  expect(findingLine({ file: 'a.ts', text: 'x' })).toBe('a.ts x')
})

test('findingRows hides optional findings until shown and says how many are not listed', () => {
  const run = (round: number, over: object) => ({ agentId: `a-${round}`, ticket: 'TCK-1', epic: 'E', round, skill: 'tests', model: 'm', startedAt: 0, status: 'done', ...over }) as never
  // Counts as record_runs carries them: 3 blocking and 2 optional, but only 2 and 1 of them are listed (as when a line has no text or the cap is reached).
  const runs = [
    run(2, {
      blocking: 3,
      optional: 2,
      items: [
        { severity: 'blocking', file: 'a.ts', line: 4, text: 'Bug' },
        { severity: 'blocking', text: 'Other' },
        { severity: 'optional', text: 'Nit' },
      ],
    }),
  ]
  expect(findingRows(runs, 2, false).map(r => r.text)).toEqual(['▲ [tests] a.ts:4 Bug', '▲ [tests] Other', '  1 blocking not listed'])
  expect(findingRows(runs, 2, true).map(r => r.text)).toEqual(['▲ [tests] a.ts:4 Bug', '▲ [tests] Other', '  1 blocking not listed', '· [tests] Nit', '  1 optional not listed'])
  // A run kept from before items were stored lists its BLOCKING lines, with the prefix removed.
  expect(findingRows([run(1, { blocking: 1, optional: 0, findings: ['BLOCKING: b.ts:2 Old'] })], 1, false).map(r => r.text)).toEqual(['▲ [tests] b.ts:2 Old'])
  expect(findingRows(runs, 3, true)).toEqual([])
})

test("the stewarding pane lists the round's blocking findings by file and line, and optional ones only after o", async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL)
  await start($)
  await $.prompt.submit(typed(STARTED.replace('TCK-151', 'TCK-143')))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: src/a.ts:3 Off by one\nOPTIONAL: Rename it'))

  const calls = seen.ticketCalls.length
  const recorded = seen.recorded.length
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /▲ \[.*\] src\/a\.ts:3 Off by one/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Rename it/ })).toBeUndefined()
  expect((await ui.find({ key: 'optional-findings' }))?.text).toContain('show optional (1)')
  await ui.press({ key: 'optional-findings' })
  expect(await ui.find({ type: 'Text', text: /Rename it/ })).toBeDefined()
  expect((await ui.find({ key: 'optional-findings' }))?.text).toContain('hide optional (1)')
  // The pane only reads what the session holds: opening it and pressing o call nothing in Tick-it.
  expect(seen.ticketCalls).toHaveLength(calls)
  expect(seen.recorded).toHaveLength(recorded)
  // The button's count is the one record_runs carried for the round's run.
  expect(seen.recorded.flatMap(r => r.args.runs).find(r => r.agentId === 'agent-1')).toMatchObject({ blocking: 1, optional: 1 })
  await ui.unmount()
})
