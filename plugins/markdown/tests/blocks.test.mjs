import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// blocks.js 内含 TS 类型注解，经 esbuild tsx loader 转译后加载（与构建管线一致）
const tmp = resolve(root, 'dist/.test-blocks.mjs')
execFileSync('npx', ['esbuild', resolve(root, 'src/cm/blocks.js'), '--format=esm', '--platform=browser', '--loader:.js=tsx', '--outfile='.concat(tmp), '--allow-overwrite'], { cwd: root, stdio: 'pipe' })
const { parseBlocks, blockAt } = await import(pathToFileURL(tmp))

const F = String.fromCharCode(96, 96, 96)
const doc = ['---', 'title: t', '---', '', '# H1', '', 'p1', 'p2', '', F + 'js', 'let a = 1', F, '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '- x', '- y', '', '> q1', '> q2', '', '$$e=mc^2$$', '', '$', 'a+b', '$$', '', 'end.'].join('\n')

test('parseBlocks：覆盖全部块类型且偏移一致', () => {
  const blocks = parseBlocks(doc)
  const types = blocks.map((b) => b.type)
  assert.ok(types.includes('meta'))
  assert.ok(types.includes('heading'))
  assert.ok(types.includes('paragraph'))
  assert.ok(types.includes('fence'))
  assert.ok(types.includes('table'))
  assert.ok(types.includes('list'))
  assert.ok(types.includes('quote'))
  assert.ok(types.includes('math'))
  for (const b of blocks) assert.equal(doc.slice(b.from, b.to), b.text, `offset mismatch: ${b.type}`)
})

test('parseBlocks：单行闭合数学块', () => {
  const blocks = parseBlocks('$$e=mc^2$$\n\ntail')
  assert.equal(blocks[0].type, 'math')
  assert.equal(blocks[0].text, '$$e=mc^2$$')
})

test('parseBlocks：未闭合 fence 吞到文档尾', () => {
  const blocks = parseBlocks('text\n\n' + F + 'js\nunclosed')
  const fence = blocks.find((b) => b.type === 'fence')
  assert.ok(fence)
  assert.equal(fence.to, ('text\n\n' + F + 'js\nunclosed').length)
})

test('blockAt：命中包含光标的块', () => {
  const blocks = parseBlocks(doc)
  assert.equal(blockAt(blocks, 1).type, 'meta')
})
