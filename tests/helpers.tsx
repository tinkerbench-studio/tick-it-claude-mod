import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { brief } from '../hooks/register'

export type Remote = { key: string; title: string; epic: string | null; epicId?: string; size: 'XS' | 'S' | 'M' | 'L'; status: string; acceptance: string[]; assignee: string | null }

/** The tickets the fake Tick-it starts with. */
export const SAMPLE = (): Remote[] => [
  { key: 'TCK-143', title: 'Persist checkout step in session', epic: 'One-page checkout', epicId: 'e-checkout', size: 'XS', status: 'Ready', acceptance: ['Step stored in session on each transition', 'GET /checkout resumes at stored step', 'Expired session falls back to step 1'], assignee: null },
  { key: 'TCK-144', title: 'Checkout summary component', epic: 'One-page checkout', epicId: 'e-checkout', size: 'S', status: 'In progress', acceptance: ['Shows items, tax and total', 'Updates when quantity changes'], assignee: 'someone' },
  { key: 'TCK-147', title: 'Add address validation service client', epic: 'Address autocomplete', epicId: 'e-address', size: 'XS', status: 'Ready', acceptance: ['Client wraps the validation API', 'Timeouts fall back to unvalidated'], assignee: null },
  { key: 'TCK-149', title: 'Migrate orders.shipping_address to JSONB', epic: 'Address autocomplete', epicId: 'e-address', size: 'M', status: 'Ready', acceptance: ['Migration and backfill', 'Old column readable until removed'], assignee: null },
  { key: 'TCK-151', title: 'Saved cards: list + delete endpoint', epic: 'Saved payment methods', epicId: 'e-cards', size: 'S', status: 'Ready', acceptance: ['List saved cards for the signed-in user', 'Delete one by id'], assignee: null },
]

export const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

