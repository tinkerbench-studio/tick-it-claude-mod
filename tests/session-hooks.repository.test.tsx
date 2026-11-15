import { expect, test } from 'claude-code/testing'

import { repositoryOf } from '../hooks/register'
import { SKILLS, engine, finishTurn, start, STARTED, typed, reports } from './helpers'

test('a first message for another repository takes nothing, and says why', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  await start($)
  const entered = await $.prompt.submit(typed(STARTED.replace('acme/web-app', 'acme/other')))
  expect('context' in entered ? entered.context?.join(' ') : '').toContain('this session is in acme/web-app, not acme/other, so it did not take TCK-151.')
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready')
  expect(reports(seen)).toEqual([])
})

const OTHER = STARTED.replace('acme/web-app', 'acme/other')
const wrongFolder = async (on: Parameters<typeof engine>[0], $: Parameters<typeof start>[0], siblings: Record<string, string> | 'unlistable') => {
  const seen = engine(on, { lines: 0, siblings })
  await start($)
  const entered = await $.prompt.submit(typed(OTHER))
  return { seen, context: 'context' in entered ? (entered.context?.join(' ') ?? '') : '' }
}

test('a start line for another repository names the checkout of it beside this one, and takes nothing', async ($, on) => {
  const { seen, context } = await wrongFolder(on, $, { 'web-app': 'git@github.com:acme/web-app.git', other: 'https://github.com/acme/other\n' })
  expect(context).toContain('did not take TCK-151. acme/other is checked out at /other: work there and take TCK-151 with update_ticket (In progress, assignee me).')
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready')
  expect(reports(seen)).toEqual([])
})

const AS_WAS = 'tick-it: this session is in acme/web-app, not acme/other, so it did not take TCK-151. The mod records and reports nothing for it: record its runs and report the session yourself, as the message says for a session without the mod.'

test('when no folder beside this one has the repository, the context line is as it was and nothing is taken', async ($, on) => {
  const { seen, context } = await wrongFolder(on, $, { 'web-app': 'git@github.com:acme/web-app.git', x: 'git@github.com:acme/x.git' })
  expect(context).toBe(AS_WAS)
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready')
})

test('when the folders cannot be listed, the context line is as it was and nothing is taken', async ($, on) => {
  const { seen, context } = await wrongFolder(on, $, 'unlistable')
  expect(context).toBe(AS_WAS)
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready')
})

test('the start-not-taken log entry names the checkout found', async ($, on) => {
  const wrote: string[] = []
  on('env.get', () => ({ value: 'debug' }))
  on('fs.write', (_$, e) => (wrote.push(e.text), { value: undefined }))
  await wrongFolder(on, $, { other: 'git@github.com:acme/other.git' })
  expect(wrote.at(-1)).toContain('start-not-taken')
  expect(wrote.at(-1)).toContain('/other')
})

test('a folder with no origin works on the repository the first message names, through to the review agents', async ($, on) => {
  const seen = engine(on, { lines: 4, origin: null }, true, { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' })
  await start($)
  const entered = await $.prompt.submit(typed(STARTED))
  const context = 'context' in entered ? (entered.context ?? []) : []
  expect(context[0]).toBe('tick-it: this folder has no origin remote, so it works on acme/web-app as Tick-it asked.')
  expect(context.some(c => c.includes('You are working on ticket TCK-151'))).toBe(true)
  expect(seen.server.find(t => t.key === 'TCK-151')).toMatchObject({ status: 'In progress', assignee: 'maddiecs84' })
  await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-151', status: 'In review' } as never)
  expect(seen.ticketCalls.filter(c => c.tool === 'update_ticket').at(-1)?.args).toMatchObject({ repository: 'acme/web-app', status: 'In review', changedLines: 4 })
  await $.turn.complete(finishTurn(undefined, 'Built it.'))
  expect(seen.spawned.map(a => a.description)).toEqual(['tick-it review: principal on TCK-151, round 1'])
  // The turn's cost goes to Tick-it under the repository the first message named.
  expect(seen.recorded.at(-1)?.args).toMatchObject({ repository: 'acme/web-app', runs: [{ kind: 'build', ticket: 'TCK-151' }] })
})

test('a session Tick-it started is not picked up by a later Claude Code session in the folder', async ($, on) => {
  const stale = { id: 's_old12345', repository: 'acme/web-app', ticket: 'TCK-2', status: 'working', reportedAt: 0, claudeSession: 'an-earlier-session' }
  engine(on, { lines: 0, origin: null, stored: { 'started-session': stale } })
  await start($)
  // With no origin and no session of its own, this folder's repository is unknown: Claude's take is left alone.
  const taken = await $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-1', repository: 'acme/web-app', key: 'TCK-147', status: 'In progress', assignee: 'me' } as never)
  expect('context' in taken ? (taken.context ?? []) : []).toEqual([])
})

test('a folder whose origin is not on GitHub takes nothing', async ($, on) => {
  const seen = engine(on, { lines: 0, origin: 'git@gitlab.com:acme/web-app.git\n' })
  await start($)
  const entered = await $.prompt.submit(typed(STARTED))
  expect('context' in entered ? entered.context?.join(' ') : '').toContain('a folder whose origin is not on GitHub, not acme/web-app, so it did not take TCK-151.')
  expect(seen.server.find(t => t.key === 'TCK-151')?.status).toBe('Ready')
})

test('repositoryOf reads owner/name from GitHub remotes, and nothing else', () => {
  expect(repositoryOf('git@github.com:acme/web-app.git\n')).toBe('acme/web-app')
  expect(repositoryOf('https://github.com/acme/web-app')).toBe('acme/web-app')
  expect(repositoryOf('https://github.com/acme/web.app.git')).toBe('acme/web.app')
  expect(repositoryOf('https://gitlab.com/acme/web-app.git')).toBeUndefined()
})
