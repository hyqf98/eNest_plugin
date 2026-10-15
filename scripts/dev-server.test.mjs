import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPreviewServer } from './dev-server.mjs'

test('preview serves only public distribution assets and never backend code through encoded traversal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'enest preview # fixture '))
  const plugin = join(root, 'plugins/com.fixture.backend'), dist = join(plugin, 'dist')
  await mkdir(join(dist, 'assets/app'), { recursive: true })
  await mkdir(join(dist, 'backend/node_modules/driver'), { recursive: true })
  await writeFile(join(plugin, 'plugin.json'), '{"id":"com.fixture.backend"}')
  await writeFile(join(dist, 'index.html'), 'public entry')
  await writeFile(join(dist, 'assets/app/main.js'), 'public asset')
  await writeFile(join(dist, 'backend/index.cjs'), 'secret backend')
  await writeFile(join(dist, 'backend/node_modules/driver/value#one.js'), 'secret driver')
  const { server, url } = await createPreviewServer(0, { root })
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  assert.equal(await (await fetch(`${url}/plugins/com.fixture.backend/`)).text(), 'public entry')
  assert.equal(await (await fetch(`${url}/plugins/com.fixture.backend/assets/app/main.js`)).text(), 'public asset')
  for (const path of ['backend/index.cjs', 'backend/node_modules/driver/value%23one.js', 'assets/%2e%2e/backend/index.cjs', 'assets/%252e%252e/backend/index.cjs', 'assets/%2e%2e%2fbackend/index.cjs', 'plugin.json']) {
    const response = await fetch(`${url}/plugins/com.fixture.backend/${path}`)
    assert.equal(response.status, 404, path)
    assert.ok(!(await response.text()).includes('secret'), path)
  }
})
