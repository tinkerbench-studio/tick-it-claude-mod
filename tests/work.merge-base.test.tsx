import { expect, test } from 'claude-code/testing'

import { RUN, UI_FILES, engine, finishReview, start, STARTED, typed } from './helpers'
import type { Seen as Net } from './helpers'

// A ticket taken at A (what the fake's rev-parse answers), the base branch merged in afterwards: merge base B, a descendant of A.
const A = 'ab12'.repeat(10)
const B = 'cd34'.repeat(10)
const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const merged = { changed: [], merged: true, byCommit: { [A]: { lines: 900 }, [B]: { lines: 12 } } }
const take = async ($: Parameters<typeof start>[0], key = 'TCK-151') => {
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: `take ${key}` })
}
const patch = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,1 @@\n+${line}\n`
const diffs = (seen: Net) => seen.processes.filter(p => p.startsWith('git diff') && !p.includes('--name-only'))

test('after the base is merged in, the diff is taken against the merge base and done sends the ticket’s own lines', async ($, on) => {
  const seen = engine(on, { lines: 0, ...merged })
  await take($)
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.processes).toContain(`git diff --numstat ${B}`)
  expect(seen.processes).toContain(`git diff --numstat -z ${B}`)
  expect(diffs(seen).filter(p => p.endsWith(A))).toEqual([])
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args).toMatchObject({ changedLines: 12, changedFiles: [{ path: 'api/a.ts', lines: 12 }] })
})

test('with no merge since the ticket was taken, the diff stays against the taken commit though a merge base exists', async ($, on) => {
  const seen = engine(on, { lines: 0, changed: [], merged: false, byCommit: { [A]: { lines: 30 }, [B]: { lines: 12 } } })
  await take($)
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.processes).toContain(`git diff --numstat ${A}`)
  expect(diffs(seen).filter(p => p.endsWith(B))).toEqual([])
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args).toMatchObject({ changedLines: 30 })
})

test('when the merge base cannot be found, the taken commit is used', async ($, on) => {
  // `changed` undefined: git merge-base finds nothing (no origin branch).
  const seen = engine(on, { lines: 0, merged: true, byCommit: { [A]: { lines: 30 }, [B]: { lines: 12 } } })
  await take($)
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.processes).toContain(`git diff --numstat ${A}`)
  expect(seen.processes.some(p => p.includes(B))).toBe(false)
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args).toMatchObject({ changedLines: 30 })
})

test('the size guard allows an edit within budget after a merge of the base that alone would exceed it', async ($, on) => {
  engine(on, { lines: 0, ...merged })
  await take($, 'TCK-143')
  const small = await $.tool.call({ tool: 'Edit', file_path: '/repo/api/a.ts', old_string: 'a', new_string: 'b' })
  expect(JSON.stringify(small)).not.toContain('refused')
  // The ticket's own 12 lines plus a 40-line write are still counted against the XS budget of 100.
  const big = await $.tool.call({ tool: 'Write', file_path: '/repo/api/b.ts', content: Array.from({ length: 95 }, (_, i) => `line ${i}`).join('\n') })
  expect(JSON.stringify(big)).toContain('refused')
})

test('the UI-evidence gate does not refuse a ticket whose only UI files came in with the merge', async ($, on) => {
  const own = { ...merged, byCommit: { [A]: { numstatZ: UI_FILES }, [B]: { numstatZ: '3\t0\tapi/a.ts\0' } } }
  const seen = engine(on, { lines: 5, ...own, pictures: [] })
  await start($)
  await $.prompt.submit(typed(STARTED))
  expect((await finishReview($ as never)).deny).toBeUndefined()
  expect(seen.ticketCalls.some(c => c.tool === 'update_ticket' && c.args.status === 'In review')).toBe(true)
})

const BASE = 'skills/review-agents/bases/security/SKILL.md'
const SECURITY = {
  '.tick-it/skills/security/SKILL.md': '---\nname: security\nbase: security\n---\nBLOCKING: our own rule.',
  [BASE]: '---\nname: security\ndescription: Security\nmodel: claude-sonnet-5-5\nsizes: M, L\nchanges: all\n---\nBLOCKING: input used unchecked.',
  'skills/secure-authentication/SKILL.md': '---\nname: secure-authentication\ndescription: d\n---\n## Must\n- Passwords are hashed.',
}
const login = { numstatZ: '3\t0\tapi/login.ts\0', patch: patch('api/login.ts', 'const ok = await bcrypt.compare(password, row.hash)') }

test('changedContent leaves out the files that came in with the merge, so the areas they touch run no security reviewer', async ($, on) => {
  const byCommit = { [A]: login, [B]: { numstatZ: '1\t0\tapi/a.ts\0', patch: patch('api/a.ts', 'const label = "Save"') } }
  const seen = engine(on, { lines: 10, changed: [], merged: true, byCommit }, true, SECURITY)
  await take($, 'TCK-143')
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.processes).toContain(`git diff -U0 --no-color --no-ext-diff ${B}`)
  expect(seen.processes).not.toContain(`git diff -U0 --no-color --no-ext-diff ${A}`)
  expect(seen.spawned).toHaveLength(0)
})

test('with no merge, changedContent reads the taken commit, where the same file is the ticket’s own and runs the security reviewer', async ($, on) => {
  const seen = engine(on, { lines: 10, changed: [], merged: false, byCommit: { [A]: login, [B]: { numstatZ: '1\t0\tapi/a.ts\0' } } }, true, SECURITY)
  await take($, 'TCK-143')
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'steward TCK-143' })
  expect(seen.processes).toContain(`git diff -U0 --no-color --no-ext-diff ${A}`)
  expect(seen.spawned).toHaveLength(1)
})

test('a git diff that fails in a repository with a HEAD counts 0 and does not fall back to the empty tree', async ($, on) => {
  const seen = engine(on, { lines: 50, failDiff: true })
  await take($)
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.processes.some(p => p.includes(EMPTY))).toBe(false)
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args.changedLines).toBe(0)
})

test('a repository with no commit still counts against the empty tree', async ($, on) => {
  const seen = engine(on, { lines: 50, noCommit: true })
  await take($)
  seen.processes.length = 0
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  expect(seen.processes).toContain(`git diff --numstat ${EMPTY}`)
  expect(seen.ticketCalls.find(c => c.tool === 'update_ticket' && c.args.status === 'In review')?.args.changedLines).toBe(50)
})
