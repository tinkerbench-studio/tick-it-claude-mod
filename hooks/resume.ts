import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ResumeState, Steward } from '../types'
import { RESUME_KEY } from './state'
import { repositoryHere } from './tickit'

// Declared in this file: the engine reads an atom only where it is written (a module cannot use one imported from state.ts).
const current = atom({ plugin: 'tick-it', key: 'current' } as const, null)
const baseCommit = atom({ plugin: 'tick-it', key: 'baseCommit' } as const, null)
const steward = atom({ plugin: 'tick-it', key: 'steward' } as const, null)
const reviewNext = atom({ plugin: 'tick-it', key: 'reviewNext' } as const, null)
const startedSession = atom({ plugin: 'tick-it', key: 'started' } as const, null)
/** A resumed session whose started session came back with no taken ticket and no stewarding: it reports for itself. */
const resumeUntaken = atom({ plugin: 'tick-it', key: 'resumeUntaken' } as const, false)

/** Keeps the taken ticket, its base commit and the stewarding in the store beside the started session, stamped with the Claude Code session and the repository; called wherever one of them changes. A session Tick-it did not start has no repository to stamp until it takes a ticket, and a failed write leaves the session as it was. */
export async function saveResume($: EngineInterface): Promise<void> {
  try {
    const repository = await repositoryHere($)
    if (repository === undefined) return
    const state: ResumeState = { claudeSession: await $.session.id(), repository, current: await read($, current), baseCommit: await read($, baseCommit), steward: await read($, steward), reviewNext: await read($, reviewNext) }
    // Once a ticket is taken the session is the mod's to report for, whatever becomes of that ticket afterwards.
    if (state.current !== null || state.steward !== null || state.reviewNext !== null) await update($, resumeUntaken, () => false)
    await $.store.set(RESUME_KEY, state)
  } catch {
    // Nothing to resume from is not worse than before.
  }
}

/** At session.start, after the started session: puts the saved ticket, base commit and stewarding back into the session they belong to (same Claude Code session id, same repository), and into no other. */
export async function restoreResume($: EngineInterface): Promise<void> {
  const started = await read($, startedSession)
  const saved = (await $.store.get(RESUME_KEY)) as ResumeState | null | undefined
  const mine = typeof saved === 'object' && saved !== null && saved.claudeSession === (await $.session.id()) && saved.repository === (await repositoryHere($))
  if (mine) {
    if (typeof saved.current === 'string' && (await read($, current)) === null) await update($, current, () => saved.current)
    if (typeof saved.baseCommit === 'string' && (await read($, baseCommit)) === null) await update($, baseCommit, () => saved.baseCommit)
    if (typeof saved.reviewNext === 'string' && (await read($, reviewNext)) === null) await update($, reviewNext, () => saved.reviewNext)
    // Its reviewers belonged to the old process and no agent is left to answer: restored as fixing, one round back, so the turn's end starts that same round again (a fixing steward at round r starts round r + 1).
    const held = saved.steward
    if (typeof held === 'object' && held !== null && (await read($, steward)) === null) await update($, steward, () => (held.phase === 'reviewing' ? { ...held, phase: 'fixing' as const, round: Math.max(0, held.round - 1) } : held) as Steward)
  }
  const restored = mine && (typeof saved.current === 'string' || (typeof saved.steward === 'object' && saved.steward !== null) || typeof saved.reviewNext === 'string')
  await update($, resumeUntaken, () => started !== null && !restored)
}

/** Whether this session was resumed with its started session but no taken ticket or stewarding, so its own record_runs and report_session calls are let through. */
export async function resumedUntaken($: EngineInterface): Promise<boolean> {
  return (await read($, resumeUntaken)) && (await read($, current)) === null && (await read($, steward)) === null && (await read($, reviewNext)) === null
}
