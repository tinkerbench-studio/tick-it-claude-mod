import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { AttachmentRef, MemoryRef, Ticket, TicketSize } from '../types'

import { brief, servedConfig, storeServed } from './board'
import type { BriefLines } from './board'
import type { Design, PictureRule, RequiredPictures } from './ui-evidence'
import { MOD_VERSION, REPORT_TOOL, TICKIT_SERVER, TICKIT_CONNECTORS, DEFAULT_ROUNDS, MAX_ROUND_LIMIT, SIZES } from './state'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const tickets = atom({ plugin: 'tick-it', key: 'tickets' } as const, [])
/** The repository's instructions for every brief, fetched when a ticket is taken and read locally after. */
const instructions = atom({ plugin: 'tick-it', key: 'instructions' } as const, '')
/** The repository's design section (uiPaths, checklist, pictures, workflow), fetched with the instructions; null when it sets no uiPaths, so no change is a UI change. */
const designHeld = atom({ plugin: 'tick-it', key: 'design' } as const, { repository: '', design: null } as { repository: string; design: Design | null })
/** The review rounds by ticket size, fetched with the instructions and kept as they were when Tick-it cannot say. */
const rounds = atom({ plugin: 'tick-it', key: 'rounds' } as const, { repository: '', limits: DEFAULT_ROUNDS } as { repository: string; limits: Record<TicketSize, number> })
/** The round limit and review budget get_mod_config gave for one ticket (null when it gave none, or something that is not a whole number of 1 or more), kept as they were when Tick-it cannot say. */
const modLimits = atom({ plugin: 'tick-it', key: 'modLimits' } as const, { repository: '', ticket: '', reviewRounds: null, reviewBudget: null } as { repository: string; ticket: string; reviewRounds: number | null; reviewBudget: number | null })
/** The files attached to the ticket just taken (and its epic) and the memories recalled for it, fetched with get_ticket when it is taken and read locally after. */
const attachments = atom({ plugin: 'tick-it', key: 'attachments' } as const, { ticket: '', files: [], memories: [] } as { ticket: string; files: AttachmentRef[]; memories: MemoryRef[] })
/** The session Tick-it started this one as: set by its first message, reported to as the work goes on. */
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)

export type Sent = { ok: true; result: Awaited<ReturnType<EngineInterface['mcp']['call']>> } | { ok: false; why: string }

/** Calls a Tick-it tool on the plugin's own server, or when that will not connect, on the claude.ai connector; the own server's failure is the one reported. */
export async function sendTickit($: EngineInterface, tool: string, args: Record<string, unknown> | ((place: 'local' | 'cloud') => Record<string, unknown>)): Promise<Sent> {
  // Where the session runs is how it got through: the plugin's own server and the connector a local session lists (`claude.ai Tick-It`) are a machine, the connector a cloud session lists (`Tick-It`) is the cloud.
  const given = (place: 'local' | 'cloud') => {
    const made = typeof args === 'function' ? args(place) : args
    // Every report_session call names the mod release, the same string get_mod_config gets, so a problem on a session can be checked against an old mod.
    return tool === REPORT_TOOL ? { ...made, modVersion: MOD_VERSION } : made
  }
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
  // Claude Code replaces a tool reply over 50,000 characters with a note (and may truncate one): the reply was never Tick-it's answer, so say so.
  if (/persisted-output|truncated-output|Output too large/i.test(result.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join(' '))) {
    return { ok: false, why: `Tick-it's answer to ${tool} was too large for Claude Code to pass on whole` }
  }
  return { ok: false, why: `Tick-it's answer to ${tool} had no result in it (${result.content.length} content blocks: ${result.content.map(b => `${b.type} ${b.type === 'text' ? (b.text ?? '').length : 0} chars`).join(', ') || 'none'}; the text starts: ${textOf(result).slice(0, 80) || 'empty'})` }
}

/** The repository this session works in, as owner/name, from its origin remote. */
/** The folder's origin remote: null when it has none, undefined when it is not a GitHub repository. */
export async function originHere($: EngineInterface): Promise<string | null | undefined> {
  const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  return remote.exitCode === 0 ? repositoryOf(remote.stdout) : null
}

