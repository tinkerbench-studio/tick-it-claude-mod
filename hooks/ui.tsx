import type { MilestoneView } from '../types'
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { PANE, TICKET_PANE, WARN_AT, groupsOf, COLOR } from './state'
import { budgetOf, boardStops, pickMilestone, nextMilestone, milestoneLine, milestoneOf, findCurrent, fixCi, rerunFailed, openPullRequest } from './board'
import { take } from './work'
import { reviewAgain, stopStewarding, summarise, reviewLine, findingRows } from './reviews'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
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
        <Button key="ticket" plain onPress={() => void $.ui.open({ id: TICKET_PANE, title: t.id })}>
          <Text bold>{t.id}</Text>
        </Button>
        <Text wrap="truncate-end">{t.title}</Text>
        <Text color={COLOR.dim}>· {t.status} · diff</Text>
        <Text color={tone}>{`${lines}/${budget}`}</Text>
        <Button key="board" label="Board" onPress={() => void $.ui.open({ id: PANE, title: 'Tick-it' })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tickets)
    const taken = await read($, current)
    const s = await read($, steward)
    const stewarded = s === null ? [] : (await read($, reviews)).filter(r => r.ticket === s.ticket)
    const optionalShown = await read($, showOptional)
    const pr = await read($, pullRequest)
    const rows = s === null ? [] : findingRows(stewarded, s.round, optionalShown)
    const roadmap = boardStops(await read($, milestones), list)
    const milestone = pickMilestone(roadmap, await read($, shownMilestone))
    const epics = milestone === undefined ? undefined : new Set(milestone.epics.map(epic => epic.title))
    const shown = epics === undefined ? list : list.filter(t => epics.has(t.epic))
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
        {groupsOf(shown).map(status => {
          const rows = shown.filter(t => t.status === status)
          return (
            <Box key={`group-${status}`} flexDirection="column">
              <Text bold>
                {status} <Text color={COLOR.dim}>{rows.length}</Text>
              </Text>
              {rows.length === 0 && <Text color={COLOR.dim}>none</Text>}
              {rows.map(t => (
                <Button
                  key={t.id}
                  plain
                  onPress={async () => {
                    const took = await take($, t.id)
                    $.ui.toast(typeof took === 'string' ? `tick-it: ${took}` : `tick-it: took ${took.id}. Its brief is with Claude.`)
                  }}
                >
                  {t.id === taken ? '◆ ' : '  '}
                  {t.id} {t.title} <Text color={COLOR.dim}>{t.size}</Text>
                </Button>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: TICKET_PANE }, async ($, e) => {
    const { Box, Text, Link, Markdown } = $.ui.resolve(e)
    const t = await findCurrent($)
    if (t === undefined) return <Text color={COLOR.dim}>No ticket is taken.</Text>
    const pr = await read($, pullRequest)
    const milestone = milestoneOf(await read($, milestones), t)

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          {t.id} {t.title}
        </Text>
        <Text color={COLOR.dim}>{[t.status, t.size, t.epic, ...(milestone === undefined ? [] : [milestone])].join(' · ')}</Text>
        {(t.labels ?? []).length > 0 && <Text>{`Labels: ${(t.labels ?? []).join(', ')}`}</Text>}
        {t.url !== undefined && (
          <Text>
            <Link key="ticket-link" href={t.url} label={`${t.id} in Tick-it`} />
          </Text>
        )}
        {pr?.url !== undefined && (
          <Text>
            <Link key="pr-link" href={pr.url} label={`#${pr.number} on GitHub`} />
          </Text>
        )}
        {t.description !== undefined && <Markdown key="description" text={t.description} />}
        {t.acceptance.length > 0 && <Markdown key="acceptance" text={t.acceptance.map(a => `- ${a}`).join('\n')} />}
      </Box>
    )
  })
}
