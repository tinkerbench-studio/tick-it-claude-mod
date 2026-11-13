import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { AttachmentRef, MemoryRef, Ticket, TicketSize } from '../types'

import { brief, servedConfig, storeServed } from './board'
import { MOD_VERSION, TICKIT_SERVER, TICKIT_CONNECTORS, DEFAULT_ROUNDS, MAX_ROUND_LIMIT, SIZES } from './state'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
/** The repository's instructions for every brief, fetched when a ticket is taken and read locally after. */
const instructions = atom({ plugin: 'tick-it', key: 'instructions' } as const, '')
/** The review rounds by ticket size, fetched with the instructions and kept as they were when Tick-it cannot say. */
const rounds = atom({ plugin: 'tick-it', key: 'rounds' } as const, { repository: '', limits: DEFAULT_ROUNDS } as { repository: string; limits: Record<TicketSize, number> })
/** The files attached to the ticket just taken (and its epic) and the memories recalled for it, fetched with get_ticket when it is taken and read locally after. */
const attachments = atom({ plugin: 'tick-it', key: 'attachments' } as const, { ticket: '', files: [], memories: [] } as { ticket: string; files: AttachmentRef[]; memories: MemoryRef[] })
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)

export type Sent = { ok: true; result: Awaited<ReturnType<EngineInterface['mcp']['call']>> } | { ok: false; why: string }

/** Calls a Tick-it tool on the plugin's own server, or when that will not connect, on the claude.ai connector; the own server's failure is the one reported. */
export async function sendTickit($: EngineInterface, tool: string, args: Record<string, unknown> | ((place: 'local' | 'cloud') => Record<string, unknown>)): Promise<Sent> {
  // Where the session runs is how it got through: the plugin's own server and the connector a local session lists (`claude.ai Tick-It`) are a machine, the connector a cloud session lists (`Tick-It`) is the cloud.
  const given = (place: 'local' | 'cloud') => (typeof args === 'function' ? args(place) : args)
  const own = await $.mcp.connect(TICKIT_SERVER)
  if (own.isConnected) {
    try {
      return { ok: true, result: await $.mcp.call(own.server, tool, given('local')) }
    } catch (error) {
      return { ok: false, why: `could not reach Tick-it (${error instanceof Error ? error.message : String(error)})` }
    }
  }
  for (const connector of TICKIT_CONNECTORS) {
    try {
      return { ok: true, result: await $.mcp.call(connector, tool, given(connector === 'Tick-It' ? 'cloud' : 'local')) }
    } catch {
      // Not a server of this session: try the next name.
    }
  }
  return { ok: false, why: `not connected to Tick-it (${own.message}). Sign in with /mcp, or add the Tick-it connector on claude.ai for cloud sessions` }
}

/** owner/name from a GitHub remote URL, https or ssh; undefined for anything else. */
export const repositoryOf = (remote: string): string | undefined => /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1]

export type Called = { ok: true; value: Record<string, unknown> } | { ok: false; why: string }

export const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content
    .map(b => (b.type === 'text' ? (b.text ?? '') : ''))
    .join(' ')
    .trim()
    .slice(0, 300)

/** Calls one of Tick-it's tools over the session's MCP connection: its structured answer, or why not. */
export async function callTickit($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Called> {
  const sent = await sendTickit($, tool, args)
  if (!sent.ok) return { ok: false, why: sent.why }
  const result = sent.result
  if (result.isError) return { ok: false, why: textOf(result) || `Tick-it refused ${tool}` }
  if (typeof result.structuredContent === 'object' && result.structuredContent !== null) {
    return { ok: true, value: result.structuredContent as Record<string, unknown> }
  }
  for (const block of result.content) {
    if (block.type !== 'text' || block.text === undefined) continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (typeof parsed === 'object' && parsed !== null) return { ok: true, value: parsed as Record<string, unknown> }
    } catch {
      // Not JSON: keep looking.
    }
  }
  return { ok: false, why: `Tick-it's answer to ${tool} had no result in it` }
}

/** The repository this session works in, as owner/name, from its origin remote. */
/** The folder's origin remote: null when it has none, undefined when it is not a GitHub repository. */
export async function originHere($: EngineInterface): Promise<string | null | undefined> {
  const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  return remote.exitCode === 0 ? repositoryOf(remote.stdout) : null
}

/**
 * The Tick-it repository this folder is: its GitHub origin, or, in a folder
 * with no origin at all (a new project not yet pushed), the repository of the
 * session Tick-it started this one as.
 */
export async function repositoryHere($: EngineInterface): Promise<string | undefined> {
  const origin = await originHere($)
  if (origin !== null) return origin
  return (await read($, startedSession))?.repository
}

