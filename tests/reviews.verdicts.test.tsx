import { expect, test } from 'claude-code/testing'

import { count, reviewPrompt } from '../hooks/register'
import { earlierBlockers, openVerdictLines, readVerdicts } from '../hooks/reviews'
import { sendable } from '../hooks/outbox'
import { RUN, SKILLS, engine, finishTurn, start } from './helpers'

test('a later round hands each reviewer its still-open earlier blockers and reads its verdicts', async () => {
  const run = (round: number, extra: Record<string, unknown>) => ({ agentId: `a${round}`, ticket: 'TCK-1', epic: 'E', round, skill: 'principal', model: 'm', startedAt: round, status: 'done', ...extra }) as never
  const bug = { severity: 'blocking', file: 'src/a.ts', line: 12, text: 'Off by one' }
  const other = { severity: 'blocking', text: 'No test' }
  // Round 1 raised two; round 2 verified one open and fixed the other; round 3 is given only the open one.
  const runs = [
    run(1, { items: [bug, other, { severity: 'optional', text: 'Rename' }] }),
    run(2, {
      verdicts: [
        { file: 'src/a.ts', text: 'Off by one', verdict: 'open', reason: 'still' },
        { text: 'No test', verdict: 'fixed', reason: 'added' },
      ],
      items: [],
    }),
  ]
  expect(earlierBlockers(runs, 'TCK-1', 'principal', 2)).toEqual([{ file: 'src/a.ts', line: 12, text: 'Off by one' }, { text: 'No test' }])
  expect(earlierBlockers(runs, 'TCK-1', 'principal', 3)).toEqual([{ file: 'src/a.ts', line: 12, text: 'Off by one' }])
  expect(earlierBlockers(runs, 'TCK-1', 'security', 3)).toEqual([])
  expect(earlierBlockers([], 'TCK-1', 'principal', 1)).toEqual([])
  const earlier = earlierBlockers(runs, 'TCK-1', 'principal', 2)
  const prompt = reviewPrompt({ id: 'TCK-1', title: 'T', epic: 'E', acceptance: [] } as never, { name: 'principal', body: 'Look.' } as never, 3, earlier, 'abc123')
  expect(prompt).toContain('1. src/a.ts:12 Off by one')
  expect(prompt).toContain('HEAD abc123')
  expect(reviewPrompt({ id: 'TCK-1', title: 'T', epic: 'E', acceptance: [] } as never, { name: 'principal', body: 'Look.' } as never, 1)).not.toContain('FINDING:')
  expect(readVerdicts('FINDING: 1 open first\nFINDING: 1 fixed again', earlier)).toEqual([{ file: 'src/a.ts', text: 'Off by one', verdict: 'open', reason: 'first' }])
  expect(readVerdicts('FINDING: 1 fixed - loop stops\n- FINDING: 2 gone: file deleted\nFINDING: 9 open nope\nBLOCKING: x', earlier)).toEqual([
    { file: 'src/a.ts', text: 'Off by one', verdict: 'fixed', reason: 'loop stops' },
    { text: 'No test', verdict: 'gone', reason: 'file deleted' },
  ])
})

test('an earlier blocker a reviewer verified open keeps the round blocking and goes to the fix', async () => {
  const earlier = [{ file: 'src/a.ts', text: 'Off by one' }]
  const verdicts = readVerdicts('FINDING: 1 open still there\nVERDICT: changes', earlier)
  expect(verdicts).toEqual([{ file: 'src/a.ts', text: 'Off by one', verdict: 'open', reason: 'still there' }])
  expect(openVerdictLines(verdicts)).toEqual(['BLOCKING: src/a.ts Off by one (still open: still there)'])
  expect(openVerdictLines([{ text: 'x', verdict: 'fixed', reason: 'r' }])).toEqual([])
})

test('a blocker verified open is asked about again until a round says fixed or gone, and the outbox leaves it out of what it sends', async () => {
  const run = (round: number, extra: Record<string, unknown>) => ({ agentId: `a${round}`, ticket: 'TCK-1', epic: 'E', round, skill: 'principal', model: 'm', startedAt: round, status: 'done', ...extra }) as never
  const runs = [run(1, { items: [{ severity: 'blocking', text: 'Bug' }] }), run(2, { items: [{ severity: 'blocking', text: 'Bug', open: true }], verdicts: [{ text: 'Bug', verdict: 'open', reason: 'still' }] }), run(3, { items: [] })]
  // Round 3 said nothing of it, so round 4 is still asked; a fixed verdict ends it.
  expect(earlierBlockers(runs, 'TCK-1', 'principal', 4)).toEqual([{ text: 'Bug' }])
  expect(earlierBlockers([...runs, run(4, { items: [], verdicts: [{ text: 'Bug', verdict: 'fixed', reason: 'ok' }] })], 'TCK-1', 'principal', 5)).toEqual([])
  expect(sendable({ ...(runs[1] as object), blocking: 1, findings: ['BLOCKING: Bug'], items: [{ severity: 'blocking', text: 'Bug', open: true }] } as never)).toMatchObject({ blocking: 0, findings: [] })
})

test('a reviewer that verifies an earlier blocker still open keeps the round blocking, and Tick-it is sent the verdict, not a second finding', async ($, on) => {
  const seen = engine(on, { lines: 10 }, true, SKILLS)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: api/a.ts:4 no test for expiry\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  // The fix turn ends and round 2 starts: the principal reviewer is given the open blocker with its line.
  await $.turn.complete(finishTurn(undefined, 'Tried a fix.'))
  expect(seen.spawned[2]?.prompt).toContain('1. api/a.ts:4 no test for expiry')
  seen.submitted.length = 0
  // It finds nothing new but verifies the old one open: the round is not clean.
  await $.turn.complete(finishTurn('agent-3', 'FINDING: 1 open the expiry test is still missing\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-4', 'VERDICT: clean', 'claude-sonnet-5-5'))
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[principal] BLOCKING: api/a.ts no test for expiry (still open: the expiry test is still missing)')
  expect(seen.toasts.some(t => t.includes('TCK-143 is Done'))).toBe(false)
  // What Tick-it is sent: no blocking count and no finding for it (it adds the open verdict itself), and the verdict.
  const sent = seen.recorded.flatMap(c => c.args.runs).find(r => r.agentId === 'agent-3')
  expect(sent).toMatchObject({ blocking: 0, findings: [], verdicts: [{ file: 'api/a.ts', text: 'no test for expiry', verdict: 'open', reason: 'the expiry test is still missing' }] })
})
