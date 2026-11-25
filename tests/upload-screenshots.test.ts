import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'claude-code/testing'

import { put } from '../scripts/upload-screenshots.mjs'

test('put PUTs a picture to an http://127.0.0.1 upload URL, as it does to an https one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'))
  writeFileSync(join(dir, 'a.png'), 'picture-bytes')
  const seen: { method?: string; type?: string; body: string }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() })
      res.statusCode = 200
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as { port: number }
    const url = `http://127.0.0.1:${port}/upload/a.png`
    expect(url.startsWith('http://127.0.0.1:')).toBe(true)
    const result = await put(dir, [{ name: 'a.png', url, headers: { 'content-type': 'image/png' } }])
    expect(result).toEqual({ confirm: [{ name: 'a.png' }], failed: [] })
    expect(seen).toEqual([{ method: 'PUT', type: 'image/png', body: 'picture-bytes' }])
  } finally {
    server.close()
  }
})