/** Whether two repository names (owner/name) are the same one: GitHub names carry no letter case, and Tick-it compares them lower-cased. */
export const sameRepository = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** A folder beside this repository's top level whose origin is `repository`, as its path; undefined when there is none or the folders cannot be listed. */
export async function checkoutBeside($: EngineInterface, repository: string): Promise<string | undefined> {
  try {
    const top = (await $.process.run(['git', 'rev-parse', '--show-toplevel'])).stdout.trim()
    const parent = top.slice(0, top.lastIndexOf('/')) || '/'
    if (top === '') return undefined
    for (const entry of await $.fs.list(parent)) {
      if (entry.kind === 'file') continue
      const path = `${parent === '/' ? '' : parent}/${entry.name}`
      if (path === top) continue
      const remote = await $.process.run(['git', '-C', path, 'remote', 'get-url', 'origin'])
      if (remote.exitCode === 0 && sameRepository(repositoryOf(remote.stdout), repository)) return path
    }
  } catch {
    // The folders cannot be listed: the decline stands as it was.
  }
  return undefined
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

/** A stored run belongs here when stamped with this repository, or with none (an older mod's, which the repository it is first read in takes). */
export const madeHere = (run: { repository?: string }, repository: string | undefined): boolean => run.repository === undefined || repository === undefined || sameRepository(run.repository, repository)

const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every(v => typeof v === 'string' && v !== '') ? (value as string[]) : null)

/** The picture rules of a design section, each kept only when well formed (Tick-it validated them; an odd one is skipped, never guessed at). */
const pictureRules = (value: unknown): PictureRule[] =>
  Array.isArray(value)
    ? value.flatMap(rule => {
        const { when, name, why } = (rule ?? {}) as Record<string, unknown>
        const globs = strings(when)
        return globs !== null && globs.length > 0 && typeof name === 'string' && name !== '' ? [{ when: globs, name, ...(typeof why === 'string' && why !== '' ? { why } : {}) }] : []
      })
    : []

/** design.requiredPictures when well formed (a non-empty list of argument strings), else null: an odd one is skipped, never guessed at. */
const requiredOf = (value: unknown): RequiredPictures | null => {
  const { command, why } = (value ?? {}) as Record<string, unknown>
  const argv = strings(command)
  return argv !== null && argv.length > 0 ? { command: argv, ...(typeof why === 'string' && why !== '' ? { why } : {}) } : null
}

/**
 * The design section of get_repository_settings' config (one entry per base branch: the first that sets uiPaths), or
 * null when none does: then no change is a UI change. Its checklist, pictures and workflow come from the same entry.
 */
export function designOf(value: Record<string, unknown>): Design | null {
  if (!Array.isArray(value.config)) return null
  for (const entry of value.config as unknown[]) {
    const design = (entry as { design?: Record<string, unknown> | null } | null)?.design
    if (design === null || design === undefined || typeof design !== 'object') continue
    const uiPaths = strings(design.uiPaths)
    if (uiPaths === null || uiPaths.length === 0) continue
    return { uiPaths, checklist: strings(design.checklist) ?? [], pictures: pictureRules(design.pictures), workflow: typeof design.workflow === 'string' && design.workflow !== '' ? design.workflow : null, requiredPictures: requiredOf(design.requiredPictures) }
  }
  return null
}

/** The repository's design for the gate: asked of Tick-it now; as last fetched when it cannot answer; null when it sets none. */
export async function designHere($: EngineInterface, repository: string): Promise<Design | null> {
  const got = await callTickit($, 'get_repository_settings', { repository }).catch(() => ({ ok: false as const, why: 'unreachable' }))
  if (got.ok) {
    const design = designOf(got.value)
    await update($, designHeld, () => ({ repository, design }))
    return design
  }
  const held = await read($, designHeld)
  return sameRepository(held.repository, repository) ? held.design : null
}

/** The design last fetched, for this repository only: another repository's is not this one's. */
async function heldDesign($: EngineInterface): Promise<Design | null> {
  const held = await read($, designHeld)
  return sameRepository(held.repository, await repositoryHere($)) ? held.design : null
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
  if (got.ok) await update($, designHeld, () => ({ repository, design: designOf(got.value) }))
  const given = got.ok ? got.value.reviewRounds : undefined
  if (typeof given === 'object' && given !== null) {
    const held = given as Record<string, unknown>
    // Limits kept from another repository are not this one's: they fall back to the defaults.
    await update($, rounds, kept => {
      const before = sameRepository(kept.repository, repository) ? kept.limits : DEFAULT_ROUNDS
      const limits = Object.fromEntries(SIZES.map(size => [size, typeof held[size] === 'number' && Number.isInteger(held[size]) && held[size] >= 1 ? Math.min(held[size], MAX_ROUND_LIMIT) : before[size]])) as Record<TicketSize, number>
      return { repository, limits }
    })
  }
}

