import { expect, test } from 'claude-code/testing'

import { linkTickets } from '../hooks/board'
import { RUN, engine, start } from './helpers'

const URL143 = 'https://app.tick-it.dev/r/acme/web-app/t/TCK-143'
const board = [{ id: 'TCK-143', title: 'Persist checkout step', epic: 'One-page checkout', size: 'XS' as const, status: 'Ready' as const, acceptance: [], url: URL143 }]

test('a ticket on the board becomes a bold link with its title; code, links and other words are left alone', () => {
  const { text, hrefs } = linkTickets('Needs tck-143 first, not `TCK-143`, [TCK-143](https://x.y), UTF-8 or TCK-999.\n```\nTCK-143\n```', board)
  expect(hrefs).toEqual([URL143])
  expect(text).toBe(`Needs [**Persist checkout step (TCK-143)**](${URL143}) first, not \`TCK-143\`, [TCK-143](https://x.y), UTF-8 or TCK-999.\n\`\`\`\nTCK-143\n\`\`\``)
})

test('a reply that names no ticket is not rewritten', () => {
  expect(linkTickets('Nothing here', board).hrefs).toEqual([])
  expect(linkTickets('TCK-143', []).hrefs).toEqual([])
})

test('a ticket written in a reply is drawn as a link, and pressing it opens the ticket pane', async ($, on) => {
  const seen = engine(on, { lines: 0 })
  ;(seen.server[0] as { url?: string }).url = URL143
  await start($)
  // The slim board has no url: TCK-143, read whole when taken, gives the address every ticket's page has.
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'board' })
  const ui = await $.ui.mount({ plugin: 'tick-it', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Do TCK-143 first.', isFirstOfReply: true, isExpanded: true } } as never)
  const drawn = await ui.find({ type: 'Markdown' })
  expect(drawn?.props?.text).toContain(`[**Persist checkout step in session (TCK-143)**](${URL143})`)
  await ui.press({ key: 'tickets', link: { href: URL143 } } as never)
  expect(seen.opened).toContain('tick-it-ticket')
})
