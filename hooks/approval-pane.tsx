import type { Approval, Ticket } from '../types'
import { COLOR } from './state'

const KINDS: Record<string, string> = { board: 'board', page: 'page', 'pull-request': 'pull request', picture: 'picture', link: 'link' }

/** The items by kind: "3 items: 2 boards, 1 picture". */
export const itemsLine = (items: Approval['items']): string => {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1)
  const by = [...counts].map(([kind, n]) => `${n} ${KINDS[kind] ?? kind}${n === 1 ? '' : 's'}`)
  return `${items.length} item${items.length === 1 ? '' : 's'}${by.length === 0 ? '' : `: ${by.join(', ')}`}`
}

/** How long a request has waited, as "waiting 3 days", "waiting 5 h" or "waiting under an hour". */
export const waited = (askedAt: string, now: number): string => {
  const ms = now - Date.parse(askedAt)
  if (Number.isNaN(ms) || ms < 0) return 'waiting'
  const hours = Math.floor(ms / 3_600_000)
  return hours < 1 ? 'waiting under an hour' : hours < 48 ? `waiting ${hours} h` : `waiting ${Math.floor(hours / 24)} days`
}

const DECISION: Record<string, string> = { confirmed: 'Confirmed', rejected: 'Rejected', rethink: 'Rethink asked for' }

/**
 * The ticket pane's approval section, from the ticket's approvals part: the open request (waiting, or changed since asked),
 * else the latest answered one. It has no button: the answer is given on the ticket's page in Tick-it.
 * TCK-45 takes the answer, and the answered request goes from the pane then.
 */
export function approvalSection({ Box, Text, Link }: Record<'Box' | 'Text' | 'Link', never>, t: Ticket, now: number) {
  const open = (t.approvals ?? []).find(a => a.state === 'open')
  const answered = (t.approvals ?? []).find(a => a.state !== 'open')
  const a = open ?? answered
  if (a === undefined) return null
  const href = t.url === undefined ? undefined : `${t.url}#${a.id.startsWith('ar_') ? a.id : `ar_${a.id}`}`
  const head = open === undefined ? 'APPROVAL ANSWERED' : open.staleReason !== undefined ? 'APPROVAL CHANGED SINCE ASKED' : 'WAITING FOR APPROVAL'
  return (
    <Box key="section-approval" flexDirection="column">
      <Text key="approval-head" color={open === undefined ? COLOR.ok : COLOR.warn} bold>{head}</Text>
      <Text key="approval-subject">{a.subject}</Text>
      <Text key="approval-items" color={COLOR.dim}>{itemsLine(a.items)}</Text>
      {open === undefined ? (
        <Box key="approval-answer" flexDirection="column">
          <Text key="approval-decision">{`${DECISION[a.state] ?? a.state} by ${a.reviewer}${a.answeredAt === undefined ? '' : ` at ${a.answeredAt}`}`}</Text>
          {a.questions.map((q, i) => (
            <Text key={`approval-q-${i}`} wrap="truncate-end">{`${q.text}: ${q.answer ?? 'no answer'}`}</Text>
          ))}
        </Box>
      ) : (
        <Text key="approval-who" color={COLOR.dim}>{`${open.staleReason !== undefined ? `changed since asked (${open.staleReason}) · ` : ''}may answer: ${open.reviewer} · ${waited(open.askedAt, now)}`}</Text>
      )}
      {href !== undefined && <Link key="approval-link" href={href} label={open === undefined ? 'Open the request in Tick-it' : 'Answer in Tick-it'} />}
    </Box>
  )
}
