import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_LEVEL, LEVELS, cleanField, levelOf, lineOf } from '../hooks/log'
import { RUN, SKILLS, engine, finishTurn, start, STARTED, typed } from './helpers'
import type { Net } from './helpers'

/** The mod's log as the engine was asked to write it: the environment it reads and each line it writes, with the file named. */
const logging = (on: On, env: Record<string, string>) => {
  const wrote: { path: string; text: string }[] = []
  const asked: string[] = []
  on('env.get', (_$, e) => (asked.push(e.name), { value: env[e.name] }))
  on('fs.write', (_$, e) => (wrote.push({ path: e.path, text: e.text }), { value: undefined }))
  return { wrote, asked, lines: () => wrote.map(w => w.text.trim()), levels: () => wrote.map(w => w.text.split(' ')[1]) }
}

test('a value is a level or the default, and the default logs only errors and warnings', () => {
  for (const l of LEVELS) expect(levelOf(l)).toBe(l)
  expect(levelOf('DEBUG')).toBe('debug')
  for (const odd of ['verbose', '', undefined, 3, 'debug,info']) expect(levelOf(odd)).toBe(DEFAULT_LEVEL)
  expect(LEVELS.slice(0, LEVELS.indexOf(DEFAULT_LEVEL) + 1)).toEqual(['error', 'warn'])
})

// A run that decides at debug (start line, ticket taken) and info (report sent).
for (const [value, levels] of [
  ['debug', ['debug', 'debug', 'info']],
  ['info', ['info']],
  ['warn', []],
  ['error', []],
  [undefined, []],
  ['loud', []],
] as const) {
  test(`TICK_IT_LOG=${String(value)} logs ${levels.length === 0 ? 'nothing' : levels.join(', ')} of a taken ticket`, async ($, on) => {
    engine(on, { lines: 0 })
    const log = logging(on, value === undefined ? {} : { TICK_IT_LOG: value })
    await start($)
    await $.prompt.submit(typed(STARTED))
    expect(log.levels()).toEqual(levels)
    expect(log.asked).toContain('TICK_IT_LOG')
  })
}

for (const [value, shown] of [[undefined, true], ['warn', true], ['error', false]] as const) {
  test(`a ticket that cannot be taken logs a warning: TICK_IT_LOG=${String(value)} ${shown ? 'shows' : 'hides'} it`, async ($, on) => {
    const log = logging(on, value === undefined ? {} : { TICK_IT_LOG: value })
    const seen = engine(on, { lines: 0 })
    seen.server.length = 0
    await start($)
    await $.prompt.submit(typed(STARTED))
    expect(log.levels().includes('warn')).toBe(shown)
    if (shown) expect(log.lines().find(l => l.includes(' warn '))).toContain('start-not-taken ticket=TCK-151 session=s_abc12345 why=take-refused')
  })
}

test('an error shows at the quietest level: runs Tick-it rejects', async ($, on) => {
  const net: Net = { answer: args => ({ rejected: args.runs.map(r => ({ agentId: String(r.agentId), reason: 'model: not a model' })) }) }
  engine(on, { lines: 10 }, true, SKILLS, net)
  const log = logging(on, { TICK_IT_LOG: 'error' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  expect(log.levels()).toEqual(['error'])
  expect(log.lines()[0]).toContain('runs-dropped dropped=1')
})

test('at debug: a start line matched or not, which ticket it took, why a round started or not, why a call was denied', async ($, on) => {
  engine(on, { lines: 10 }, true, SKILLS)
  const log = logging(on, { TICK_IT_LOG: 'debug' })
  on('tool.check', () => ({ decision: 'allow' as const }))
  await start($)
  await $.prompt.submit(typed('hello, just a question'))
  expect(log.lines().at(-1)).toContain('debug start-line matched=false command=false')
  await $.prompt.submit(typed(STARTED))
  expect(log.lines().join('\n')).toContain('start-line matched=true')
  expect(log.lines().join('\n')).toContain('ticket-taken ticket=TCK-151 session=s_abc12345')
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(log.lines().join('\n')).toMatch(/round-started ticket=TCK-151 round=1 why=done-command skills=principal,security/)
  await $.turn.complete(finishTurn('agent-1', 'BLOCKING: a.ts:1 wrong\nVERDICT: changes'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean'))
  expect(log.lines().join('\n')).toContain('round-settled ticket=TCK-151 round=1 outcome=fix blocking=1')
  await $.turn.complete(finishTurn(undefined, 'Fixed.'))
  expect(log.lines().join('\n')).toMatch(/round-started ticket=TCK-151 round=2 why=after-fix/)
  for (const [tool, why] of [['record_runs', 'runs-are-the-mods'], ['report_review_agents', 'agents-are-the-mods'], ['report_session', 'reports-are-the-mods']] as const) {
    await $.tool.check({ tool: `mcp__plugin_tick-it_tickit__${tool}`, input: { runs: [] } })
    expect(log.lines().at(-1)).toContain(`tool-denied tool=mcp__plugin_tick-it_tickit__${tool} why=${why}`)
  }
})

test('at debug: a round that did not start says why', async ($, on) => {
  engine(on, { lines: 10 })
  const log = logging(on, { TICK_IT_LOG: 'debug' })
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-147' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(log.lines().join('\n')).toContain('round-not-started ticket=TCK-147 round=1 why=no-skills')
})

test('a log line carries no token, ticket text, comment, file content or environment value, whatever the fields hold', async ($, on) => {
  const secret = 'ghp_SECRET token with spaces'
  expect(cleanField(secret)).toBe('<omitted>')
  expect(cleanField('Saved card picker in checkout')).toBe('<omitted>')
  expect(cleanField('line one\nline two')).toBe('<omitted>')
  expect(cleanField('x'.repeat(101))).toBe('<omitted>')
  expect(cleanField('TCK-151')).toBe('TCK-151')
  expect(cleanField(2)).toBe(2)
  expect(lineOf(0, 'info', 'x', { ticket: 'TCK-1', title: 'Saved card picker', token: 'a b' })).toBe('1970-01-01T00:00:00.000Z info x ticket=TCK-1 title=<omitted> token=<omitted>')

  // The whole of a stewarded ticket at debug, with a secret in the environment, the ticket's text and a reviewer's finding.
  const net: Net = { instructions: 'Never print SECRET-INSTRUCTION' }
  const seen = engine(on, { lines: 10 }, true, { '.tick-it/skills/principal/SKILL.md': `---\nname: principal\n---\nBODY-OF-SKILL ${secret}` }, net)
  const log = logging(on, { TICK_IT_LOG: 'debug', API_TOKEN: secret, TICK_IT_LOG_FILE: '/var/log/tick-it.log' })
  await start($)
  await $.prompt.submit(typed(STARTED))
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', `BLOCKING: secrets.ts:3 ${secret} FILE-CONTENT\nVERDICT: changes`))
  const text = log.lines().join('\n')
  expect(log.lines().length).toBeGreaterThan(5)
  expect(log.wrote.every(w => w.path === '/var/log/tick-it.log')).toBe(true)
  const ticket = seen.server.find(t => t.key === 'TCK-151')
  for (const forbidden of [secret, 'ghp_', 'SECRET', 'FILE-CONTENT', 'BODY-OF-SKILL', 'Saved card', ticket?.title ?? 'x', ...(ticket?.acceptance ?? []), '/var/log']) expect(text).not.toContain(forbidden)
  for (const line of log.lines()) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z (error|warn|info|debug) [a-z-]+( [a-z]+=[A-Za-z0-9_.:#/,<>-]+)*$/)
})
