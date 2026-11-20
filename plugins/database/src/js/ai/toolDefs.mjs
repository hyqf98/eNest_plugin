/**
 * toolDefs — AI 助手的 OpenAI function 工具定义
 * name 为 db_* 下划线形式（宿主 MCP 点号 id 不能直接作 function name），
 * 映射规则见 toolIdOf：db_query -> query、db_connections_list -> connections.list。
 * inputSchema 与 plugin.json contributes.mcpTools 逐一内联同构——修改 manifest 时
 * 必须同步维护这里（去掉 $defs，tableRef 直接展开为内联对象）。
 * 注意：刻意排除 connection.save——AI 会话不创建/改写连接配置，凭据与文件句柄
 * 授权必须走插件界面表单。
 */

const tableRefSchema = {
  type: 'object',
  properties: {
    database: { type: 'string', maxLength: 128 },
    schema: { type: 'string', maxLength: 128 },
    table: { type: 'string', minLength: 1, maxLength: 128 }
  },
  required: ['table'],
  additionalProperties: false
}

/** db_* 工具名 -> execTool id（驼峰 id 的下划线形式，显式映射避免歧义） */
const NAME_TO_ID = {
  db_connections_list: 'connections.list',
  db_connection_open: 'connection.open',
  db_connection_close: 'connection.close',
  db_sessions_list: 'sessions.list',
  db_connection_test: 'connection.test',
  db_query: 'query',
  db_explain: 'explain',
  db_cancel: 'cancel',
  db_apply_changes: 'applyChanges',
  db_import_csv: 'importCsv',
  db_schema_tree: 'schema.tree',
  db_schema_describe: 'schema.describe',
  db_schema_ddl: 'schema.ddl',
  db_dialects_list: 'dialects.list',
  db_connection_delete: 'connection.delete'
}

export function toolIdOf(name) {
  return NAME_TO_ID[name] || ''
}