/** Fetches the repository's instructions for every brief (get_repository_settings) into the mod's state; kept as they were when Tick-it cannot say. */
export async function fetchInstructions($: EngineInterface): Promise<void> {
  const repository = await repositoryHere($)
  if (repository === undefined) return
  const got = await callTickit($, 'get_repository_settings', { repository }).catch(() => ({ ok: false as const, why: 'unreachable' }))
  if (got.ok && typeof got.value.instructions === 'string') {
    const text = got.value.instructions
    await update($, instructions, () => text)
  }
  const given = got.ok ? got.value.reviewRounds : undefined
  if (typeof given === 'object' && given !== null) {
    const held = given as Record<string, unknown>
    // Limits kept from another repository are not this one's: they fall back to the defaults.
    await update($, rounds, kept => {
      const before = kept.repository === repository ? kept.limits : DEFAULT_ROUNDS
      const limits = Object.fromEntries(SIZES.map(size => [size, typeof held[size] === 'number' && Number.isInteger(held[size]) && held[size] >= 1 ? Math.min(held[size], MAX_ROUND_LIMIT) : before[size]])) as Record<TicketSize, number>
      return { repository, limits }
    })
  }
}

/** Asks Tick-it for what the mod shares with it (get_mod_config): size budgets, review round defaults and the brief lines naming this ticket. Kept as they were when it cannot say. */
export async function fetchModConfig($: EngineInterface, ticket: string): Promise<void> {
  const got = await callTickit($, 'get_mod_config', { key: ticket, modVersion: MOD_VERSION }).catch(() => ({ ok: false as const, why: 'unreachable' }))
  if (!got.ok) return
  const v = got.value as { sizeBudgets?: Record<string, unknown>; defaultReviewRounds?: Record<string, unknown>; briefLines?: Record<string, unknown> }
  const budgets = v.sizeBudgets
  const lines = v.briefLines
  if (budgets === undefined || lines === undefined || !SIZES.every(size => typeof budgets[size] === 'number') || !['memories', 'memoryTools', 'deferredTools', 'done', 'branch'].every(k => typeof lines[k] === 'string') || !Array.isArray(lines.addToTicket)) return
  await storeServed($, { sizeBudgets: budgets as Record<TicketSize, number>, ticket, briefLines: lines as never })
  const defaults = v.defaultReviewRounds
  if (defaults !== undefined && SIZES.every(size => typeof defaults[size] === 'number')) await update($, rounds, kept => (kept.repository === '' ? { repository: '', limits: defaults as Record<TicketSize, number> } : kept))
}

/** The review rounds a ticket of this size gets before the one past the limit, as of the last fetch. */
export async function roundLimit($: EngineInterface, size: TicketSize): Promise<number> {
  const held = await read($, rounds)
  return (held.repository === (await repositoryHere($)) || held.repository === '' ? held.limits : DEFAULT_ROUNDS)[size]
}

/** A ticket's brief with the repository's instructions, as of the last fetch. */
export async function briefOf($: EngineInterface, t: Ticket): Promise<string> {
  const held = await read($, attachments)
  return brief(t, await read($, tickets), await read($, instructions), held.ticket === t.id ? held.files : [], held.ticket === t.id ? held.memories : [], await servedConfig($))
}

/** Fetches the ticket's attachments (get_ticket) into the mod's state; none when Tick-it cannot say. */
export async function fetchAttachments($: EngineInterface, t: Ticket): Promise<void> {
  const repository = await repositoryHere($)
  const got = repository === undefined ? undefined : await callTickit($, 'get_ticket', { repository, key: t.id, include: ['attachments', 'memories'] }).catch(() => undefined)
  const listed = got?.ok === true ? (got.value.ticket as { attachments?: AttachmentRef[] } | undefined)?.attachments : undefined
  const files = (listed ?? []).map(({ id, name, type }) => ({ id, name, type }))
  const recalled = got?.ok === true ? (got.value.ticket as { memories?: MemoryRef[] } | undefined)?.memories : undefined
  const memories = (recalled ?? []).slice(0, 5).map(({ key, kind, body, status, strength }) => ({ key, kind, body, status, strength }))
  await update($, attachments, () => ({ ticket: t.id, files, memories }))
}

/** The brief of a ticket just taken: the instructions are fetched afresh first. */
export async function freshBriefOf($: EngineInterface, t: Ticket): Promise<string> {
  return (await Promise.all([fetchInstructions($), fetchAttachments($, t), fetchModConfig($, t.id)]), briefOf($, t))
}
