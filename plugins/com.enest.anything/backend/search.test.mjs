import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function load(source) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('require', 'module', 'exports', js)(require, module, module.exports)
  return module.exports
}

const search = load(await require('node:fs/promises').readFile(new URL('./search.ts', import.meta.url), 'utf8'))
const files = load(await require('node:fs/promises').readFile(new URL('./files.ts', import.meta.url), 'utf8'))

test('parseQuery handles quoted, excluded and wildcard terms', () => {
  const tokens = search.parseQuery('"年度 报告" logo -png *.sketch \\-literal')
  assert.deepEqual(tokens.includes.map(item => item.raw), ['年度 报告', 'logo', '*.sketch', '-literal'])
  assert.ok(tokens.includes[0].quoted)
  assert.deepEqual(tokens.excludes, ['png'])
})

test('buildMdfindQuery joins include clauses and negates exclusions', () => {
  const query = search.buildMdfindQuery(search.parseQuery('报告 pdf -png "*.key"'))
  assert.ok(query.includes('kMDItemFSName == "*报告*"cd'))
  assert.ok(query.includes('!(kMDItemFSName == "*png*"'))
  assert.ok(query.includes('\\*.key'), 'quoted terms escape wildcards')
})

async function everythingMockServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname !== '/search.json') {
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== 'Basic ' + Buffer.from('demo:pass').toString('base64')) {
      response.writeHead(401).end()
      return
    }
    const results = [
      { type: 'file', name: 'annual-report.pdf', path: 'C:\\Docs\\annual-report.pdf', size: 409600, date_modified: 1791753600 },
      { type: 'folder', name: 'assets', path: 'C:\\Docs\\assets', size: 0, date_modified: 1791667200 }
    ]
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ totalResults: results.length, results }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

test('everythingSearch queries the HTTP server and maps items', async () => {
  const { server, port } = await everythingMockServer()
  try {
    const available = await search.everythingAvailable(port, 'demo:pass', true)
    assert.equal(available.ok, true)
    const { files: hits, total } = await search.everythingSearch(
      search.parseQuery('report'),
      { port, auth: 'demo:pass' },
      { limit: 20, offset: 0, sort: 'name' }
    )
    assert.equal(total, 2)
    const pdf = hits.find(file => file.name === 'annual-report.pdf')
    assert.equal(pdf.isDirectory, false)
    assert.equal(pdf.ext, 'pdf')
    assert.equal(pdf.size, 409600)
    assert.equal(pdf.mtimeMs, 1791753600000)
    assert.ok(pdf.path.endsWith('annual-report.pdf'))
    const folder = hits.find(file => file.name === 'assets')
    assert.equal(folder.isDirectory, true)
    const unreachable = await search.everythingAvailable(port + 1, undefined, true)
    assert.equal(unreachable.ok, false)
    assert.match(unreachable.detail, /不可达/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('spotlight search runs end to end on darwin', { skip: process.platform !== 'darwin' }, async () => {
  const result = await search.searchFiles('Applications', { limit: 5 })
  assert.equal(result.provider, 'spotlight')
  assert.ok(Array.isArray(result.results))
  assert.ok(result.results.length <= 5)
  for (const file of result.results) {
    assert.equal(typeof file.path, 'string')
    assert.equal(typeof file.isDirectory, 'boolean')
    assert.ok(file.path.startsWith('/'))
  }
})

test('readTextFile detects utf-8 and gb18030', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anything-test-'))
  try {
    const utf8 = join(dir, 'note.md')
    writeFileSync(utf8, '# 标题\n正文内容')
    const decoded = files.readTextFile(utf8)
    assert.equal(decoded.encoding, 'utf-8')
    assert.match(decoded.content, /标题/)
    const gbk = join(dir, 'gbk.txt')
    // 「中文」的 GBK 编码字节
    writeFileSync(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
    const legacy = files.readTextFile(gbk)
    assert.equal(legacy.encoding, 'gb18030')
    assert.equal(legacy.content, '中文')
    assert.throws(() => files.readTextFile(join(dir, 'missing.txt')), /ENOENT|不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('path guards reject relative and empty targets', async () => {
  await assert.rejects(() => files.openPath('relative/file.txt'), /绝对路径/)
  await assert.rejects(() => files.revealPath(''), /路径参数无效|绝对路径/)
  assert.throws(() => files.statPath('C:\\nope'), /绝对路径/)
})

test('trashPath moves a temp file to the OS trash', { skip: process.platform !== 'darwin' || process.env.CI }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anything-trash-'))
  try {
    const target = join(dir, 'disposable.txt')
    writeFileSync(target, 'to be trashed')
    await files.trashPath(target)
    assert.equal(await require('node:fs/promises').access(target).then(() => true, () => false), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
