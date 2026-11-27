import type { HostDbConnectionConfig as DbConnectionConfig } from '@backend/hostDbConfig'
/** Database driver contract and lazy native adapter registry. Runs only in dbUtility. */
import type {
  BatchResult,
  CompletionCatalog,
  CompletionResponse,
  DbCompletionInput,
  DbDriverId,
  DbTestResult,
  QueryResult,
  RowChange,
  SchemaObject,
  TableDetail
} from '@backend/contracts/ssh-db'
import type { DbInspectionKind } from '@backend/contracts/db-workbench'

export interface DriverHandle {
  id: DbDriverId
  /** mysql2 pool / pg Client / DatabaseSync / null for http */
  raw: unknown
  config: DbConnectionConfig
  readOnly: boolean
  password?: string
  database?: string
  runtime?: Record<string, unknown>
  closed?: boolean
  controller?: AbortController
}

export interface DriverExecuteOptions {
  maxRows?: number
  timeoutMs?: number
  params?: unknown[] | Record<string, unknown>
  signal?: AbortSignal
  executionId?: string
}

export interface DbDriver {
  id: DbDriverId
  label: string
  dialect: string
  defaultPort?: number
  capabilities: {
    multiStatement: boolean
    explain: boolean
    schemas: boolean
    timeSeries: boolean
    fileBased: boolean
    updatableResult: boolean
    ddl: boolean
    import: boolean
  }
  test(config: DbConnectionConfig, password?: string): Promise<DbTestResult>
  open(config: DbConnectionConfig, password?: string): Promise<DriverHandle>
  close(h: DriverHandle): Promise<void>
  execute(
    h: DriverHandle,
    sql: string,
    opts?: DriverExecuteOptions
  ): Promise<QueryResult>
  cancel?(h: DriverHandle, executionId?: string): Promise<boolean>
  transaction?(h: DriverHandle, operation: 'begin' | 'commit' | 'rollback'): Promise<void>
  explain?(h: DriverHandle, sql: string): Promise<QueryResult>
  listDatabases(h: DriverHandle): Promise<string[]>
  listSchemas(h: DriverHandle, database?: string): Promise<string[]>
  listTables(h: DriverHandle, scope: { database?: string; schema?: string }): Promise<SchemaObject[]>
  describeTable(
    h: DriverHandle,
    scope: { database?: string; schema?: string },
    table: string
  ): Promise<TableDetail>
  getDdl?(h: DriverHandle, scope: { database?: string; schema?: string }, table: string): Promise<string>
  completionCatalog(
    h: DriverHandle,
    scope: { database?: string; schema?: string }
  ): Promise<CompletionCatalog>
  complete?(input: DbCompletionInput, catalog: CompletionCatalog | null): CompletionResponse | undefined
  inspect?(h: DriverHandle, kind: DbInspectionKind, signal: AbortSignal): Promise<QueryResult | undefined>
  isViewWrite?(viewId: string, operation: string): boolean | undefined
  invokeView?(h: DriverHandle, viewId: string, operation: string, input: unknown, signal: AbortSignal, viewToken: string): Promise<unknown>
  releaseView?(h: DriverHandle, viewToken: string): Promise<void>
  applyBatch?(h: DriverHandle, changes: RowChange[], mode: 'stop-on-error' | 'continue'): Promise<BatchResult>
}
