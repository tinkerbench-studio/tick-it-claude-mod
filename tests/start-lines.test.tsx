import { expect, test } from 'claude-code/testing'

import { BREAKDOWN_LINE, START_LINE } from '../hooks/state'

test('a start line is found whatever the ticket prefix, and no other shape of key', () => {
  expect(START_LINE.exec('Tick-it session s_abc12345: work on TCK-151 in acme/web-app.')?.[2]).toBe('TCK-151')
  expect(START_LINE.exec('Tick-it session s_abc12345: work on NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(START_LINE.test('Tick-it session s_abc12345: work on AB-7 in acme/web-app.')).toBe(false)
  expect(START_LINE.test('Tick-it session s_abc12345: work on ABCD-7 in acme/web-app.')).toBe(false)
})

test('a breakdown or analysis line is found whatever the ticket prefix', () => {
  expect(BREAKDOWN_LINE.exec('Tick-it session s_abc12345: break down NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.exec('Tick-it session s_abc12345: analyse suggestions of NEW-7 in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.exec('Tick-it session s_abc12345: check NEW-7 after deploy in acme/web-app.')?.[2]).toBe('NEW-7')
  expect(BREAKDOWN_LINE.test('Tick-it session s_abc12345: break down NE-7 in acme/web-app.')).toBe(false)
})
