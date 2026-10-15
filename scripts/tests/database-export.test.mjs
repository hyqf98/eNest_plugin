import test from 'node:test'
import assert from 'node:assert/strict'
import { toCsv, toTsv, toJson, toSql, exportSqlLiteral, buildExport } from '../../plugins/com.enest.database/src/js/exportFormats.js'

test('CSV and TSV preserve multiline, quote and delimiter values with configurable headers/BOM', () => {
  assert.equal(toCsv(['名字', 'note'], [['甲', 'a,"b"\r\nc']]), '\uFEFF名字,note\r\n甲,"a,""b""\r\nc"')
  assert.equal(toCsv(['x'], [['a;b'], [null]], { delimiter: ';', bom: false, headers: false }), '"a;b"\r\n')
  assert.equal(toTsv(['a', 'b'], [['x\ty', 'z']]), 'a\tb\r\n"x\ty"\tz')
})

test('JSON preserves duplicate columns and large integer precision', () => {
  assert.deepEqual(JSON.parse(toJson(['id', 'id'], [[1, 9007199254740993n]])), { columns: ['id', 'id'], rows: [[1, '9007199254740993']] })
  assert.deepEqual(JSON.parse(toJson(['id', 'name'], [[1, null]])), [{ id: 1, name: null }])
})

test('SQL exports quote each identifier segment and preserve values across dialects', () => {
  const sql = toSql(['a`b', 'text'], [[9007199254740993n, "it's"], [null, '换行\n\\']], { database: 'my.db', table: 'a`table' })
  assert.match(sql, /^START TRANSACTION;\nINSERT INTO `my\.db`\.`a``table` \(`a``b`, `text`\)/)
  assert.match(sql, /9007199254740993, 'it''s'/)
  assert.match(sql, /CONVERT\(X'[0-9a-f]+' USING utf8mb4\)/)
  assert.match(sql, /COMMIT;$/)
  assert.match(toSql(['id'], [[1]], { schema: 'odd.schema', table: 'a"b' }, { driver: 'postgres', transaction: false }), /^INSERT INTO "odd.schema"\."a""b"/)
  assert.equal(exportSqlLiteral('A\n\\B', 'postgres'), "E'A\\n\\\\B'")
  assert.equal(exportSqlLiteral('中文', 'sqlserver'), "N'中文'")
  assert.match(toSql(['id'], [[1]], { schema: 'dbo', table: 'a]b' }, { driver: 'sqlserver' }), /^BEGIN TRANSACTION;\nINSERT INTO \[dbo\]\.\[a\]\]b\]/)
  assert.throws(() => toSql(['id', 'id'], [[1, 2]]), /字段名唯一/)
  assert.throws(() => exportSqlLiteral(Infinity), /非有限/)
  assert.throws(() => exportSqlLiteral('\0', 'postgres'), /NUL/)
})

test('file export respects selected options and avoids invalid transaction wrappers', () => {
  assert.deepEqual(buildExport('csv', ['name'], [['a;b']], null, { filename: 'bad/file.csv', delimiter: ';', exportBom: false, headers: false }), { filename: 'bad-file.csv', content: '"a;b"' })
  assert.equal((toSql(['id'], [[1], [2]], { table: 't' }, { driver: 'oracle' }).match(/INSERT INTO/g) || []).length, 2)
  assert.ok(!toSql(['id'], [[1]], { table: 't' }, { driver: 'oracle' }).startsWith('BEGIN'))
  assert.throws(() => toSql(['id'], [[1]], null, { driver: 'clickhouse' }), /不支持通用事务/)
  assert.ok(!toSql(['id'], [[1]], null, { driver: 'clickhouse', transaction: false }).includes('COMMIT'))
})
