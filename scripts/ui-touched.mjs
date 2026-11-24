// The stories and pages a change touches, and the ones with no picture: shared by the `/tick-it done` gate
// (hooks/ui-check.ts) and scripts/ui-evidence-check.mjs. Plain JavaScript with no imports at all (a hooks module may import nothing
// but its own files), so it reads files through the `fs` it is given: { exists, read, list } as async functions on repository-relative paths.
// Layout read (a repository without these files has nothing touched, so nothing is refused): stories in
// apps/web/src/design/*.stories.tsx, pages as the PAGES of scripts/page-shots.mjs, drawn through apps/web/src/render.tsx
// (`home` entries through apps/web/src/design/page-examples.tsx), and .storybook/preview.ts, whose imports style every story.
// A story or page is touched when a changed file is in the import closure of its entry. Modelled on tinkerbench-studio/tick-it#TCK-1653's scripts/ui-touched.mjs.

/** A repository-relative path from a folder and a relative import: "a/b" + "../c" is "a/c". */
const join = (...parts) => {
  const out = []
  for (const seg of parts.join('/').split('/')) {
    if (seg === '..') out.pop()
    else if (seg !== '' && seg !== '.') out.push(seg)
  }
  return out.join('/')
}
const dirname = path => path.split('/').slice(0, -1).join('/')

export const VARIANTS = ['dark', 'light', 'phone']
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '/index.ts', '/index.tsx']
const IMPORT = /(?:from|import)\s*['"](\.[^'"]+)['"]/g
const SRC = 'apps/web/src'

/** Every file `entry` imports (relative imports only), itself included. Paths are relative to the repository root. */
export async function closure(fs, entry) {
  const seen = new Set()
  const walk = async file => {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.(tsx?|mjs)$/.test(file)) return
    for (const [, spec] of (await fs.read(file)).matchAll(IMPORT)) {
      const base = join(dirname(file), spec)
      for (const ext of EXTENSIONS) {
        // A folder of the same name (pages/ beside pages.tsx) is no file: `exists` may be true for one, as the gate's $.fs.exists is.
        if (!(await fs.exists(base + ext)) || (await fs.list(base + ext)).length > 0) continue
        await walk(base + ext)
        break
      }
    }
  }
  if (await fs.exists(entry)) await walk(entry)
  return seen
}

// Storybook's own sanitize on a title, and its startCase on an export name (PriorityMarkerSheet is priority-marker-sheet).
const sanitize = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()

/** The stories of a story file as Storybook ids (`pages-priority-marker--priority-marker-sheet`), from its title and exports. */
export function storyIds(source) {
  const title = /title:\s*['"]([^'"]+)['"]/.exec(source)?.[1]
  if (!title) return []
  return [...source.matchAll(/^export const (\w+)/gm)].map(m => `${title.split('/').map(sanitize).join('-')}--${kebab(m[1])}`)
}

/** The PAGES entries of scripts/page-shots.mjs, read as text (nothing is run): `{ name: { home?: true } }`. A name is a top-level key of the PAGES literal or a `PAGES['name'] =` assignment. */
export function pagesOf(source) {
  const pages = {}
  const body = /export const PAGES = \{\n([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  for (const line of body.split('\n')) {
    const m = /^ {2}(?:'([^']+)'|(\w[\w-]*)):/.exec(line)
    if (m) pages[m[1] ?? m[2]] = /\bhome:\s*true\b/.test(line) ? { home: true } : {}
  }
  for (const m of source.matchAll(/^PAGES\[['"]([^'"]+)['"]\]\s*=.*$/gm)) pages[m[1]] = /\bhome:\s*true\b/.test(m[0]) ? { home: true } : {}
  for (const m of source.matchAll(/^for \(const \w+ of .*\) PAGES\[`([^`$]+)\$\{/gm)) pages[m[1]] ??= {}
  return pages
}

/** The stories and pages `changed` (repository-relative paths) touches in a repository read through `fs`. */
export async function touched({ fs, changed }) {
  const set = new Set(changed.map(f => join(f)))
  const hits = async entry => [...(await closure(fs, entry))].some(f => set.has(f))
  const styled = await hits('.storybook/preview.ts')
  const render = await hits(`${SRC}/render.tsx`)
  const homeDraws = await hits(`${SRC}/design/page-examples.tsx`)
  const stories = []
  for (const name of (await fs.list(`${SRC}/design`)).filter(n => n.endsWith('.stories.tsx'))) {
    const file = `${SRC}/design/${name}`
    if (styled || (await hits(file))) stories.push(...storyIds(await fs.read(file)).map(id => ({ id, file })))
  }
  const pages = (await fs.exists('scripts/page-shots.mjs')) ? pagesOf(await fs.read('scripts/page-shots.mjs')) : {}
  const names = Object.keys(pages).filter(n => !(n.endsWith('-phone') && pages[n.slice(0, -6)]))
  return { stories, pages: names.filter(n => (pages[n].home ? homeDraws : render)) }
}

/** The touched stories and pages with no picture: each needs `-dark`, `-light` and `-phone` (a page as `<page>-<variant>`, a story as `story-<id>-<variant>`), each with or without `-before-after`. `pictures` are file names or keys. */
export function uncovered(found, pictures) {
  const names = new Set(pictures.map(p => p.replace(/^.*\//, '').replace(/\.(png|jpe?g|gif|webp)$/i, '')))
  const has = (base, v) => names.has(`${base}-${v}`) || names.has(`${base}-${v}-before-after`)
  const all = base => VARIANTS.every(v => has(base, v))
  return { pages: found.pages.filter(p => !all(p)), stories: found.stories.filter(s => !all(`story-${s.id}`)) }
}

/** One line per page or story with no picture, naming it and the pictures it needs. */
export const uncoveredLines = missing => [
  ...missing.pages.map(p => `page ${p} has no confirmed picture (needs ${p}-dark, ${p}-light, ${p}-phone)`),
  ...missing.stories.map(s => `story ${s.id} (${s.file}) has no confirmed picture (needs story-${s.id}-dark, -light, -phone)`),
]
