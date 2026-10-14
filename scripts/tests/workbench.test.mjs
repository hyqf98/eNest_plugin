import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SelectionModel, CommandRegistry, normalizeShortcut } from '../../packages/plugin-kit/workbench.js'
import { qualifiedName, objectQuery } from '../../plugins/com.enest.database/src/js/queryTemplates.js'
import { compareRows, structureDiff } from '../../plugins/com.enest.database/src/js/comparison.js'

test('selection handles range, toggle and vanished files', () => {
  const selection = new SelectionModel(); selection.select('b', ['a', 'b', 'c', 'd'])
  assert.deepEqual(selection.select('d', ['a', 'b', 'c', 'd'], { range: true }), ['b', 'c', 'd'])
  selection.select('c', ['a', 'b', 'c', 'd'], { additive: true }); selection.retain(['a', 'b'])
  assert.deepEqual([...selection.selected], ['b'])
})
test('command bindings reject duplicates and respect availability', async () => {
  const registry = new CommandRegistry(); let runs = 0
  registry.register({ id: 'query', label: '查询', shortcut: 'Mod+Enter', run: () => runs++ })
  registry.register({ id: 'stop', label: '停止', shortcut: 'Alt+Escape', enabled: () => false, run: () => runs++ })
  assert.throws(() => registry.setBinding('stop', 'Mod+Enter'), /冲突/)
  assert.equal(await registry.run('stop'), false); await registry.run('query'); assert.equal(runs, 1)
  assert.equal(normalizeShortcut({ key: 'p', metaKey: true, shiftKey: true }), 'Mod+Shift+P')
})
test('comparison aligns reordered columns, distinguishes null and duplicate keys', () => {
  const left = { columns: [{ name: 'id' }, { name: 'value' }], rows: [[1, null], [2, 'x'], [2, 'y'], [3, 'only']] }
  const right = { columns: [{ name: 'value' }, { name: 'id' }], rows: [[null, 1], ['x', 2], ['new', 4]] }
  assert.deepEqual(compareRows(left, right, ['id']).map((row) => row.status), ['equal', 'ambiguous', 'left-only', 'right-only'])
  assert.throws(() => compareRows(left, right, []), /唯一键/)
  assert.throws(() => compareRows(left, right, ['missing']), /缺少/)
})
test('structure comparison emits differences only and never migration SQL', () => {
  const result = structureDiff({ columns: [{ name: 'id', type: 'INT', nullable: false }] }, { columns: [{ name: 'id', type: 'BIGINT', nullable: false }] })
  assert.equal(result[0].status, 'different'); assert.equal(Object.hasOwn(result[0], 'sql'), false)
  const indexes = structureDiff({ columns: [], indexes: [{ name: 'by_name', columns: ['name'], unique: false }], foreignKeys: [{ name: 'owner', columns: ['owner_id'], referencedTable: 'users', referencedColumns: ['id'] }] }, { columns: [], indexes: [{ name: 'by_name', columns: ['name'], unique: true }] })
  assert.deepEqual(indexes.map((row) => row.status), ['different', 'left-only'])
})


test('object query snippets preserve dialect quoting and native document syntax', () => {
  assert.equal(qualifiedName('postgres', { database: 'ignored', schema: 'public', table: 'a"b' }), '"public"."a""b"')
  assert.match(objectQuery('mssql', { table: 'audit' }), /^SELECT TOP \(200\)/)
  assert.match(objectQuery('oracle', { table: 'audit' }), /FETCH FIRST 200 ROWS ONLY/)
  assert.deepEqual(JSON.parse(objectQuery('mongodb', { table: 'events' })), { collection: 'events', operation: 'find', filter: {} })
})


test('database and SSH manifests allow the real Quick viewport and local compiled entries', async () => {
  for (const id of ['com.enest.database', 'com.enest.ssh']) {
    const base = new URL(`../../plugins/${id}/`, import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('plugin.json', base), 'utf8'))
    assert.deepEqual(manifest.window, { width: 720, height: 420, minWidth: 480, minHeight: 240 })
    if (id === 'com.enest.database') assert.ok(manifest.permissions.includes('shell.openExternal'))
    const html = await readFile(new URL('index.html', base), 'utf8')
    assert.ok(!html.includes('type="importmap"'))
    assert.match(html, /src="\.\/src\/entry\.js"/)
  }
})