export const TOOL_DEFS = [
  {
    name: 'db_connections_list',
    description: 'List saved database connections with id, name, driver, host, port, database, username, env, readOnly and favorite. Never returns credentials.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'db_connection_open',
    description: 'Open a saved connection by id and return a sessionKey. Later tools can just pass connectionId; this tool caches the mapping. Read-only connections reject write statements.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', maxLength: 64, description: 'Connection id from connections.list.' },
        database: { type: 'string', maxLength: 128, description: 'Override the initial database for this session.' }
      },
      required: ['connectionId'],
      additionalProperties: false
    }
  },
  {
    name: 'db_connection_close',
    description: 'Close a database session opened by connection.open (or any live sessionKey). Other sessions on the same connection are not affected.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256, description: 'Explicit session key; takes precedence over connectionId.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'db_sessions_list',
    description: 'List all live database sessions of this plugin with sessionKey, driver, database, readOnly and transactionActive.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'db_connection_test',
    description: 'Test connectivity of a saved connection without opening a session. Returns ok, message and server version.',
    parameters: {
      type: 'object',
      properties: { connectionId: { type: 'string', maxLength: 64 } },
      required: ['connectionId'],
      additionalProperties: false
    }
  },
  {
    name: 'db_query',
    description: 'Execute SQL on an open session. Read-only connections reject write statements; prod/requireConfirm connections need confirmed:true for writes. Result rows are capped (per-result 400 rows) and overlong cells truncated; check the truncated flag. For big tables run COUNT first.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', minLength: 1, maxLength: 512000, description: 'SQL text; multiple statements allowed on SQL drivers.' },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 },
        database: { type: 'string', maxLength: 128 },
        schema: { type: 'string', maxLength: 128 },
        maxRows: { type: 'integer', minimum: 1, maximum: 5000 },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 600000, description: 'Default 30000.' },
        confirmed: { type: 'boolean', description: 'Explicit confirmation for write statements on prod/protected connections.' }
      },
      required: ['sql'],
      additionalProperties: false
    }
  },
  {
    name: 'db_explain',
    description: 'Run EXPLAIN for a single read-only statement and return the plan rows.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', minLength: 1, maxLength: 512000 },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 }
      },
      required: ['sql'],
      additionalProperties: false
    }
  },
  {
    name: 'db_cancel',
    description: 'Cancel the running query on a session. Safe to call when nothing is running.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'db_apply_changes',
    description: 'Apply row-level insert/update/delete changes in one batch. Destructive. Read-only connections reject it; prod/requireConfirm need confirmed:true. Default stop-on-error rolls the whole batch back on failure.',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  type: { const: 'insert' },
                  table: tableRefSchema,
                  values: { type: 'object', description: 'Column -> value for the new row.' }
                },
                required: ['type', 'table', 'values'],
                additionalProperties: false
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'update' },
                  table: tableRefSchema,
                  key: { type: 'object', description: 'Column -> value identifying the row (primary key).' },
                  set: { type: 'object', description: 'Column -> new value.' }
                },
                required: ['type', 'table', 'key', 'set'],
                additionalProperties: false
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'delete' },
                  table: tableRefSchema,
                  key: { type: 'object', description: 'Column -> value identifying the row to delete.' }
                },
                required: ['type', 'table', 'key'],
                additionalProperties: false
              }
            ]
          }
        },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 },
        mode: { type: 'string', enum: ['stop-on-error', 'continue'], description: 'Default stop-on-error.' },
        confirmed: { type: 'boolean' }
      },
      required: ['changes'],
      additionalProperties: false
    }
  },
  {
    name: 'db_import_csv',
    description: 'Import CSV text into a table. Default run:false returns a preview only; call again with run:true to execute (destructive: inserts rows). Keep each call under 512KB.',
    parameters: {
      type: 'object',
      properties: {
        csvText: { type: 'string', minLength: 1, maxLength: 512000 },
        table: {
          oneOf: [
            { type: 'string', minLength: 1, maxLength: 384, description: '"table", "schema.table" or "db.schema.table".' },
            tableRefSchema
          ]
        },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 },
        delimiter: { type: 'string', minLength: 1, maxLength: 1, description: "Default ','." },
        hasHeader: { type: 'boolean', description: 'Default true.' },
        columns: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 512, description: 'Target column names in CSV order.' },
        conflict: { type: 'string', enum: ['insert'] },
        run: { type: 'boolean', description: 'false previews, true executes.' },
        confirmed: { type: 'boolean' }
      },
      required: ['csvText', 'table'],
      additionalProperties: false
    }
  },
  {
    name: 'db_schema_tree',
    description: 'List schema objects level by level: omit parent for databases (or tables for single-db drivers), parent=database for schemas/tables, parent=schema for tables, parent=table plus table name for columns.',
    parameters: {
      type: 'object',
      properties: {
        parent: { type: 'string', enum: ['root', 'database', 'schema', 'table'] },
        table: { type: 'string', maxLength: 128, description: 'Required when parent=table.' },
        database: { type: 'string', maxLength: 128 },
        schema: { type: 'string', maxLength: 128 },
        filter: { type: 'string', maxLength: 128, description: 'Case-insensitive name substring filter.' },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'db_schema_describe',
    description: 'Return full column metadata (types, nullability, defaults, keys, comments) for a table or view.',
    parameters: {
      type: 'object',
      properties: {
        table: { type: 'string', minLength: 1, maxLength: 128, description: 'Table name; qualify as schema.table when needed.' },
        database: { type: 'string', maxLength: 128 },
        schema: { type: 'string', maxLength: 128 },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 }
      },
      required: ['table'],
      additionalProperties: false
    }
  },
  {
    name: 'db_schema_ddl',
    description: 'Return the CREATE statement of a table when the driver supports DDL inspection.',
    parameters: {
      type: 'object',
      properties: {
        table: { type: 'string', minLength: 1, maxLength: 128 },
        database: { type: 'string', maxLength: 128 },
        schema: { type: 'string', maxLength: 128 },
        connectionId: { type: 'string', maxLength: 64 },
        sessionKey: { type: 'string', maxLength: 256 }
      },
      required: ['table'],
      additionalProperties: false
    }
  },
  {
    name: 'db_dialects_list',
    description: 'List supported database drivers with id, label, language and transport.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'db_connection_delete',
    description: 'Delete a saved connection configuration and its stored credential reference. Destructive to the saved config only: the database itself is never touched.',
    parameters: {
      type: 'object',
      properties: { connectionId: { type: 'string', maxLength: 64 } },
      required: ['connectionId'],
      additionalProperties: false
    }
  }
]
