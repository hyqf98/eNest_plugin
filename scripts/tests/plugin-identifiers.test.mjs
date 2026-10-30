import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolvePluginSource } from '../plugin-contract.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'enest-plugin-identifiers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const add = async (slug, id) => {
    const source = join(root, 'plugins', slug)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, version: '1.0.0' }))
    return source
  }
  const source = await add('notes', 'org.example.notes')
  await add('ssh', 'com.github.eNest.ssh')
  return { root, source, add }
}

test('directory slugs and exact manifest IDs resolve to the same canonical source', async t => {
  const f = await fixture(t)
  assert.deepEqual(resolvePluginSource('notes', f.root), resolvePluginSource('org.example.notes', f.root))
  assert.equal(resolvePluginSource('org.example.notes', f.root).source, f.source)
  assert.equal(resolvePluginSource('com.github.eNest.ssh', f.root).slug, 'ssh')
  for (const identifier of ['com.github.eNest.notes', 'org.other.notes', 'org.example.Notes', 'com.github.enest.ssh', 'missing']) {
    assert.throws(() => resolvePluginSource(identifier, f.root), /Unknown plugin/)
  }
  for (const identifier of ['', '.', '..', '../notes', 'plugins/notes', 'plugins\\notes', '/tmp/notes']) {
    assert.throws(() => resolvePluginSource(identifier, f.root), /Invalid plugin identifier/)
  }
})

test('duplicate full IDs and a full ID colliding with another slug are rejected', async t => {
  const f = await fixture(t)
  await f.add('duplicate', 'org.example.notes')
  assert.throws(() => resolvePluginSource('org.example.notes', f.root), /Ambiguous plugin identifier/)
  await f.add('com.github.eNest.ssh', 'org.example.other')
  assert.throws(() => resolvePluginSource('com.github.eNest.ssh', f.root), /Ambiguous plugin identifier/)
})
