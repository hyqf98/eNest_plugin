import { attachRelationalMetadata } from '@backend/relationalMetadata'
import { adapterBase, withConnectionTest } from '@backend/adapterUtils'
import { attachRowEditing } from '@backend/rowChanges'
import type { DriverHandle } from '@backend/drivers'
import type { QueryResult } from '@backend/contracts/ssh-db'
import { normalizeLimit, sqlTokens, wireValue, ResultBudget } from '@backend/queryPolicy'

const driver = adapterBase('postgres', 'PostgreSQL', 'postgres', 5432)
driver.capabilities = { ...driver.capabilities, multiStatement: true, explain: true, schemas: true, updatableResult: true, ddl: true, import: true }
driver.open = async (config, password) => {
  const pg = await import('pg')
  const client = new pg.Client({ host: config.host, port: config.port ?? 5432, user: config.username, password, database: config.database,
    connectionTimeoutMillis: 10000, application_name: 'eNest',
    ssl: config.options?.ssl ? { rejectUnauthorized: config.options?.rejectUnauthorized !== false, ca: typeof config.options.ca === 'string' ? config.options.ca : undefined } : undefined,
    types: { getTypeParser(oid, format) { return [20, 1700, 1082, 1114, 1184].includes(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format) } } })
  try { await client.connect(); if (config.options?.readOnly) await client.query('SET default_transaction_read_only = on') }
  catch (error) { await client.end().catch(() => undefined); throw error }
  let result: import('pg').QueryResult
  try { result = await client.query('SELECT pg_backend_pid() AS pid') } catch (error) { await client.end(); throw error }
  const handle: DriverHandle = { id: config.driver, raw: client, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: { backendPid: result.rows[0].pid, transaction: false, activeCount: 0 } }
  client.on('error', () => { handle.closed = true })
  return handle
}
driver.cancel = async handle => {
  const pg = await import('pg')
  const control = new pg.Client({ host: handle.config.host, port: handle.config.port ?? 5432, user: handle.config.username, password: handle.password, database: handle.database,
    connectionTimeoutMillis: 5000, ssl: handle.config.options?.ssl ? { rejectUnauthorized: handle.config.options?.rejectUnauthorized !== false, ca: typeof handle.config.options.ca === 'string' ? handle.config.options.ca : undefined } : undefined })
  try { await control.connect(); const result = await control.query('SELECT pg_cancel_backend($1) AS cancelled', [handle.runtime?.backendPid]); return result.rows[0]?.cancelled === true }
  finally { await control.end() }
}
driver.execute = async (handle, sql, opts) => {
  const client = handle.raw as import('pg').Client, started = Date.now(), max = normalizeLimit(opts?.maxRows)
  opts?.signal?.throwIfAborted()
  let cancellation: Promise<unknown> | undefined
  const abort = () => { cancellation ||= driver.cancel!(handle).catch(() => undefined) }
  opts?.signal?.addEventListener('abort', abort, { once: true }); handle.runtime!.activeCount = 1
  try {
    if (/^(SELECT|WITH|VALUES)\b/i.test(sqlTokens(sql, false, 'postgres').trim())) {
      const { default: QueryStream } = await import('pg-query-stream')
      const stream = client.query(new QueryStream(sql, Array.isArray(opts?.params) ? opts.params : [], { batchSize: Math.min(max + 1, 128), rowMode: 'array' }))
      const rows: unknown[][] = []; const budget = new ResultBudget(); let truncated = false
      for await (const row of stream) { if (rows.length >= max) { truncated = true; break }; const safe = (row as unknown[]).map(wireValue); budget.add(safe); rows.push(safe) }
      const fields = (stream as unknown as { cursor: { _result: { fields: Array<{ name: string; dataTypeID: number }> } } }).cursor._result.fields
      return { sql, columns: fields.map(field => ({ name: field.name, dataType: String(field.dataTypeID) })), rows, rowCount: rows.length, truncated, durationMs: Date.now() - started }
    }
    const pg = await import('pg')
    return await new Promise<QueryResult>((resolve, reject) => {
      const rows: unknown[][] = [], budget = new ResultBudget(); let truncated = false, failure: unknown
      const query = new pg.Query({ text: sql, values: Array.isArray(opts?.params) ? opts.params : [], rowMode: 'array' } as import('pg').QueryConfig)
      query.on('row', row => { if (rows.length >= max) { truncated = true; return }; if (failure) return; try { const safe = (row as unknown[]).map(wireValue); budget.add(safe); rows.push(safe) } catch (error) { failure = error; abort() } })
      query.once('error', error => reject(failure || error))
      query.once('end', result => failure ? reject(failure) : resolve({ sql, columns: result.fields.map((field: import('pg').FieldDef) => ({ name: field.name, dataType: String(field.dataTypeID) })), rows, rowCount: rows.length, affectedRows: result.rowCount ?? undefined, truncated, durationMs: Date.now() - started }))
      client.query(query)
    })
  } finally { await cancellation; opts?.signal?.removeEventListener('abort', abort); handle.runtime!.activeCount = 0 }
}
driver.transaction = async (handle, operation) => {
  if ((operation === 'begin') === !!handle.runtime?.transaction) throw new Error(operation === 'begin' ? 'Transaction already active' : 'No active transaction')
  await (handle.raw as import('pg').Client).query(operation.toUpperCase()); handle.runtime!.transaction = operation === 'begin'
}
driver.close = async handle => { await (handle.raw as import('pg').Client).end(); handle.closed = true }
driver.explain = (handle, sql) => driver.execute(handle, `EXPLAIN ${sql}`)
const inspections: Partial<Record<string, string>> = {
  sessions: 'SELECT pid, usename, datname, application_name, client_addr::text, state, wait_event_type, wait_event, query_start, query FROM pg_stat_activity',
  resources: 'SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, deadlocks FROM pg_stat_database',
  locks: 'SELECT a.pid, a.query, a.wait_event, pg_blocking_pids(a.pid)::text AS blocked_by FROM pg_stat_activity a WHERE cardinality(pg_blocking_pids(a.pid)) > 0',
  queries: 'SELECT query, calls, total_exec_time, rows FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 100'
}
driver.inspect = async (handle, kind, signal) => inspections[kind] ? driver.execute(handle, inspections[kind]!, { signal, maxRows: 500 }) : undefined
attachRelationalMetadata(driver, 'postgres')
attachRowEditing(driver, 'postgres')
export default withConnectionTest(driver)
