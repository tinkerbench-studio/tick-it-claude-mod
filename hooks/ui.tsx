import type { MilestoneView, TicketStatus } from '../types'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { PANE, TICKET_PANE, WARN_AT, groupsOf, COLOR } from './state'
import { budgetOf, linkTickets, boardStops, pickMilestone, nextMilestone, milestoneLine, milestoneOf, findCurrent, pullRequestLine, startSession, fixCi, rerunFailed, openPullRequest } from './board'
import { take } from './work'
import { reviewAgain, stopStewarding, summarise, reviewLine, findingRows } from './reviews'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
const boardError = atom({ plugin: 'tick-it', key: 'boardError' } as const, null)
const diffLines = atom({ plugin: 'tick-it', key: 'diffLines' } as const, 0)
/** The roadmap, in order, as list_milestones answers it; empty when the repository has none or Tick-it could not be asked. */
const milestones = atom({ plugin: 'tick-it', key: 'milestones' } as const, [] as MilestoneView[])
/** The milestone the board shows, by title; the first one when it is null or no longer on the roadmap. */
const shownMilestone = atom({ plugin: 'tick-it', key: 'shownMilestone' } as const, null as string | null)
const pullRequest = atom({ plugin: 'tick-it', key: 'pullRequest' } as const, null)
const reviews = atom({ plugin: 'tick-it', key: 'reviews' } as const, [])
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
/** Whether the stewarding pane lists the round's optional findings; they stay behind a key until asked for. */
const showOptional = atom({ plugin: 'tick-it', key: 'showOptional' } as const, false)
/** The ticket the details pane shows, by key; the taken ticket when it is null or no longer on the board. */
const sessionLink = atom({ plugin: 'tick-it', key: 'sessionLink' } as const, null as { ticket: string; href: string } | null)
const viewed = atom({ plugin: 'tick-it', key: 'viewed' } as const, null as string | null)

const viewTicket = async ($: EngineInterface, id: string) => {
  await update($, viewed, () => id)
  await $.ui.open({ id: TICKET_PANE, title: id })
}

const STATUS_COLOR: Partial<Record<TicketStatus, string>> = { 'In progress': COLOR.accent, 'In review': COLOR.warn, 'Ready to merge': COLOR.ok }

