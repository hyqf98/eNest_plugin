import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('../../plugins/', import.meta.url)

test('database never forwards old paths and reauthorizes saved handles once per runtime', async () => {
  const calls = [], picks = [{ id: 'current', name: 'test.db', displayPath: 'test.db', kind: 'file' }]
  globalThis.window = { enest: { ui: { toast: async () => {} }, db: {
    pickSqliteFile: async options => { calls.push(['pick', options]); return picks.shift() || null },
    open: async input => { calls.push(['open', structuredClone(input)]); return true },
    test: async input => { calls.push(['test', structuredClone(input)]); return true }
  } } }
  try {
    const { DbHost, toConnectionInput } = await import(new URL('com.enest.database/src/js/api.js?handles-test', root))
    const legacy = { id: 'one', driver: 'sqlite', filePath: '/private/old.db', sqlitePath: '/private/old.db', fileHandleId: 'expired', options: { file: '/private/old.db' } }
    const payload = toConnectionInput(legacy)
    assert.equal('filePath' in payload, false)
    assert.equal('sqlitePath' in payload, false)
    assert.equal('file' in payload.options, false)
    await DbHost.open({ config: payload })
    assert.equal(calls.at(-1)[1].config.fileHandleId, 'current')
    await DbHost.test(toConnectionInput(legacy))
    assert.equal(calls.at(-1)[1].fileHandleId, 'current')
    assert.equal(calls.filter(([name]) => name === 'pick').length, 1)
    await assert.rejects(DbHost.open({ config: { connectionId: 'two', driver: 'sqlite' } }), /已取消/)
    assert.equal(calls.filter(([name]) => name === 'open').length, 1)
  } finally { delete globalThis.window }
})

test('SSH local picker and SFTP use opaque capabilities rather than raw paths', async () => {
  const calls = [], host = { localFiles: { pick: async options => { calls.push(['pick', options]); return [{ id: 'allowed', name: 'id_ed25519', kind: 'file' }] } }, ssh: { sftp: {
    upload: async input => calls.push(['upload', input]), download: async input => calls.push(['download', input])
  } } }
  const window = { enest: host }
  vm.runInNewContext(await readFile(new URL('com.enest.ssh/src/js/api.js', root), 'utf8'), { window })
  assert.equal(window.SshApi.hasLocalFileHandle('saved-old-handle'), false)
  const handle = await window.SshApi.pickLocalFile({ kind: 'directory', access: 'write' })
  assert.equal(window.SshApi.hasLocalFileHandle(handle.id), true)
  assert.equal(calls[0][1].access, 'write')
  await window.SshApi.sftpUpload('session', handle.id, '/remote/upload')
  await window.SshApi.sftpDownload('session', '/remote/download', handle.id)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][1])), { sessionId: 'session', localHandleId: 'allowed', remotePath: '/remote/upload' })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2][1])), { sessionId: 'session', remotePath: '/remote/download', localDirectoryHandleId: 'allowed' })
})
