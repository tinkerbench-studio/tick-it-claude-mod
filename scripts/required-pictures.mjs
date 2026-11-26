// The pictures a repository's design tool says a change needs: the command in design.requiredPictures of its
// .tick-it/config.json ({ command: [argv], why? }) is run with the changed paths one per line on stdin and prints
// { "touched": [{ "kind": "story"|"page", "id", "file" }], "required": [{ "for": "<id>", "name": "<base>-<variant>" }] }.
// The mod assumes no design tool or path: it runs the command and checks the uploads against what it lists.
// Shared by the gate (hooks/ui-check.ts) and scripts/ui-evidence-check.mjs.

/** How long the command may run before the gate counts it as one that could not run. */
export const REQUIRED_TIMEOUT_MS = 60_000

const text = v => typeof v === 'string' && v !== ''

/** The command's output as the contract, or an Error saying what is wrong with it. */
export function parseRequired(output) {
  let raw
  try {
    raw = JSON.parse(output)
  } catch {
    throw new Error('its output is not JSON')
  }
  const list = (v, keys) => Array.isArray(v) && v.every(e => e !== null && typeof e === 'object' && keys.every(k => text(e[k])))
  if (raw === null || typeof raw !== 'object' || !list(raw.touched, ['kind', 'id', 'file']) || !list(raw.required, ['for', 'name']) || !raw.touched.every(t => t.kind === 'story' || t.kind === 'page'))
    throw new Error('its output is not { touched: [{ kind, id, file }], required: [{ for, name }] }')
  return { touched: raw.touched, required: raw.required }
}

export const commandText = command => command.join(' ')

/** The required entries no picture covers: a picture covers a name as it is, with -before-after, or as a -before and an -after pair. */
export function uncovered(required, pictures) {
  const have = new Set(pictures.map(p => p.replace(/\.(png|jpe?g|gif|webp)$/i, '')))
  return required.filter(({ name }) => !(have.has(name) || have.has(`${name}-before-after`) || (have.has(`${name}-before`) && have.has(`${name}-after`))))
}

/** One line a touched story or page with missing pictures: the story or page, and each name it lacks. */
export function uncoveredLines(missing, touched = []) {
  const forId = [...new Set(missing.map(m => m.for))]
  return forId.map(id => {
    const one = touched.find(t => t.id === id)
    return `${one ? `${one.kind} ${id} (${one.file})` : id} has no confirmed picture (needs ${missing.filter(m => m.for === id).map(m => m.name).join(', ')})`
  })
}
