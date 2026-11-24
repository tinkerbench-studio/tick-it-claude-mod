export type Found = { stories: { id: string; file: string }[]; pages: string[] }
export type Fs = { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; list(path: string): Promise<string[]> }
export const VARIANTS: string[]
export function closure(fs: Fs, entry: string): Promise<Set<string>>
export function storyIds(source: string): string[]
export function pagesOf(source: string): Record<string, { home?: true }>
export function touched(input: { fs: Fs; changed: readonly string[] }): Promise<Found>
export function uncovered(found: Found, pictures: readonly string[]): Found
export function uncoveredLines(missing: Found): string[]
