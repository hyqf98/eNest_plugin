/** Shared shapes between the Anything backend and its renderer. */

export type SearchSort = 'relevance' | 'name' | 'mtime' | 'size'

export interface FileInfo {
  path: string
  name: string
  dir: string
  ext: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface SearchOptions {
  directory?: string
  limit?: number
  offset?: number
  sort?: SearchSort
  everythingPort?: number
  everythingAuth?: string
}

export interface SearchResult {
  results: FileInfo[]
  provider: string
  /** total known hits when the engine reports it, otherwise the collected window */
  total: number
  collected: number
  truncated: boolean
  elapsedMs: number
}

export interface ProviderStatus {
  id: string
  label: string
  available: boolean
  detail: string
}

export interface ProvidersReport {
  platform: string
  providers: ProviderStatus[]
  active: string | null
}
