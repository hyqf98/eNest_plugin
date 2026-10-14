import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readAuthorizedFiles, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
const handle = { id: 'owned', name: 'demo.txt', size: 4, kind: 'file' }
test('drop import consumes only bytes returned for a host-authorized handle', async () => {
  const calls = [], original = { name: 'demo.txt', arrayBuffer() { throw new Error('must not read original OS file') } }
  const api = { localFiles: {
    fromDrop: async files => { assert.equal(files[0], original); return [handle] },
    read: async options => { calls.push(options); return 'data:application/octet-stream;base64,dGVzdA==' }
  } }
  const [file] = await readDroppedFiles([original], { api })
  assert.equal(await file.text(), 'test')
  assert.equal(file.name, 'demo.txt')
  assert.equal(calls[0].handleId, 'owned')
})
test('denied, canceled and oversized imports do not read file data', async () => {
  let reads = 0
  const api = { localFiles: { fromDrop: async () => { throw new Error('permission denied') }, read: async () => { reads++; return '' } } }
  await assert.rejects(readDroppedFiles([{}], { api }), /permission denied/)
  assert.deepEqual(await readAuthorizedFiles([], { api }), [])
  await assert.rejects(readAuthorizedFiles([{ ...handle, size: 40 * 1024 * 1024 }], { api }), /超过允许大小/)
  assert.equal(reads, 0)
})
