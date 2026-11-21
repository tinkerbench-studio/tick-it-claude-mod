// The one reading of a UI path, shared by the `/tick-it done` gate (hooks/ui-evidence.ts) and the evidence script
// (scripts/ui-evidence-check.mjs). Plain JavaScript with no imports, so the script runs with node alone.


/** A glob ("**" crosses folders, "*" and "?" stay in one) as a regular expression on a whole path. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * A path matches one of the repository's design.uiPaths globs. With none, no path is a UI path: Tick-it assumes no
 * layout or design process of its own, so a repository opts in by setting design.uiPaths in .tick-it/config.json.
 */
export const isUiPath = (path, uiPaths) => uiPaths.some(g => globToRegExp(g).test(path))

/** A file whose change can be test-only: a story (its play function asserts) or the Storybook configuration (its test settings). A stylesheet or a design file never is. */
export const TESTABLE_UI_FILE = /(^|\/)\.storybook\/|\.stories\.tsx?$/

/**
 * A changed line that only tests: blank, a comment, an import from Storybook's test package, or a line that waits, asserts, queries or
 * types (waitFor, expect, findBy/getBy/queryBy/findAllBy…, userEvent, within, configure, asyncUtilTimeout, a play function's await of one).
 * Anything else (an export, args, JSX, a style) is not: a change with one such line is a change to what a person sees.
 */
const TEST_LINE = /^\s*(?:$|\/\/|\/\*|\*|import\b.*['"]storybook\/test['"]|.*\b(?:waitFor|waitForElementToBeRemoved|expect|findBy\w+|findAllBy\w+|getBy\w+|getAllBy\w+|queryBy\w+|queryAllBy\w+|userEvent|within|fireEvent|configure|asyncUtilTimeout)\b)/

/**
 * True when a change to a story or to .storybook/ changes only lines that test (see TEST_LINE), so it needs no pictures.
 * lines: the added and removed lines of the file, one per line, without their +/- markers. A file that is not a story, or
 * with no lines to read (a binary, a rename with no change), is never test-only: it counts as the UI path it is.
 */
export function isTestOnlyChange(path, lines) {
  if (!TESTABLE_UI_FILE.test(path) || lines === undefined || lines === '') return false
  return lines.split('\n').every(line => TEST_LINE.test(line))
}

/** The added and removed lines of each file of a `git diff -U0` patch, as a Map from path (after the change; before it for a deletion) to its lines, one per line without the markers. */
export function patchLines(patch) {
  const files = new Map()
  let from = ''
  let current
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      from = ''
    } else if (line.startsWith('--- ')) from = line.slice(4).replace(/^a\//, '')
    else if (line.startsWith('+++ ')) {
      const to = line.slice(4).replace(/^b\//, '')
      const path = to === '/dev/null' ? from : to
      current = path !== '' && path !== '/dev/null' ? path : undefined
      if (current !== undefined) files.set(current, [])
    } else if (current !== undefined && (line.startsWith('+') || line.startsWith('-'))) files.get(current).push(line.slice(1))
  }
  return new Map([...files].map(([path, lines]) => [path, lines.join('\n')]))
}
