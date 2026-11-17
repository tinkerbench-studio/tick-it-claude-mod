// The one reading of a UI path, shared by the `/tick-it done` gate (hooks/ui-evidence.ts) and the evidence script
// (scripts/ui-evidence-check.mjs). Plain JavaScript with no imports, so the script runs with node alone.

/**
 * Paths a ticket that changes what a person sees touches when a repository sets no design.uiPaths: the web app's pages and components
 * (not its server code or tests), the design system or canvas, a story or a stylesheet. A path may follow a space, a quote, a bracket, "./" or a directory.
 */
export const DEFAULT_UI_PATH = /(^|[^\w-])apps\/web\/src\/(design\/|(pages|client|links|markdown|pictures|render|style|dropzone)\.tsx?\b)|(?<![\w-]|docs\/)design\/|\.storybook\/|[\w./-]*\.stories\.tsx?\b|[\w./-]*\.css(\.ts)?(?![\w-])/

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