/** Asks Tick-it for what the mod shares with it (get_mod_config): size budgets, review round defaults and the brief lines naming this ticket, kept as they were when it cannot say, and a notice for the person when this mod is too old, shown as a toast. */
export async function fetchModConfig($: EngineInterface, ticket: string): Promise<void> {
  // With the repository, Tick-it answers reviewRounds and reviewBudget for this ticket's size; a folder with no GitHub origin has none to give.
  const repository = await repositoryHere($)
  const got = await callTickit($, 'get_mod_config', { ...(repository === undefined ? {} : { repository }), key: ticket, modVersion: MOD_VERSION }).catch(() => ({ ok: false as const, why: 'unreachable' }))
  if (!got.ok) return
  const v = got.value as { sizeBudgets?: Record<string, unknown>; defaultReviewRounds?: Record<string, unknown>; briefLines?: Record<string, unknown>; notice?: unknown; reviewRounds?: unknown; reviewBudget?: unknown }
  // The server's word for a mod older than its minModVersion (null otherwise): shown before the rest is checked, since an old mod may not be able to read the rest.
  if (typeof v.notice === 'string' && v.notice.trim() !== '') $.ui.toast(`tick-it: ${v.notice.trim()}`)
  // Kept before the rest is checked: the ticket's limits stand even when the brief lines are unusable.
  const whole = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null)
  await update($, modLimits, () => ({ repository: repository ?? '', ticket, reviewRounds: whole(v.reviewRounds), reviewBudget: whole(v.reviewBudget) }))
  const budgets = v.sizeBudgets
  const lines = v.briefLines
  if (budgets === undefined || lines === undefined || !SIZES.every(size => typeof budgets[size] === 'number') || !['memories', 'memoryTools', 'deferredTools', 'done', 'branch'].every(k => typeof lines[k] === 'string') || !Array.isArray(lines.addToTicket)) return
  await storeServed($, { sizeBudgets: budgets as Record<TicketSize, number>, ticket, briefLines: { ...(lines as never as BriefLines), beforeReview: Array.isArray(lines.beforeReview) ? lines.beforeReview.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [], afterFix: typeof lines.afterFix === 'string' && lines.afterFix.trim() !== '' ? lines.afterFix : undefined, wake: typeof lines.wake === 'string' && lines.wake.trim() !== '' ? lines.wake : undefined } })
  const defaults = v.defaultReviewRounds
  if (defaults !== undefined && SIZES.every(size => typeof defaults[size] === 'number')) await update($, rounds, kept => (kept.repository === '' ? { repository: '', limits: defaults as Record<TicketSize, number> } : kept))
}

/** The review rounds a ticket of this size gets before the one past the limit, as of the last fetch. */
export async function roundLimit($: EngineInterface, size: TicketSize, ticket?: string): Promise<number> {
  // The rounds get_mod_config gave for this very ticket win; without a usable one the repository's settings and the defaults give the limit.
  const given = await heldLimits($, ticket)
  if (given?.reviewRounds != null) return Math.min(given.reviewRounds, MAX_ROUND_LIMIT)
  const held = await read($, rounds)
  return (sameRepository(held.repository, await repositoryHere($)) || held.repository === '' ? held.limits : DEFAULT_ROUNDS)[size]
}

/** What get_mod_config last gave for this ticket in this repository; undefined for any other ticket. */
async function heldLimits($: EngineInterface, ticket: string | undefined) {
  if (ticket === undefined) return undefined
  const held = await read($, modLimits)
  return held.ticket === ticket && sameRepository(held.repository, (await repositoryHere($)) ?? '') ? held : undefined
}

/** The review budget in whole dollars get_mod_config gave for this ticket's size, or null when the size has none (or Tick-it could not say). */
export async function reviewBudgetOf($: EngineInterface, ticket: string): Promise<number | null> {
  return (await heldLimits($, ticket))?.reviewBudget ?? null
}

/** Whether get_mod_config has been read for this ticket, so a round that begins for a ticket not taken here can read it. */
export async function hasModLimits($: EngineInterface, ticket: string): Promise<boolean> {
  return (await heldLimits($, ticket)) !== undefined
}

/** A ticket's brief with the repository's instructions, as of the last fetch. */
export async function briefOf($: EngineInterface, t: Ticket): Promise<string> {
  const held = await read($, attachments)
  return brief(t, await read($, tickets), await read($, instructions), held.ticket === t.id ? held.files : [], held.ticket === t.id ? held.memories : [], await servedConfig($), await heldDesign($), await reviewBudgetOf($, t.id), await roundLimit($, t.size, t.id))
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
