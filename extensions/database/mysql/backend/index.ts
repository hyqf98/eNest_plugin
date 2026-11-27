import { attachRelationalMetadata } from '@backend/relationalMetadata'
import { adapterBase, withConnectionTest } from '@backend/adapterUtils'
import { attachRowEditing } from '@backend/rowChanges'
import type { DbDriver, DriverHandle } from '@backend/drivers'
import type { QueryResult } from '@backend/contracts/ssh-db'
import { normalizeLimit, isReadQuery, sqlTokens, wireValue, ResultBudget } from '@backend/queryPolicy'

interface MysqlRuntime { session?: import('mysql2/promise').PoolConnection; lease?: import('mysql2/promise').PoolConnection; active?: import('mysql2/promise').PoolConnection; transaction?: boolean; created: number; activeCount: number }
function mysqlRuntime(h: DriverHandle): MysqlRuntime { return h.runtime as unknown as MysqlRuntime }

/** Fixed transaction lease, bounded streaming and actual protocol cancellation. */
function upgradeMysql(base: DbDriver): DbDriver {
  const driver: DbDriver = { ...base }
  driver.open = async (config, password) => {
    const mysql = await import('mysql2/promise')
    const pool = mysql.createPool({ host: config.host, port: config.port ?? 3306, user: config.username, password, database: config.database,
      connectionLimit: Math.max(1, Math.min(20, Number(config.options?.poolSize) || 5)), waitForConnections: true, queueLimit: 100,
      connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false,
      ssl: config.options?.ssl ? { rejectUnauthorized: config.options?.rejectUnauthorized !== false, ca: typeof config.options.ca === 'string' ? config.options.ca : undefined } : undefined })
    const runtime: MysqlRuntime = { created: 0, activeCount: 0 }
    pool.on('connection', () => runtime.created++)
    try { runtime.session = await pool.getConnection(); await runtime.session.query('SELECT 1') } catch (error) { runtime.session?.release(); await pool.end(); throw error }
    const handle: DriverHandle = { id: config.driver, raw: pool, config, password, database: config.database, readOnly: !!config.options?.readOnly, runtime: runtime as unknown as Record<string, unknown> }
    // A console owns its SQL session, including temporary objects, variables and transactions.
    runtime.session.connection.on('error', () => { handle.closed = true })
    return handle
  }
  driver.cancel = async h => {
    const active = mysqlRuntime(h).active
    if (!active) return false
    const mysql = await import('mysql2/promise')
    const control = await mysql.createConnection({ host: h.config.host, port: h.config.port ?? 3306, user: h.config.username, password: h.password, connectTimeout: 5000,
      ssl: h.config.options?.ssl ? { rejectUnauthorized: h.config.options?.rejectUnauthorized !== false, ca: typeof h.config.options.ca === 'string' ? h.config.options.ca : undefined } : undefined })
    try { await control.query(`KILL QUERY ${Number(active.threadId)}`); return true } finally { await control.end() }
  }
  driver.execute = async (h, sql, opts) => {
    opts?.signal?.throwIfAborted()
    const runtime = mysqlRuntime(h), conn = runtime.session!
    runtime.active = conn; runtime.activeCount++
    const started = Date.now(), max = normalizeLimit(opts?.maxRows)
    let cancelledForLimit = false, cancellation: Promise<unknown> | undefined
    const canStopAtLimit = isReadQuery(sql, 'mysql')
    let refreshTransaction = /^(?:CALL\b|(?:[\w$]+\s*:\s*)?BEGIN\b)/i.test(sqlTokens(sql, false, 'mysql').trim())
    const stop = () => cancellation ||= driver.cancel!(h)
    const abort = () => { void stop().catch(() => { conn.destroy(); h.closed = true }) }
    opts?.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (h.readOnly && !runtime.transaction) await conn.query('SET SESSION TRANSACTION READ ONLY')
      // Retain each CALL recordset independently. A display row limit must never cancel
      // the remainder of a procedure (which may contain writes after its first SELECT).
      return await new Promise<QueryResult>((resolve, reject) => {
        const results: QueryResult[] = [], budget = new ResultBudget()
        let current: QueryResult | undefined, failure: unknown
        const query = (conn.connection as unknown as import('mysql2').PoolConnection).query({ sql, rowsAsArray: true }, Array.isArray(opts?.params) ? opts.params : [])
        query.on('fields', (fields: import('mysql2').FieldPacket[] | undefined) => {
          current = { sql, columns: (fields || []).map(field => ({ name: field.name, dataType: String(field.type) })), rows: [], rowCount: 0, durationMs: 0 }
          results.push(current)
        })
        query.on('result', (row: unknown) => {
          if (failure || !current) return
          if (Array.isArray(row)) {
            if (current.rows.length < max) {
              try { const safe = row.map(wireValue); budget.add(safe); current.rows.push(safe); current.rowCount++ }
              catch (error) { failure = error; void stop().catch(reject) }
            } else {
              current.truncated = true
              if (canStopAtLimit && !cancelledForLimit) { cancelledForLimit = true; void stop().catch(reject) }
            }
          } else if (row && typeof row === 'object' && 'affectedRows' in row) {
            current.affectedRows = Number(row.affectedRows)
            // MySQL OK packets report transaction status after CALL/DDL and implicit commits.
            if ('serverStatus' in row) runtime.transaction = !!(Number(row.serverStatus) & 1)
          }
        })
        const result = (): QueryResult => {
          for (const item of results) item.durationMs = Date.now() - started
          const first = results[0] || { sql, columns: [], rows: [], rowCount: 0, durationMs: Date.now() - started }
          return { ...first, ...(results.length > 1 ? { results } : {}) }
        }
        query.once('end', () => failure ? reject(failure) : resolve(result()))
        query.once('error', (error: Error & { code?: string }) => { if (failure) reject(failure); else if (cancelledForLimit && !opts?.signal?.aborted && ['ER_QUERY_INTERRUPTED', 'ER_QUERY_TIMEOUT'].includes(String(error.code))) resolve(result()); else reject(error) })
      })
    } catch (error) { refreshTransaction = true; throw error }
    finally {
      await cancellation?.catch(() => undefined)
      opts?.signal?.removeEventListener('abort', abort); runtime.active = undefined; runtime.activeCount--
      // A failed CALL can leave a transaction open without sending its final OK packet.
      // A no-op produces an authoritative status packet on the same pinned session.
      if (refreshTransaction && !h.closed) {
        try { const [status] = await conn.query<import('mysql2').ResultSetHeader>({ sql: 'DO 0', timeout: 2000 }); runtime.transaction = !!(status.serverStatus & 1) }
        catch { h.closed = true; conn.destroy(); throw new Error('MySQL transaction state is unavailable; reconnect this console') }
      }
    }
  }
  driver.transaction = async (h, operation) => {
    const runtime = mysqlRuntime(h)
    if (operation === 'begin') {
      if (runtime.transaction) throw new Error('Transaction already active')
      const conn = runtime.session!
      try { if (h.readOnly) await conn.query('SET SESSION TRANSACTION READ ONLY'); await conn.beginTransaction(); runtime.lease = conn; runtime.transaction = true }
      catch (error) { throw error }
    } else {
      if (!runtime.transaction) throw new Error('No active transaction')
      if (operation === 'commit') await runtime.session!.commit(); else await runtime.session!.rollback()
      runtime.lease = undefined; runtime.transaction = false
    }
  }
  driver.close = async h => { try { if (mysqlRuntime(h).transaction) await driver.transaction!(h, 'rollback') } finally { mysqlRuntime(h).session?.release(); await (h.raw as import('mysql2/promise').Pool).end(); h.closed = true } }
  driver.explain = (h, sql) => driver.execute(h, `EXPLAIN ${sql}`)
  attachRelationalMetadata(driver, 'mysql')
  return driver
}

const base = adapterBase('mysql', 'MySQL', 'mysql', 3306)
base.capabilities = { ...base.capabilities, multiStatement: true, explain: true, updatableResult: true, ddl: true, import: true }
const driver = upgradeMysql(base)
const inspections: Partial<Record<string, string>> = {
  sessions: 'SHOW FULL PROCESSLIST',
  resources: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Connections','Questions','Bytes_received','Bytes_sent','Uptime','Innodb_buffer_pool_bytes_data')",
  locks: 'SELECT * FROM performance_schema.data_lock_waits LIMIT 200',
  queries: 'SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, SUM_ROWS_EXAMINED FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT 100'
}
driver.inspect = async (handle, kind, signal) => inspections[kind] ? driver.execute(handle, inspections[kind]!, { signal, maxRows: 500 }) : undefined
attachRowEditing(driver, 'mysql')
export default withConnectionTest(driver)