export const registerUi: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const t = await findCurrent($)
    if (t === undefined) {
      const s = await read($, steward)
      if (s === null || s.phase === 'done') return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const runs = (await read($, reviews)).filter(r => r.ticket === s.ticket)
      const round = runs.filter(r => r.round === s.round)
      const answered = round.filter(r => r.status !== 'running').length
      return (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={COLOR.accent}>◇</Text>
          <Text bold>{s.ticket}</Text>
          <Text color={COLOR.dim}>{`stewarding · round ${s.round}/${s.maxRounds} · ${s.phase}`}</Text>
          <Text>{`${answered}/${round.length} reviewers`}</Text>
          <Text color={COLOR.dim}>{summarise(runs)}</Text>
          {s.phase === 'fixing' && <Text color={COLOR.dim}>{`round ${s.round + 1} starts when this turn ends`}</Text>}
        </Box>
      )
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const lines = await read($, diffLines)
    const budget = await budgetOf($, t.size)
    const tone = lines > budget ? COLOR.over : lines >= budget * WARN_AT ? COLOR.warn : COLOR.ok

    return (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={COLOR.accent}>◆</Text>
        <Button key="ticket" plain onPress={() => void viewTicket($, t.id)}>
          <Text bold>{t.id}</Text>
        </Button>
        <Text wrap="truncate-end">{t.title}</Text>
        <Text color={COLOR.dim}>· {t.status} · diff</Text>
        <Text color={tone}>{`${lines}/${budget}`}</Text>
        <Button key="board" label="Board" onPress={() => void $.ui.open({ id: PANE, title: 'Tick-it' })} />
      </Box>
    )
  })

  // A ticket written in a reply becomes a link that opens its pane. A summary row, or a reply that names none, is drawn as it was.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const list = await read($, tickets)
    const { text, hrefs } = linkTickets(e.props.text, list)
    if (hrefs.length === 0) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        {e.props.isFirstOfReply && <Text>●</Text>}
        <Box flexGrow={1} flexDirection="column">
          <Markdown
            key="tickets"
            text={text}
            pressableLinks={hrefs}
            onLinkPress={link => {
              const t = list.find(one => one.url === link.href)
              if (t !== undefined) void viewTicket($, t.id)
            }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tickets)
    const taken = await read($, current)
    const problem = await read($, boardError)
    const s = await read($, steward)
    const stewarded = s === null ? [] : (await read($, reviews)).filter(r => r.ticket === s.ticket)
    const optionalShown = await read($, showOptional)
    const pr = await read($, pullRequest)
    const rows = s === null ? [] : findingRows(stewarded, s.round, optionalShown)
    const roadmap = boardStops(await read($, milestones), list)
    const milestone = pickMilestone(roadmap, await read($, shownMilestone))
    const epics = milestone === undefined ? undefined : new Set(milestone.epics.map(epic => epic.id))
    const shown = epics === undefined ? list : list.filter(t => epics.has(t.epicId))
    const optionalCount = s === null ? 0 : stewarded.filter(r => r.round === s.round).reduce((n, r) => n + (r.optional ?? 0), 0)

    return (
      <Box flexDirection="column" gap={1}>
        {milestone !== undefined && (
          <Box key="milestone" flexDirection="row" gap={1} flexWrap="wrap">
            <Text color={COLOR.accent}>◇</Text>
            <Text bold>{milestoneLine(milestone)}</Text>
            {roadmap.length > 1 && <Button key="milestone-next" label="m next milestone" onPress={async () => void (await update($, shownMilestone, () => nextMilestone(roadmap, milestone.title)))} />}
          </Box>
        )}
        {problem !== null && <Text color={COLOR.warn}>{`Could not read the board: ${problem}.`}</Text>}
        <Text color={COLOR.dim}>Press a ticket to take it.</Text>
        {s !== null && (
          <Box key="steward" flexDirection="column">
            <Text bold>
              Stewarding {s.ticket} <Text color={COLOR.dim}>{`round ${s.round}/${s.maxRounds} · ${s.phase}`}</Text>
            </Text>
            {stewarded.map(r => (
              <Text key={`review-${r.agentId}`} color={r.status === 'running' ? COLOR.dim : undefined}>
                {reviewLine(r).trim()}
              </Text>
            ))}
            <Text color={COLOR.dim}>{`Review agents: ${summarise(stewarded)}`}</Text>
            {rows.map((f, i) => (
              <Text key={`finding-${i}`} color={f.severity === 'blocking' && f.note !== true ? COLOR.warn : COLOR.dim}>
                {f.text}
              </Text>
            ))}
            {s.note !== undefined && <Text color={COLOR.dim}>{s.note}</Text>}
            <Box key="steward-actions" flexDirection="row" gap={1}>
              <Button key="review-again" label="r review again now" onPress={async () => void $.ui.toast(await reviewAgain($))} />
              <Button key="optional-findings" label={`o ${optionalShown ? 'hide' : 'show'} optional (${optionalCount})`} onPress={async () => void (await update($, showOptional, v => !v))} />
              <Button key="stop-stewarding" label="s stop stewarding" onPress={async () => void $.ui.toast(await stopStewarding($))} />
            </Box>
          </Box>
        )}
        {taken !== null && pr !== null && (
          <Box key="pr-actions" flexDirection="row" gap={1}>
            {pr.ci === 'failure' && <Button key="fix-ci" label="f Fix with Claude" onPress={async () => void $.ui.toast(await fixCi($))} />}
            <Button key="rerun-ci" label="r Re-run failed" onPress={async () => void $.ui.toast(await rerunFailed($))} />
            <Button key="open-pr" label="g Open PR on GitHub" onPress={async () => void $.ui.toast(await openPullRequest($))} />
          </Box>
        )}
        <Box key="table" flexDirection="column">
          <Box key="table-head" flexDirection="row" gap={1}>
            <Box width={11}>
              <Text color={COLOR.dim}>KEY</Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={COLOR.dim}>TICKET</Text>
            </Box>
            <Box width={4}>
              <Text color={COLOR.dim}>SIZE</Text>
            </Box>
            <Box width={14}>
              <Text color={COLOR.dim}>STATUS</Text>
            </Box>
          </Box>
          {shown.length === 0 && <Text color={COLOR.dim}>none</Text>}
          {groupsOf(shown).flatMap(status =>
            shown
              .filter(t => t.status === status)
              .map(t => (
                <Box key={`row-${t.id}`} flexDirection="row" gap={1}>
                  <Box width={11}>
                    <Button key={`open-${t.id}`} plain onPress={() => void viewTicket($, t.id)}>
                      <Text bold color={t.id === taken ? COLOR.accent : undefined}>{`${t.id === taken ? '◆ ' : '  '}${t.id}`}</Text>
                    </Button>
                  </Box>
                  <Box flexGrow={1} flexDirection="column">
                    <Button
                      key={t.id}
                      plain
                      onPress={async () => {
                        const took = await take($, t.id)
                        $.ui.toast(typeof took === 'string' ? `tick-it: ${took}` : `tick-it: took ${took.id}. Its brief is with Claude.`)
                      }}
                    >
                      {t.title}
                    </Button>
                    <Text color={COLOR.dim} wrap="truncate-end">{t.epic}</Text>
                  </Box>
                  <Box width={4}>
                    <Text>{t.size}</Text>
                  </Box>
                  <Box width={14}>
                    <Text color={STATUS_COLOR[t.status] ?? COLOR.dim}>{t.status}</Text>
                  </Box>
                </Box>
              )),
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: TICKET_PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const board = await read($, tickets)
    const taken = await read($, current)
    const id = (await read($, viewed)) ?? taken
    const t = board.find(one => one.id === id)
    if (t === undefined) return <Text color={COLOR.dim}>No ticket is shown.</Text>
    // The pull request and the diff read are the taken ticket's.
    const mine = t.id === taken
    const pr = mine ? await read($, pullRequest) : null
    const lines = mine ? await read($, diffLines) : 0
    const budget = await budgetOf($, t.size)
    const milestone = milestoneOf(await read($, milestones), t)
    const link = await read($, sessionLink)
    // Another ticket: pressing it shows that ticket here; one off the board links to its page, built from this ticket's.
    const ref = (key: string) => {
      const other = board.find(one => one.id === key)
      if (other !== undefined) {
        return (
          <Box key={`ref-${key}`} flexDirection="row" gap={1}>
            <Button key={`ref-${key}-open`} plain onPress={() => void viewTicket($, key)}>
              <Text bold color={COLOR.accent}>{key}</Text>
            </Button>
            <Text wrap="truncate-end">{other.title}</Text>
            <Text color={STATUS_COLOR[other.status] ?? COLOR.dim}>{other.status}</Text>
          </Box>
        )
      }
      const href = t.url?.replace(t.id, key)
      return (
        <Text key={`ref-${key}`}>{href === undefined ? key : <Link key={`ref-${key}-link`} href={href} label={key} />}</Text>
      )
    }
    const section = (name: string, rows: unknown) => (
      <Box key={`section-${name}`} flexDirection="column">
        <Text color={COLOR.dim}>{name}</Text>
        {rows as never}
      </Box>
    )
    const waitingOn = t.blockedBy ?? []
    const blocks = t.blocks ?? []
    const labels = t.labels ?? []

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="head" flexDirection="column">
          <Text bold>
            {t.id} {t.title}
          </Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text color={STATUS_COLOR[t.status] ?? COLOR.dim}>{t.status}</Text>
            <Text color={COLOR.dim}>{[t.size, t.epic, ...(milestone === undefined ? [] : [milestone])].join(' · ')}</Text>
          </Box>
          {pr !== null && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text color={pr.ci === 'failure' ? COLOR.over : pr.ci === 'success' ? COLOR.ok : COLOR.dim}>{`${pullRequestLine(pr)}${pr.queued ? ' · in merge queue' : ''}${pr.conflicting ? ' · conflicting' : ''}`}</Text>
              <Text color={lines > budget ? COLOR.over : COLOR.dim}>{`${lines}/${budget} lines`}</Text>
            </Box>
          )}
          <Box flexDirection="row" gap={2}>
            {t.url !== undefined && <Link key="ticket-link" href={t.url} label="Open in Tick-it" />}
            {pr?.url !== undefined && <Link key="pr-link" href={pr.url} label="Open PR on GitHub" />}
          </Box>
          {!mine && !['Done', 'Superseded', 'Dropped'].includes(t.status) && (
            <Box flexDirection="row" gap={2}>
              <Button key="start-session" label="t Start a session on this ticket" onPress={async () => void $.ui.toast(await startSession($, t.id))} />
              {link?.ticket === t.id && <Link key="session-link" href={link.href} label="Open the new session" />}
            </Box>
          )}
        </Box>
        {waitingOn.length > 0 && section('WAITING ON', waitingOn.map(ref))}
        {blocks.length > 0 && section('BLOCKS', blocks.map(ref))}
        {t.description !== undefined && section('DESCRIPTION', <Markdown key="description" text={t.description} />)}
        {t.acceptance.length > 0 && section('ACCEPTANCE', <Markdown key="acceptance" text={t.acceptance.map(a => `- ${a}`).join('\n')} />)}
        {labels.length > 0 && section('LABELS', <Text>{labels.join(' · ')}</Text>)}
      </Box>
    )
  })
}
