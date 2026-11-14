import type { EngineInterface } from 'claude-code'

/** Most to least urgent: a level logs itself and every level before it. */
export const LEVELS = ['error', 'warn', 'info', 'debug'] as const
export type Level = (typeof LEVELS)[number]
/** What logs when TICK_IT_LOG is unset or not a level: errors and warnings only. */
export const DEFAULT_LEVEL: Level = 'warn'
/** The one setting: the level, as an environment variable. */
export const LEVEL_VAR = 'TICK_IT_LOG'
/** Where lines go; unset, the file below in the temporary directory. */
export const FILE_VAR = 'TICK_IT_LOG_FILE'
export const DEFAULT_FILE = 'tick-it-mod.log'
/** The file keeps this many of the newest lines. */
export const KEEP_LINES = 1000

export const levelOf = (value: unknown): Level => LEVELS.find(l => l === (typeof value === 'string' ? value.trim().toLowerCase() : value)) ?? DEFAULT_LEVEL

/** Only ids, states and reasons are logged: a field that is not a short token (a title, comment, path or file's text has spaces or is long) is replaced, never written. */
const SAFE = /^[A-Za-z0-9_.:#/,-]{1,100}$/
export const cleanField = (value: unknown): string | number | boolean => (typeof value === 'number' || typeof value === 'boolean' ? value : typeof value === 'string' && SAFE.test(value) ? value : '<omitted>')

/** One line: `<time> <level> <event> key=value ...`, where the values are ids, states and reasons (never tokens, ticket text, file contents or environment values: callers pass none, and cleanField drops what is not a short token). */
export const lineOf = (at: number, level: Level, event: string, fields: Record<string, unknown>): string =>
  [new Date(at).toISOString(), level, event, ...Object.entries(fields).map(([k, v]) => `${k}=${cleanField(v)}`)].join(' ')

/** Logs an event at a level when the setting allows it. Never throws: a log that cannot be written must not stop the mod. */
export async function log($: EngineInterface, level: Level, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  try {
    const set = levelOf(await $.env.get('TICK_IT_LOG'))
    if (LEVELS.indexOf(level) > LEVELS.indexOf(set)) return
    const file = (await $.env.get('TICK_IT_LOG_FILE')) || `${(await $.env.get('TMPDIR')) || '/tmp'}/${DEFAULT_FILE}`
    // The engine writes whole files: the file's last lines are kept, and this one added.
    const before = (await $.fs.exists(file)) ? (await $.fs.read(file)).split('\n').filter(l => l !== '') : []
    await $.fs.write(file, `${[...before, lineOf(await $.clock.now(), level, event, fields)].slice(-KEEP_LINES).join('\n')}\n`)
  } catch {
    // Nothing to tell: the log is how the mod tells.
  }
}
