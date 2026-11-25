import { expect, test } from 'claude-code/testing'

import { put } from '../scripts/upload-screenshots.mjs'

const DIR = new URL('./fixtures', import.meta.url).pathname

/** A send that records each request and answers 200. */
const recorder = () => {
  const calls: { url: string; method?: string; headers?: Record<string, string>; size: number }[] = []
  const send = async (url: string, init: { method?: string; headers?: Record<string, string>; body: Uint8Array }) => {
    calls.push({ url, method: init.method, headers: init.headers, size: init.body.length })
    return { ok: true, status: 200 }
  }
  return { calls, send }
}

test('put PUTs a picture to an http://127.0.0.1 upload URL as it does to an https one', async () => {
  const headers = { 'content-type': 'image/png' }
  const loopback = recorder()
  const https = recorder()
  const a = await put(DIR, [{ name: 'a.png', url: 'http://127.0.0.1:8789/upload/a.png', headers }], loopback.send as never)
  const b = await put(DIR, [{ name: 'a.png', url: 'https://uploads.example.com/a.png', headers }], https.send as never)
  expect(a).toEqual({ confirm: [{ name: 'a.png' }], failed: [] })
  expect(b).toEqual(a)
  expect(loopback.calls).toEqual([{ url: 'http://127.0.0.1:8789/upload/a.png', method: 'PUT', headers, size: 13 }])
  expect(https.calls).toEqual([{ url: 'https://uploads.example.com/a.png', method: 'PUT', headers, size: 13 }])
})
