import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('..', import.meta.url).pathname

// TCK-98: every prompt the mod submits goes through submitPrompt in hooks/work.ts, where the stop and the repeat are held.
test('$.prompt.submit is called only inside submitPrompt', () => {
  const calls = readdirSync(`${root}hooks`)
    .filter(f => f.endsWith('.ts'))
    .flatMap(f => readFileSync(`${root}hooks/${f}`, 'utf8').split('\n').flatMap((line, i) => (/\$\.prompt\.submit\(/.test(line) ? [`${f}:${i + 1}`] : [])))
  assert.equal(calls.length, 1, `found ${calls.join(', ')}`)
  const [file, line] = calls[0].split(':')
  assert.equal(file, 'work.ts')
  const text = readFileSync(`${root}hooks/work.ts`, 'utf8').split('\n')
  const at = Number(line) - 1
  let start = at
  while (start >= 0 && !/^(export )?(async )?function /.test(text[start])) start--
  assert.match(text[start], /^export async function submitPrompt/)
})