export const PANE = {
  component: 'Pane',
  requestId: 'tick-it-board',
  props: { title: 'Tick-it', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

export const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

const BASES = 'skills/review-agents/bases'

export const SKILLS: Record<string, string> = {
  '.tick-it/skills/principal/SKILL.md': '---\nname: principal\ndescription: Second principal engineer\nmodel: claude-opus-5-5\n---\nCheck the tests prove each decision.',
  '.tick-it/skills/security/SKILL.md': '---\nname: security\ndescription: Security review\nmodel: claude-sonnet-5-5\n---\nLook for injection and leaked secrets.',
  '.tick-it/skills/migrations/SKILL.md': '---\nname: migrations\nsizes: M, L\n---\nOnly big changes.',
}

/** What the fake engine saw: subagents spawned, prompts submitted, toasts raised. */
export type Seen = {
  spawned: { prompt: string; model?: string; agentId: string; description: string }[]
  submitted: string[]
  /** Tick-it refuses to read tickets (a test sets it once the ticket is taken). */
  failTicketReads?: boolean
  toasts: string[]
  /** Each pane the mod opened. */
  opened: string[]
  /** Each record_runs call the mod made, with the server name it used. */
  recorded: { server: string; args: { session: string; repository: string | null; runs: Record<string, unknown>[] } }[]
  /** The fake Tick-it's tickets, as its ticket tools left them. */
  server: Remote[]
  /** The ticket tool calls the mod made, in order: tool and arguments. */
  ticketCalls: { tool: string; args: Record<string, unknown>; server: string; /** The need a report_session call carried, as Tick-it stores it (its `needsHuman` follows the rule of set_needs_human); the mod made no set_needs_human call of its own. */ derived?: true }[]
  /** Every command the mod ran, as one line. */
  processes: string[]
  /** Agents the agent list does not show (gone), and agents it shows running that this session did not spawn. */
  unlisted?: string[]
  listedExtra?: string[]
}

/**
 * Tick-it's MCP server: `connected` false stands for a person not signed in;
 * `answer` answers each record_runs call (every run accepted when absent);
 * an answer of 'unreachable' makes the call itself fail.
 */
export type Net = {
  connected?: boolean
  /** list_tickets fails (the board cannot be read) while the other tools answer. */
  listFails?: boolean
  /** The named tool's reply is too large for Claude Code, which passes on its note in place of the answer. */
  tooLarge?: 'list_tickets' | 'get_ticket'
  /** get_ticket answers acceptanceItems, none ticked (a ticket's checks are then unticked). */
  acceptanceItems?: boolean
  /** get_ticket answers with text that holds no result (not JSON, no structured content). */
  ticketNoResult?: boolean
  /** Only this server connects (a cloud session: the claude.ai connector, not the plugin's own). */
  only?: string
  answer?: (args: Seen['recorded'][number]['args'], call: number) => 'unreachable' | { isError?: boolean; text?: string; rejected?: { agentId: string; reason: string }[]; /** Only these runs are taken; the others are left unanswered. */ only?: string[] }
  /** Tick-it keeps no session for a ticket taken (a person's own local session): the take answers none. */
  noSession?: boolean
  /** Answer with lists that name no run. */
  silent?: boolean
  /** The repository's instructions for every brief; 'unreachable' makes get_repository_settings fail. */
  instructions?: string
  /** The review rounds by ticket size, as get_repository_settings answers them; not answered when absent. */
  reviewRounds?: Record<string, number>
  /** What get_mod_config answers; 'unreachable' makes the call fail, and absent leaves it unanswered (the mod keeps its own copies). */
  modConfig?: Record<string, unknown> | 'unreachable'
  /** The reviewSpend get_ticket answers with (null when costs cannot be seen); absent leaves it out of the ticket. */
  reviewSpend?: Record<string, unknown> | null
  /** What get_ticket_timeline answers (its review entries); 'unreachable' makes the call fail, and absent leaves it unanswered. */
  timeline?: Record<string, unknown>[] | 'unreachable'
  /** What list_sessions answers; absent leaves it unanswered. */
  sessions?: Record<string, unknown>[]
  /** The findings get_ticket answers with when asked for them (include findings); absent answers none. */
  findings?: Record<string, unknown>[]
  /** The config of get_repository_settings (one entry per base branch with its design section); absent when not answered. */
  config?: unknown[]
  /** The repository's autoMerge setting, as get_repository_settings answers it. */
  autoMerge?: boolean
  /** What report_session answers as the session's instructions, such as resolving a merge conflict. */
  reportInstructions?: string[]
  /** The next this many report_session calls are refused (Tick-it is down). */
  reportFails?: number
  /** A done report_session is refused with this text while it is set (Tick-it's refusal of a pull request that is behind its base). */
  doneRefusal?: string
  /** Fields merged into each report_session answer in turn (waitingOn, next, resume): one entry per call, the last one kept for every call after. */
  reportAnswers?: Record<string, unknown>[]
  /** Fields merged into every record_runs answer (roundVerdict, next, sessionStopped). */
  recordExtra?: Record<string, unknown>
  /** What a Tick-it tool call hands back to Claude as its result (a JSON text); 'ok' when absent. */
  toolResult?: string
  /** link_pull_request cannot reach Tick-it while this is true. */
  linkRefused?: boolean
  /** Tick-it answers link_pull_request with an error while this is true. */
  linkRejected?: boolean
  /** Tick-it gives no headSha for a pull request; otherwise one without it is at the checked-out commit. */
  noHeadSha?: boolean
  /** What list_pull_requests answers; 'unreachable' makes it fail. */
  pullRequests?: 'unreachable' | { number: number; state: string; draft: boolean; ci: string | null; behind?: boolean | null; mergeState?: string; mergeQueue?: unknown; ciInstructed?: boolean; headSha?: string; branch?: string }[]
  /** What list_milestones answers; no milestones when absent. */
  milestones?: { title: string; dueOn: string | null; epics: { id?: string; title: string; tickets: number; done: number }[]; tickets: number; done: number }[]
  /** list_tickets answers this many tickets a page with a nextCursor (the page's offset); `failAt` refuses the page with that cursor. */
  pageSize?: number
  failAt?: string
  /** Every page names the cursor '2' as the next one. */
  loop?: boolean
  /** Milliseconds each clock read jumps by on top of its second, to get past a throttle. */
  skip?: number
}

/** The engine beneath the mod: a store, a repo whose diff is `diff.lines` lines, and quiet UI calls. */
export const engine = (
  on: On,
  diff: { lines: number; merged?: boolean; byCommit?: Record<string, { lines?: number; numstatZ?: string; patch?: string }>; failDiff?: boolean; branch?: string; defaultBranch?: string; branchThrows?: boolean; siblings?: Record<string, string> | 'unlistable'; pr?: number; origin?: string | null; noCommit?: boolean; numstatZ?: string; failFiles?: boolean; changed?: string[] | null; since?: string[] | null; failUntracked?: boolean; truncateNames?: boolean; bases?: string[]; failNames?: 'exit' | 'throw'; subdir?: string; stored?: Record<string, unknown>; kept?: Map<string, unknown>; refuse?: (model: string | undefined, description: string) => string | undefined; patch?: string; dirty?: boolean; untracked?: Record<string, string>; binary?: Record<string, string>; gh?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined; pictures?: { key: string; name: string }[] | 'unreachable' | 'throws' | 'odd'; copies?: { exitCode: number; stdout: string; stderr: string } | 'hang' | 'throw'; required?: { exitCode: number; stdout: string; stderr: string } | 'hang'; ran?: { argv: string[]; stdin: unknown; timeoutMs?: unknown }[]; files?: Record<string, string>; base?: Record<string, string>; ignored?: string[]; throwShow?: boolean; remoteHead?: string; failFetch?: boolean; unpushed?: boolean; localAhead?: boolean },
  isPlaced = true,
  skills: Record<string, string> = {},
  net: Net = {},
): Seen => {
  let lastKey = 'TCK-143'
  const seen: Seen = { spawned: [], submitted: [], toasts: [], opened: [], recorded: [], server: SAMPLE(), ticketCalls: [], processes: [] }
  const answer = (value: Record<string, unknown>) => ({
    // As $.mcp.call hands a plugin a reply: the content blocks only, never structuredContent.
    value: { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] },
  })
  // What Claude Code puts in place of a reply over 50,000 characters.
  const tooLarge = () => ({ value: { isError: false, content: [{ type: 'text', text: '<persisted-output>\nOutput too large (51.4KB). Full output saved to: /tmp/x.txt\n</persisted-output>' }] } })
  const refuseOr = (instructions: string) => (instructions === 'unreachable' ? refuse('Tick-it is down') : answer({ instructions, canEdit: true }))
  const refuse = (text: string) => ({ value: { isError: true, content: [{ type: 'text', text }] } })
  on('session.id', () => ({ value: 'session-1' }))
  on('mcp.connect', (_$, e) => ({
    value:
      net.connected === false || (net.only !== undefined && e.server !== net.only)
        ? { isConnected: false as const, reason: 'needs-auth' as never, message: 'Tick-it needs you to sign in' }
        : e.server === 'tickit'
          ? { isConnected: true as const, server: `plugin:tick-it:${e.server}` }
          : // As the engine answers a server outside the plugin's own manifest.
            { isConnected: false as const, reason: 'unlisted' as never, message: `${e.server} is not in the manifest` },
  }))
  on('mcp.call', (_$, e) => {
    // Only the servers the session runs can be called; `only` is the one a cloud session has.
    if (net.connected === false || (net.only !== undefined && e.server !== net.only)) throw new Error(`no MCP server ${e.server}`)
    if (e.tool !== 'record_runs') {
      const a = e.args as Record<string, unknown>
      seen.ticketCalls.push({ tool: e.tool, args: a, server: e.server })
      if (typeof a.key === 'string') lastKey = a.key
      const refusing = e.tool === 'report_session' && (net.reportFails ?? 0) > 0
      // A need that rides on a report is stored as a need, as set_needs_human stores it.
      if (!refusing && e.tool === 'report_session' && typeof a.needsHuman === 'object' && a.needsHuman !== null) seen.ticketCalls.push({ tool: 'set_needs_human', args: { repository: a.repository, key: lastKey, ...(a.needsHuman as Record<string, unknown>) }, server: e.server, derived: true })
      if (e.tool === 'get_mod_config') return net.modConfig === undefined ? refuse('No such tool') : net.modConfig === 'unreachable' ? refuseOr('unreachable') : answer(net.modConfig)
      if (a.repository !== 'acme/web-app') return refuse(`No tickets in ${String(a.repository)} yet. create_ticket adds the first one.`)
      if (e.tool === net.tooLarge) return tooLarge()
      if (e.tool === 'list_tickets') {
        if (net.listFails === true) return refuse('Tick-it is down')
        // A slim row is what the server's slim list sends: no description, acceptance, links or url.
        const row = (t: Remote) => (a.slim === true ? { key: t.key, title: t.title, status: t.status, size: t.size, epic: t.epic, epicId: t.epicId ?? null, assignee: t.assignee, ...('notBefore' in t ? { notBefore: t.notBefore } : {}) } : t)
        if (net.pageSize === undefined) return answer({ tickets: seen.server.map(row) })
        if (a.cursor !== undefined && a.cursor === net.failAt) return refuse('Tick-it is down')
        const from = a.cursor === undefined ? 0 : Number(a.cursor)
        const to = from + net.pageSize
        // The last page leaves nextCursor out; the pages before it name the next.
        return answer({ tickets: seen.server.slice(from, to).map(row), ...(net.loop === true ? { nextCursor: '2' } : to < seen.server.length ? { nextCursor: String(to) } : {}) })
      }
      if (e.tool === 'list_screenshots') {
        if (diff.pictures === 'unreachable') return refuse('Tick-it is down')
        if (diff.pictures === 'throws') throw new Error('connection refused')
        return diff.pictures === 'odd' ? answer({ note: 'no list' }) : answer({ screenshots: diff.pictures ?? [] })
      }
      if (e.tool === 'list_milestones') return answer({ milestones: net.milestones ?? [], withoutMilestone: [] })
      if (e.tool === 'get_ticket') {
        if (seen.failTicketReads === true) return refuse('Tick-it is down')
        if (net.ticketNoResult === true) return { value: { isError: false, content: [{ type: 'text', text: 'Tick-it is busy, try again later. ' + 'x'.repeat(200) }, { type: 'image' }] } }
        const ticket = seen.server.find(t => t.key === a.key)
        return ticket === undefined ? refuse(`No ticket ${String(a.key)} in acme/web-app.`) : answer({ ticket: { ...ticket, ...(net.acceptanceItems === true ? { acceptanceItems: ticket.acceptance.map((text, i) => ({ id: `c${i}`, text, checked: false, afterDeploy: false })) } : {}), ...(net.reviewSpend === undefined ? {} : { reviewSpend: net.reviewSpend }), ...(net.findings === undefined || !Array.isArray(a.include) || !a.include.includes('findings') ? {} : { findings: net.findings }) } })
      }
      if (e.tool === 'get_ticket_timeline') return net.timeline === undefined || net.timeline === 'unreachable' ? refuse('Tick-it is down') : answer({ timeline: net.timeline })
      if (e.tool === 'list_sessions') return net.sessions === undefined ? refuse('Tick-it is down') : answer({ sessions: net.sessions })
      if (e.tool === 'list_pull_requests') {
        if (net.pullRequests === 'unreachable') return refuse('Tick-it is down')
        return answer({ pullRequests: (net.pullRequests ?? []).map(p => (net.noHeadSha === true ? p : { headSha: 'ab12'.repeat(10), ...p })) })
      }
      if (e.tool === 'get_repository_settings') return net.instructions === undefined ? answer({ instructions: '', canEdit: true, autoMerge: net.autoMerge, reviewRounds: net.reviewRounds, config: net.config }) : refuseOr(net.instructions)
      if (e.tool === 'report_review_agents') return answer({ agents: a.agents })
      if (e.tool === 'report_session' && net.doneRefusal !== undefined && a.status === 'done') return refuse(net.doneRefusal)
      if (refusing) {
        net.reportFails = (net.reportFails ?? 1) - 1
        return refuse('Tick-it is down')
      }
      if (e.tool === 'report_session') return answer({ session: { id: a.session, status: a.status }, instructions: net.reportInstructions?.splice(0) ?? [], ...((net.reportAnswers?.length ?? 0) > 1 ? net.reportAnswers?.shift() : net.reportAnswers?.[0]) })
      if (e.tool === 'link_pull_request') {
        if (net.linkRefused) throw new Error('connection refused')
        return net.linkRejected ? refuse('No ticket TCK-143 in acme/web-app.') : answer({ pullRequests: [] })
      }
      if (e.tool === 'start_session') {
        const held = seen.server.find(t => t.key === a.key) as { notBefore?: string | null } | undefined
        if (held?.notBefore != null && Date.parse(held.notBefore) > Date.now()) return refuse(`${String(a.key)} is held until ${held.notBefore}: it cannot be started before then.`)
      }
      if (e.tool === 'start_session') return answer({ session: { id: 's_new1234567' }, local: { link: `claude-cli://open?q=work+on+${String(a.key)}` } })
      if (e.tool === 'add_attachment') return answer({ attachment: { id: 'att1', name: a.name, type: a.type } })
      if (e.tool === 'create_ticket') {
        const ticket: Remote = { key: `TCK-${200 + seen.server.length}`, title: String(a.title), epic: null, size: a.size as Remote['size'], status: 'Ready', acceptance: [], assignee: null }
        seen.server.push(ticket)
        return answer({ ticket })
      }
      if (e.tool === 'update_ticket') {
        const ticket = seen.server.find(t => t.key === a.key)
        if (ticket === undefined) return refuse(`No ticket ${String(a.key)} in acme/web-app.`)
        if (a.status === 'In progress' && (ticket as { refuseHold?: string }).refuseHold !== undefined) return refuse((ticket as { refuseHold: string }).refuseHold)
        if (a.status === 'Done' && diff.pr !== undefined) return refuse(`${String(a.key)}'s pull request #${diff.pr} is still open: it moves to Done when it merges.`)
        if (a.status === 'Done' && (typeof a.reason !== 'string' || a.reason.trim() === '')) return refuse(`${String(a.key)} has no merged pull request: give a reason to move it to Done.`)
        if (a.status !== undefined) ticket.status = String(a.status)
        if (a.assignee !== undefined) ticket.assignee = a.assignee === 'me' ? 'maddiecs84' : null
        // Taking it, Tick-it answers the session it keeps for it.
        return answer(a.status === 'In progress' && net.noSession !== true ? { ticket, session: 's_taken12345' } : { ticket })
      }
      if (e.tool === 'set_criterion_checked') return answer({ ticket: seen.server.find(t => t.key === a.key) })
      return refuse(`no tool ${e.tool}`)
    }
    const args = e.args as Seen['recorded'][number]['args']
    seen.recorded.push({ server: e.server, args })
    // Tick-it's own check: the repository as owner/name.
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(args.repository))) return refuse('repository: must be owner/name, as on GitHub')
    const answered = net.answer?.(args, seen.recorded.length) ?? {}
    if (answered === 'unreachable') throw new Error('connection refused')
    const rejected = answered.rejected ?? []
    const accepted = net.silent ? [] : args.runs.map(r => String(r.agentId)).filter(id => !rejected.some(x => x.agentId === id) && (answered.only === undefined || answered.only.includes(id)))
    return {
      value: answered.isError ? { isError: true, content: [{ type: 'text', text: answered.text ?? '' }] } : { isError: false, content: [{ type: 'text', text: JSON.stringify({ accepted, rejected, ...net.recordExtra }) }] },
    }
  })
  let clock = 1_000
  if (diff.kept === undefined) mock.store(on, diff.stored)
  else {
    // A store the test can read: what the mod wrote, as a later session would find it.
    const kept = diff.kept
    for (const [k, v] of Object.entries(diff.stored ?? {})) kept.set(k, v)
    on('store.get', (_$, e) => ({ value: kept.get((e as { key: string }).key) }))
    on('store.set', (_$, e) => (kept.set((e as { key: string }).key, (e as { value: unknown }).value), { value: undefined }))
  }
  on('clock.now', () => ({ value: (clock += 1000 + (net.skip ?? 0)) }))
  // The engine hands the paths over resolved against the working directory.
  // A base review skill is read from the plugin's own folder, wherever that is: the map names it from skills/review-agents/bases on.
  // A secure-coding skill is read from the plugin's own folder too: the map names it from skills/secure- on.
  const rel = (path: string) => (path.includes('.tick') ? path.slice(path.indexOf('.tick')) : path.includes(BASES) ? path.slice(path.indexOf(BASES)) : path.includes('skills/secure-') ? path.slice(path.indexOf('skills/secure-')) : /\/(package\.json|node_modules)$/.test(path) ? path.slice(path.lastIndexOf('/') + 1) : path)
  on('fs.exists', (_$, e) => ({
    value: Object.keys(skills).some(path => path === rel(e.path) || path.startsWith(`${rel(e.path)}/`)),
  }))
  on('fs.list', (_$, e) => {
    if (e.path === '/' && diff.siblings !== undefined) {
      if (diff.siblings === 'unlistable') throw new Error('EACCES')
      return { value: Object.keys(diff.siblings).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
    }
    return {
    value: [
      ...new Set(
        Object.keys(skills)
          .filter(path => path.startsWith(`${rel(e.path)}/`))
          .map(path => path.slice(rel(e.path).length + 1).split('/')[0] ?? ''),
      ),
    ].map(name => ({
      name,
      kind: 'dir' as const,
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
    }
  })
  // The engine resolves a relative path against the working directory.
  const untracked = (path: string) => Object.entries(diff.untracked ?? {}).find(([name]) => path === name || path.endsWith(`/${name}`))?.[1]
  const binary = (path: string) => Object.entries(diff.binary ?? {}).find(([name]) => path === name || path.endsWith(`/${name}`))?.[1]
  on('fs.read', (_$, e) => {
    if (e.as !== 'bytes') return { value: skills[rel(e.path)] ?? diff.files?.[e.path] ?? untracked(e.path) ?? '' }
    const text = untracked(e.path)
    const base64 = binary(e.path) ?? (text === undefined ? undefined : btoa(String.fromCharCode(...new TextEncoder().encode(text))))
    return { value: { base64: base64 ?? '' } }
  })
  on('agent.spawn', (_$, e) => {
    const refused = diff.refuse?.(e.model, e.description)
    if (refused !== undefined) return { deny: refused }
    const agentId = `agent-${seen.spawned.length + 1}`
    seen.spawned.push({ prompt: e.prompt, model: e.model, agentId, description: e.description })
    return { model: e.model ?? 'claude-opus-5-5', agentId }
  })
  on('agent.list', () => ({
    value: [...seen.spawned.map(s => ({ id: s.agentId, description: s.description })), ...(seen.listedExtra ?? []).map(id => ({ id, description: id }))].filter(a => !(seen.unlisted ?? []).includes(a.id)).map(a => ({ ...a, type: 'general-purpose', status: 'running' as const, spawnedBy: 'tick-it' })),
  }))
  on('prompt.submit', (_$, e) => {
    seen.submitted.push(e.text)
    // As core does: the prompt enters with the context hooks attached on the way down.
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(typeof e === 'string' ? e : JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push((e as { id: string }).id)
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' as const } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('tool.call', () => ({ result: net.toolResult ?? 'ok' }) as never)
  // The commit checked out: a `git checkout -B <branch> FETCH_HEAD` moves it to what `git fetch` gave (`remoteHead`).
  let head = 'ab12'.repeat(10)
  on('process.run', (_$, e) => {
    const [cmd, sub] = e.argv
    seen.processes.push(e.argv.join(' '))
    const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'git' && sub === 'fetch') return ok('', diff.failFetch === true ? 1 : 0)
    if (cmd === 'git' && sub === 'rev-parse' && e.argv.at(-1) === 'FETCH_HEAD') return ok(`${diff.remoteHead ?? 'ab12'.repeat(10)}\n`)
    if (cmd === 'git' && sub === 'rev-list') return e.argv[2]?.startsWith('refs/heads/') ? ok(diff.localAhead === true ? 'ee55\n' : '') : ok(diff.unpushed === true ? 'ff66\n' : '')
    if (cmd === 'git' && sub === 'checkout') {
      head = diff.remoteHead ?? head
      return ok()
    }
    // The repository's design.requiredPictures command (a fake): what it was given is kept, what it answers is the test's.
    if (cmd === 'design-tool' && diff.required !== undefined) {
      const init = (e as { init?: { stdin?: unknown; timeoutMs?: number } }).init
      diff.ran?.push({ argv: e.argv, stdin: init?.stdin, timeoutMs: init?.timeoutMs })
      // As the engine does: the child is killed and the call rejects once timeoutMs passes.
      if (diff.required === 'hang') return new Promise((_, reject) => setTimeout(() => reject(new Error('process killed after timeout')), init?.timeoutMs ?? 30_000)) as never
      return { value: { ...diff.required, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (cmd === 'npm' && diff.copies !== undefined) {
      if (diff.copies === 'throw') throw new Error('$.process.run(npm) failed to start: ENOENT')
      if (diff.copies === 'hang') return new Promise(resolve => setTimeout(() => resolve({ value: { exitCode: 1, stdout: 'late hits', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }), 300)) as never
      return { value: { ...diff.copies, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // As in a session that will not run them for a plugin: only git and gh start.
    if (cmd !== 'git' && cmd !== 'gh') throw new Error(`$.process.run(${cmd}) failed to start: ENOENT`)
    const ghAnswer = cmd === 'gh' ? diff.gh?.(e.argv) : undefined
    if (ghAnswer !== undefined) return { value: { ...ghAnswer, isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === '-C') {
      const origin = typeof diff.siblings === 'object' ? diff.siblings[e.argv[2]?.slice(1) ?? ''] : undefined
      return { value: { exitCode: origin === undefined ? 128 : 0, stdout: origin ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // The size guard: a path git ignores, and a file's text at the ticket's base (`base`; absent stands for text that cannot be read).
    if (cmd === 'git' && sub === 'check-ignore') return { value: { exitCode: (diff.ignored ?? []).includes(e.argv.at(-1) ?? '') ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'show') {
      if (diff.throwShow === true) throw new Error('git show failed')
      const text = diff.base?.[(e.argv[2] ?? '').replace(/^[^:]*:/, '')]
      return { value: { exitCode: text === undefined ? 128 : 0, stdout: text ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (cmd === 'git' && sub === 'symbolic-ref') return { value: { exitCode: diff.defaultBranch === undefined ? 1 : 0, stdout: `origin/${diff.defaultBranch ?? ''}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'rev-parse' && e.argv.includes('--abbrev-ref') && diff.branchThrows === true) throw new Error('git rev-parse failed')
    if (cmd === 'git' && sub === 'ls-files' && diff.failUntracked === true) return { value: { exitCode: 1, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'ls-files') {
      // As git does: the session folder (`subdir`, below the root) only, unless the `:/` pathspec names the whole repository; --full-name changes only how paths print.
      const whole = e.argv.includes(':/')
      const full = e.argv.includes('--full-name')
      const names = Object.keys(diff.untracked ?? {}).filter(f => diff.subdir === undefined || whole || f.startsWith(diff.subdir)).map(f => (diff.subdir === undefined || full ? f : f.slice(diff.subdir.length)))
      return { value: { exitCode: 0, stdout: names.join('\0'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // The merge base and the files changed since it: `changed` null stands for a repository where they cannot be listed.
    // `merged`: the base was merged in after the ticket was taken, so the merge base is newer than the taken commit (a descendant of it).
    if (cmd === 'git' && sub === 'merge-base' && e.argv[2] === '--is-ancestor') return { value: { exitCode: diff.merged === true ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // `byCommit`: what the diff against that commit holds, so a test tells the taken commit's diff from the merge base's.
    const per = diff.byCommit?.[e.argv.at(-1) ?? '']
    if (cmd === 'git' && sub === 'diff' && !e.argv.includes('--name-only') && diff.failDiff === true && e.argv.at(-1) !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904') return { value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'merge-base') return { value: { exitCode: diff.changed === undefined || diff.changed === null || (diff.bases !== undefined && !diff.bases.includes(e.argv[3] ?? '')) ? 1 : 0, stdout: `${'cd34'.repeat(10)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'diff' && e.argv.includes('--name-only') && diff.failNames === 'exit') return { value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'diff' && e.argv.includes('--name-only') && diff.failNames === 'throw') throw new Error('git diff --name-only failed')
    // Files changed since a review's head (the diff against it, not against the merge base): `since`, else every changed file (a fix changed something); a test of a turn that changes no file sets `since: []`.
    if (cmd === 'git' && sub === 'diff' && e.argv.includes('--name-only') && e.argv.includes('ab12'.repeat(10))) return { value: { exitCode: diff.since === null ? 128 : 0, stdout: (diff.since ?? diff.changed ?? ["x"]).map(f => `${f}\0`).join(''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'diff' && e.argv.includes('--name-only')) return { value: { exitCode: 0, stdout: (diff.changed ?? []).map(f => `${f}\0`).join(''), stderr: '', isStdoutTruncated: diff.truncateNames === true, isStderrTruncated: false } }
    if (cmd === 'git' && sub === 'diff' && e.argv.includes('-z') && diff.failFiles === true) throw new Error('git diff -z failed')
    const stdout =
      cmd === 'git' && sub === 'diff'
        ? e.argv.includes('-U0')
          ? (per?.patch ?? diff.patch ?? '')
          : e.argv.includes('-z')
          ? (per?.numstatZ ?? diff.numstatZ ?? `${per?.lines ?? diff.lines}\t0\tapi/a.ts\0`)
          : `${per?.lines ?? diff.lines}\t0\tapi/a.ts\n`
        : cmd === 'git' && sub === 'remote'
          ? diff.origin === undefined
            ? 'git@github.com:acme/web-app.git\n'
            : (diff.origin ?? '')
          : cmd === 'git' && sub === 'rev-parse' && e.argv.includes('--show-toplevel')
            ? '/repo\n'
            : cmd === 'git' && sub === 'rev-parse' && e.argv.includes('--abbrev-ref')
              ? `${diff.branch ?? 'tck-151-picker'}\n`
              : cmd === 'git' && sub === 'rev-parse'
                ? `${head}\n`
                : cmd === 'git' && sub === 'status' && diff.dirty === true
                  ? ' M hooks/reviews.ts\n'
                  : cmd === 'gh' && diff.pr !== undefined
                  ? JSON.stringify({ number: diff.pr })
                  : ''
    return {
      value: { exitCode: cmd === 'cat' || (cmd === 'gh' && diff.pr === undefined) || (sub === 'remote' && diff.origin === null) || (diff.noCommit === true && ((sub === 'diff' && !e.argv.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904')) || (sub === 'rev-parse' && e.argv.at(-1) === 'HEAD'))) ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))

  return seen
}

/** A review agent (or, with no agentId, the main loop) finishing its turn. */
export const finishTurn = (agentId: string | undefined, answer: string, model = 'claude-opus-5-5') => ({
  answer,
  durationMs: 95_000,
  isAborted: false,
  turnId: `turn-${agentId ?? 'main'}-${answer.length}`,
  ...(agentId === undefined ? {} : { agentId }),
  usage: { model, input_tokens: 20_000, output_tokens: 4_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 },
  reason: 'answer' as const,
})

export const start = ($: { session: { start: (e: never) => Promise<unknown> } }) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

export const PRINCIPAL_ONLY = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }

/** Takes TCK-143 through two blocking rounds and fixes, then round 3 answers `answer`. */
export const roundThree = async ($: Parameters<typeof start>[0], on: Parameters<typeof engine>[0], answer: string) => {
  const seen = engine(on, { lines: 10 }, true, PRINCIPAL_ONLY)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  for (const round of [1, 2]) {
    await $.turn.complete(finishTurn(`agent-${round}`, 'BLOCKING: wrong'))
    // Rounds remaining: the next round starts after the fix.
    expect(seen.spawned).toHaveLength(round)
    await $.turn.complete(finishTurn(undefined, 'Fixed.'))
    expect(seen.spawned).toHaveLength(round + 1)
  }
  await $.turn.complete(finishTurn('agent-3', answer))
  return seen
}

export const noExtraRound = (seen: Awaited<ReturnType<typeof roundThree>>) => {
  expect(seen.spawned).toHaveLength(3)
  expect(seen.submitted).toHaveLength(2)
  expect(seen.ticketCalls.some(c => c.tool === 'set_needs_human' && c.args.kind === 'no-clean-round')).toBe(false)
}

export const PRINCIPAL = { '.tick-it/skills/principal/SKILL.md': SKILLS['.tick-it/skills/principal/SKILL.md'] ?? '' }

export const STARTED = 'Tick-it session s_abc12345: work on TCK-151 in acme/web-app.\nSaved card picker in checkout\n\nThe tick-it mod takes the ticket.'

/** A prompt typed and entered with Enter. */
export const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

export const reports = (seen: Seen) => seen.ticketCalls.filter(c => c.tool === 'report_session').map(c => c.args)

export const finishReview = ($: Parameters<typeof start>[0] & { tool: { call: (e: never) => Promise<unknown> } }) => $.tool.call({ tool: 'mcp__plugin_tick-it_tickit__update_ticket', tool_use_id: 'tu-ui', repository: 'acme/web-app', key: 'TCK-151', status: 'In review' } as never) as Promise<{ deny?: string }>

export const UI_FILES = `1\t0\tapps/web/src/pages.tsx\0`

export const BOARD_FILES = `${UI_FILES}1\t0\tdesign/canvas/boards/Board.map.json\0`

/** A repository's design section (.tick-it/config.json), as get_repository_settings gives it in config: what makes the UI-evidence gate and checklist run at all. */
export const DESIGN_CHECKLIST = ['UI evidence: a before/after picture of each changed screen, uploaded to Tick-it', 'UI evidence: the pull request names every visible difference']
export const DESIGN_CONFIG = [
  {
    branch: 'main',
    design: {
      workflow: 'docs/design-system.md',
      uiPaths: ['apps/web/src/**', 'design/**'],
      checklist: DESIGN_CHECKLIST,
      pictures: [{ when: ['design/canvas/boards/*.map.json', 'design/canvas/boards/*.dc.html'], name: 'board-beside-story-*', why: 'Run the board shots and copy each to board-beside-story-<Board>.png.' }],
    },
  },
]
// The fake `design-tool`: an argument carries a shell metacharacter, which must reach it literally.
export const REQUIRED_COMMAND = ['design-tool', 'required-pictures', '--for', 'a; echo $HOME']
export const REQUIRED_CONFIG = [{ branch: 'main', design: { ...DESIGN_CONFIG[0].design, requiredPictures: { command: REQUIRED_COMMAND } } }]
export const PIC = { key: 'acme/web-app/TCK-151/board-before-after.png', name: 'board-before-after.png' }

export const PAGED = [161, 162, 163, 164, 165]

export const paged = (seen: Seen, from = PAGED) => {
  for (const n of from) seen.server.push({ key: `TCK-${n}`, title: `Paged ${n}`, epic: null, size: 'XS', status: 'Backlog', acceptance: [], assignee: null })
}

export const PR = { number: 7, state: 'open', draft: false, ci: 'success', behind: false, conflicting: false, queued: false, ciInstructed: false } as const

/** A clean round of both reviewers on TCK-143 whose pull request #12 is as given: what the steward does next. */
export const cleanRoundWith = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, pr: Record<string, unknown> | 'unreachable') => {
  const net: Net = { pullRequests: pr === 'unreachable' ? 'unreachable' : [{ number: 12, state: 'open', draft: false, ci: 'success', ...pr }] }
  const seen = engine(on, { lines: 10 }, true, SKILLS, net)
  await start($)
  await $.command.run({ ...RUN, command: 'tick-it', args: 'take TCK-143' })
  await $.command.run({ ...RUN, command: 'tick-it', args: 'done' })
  await $.turn.complete(finishTurn('agent-1', 'VERDICT: clean'))
  await $.turn.complete(finishTurn('agent-2', 'VERDICT: clean', 'claude-sonnet-5-5'))
  return seen
}

export const staleBranch = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, stale: Record<string, unknown>) => {
  const seen = await cleanRoundWith($, on, stale)
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('[base] Pull request #12')
  expect(seen.submitted[0]).toContain('never rebase or force-push')
}
