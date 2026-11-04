import { expect, test } from 'claude-code/testing'

import { PANE, RUN, engine, start } from './helpers'
import type { Net } from './helpers'

test('the pane acts on the pull request: fix with Claude, re-run failed, open on GitHub', async ($, on) => {
  // Answers by the start of the command; the folder's own branch is tck-151-picker, the pull request's is feature/ci.
  const answers: Record<string, { exitCode: number; stdout: string; stderr: string } | 'missing'> = {
    'gh pr view 12 --json headRefName': { exitCode: 0, stdout: JSON.stringify({ headRefName: 'feature/ci' }), stderr: '' },
  }
  const diff = {
    lines: 12,
    gh: (argv: string[]) => {
      const line = argv.join(' ')
      const key = Object.keys(answers).find(k => line.startsWith(k))
      if (key === undefined) return undefined
      const found = answers[key]
      if (found === 'missing') throw new Error('$.process.run(gh) failed to start: ENOENT')
      return found
    },
  }
  const net: Net = { pullRequests: [{ number: 12, state: 'open', draft: false, ci: 'failure' }] }
  const seen = engine(on, diff, true, {}, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })

  await ui.press({ key: 'fix-ci' })
  expect(seen.toasts.at(-1)).toContain('tick-it: asked Claude to fix the failing checks on #12.')
  expect(seen.submitted.at(-1)).toContain('gh pr checks 12')
  expect(seen.submitted.at(-1)).toContain('budget of 100 changed lines')

  // Re-run: why it failed, each way.
  answers['gh pr view 12 --json headRefName'] = { exitCode: 1, stdout: '', stderr: 'no such pull request' }
  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('could not read the branch of #12: no such pull request')
  answers['gh pr view 12 --json headRefName'] = 'missing'
  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('could not re-run: gh did not start.')
  answers['gh pr view 12 --json headRefName'] = { exitCode: 0, stdout: 'not json', stderr: '' }
  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('could not read the branch of #12 from gh.')
  answers['gh pr view 12 --json headRefName'] = { exitCode: 0, stdout: JSON.stringify({ headRefName: 'feature/ci' }), stderr: '' }

  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('could not list the runs of feature/ci')
  answers['gh run list'] = { exitCode: 0, stdout: 'not json', stderr: '' }
  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('could not read the runs of feature/ci from gh.')
  answers['gh run list'] = {
    exitCode: 0,
    stdout: JSON.stringify([
      { databaseId: 7, workflowName: 'ci', conclusion: 'success' },
      { databaseId: 5, workflowName: 'ci', conclusion: 'failure' },
    ]),
    stderr: '',
  }
  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('no failed run to re-run on feature/ci.')
  answers['gh run list'] = {
    exitCode: 0,
    stdout: JSON.stringify([
      { databaseId: 9, workflowName: 'ci', conclusion: 'failure' },
      { databaseId: 8, workflowName: 'lint', conclusion: 'failure' },
    ]),
    stderr: '',
  }
  answers['gh run rerun'] = { exitCode: 0, stdout: '', stderr: '' }
  await ui.press({ key: 'rerun-ci' })
  expect(seen.processes).toContain('gh run list --branch feature/ci --limit 100 --json databaseId,workflowName,conclusion')
  expect(seen.processes).toContain('gh run rerun 9 --failed')
  expect(seen.processes).toContain('gh run rerun 8 --failed')
  expect(seen.toasts.at(-1)).toContain('re-running the failed jobs of 2 runs on feature/ci.')
  answers['gh run rerun'] = { exitCode: 1, stdout: '', stderr: 'run cannot be rerun' }
  await ui.press({ key: 'rerun-ci' })
  expect(seen.toasts.at(-1)).toContain('re-running 0 of 2 runs on feature/ci; could not re-run ci: run cannot be rerun; lint: run cannot be rerun')

  // Open: opens it, or says why not.
  answers['gh pr view 12 --web'] = { exitCode: 0, stdout: '', stderr: '' }
  await ui.press({ key: 'open-pr' })
  expect(seen.processes).toContain('gh pr view 12 --web')
  expect(seen.toasts.at(-1)).toContain('tick-it: opened #12 on GitHub.')
  answers['gh pr view 12 --web'] = { exitCode: 1, stdout: '', stderr: 'no browser' }
  await ui.press({ key: 'open-pr' })
  expect(seen.toasts.at(-1)).toContain('could not open #12: no browser')
  answers['gh pr view 12 --web'] = 'missing'
  await ui.press({ key: 'open-pr' })
  expect(seen.toasts.at(-1)).toContain('could not open the pull request: gh did not start.')

  // With CI passing there is nothing to fix: no f button, the others stay.
  net.pullRequests = [{ number: 12, state: 'open', draft: false, ci: 'success' }]
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  await ui.unmount()
  const passing = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await passing.find({ type: 'Button', key: 'fix-ci' })).toBeUndefined()
  expect(await passing.find({ type: 'Button', key: 'open-pr' })).toBeDefined()
  await passing.unmount()
})

test('the pane has no pull request actions without a pull request or a taken ticket', async ($, on) => {
  const net: Net = { pullRequests: [] }
  engine(on, { lines: 12 }, true, {}, net)
  await start($)
  const none = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await none.find({ type: 'Button', key: 'open-pr' })).toBeUndefined()
  await none.unmount()
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  const taken = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', ...PANE })
  expect(await taken.find({ type: 'Button', key: 'open-pr' })).toBeUndefined()
  await taken.unmount()
})
