import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { executionStatements, currentExecutionStatement, resolveExecutionRange } = await import('@db/executionRange.js')
const { registerDialect, getDialect } = await import('@db/sql-intelligence/dialects/registry.js')

const current = (sql, text, dialect = 'mysql') => currentExecutionStatement(sql, sql.indexOf(text) + 1, dialect)
const fragments = (sql, dialect) => executionStatements(sql, dialect).filter(statement => !statement.directive).map(statement => statement.sql.trim())

test('caret executes exactly one complete SQL with Chinese, CRLF and attached comments', () => {
  const sql = "SELECT '第一条';\r\n-- 第二条查询\r\nSELECT 名称\r\nFROM 客户;\r\nSELECT 3;"
  const found = current(sql, '名称')
  assert.equal(found.sql.trim(), '-- 第二条查询\r\nSELECT 名称\r\nFROM 客户;')
  assert.equal(sql.slice(found.start, found.end), found.sql)
  assert.equal(current(sql, '3').sql.trim(), 'SELECT 3;')
})
test('quoted semicolons, escaped quotes and nested comments never form execution boundaries', () => {
  const sql = "SELECT 'a;''b', 'escaped\\\';still', `a;b`, \"escaped\\\";still\"; /* outer ; /* inner ; */ */ SELECT 2;"
  assert.equal(fragments(sql, 'mysql').length, 2)
  assert.match(current(sql, 'inner', 'mysql').sql, /SELECT 2;/)
  assert.equal(fragments('SELECT 1--1; SELECT 2;', 'mysql').length, 2)
  assert.equal(fragments('SELECT 1 # ; comment\n; SELECT 2;', 'mysql').length, 2)
})
test('PostgreSQL dollar bodies and E strings remain a single executable statement', () => {
  const sql = "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM ';'; PERFORM 2; END; $body$ LANGUAGE plpgsql;\nSELECT E'a\\\';b';"
  const body = current(sql, 'PERFORM 2', 'postgres')
  assert.match(body.sql, /LANGUAGE plpgsql;$/)
  assert.equal(body.unsupportedReason, undefined)
  assert.equal(fragments(sql, 'postgres').length, 2)
})
test('SQLite bracket identifiers and Oracle alternative quotes protect semicolons', () => {
  assert.deepEqual(fragments('SELECT [a;]]b] FROM [t]; SELECT 2;', 'sqlite'), ['SELECT [a;]]b] FROM [t];', 'SELECT 2;'])
  assert.deepEqual(fragments("SELECT q'[a;b\"''c]' FROM dual; SELECT 2 FROM dual;", 'oracle'), ["SELECT q'[a;b\"''c]' FROM dual;", 'SELECT 2 FROM dual;'])
})
test('selection wins identically in current/selection modes and select-all executes the selection', () => {
  const sql = 'SELECT 1; SELECT 2; SELECT 3;'
  for (const mode of ['current', 'selection']) {
    assert.equal(resolveExecutionRange(sql, { start: 10, end: 19, mode }).sql, 'SELECT 2;')
    assert.equal(resolveExecutionRange(sql, { start: 12, end: 12, cursor: 12, mode }).sql.trim(), 'SELECT 2;')
    assert.equal(resolveExecutionRange(sql, { start: 0, end: sql.length, mode }).sql, sql)
  }
  assert.equal(resolveExecutionRange(sql, { start: 10, end: 19, mode: 'all' }).sql, sql)
})
test('caret at statement terminator remains on that statement; trailing whitespace does not select the first', () => {
  const sql = 'SELECT 1;\nSELECT 2;  '
  assert.equal(currentExecutionStatement(sql, 8).sql, 'SELECT 1;')
  assert.equal(currentExecutionStatement(sql, sql.length).sql.trim(), 'SELECT 2;')
  assert.equal(currentExecutionStatement('/* only comment ; */', 5).sql, '')
  assert.equal(currentExecutionStatement('', 0).sql, '')
  assert.equal(currentExecutionStatement('SELECT 1;SELECT 2;', 9).sql, 'SELECT 2;')
  assert.equal(currentExecutionStatement('SELECT 1;SELECT 2;', 18).sql, 'SELECT 2;')
})
test('MySQL procedure/SQLite trigger execute intact without exposing inner statements', () => {
  for (const [dialect, sql, marker] of [
    ['mysql', 'SELECT 1; CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 2; END IF; SELECT 3; END; SELECT 4;', 'SELECT 3'],
    ['sqlite', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a=CASE WHEN a=1 THEN 2 ELSE 3 END; INSERT INTO y VALUES (1); END; SELECT 4;', 'INSERT INTO y']
  ]) {
    const selected = current(sql, marker, dialect)
    assert.match(selected.sql, /END;$/)
    assert.equal(selected.unsupportedReason, undefined)
    assert.equal(current(sql, 'SELECT 4', dialect).unsupportedReason, undefined)
    assert.equal(current(sql, 'SELECT 4', dialect).sql.trim(), 'SELECT 4;')
  }
})
test('ordinary transaction batches remain executable and are not mistaken for procedural blocks', () => {
  for (const dialect of ['mysql', 'postgres', 'sqlite', 'mssql', 'oracle']) {
    const sql = dialect === 'mssql' ? 'BEGIN TRANSACTION\nGO\nUPDATE customers SET active=1;\nGO\nCOMMIT\nGO' : 'BEGIN; UPDATE customers SET active=1; COMMIT;'
    const result = resolveExecutionRange(sql, { mode: 'all', dialect })
    assert.equal(result.unsupportedReason, undefined, dialect)
    assert.equal(fragments(sql, dialect).length, 3, dialect)
  }
})
test('client DELIMITER/GO and Oracle blocks preserve complete server requests', () => {
  const mysql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;'
  assert.equal(current(mysql, 'SELECT 2').unsupportedReason, undefined)
  assert.equal(current(mysql, 'SELECT 2').sql, 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END')
  assert.equal(resolveExecutionRange(mysql, { mode: 'all' }).unsupportedReason, undefined)
  assert.equal(current(mysql, 'SELECT 3').sql.trim(), 'SELECT 3;')
  assert.equal(resolveExecutionRange('SELECT 1;\nGO\nSELECT 2;', { mode: 'all', dialect: 'mssql' }).unsupportedReason, undefined)
  assert.equal(current('DECLARE x number; BEGIN x := 1; x := 2; END;\n/\nSELECT 3 FROM dual;', 'x := 2', 'oracle').unsupportedReason, undefined)
})
test('native JSON/Flux/Cypher query languages keep their entire query without SQL splitting', () => {
  const source = '{"script":"a;b"}\n{"next":true}'
  for (const dialect of ['mongodb', 'redis', 'neo4j', 'influxdb2', 'elasticsearch']) assert.equal(resolveExecutionRange(source, { cursor: 5, dialect }).sql, source)
})
test('registered dialects can declare their execution boundary strategy without editor changes', () => {
  registerDialect('test-execution-mysql', { base: 'mysql', statementRules: { mysqlDelimiter: false } })
  const descriptor = getDialect('test-execution-mysql')
  assert.equal(descriptor.statementRules.mysqlDelimiter, false)
  assert.equal(fragments("SELECT 'a;b'; SELECT 2;", descriptor).length, 2)
})


test('nested procedural controls do not consume the following regular statement', () => {
  const sources = [
    ['oracle', 'BEGIN WHILE x < 3 LOOP x := x + 1; END LOOP; END; SELECT 4 FROM dual;'],
    ['mssql', 'BEGIN IF 1=1 BEGIN SELECT 1; END; SELECT 2; END;\nGO\nSELECT 4;'],
    ['postgres', 'BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 4;']
  ]
  for (const [dialect, sql] of sources) {
    const statement = current(sql, 'SELECT 4', dialect)
    assert.match(statement.sql.trim(), /^SELECT 4/)
    assert.equal(statement.unsupportedReason, undefined)
    assert.equal(current(sql, sql.includes('x :=') ? 'x :=' : 'SELECT 1', dialect).unsupportedReason, undefined)
  }
})

test('Oracle alternative quoting protects embedded quotes and semicolons through execution', () => {
  const sql = "SELECT q'[a';b]' FROM dual; SELECT 2 FROM dual;"
  assert.equal(current(sql, 'a', 'oracle').unsupportedReason, undefined)
  assert.equal(current(sql, 'SELECT 2', 'oracle').unsupportedReason, undefined)
})

test('guarded or labelled procedural blocks cannot expose their inner writes as standalone caret statements', () => {
  const definitions = [
    ['mssql', 'IF 1=0 BEGIN SELECT 1; DELETE FROM audit; END;'],
    ['mssql', 'WHILE 1=0 BEGIN SELECT 1; DELETE FROM audit; END;'],
    ['oracle', '<<guarded>> BEGIN IF 1=0 THEN NULL; DELETE FROM audit; END IF; END;'],
    ['oracle', '<<first>> <<second>> DECLARE n NUMBER; BEGIN NULL; DELETE FROM audit; END;'],
    ['mariadb', 'BEGIN NOT ATOMIC IF 1=0 THEN SELECT 1; DELETE FROM audit; END IF; UPDATE audit SET n=1; END;'],
    ['mariadb', 'guarded: BEGIN NOT ATOMIC SELECT 1; DELETE FROM audit; END;'],
  ]
  for (const [dialect, definition] of definitions) {
    const following = dialect === 'oracle' ? 'SELECT 42 FROM dual;' : 'SELECT 42;'
    const sql = `${definition}\r\n${dialect === 'mssql' ? 'GO\r\n' : ''}${following}`
    const found = current(sql, 'DELETE', dialect)
    assert.equal(found.sql, definition, dialect)
    assert.equal(found.unsupportedReason, undefined, dialect)
    assert.equal(current(sql, 'SELECT 42', dialect).sql.trim(), following, dialect)
    assert.equal(current(sql, 'SELECT 42', dialect).unsupportedReason, undefined, dialect)
    assert.equal(resolveExecutionRange(sql, { mode: 'all', dialect }).unsupportedReason, undefined)
  }
})

test('ordinary DDL identifiers named after routine types do not become procedural definitions', () => {
  for (const sql of [
    'CREATE TABLE events (event TEXT);',
    'ALTER TABLE t ADD COLUMN function TEXT;',
    'CREATE VIEW v AS SELECT event FROM t;',
    'CREATE TEMP TABLE t (procedure TEXT, trigger TEXT);',
  ]) assert.equal(resolveExecutionRange(sql, { dialect: 'sqlite' }).unsupportedReason, undefined, sql)
  for (const [dialect, sql] of [
    ['mysql', "CREATE DEFINER='user'@'host' PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;"],
    ['mysql', 'CREATE DEFINER=CURRENT_USER() FUNCTION f() RETURNS INT RETURN 1;'],
    ['mssql', 'CREATE OR ALTER PROC p AS SELECT 1; SELECT 2;'],
    ['oracle', 'CREATE OR REPLACE NONEDITIONABLE PACKAGE p AS PROCEDURE f; END;'],
  ]) assert.equal(resolveExecutionRange(sql, { mode: 'all', dialect }).unsupportedReason, undefined, sql)
})


test('a valid earlier caret statement remains runnable when a later unit or directive is invalid', () => {
  for (const sql of ["SELECT 1; SELECT 'unfinished", 'SELECT 1; /* unfinished']) {
    assert.equal(currentExecutionStatement(sql, 3).unsupportedReason, undefined)
    assert.match(resolveExecutionRange(sql, { mode: 'all' }).unsupportedReason, /Unterminated/)
  }
  const source = 'SELECT 1;\nGO 3\nSELECT 2;'
  assert.match(resolveExecutionRange(source, { mode: 'all', dialect: 'mssql' }).unsupportedReason, /repeat counts/)
})
