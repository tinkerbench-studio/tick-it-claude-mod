import { globToRegExp } from '../scripts/ui-paths.mjs'

/** A picture a UI change must carry when it touches one of `when`'s globs: a confirmed screenshot whose name matches the glob `name`; `why` says how to make it. */
export type PictureRule = { when: readonly string[]; name: string; why?: string }

/**
 * What a repository says about its UI changes, from the design section of its .tick-it/config.json (as
 * get_repository_settings gives it in config): the globs of what a person sees, the acceptance lines its UI tickets
 * carry, the pictures some changes must carry, and its design workflow doc. The mod assumes no design tool or process of
 * its own: null (no design.uiPaths) means no change is a UI change.
 */
export type Design = { uiPaths: readonly string[]; checklist: readonly string[]; pictures: readonly PictureRule[]; workflow: string | null }

/** The path-like words of a text: split at spaces, quotes, brackets and commas, with a leading "./" and trailing punctuation dropped. */
const wordsOf = (text: string): string[] => text.split(/[\s"'`()[\],;<>]+/).map(w => w.replace(/^\.\//, '').replace(/[.:]+$/, '')).filter(w => w !== '')

/**
 * True when the text (file paths, or a ticket's title, description and acceptance) names one of the repository's UI
 * paths: a word of the text matching one of its design.uiPaths globs. Never with no design: the repository sets none.
 * Words alone ("page", "board") do not count.
 */
export const touchesUi = (text: string, design: Design | null = null): boolean => {
  if (design === null || design.uiPaths.length === 0) return false
  const globs = design.uiPaths.map(globToRegExp)
  // Each line whole first (the gate passes one changed path a line, and a path may hold brackets or parentheses, as Next.js routes do), then the words of prose.
  return [...text.split('\n').map(l => l.trim()), ...wordsOf(text)].some(w => w !== '' && globs.some(g => g.test(w)))
}

/** True when the criteria already carry a checklist (any line beginning "UI evidence:", the convention a repository's checklist lines follow). */
export const hasUiEvidence = (acceptance: readonly string[]): boolean => acceptance.some(a => a.startsWith('UI evidence:'))

/** The criteria with the repository's design.checklist added when the ticket touches its UI paths and carries none of it; unchanged otherwise, and always with no checklist. */
export const withUiEvidence = (acceptance: readonly string[], text = acceptance.join('\n'), design: Design | null = null): string[] =>
  design !== null && design.checklist.length > 0 && touchesUi(text, design) && !hasUiEvidence(acceptance) ? [...acceptance, ...design.checklist] : [...acceptance]
