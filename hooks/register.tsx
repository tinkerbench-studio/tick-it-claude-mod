import type { Register } from 'claude-code'

import { registerCommand } from './command'
import { registerSession } from './session-hooks'
import { registerTools } from './tool-hooks'
import { registerTurn } from './turn'
import { registerUi } from './ui'

export { AGENTS_TOOL, BREAKDOWN_LINE, BUDGET, DEFAULT_ROUNDS, PRICES, RECORD_TOOL, REPORT_TOOL, START_LINE, TICKIT_CONNECTORS, TICKIT_SERVER } from './state'
export * from './board'
export * from './tickit'
export * from './work'
export * from './reviews'
export * from './outbox'
export * from './security-areas'

export const register: Register = on => {
  registerSession(on)
  registerCommand(on)
  registerTools(on)
  registerTurn(on)
  registerUi(on)
}
