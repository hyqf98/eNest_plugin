#!/usr/bin/env node
/* 规则引擎自测矩阵：正则替换 / 序号 / 日期 / 大小写 / 扩展名 / 冲突检测 / 链式叠加 */
import assert from 'node:assert/strict'
import { applyRules, splitName, joinName, validateName, hasBlocked } from './core.mjs'

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok ${name}`) }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1 }
}

const E = (name, i = 0, dir = '/d') => ({ id: `h${i}`, name, mtime: 1700000000000, dir })

console.log('splitName / joinName')
ok('基础拆分与还原', () => {
  const p = splitName('photo.jpg')
  assert.equal(p.base, 'photo'); assert.equal(p.ext, 'jpg')
  assert.equal(joinName(p.base, p.ext), 'photo.jpg')
})
ok('无扩展名', () => {
  const p = splitName('README')
  assert.equal(p.base, 'README'); assert.equal(p.ext, '')
})
ok('点开头文件不算扩展分隔', () => {
  const p = splitName('.gitignore')
  assert.equal(p.base, '.gitignore'); assert.equal(p.ext, '')
})

console.log('validateName')
ok('非法字符矩阵', () => {
  for (const n of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a<b', 'a|b', '', '.', '..', '.hidden', 'con', 'NUL']) {
    assert.ok(validateName(n), `should reject: ${n}`)
  }
  assert.equal(validateName('正常名称 v2.txt'), null)
  assert.equal(validateName('a.b'), null)
})

console.log('replace 规则')
ok('普通查找替换（默认不区分大小写）', () => {
  const rows = applyRules([E('IMG-001.jpg', 0), E('img-002.png', 1)], [{ type: 'replace', find: 'img-', replaceWith: '' }])
  assert.equal(rows[0].newName, '001.jpg')
  assert.equal(rows[1].newName, '002.png')
})
ok('大小写开关：区分后不再命中', () => {
  const rows = applyRules([E('IMG-001.jpg')], [{ type: 'replace', find: 'img-', replaceWith: '', caseSensitive: true }])
  assert.equal(rows[0].newName, 'IMG-001.jpg') // 不变
})
ok('正则开关 + 捕获组', () => {
  const rows = applyRules([E('2023-report.txt')], [{ type: 'replace', find: '(\\d{4})-(.*)', replaceWith: '$2-$1', regex: true }])
  assert.equal(rows[0].newName, 'report-2023.txt')
})
ok('坏正则整体抛错（供规则编辑处提示）', () => {
  assert.throws(() => applyRules([E('a.txt')], [{ type: 'replace', find: '([', replaceWith: '', regex: true }]), /Invalid regular expression|SyntaxError/)
})

console.log('number 规则')
ok('前缀序号（起始/步进/位数）', () => {
  const rows = applyRules([E('a.txt', 0), E('b.txt', 1), E('c.txt', 2)], [{ type: 'number', start: 5, step: 10, width: 3, position: 'prefix' }])
  assert.equal(rows[0].newName, '005_a.txt')
  assert.equal(rows[1].newName, '015_b.txt')
  assert.equal(rows[2].newName, '025_c.txt')
})
ok('后缀序号 + 自定义分隔符', () => {
  const rows = applyRules([E('a.txt', 0), E('b.txt', 1)], [{ type: 'number', start: 1, step: 1, width: 2, position: 'suffix', separator: '-' }])
  assert.equal(rows[0].newName, 'a-01.txt')
  assert.equal(rows[1].newName, 'b-02.txt')
})
ok('纯序号（keepBase=false）丢扩展名仅序号主体', () => {
  const rows = applyRules([E('a.txt', 0), E('b.txt', 1)], [{ type: 'number', keepBase: false, start: 1, width: 3 }])
  assert.equal(rows[0].newName, '001.txt')
  assert.equal(rows[1].newName, '002.txt')
})

console.log('date 规则')
ok('mtime 格式化后缀', () => {
  const rows = applyRules([E('doc.pdf', 0, '/d')], [{ type: 'date', source: 'mtime', pattern: 'YYYY-MM-DD', position: 'suffix', separator: '-' }])
  // 1700000000000 = 2023-11-14 UTC / 11-15 UTC+8：本地时区按天可能有 ±1，断言形状
  assert.match(rows[0].newName, /^doc-2023-11-(14|15)\.pdf$/, rows[0].newName)
})

console.log('case 规则')
ok('大写 / 小写 / 首字母', () => {
  assert.equal(applyRules([E('abc.txt')], [{ type: 'case', mode: 'upper' }])[0].newName, 'ABC.txt')
  assert.equal(applyRules([E('ABC.txt')], [{ type: 'case', mode: 'lower' }])[0].newName, 'abc.txt')
  assert.equal(applyRules([E('hello world.txt')], [{ type: 'case', mode: 'title' }])[0].newName, 'Hello World.txt')
})

console.log('ext 规则')
ok('扩展名替换', () => {
  const rows = applyRules([E('a.jpeg', 0), E('b.png', 1)], [{ type: 'ext', ext: 'jpg' }])
  assert.equal(rows[0].newName, 'a.jpg')
  assert.equal(rows[1].newName, 'b.jpg')
})

console.log('规则链叠加（按序）')
ok('先替换再序号再扩展名', () => {
  const rows = applyRules([E('photo-old.png', 0)], [
    { type: 'replace', find: '-old', replaceWith: '' },
    { type: 'number', start: 1, position: 'prefix', width: 2 },
    { type: 'ext', ext: 'webp' }
  ])
  assert.equal(rows[0].newName, '01_photo.webp')
})

console.log('冲突检测矩阵')
ok('批内同目录同名冲突（后者标注，先到者放行）', () => {
  const rows = applyRules([E('x1.txt', 0), E('x2.txt', 1)], [
    { type: 'replace', find: 'x1', replaceWith: 'same' },
    { type: 'replace', find: 'x2', replaceWith: 'same' }
  ])
  assert.equal(rows[0].error, null)
  assert.equal(rows[1].error, '冲突：同名目标')
  assert.ok(hasBlocked(rows))
})
ok('不同目录同名不冲突', () => {
  const rows = applyRules([E('x1.txt', 0, '/a'), E('x2.txt', 1, '/b')], [
    { type: 'replace', find: 'x1', replaceWith: 'same' },
    { type: 'replace', find: 'x2', replaceWith: 'same' }
  ])
  assert.equal(rows[0].error, null)
  assert.equal(rows[1].error, null)
})
ok('目标撞上队列内未改名文件', () => {
  const rows = applyRules([E('a.txt', 0), E('b.txt', 1)], [{ type: 'replace', find: 'b', replaceWith: 'a' }])
  assert.equal(rows[1].error, '冲突：与现有文件同名')
})
ok('改名后仍是原名不算冲突', () => {
  const rows = applyRules([E('a.txt', 0), E('a.txt', 1, '/other')], [])
  assert.equal(rows[0].error, null)
})
ok('非法结果名标注（替换出 / 的）', () => {
  const rows = applyRules([E('a.txt')], [{ type: 'replace', find: 'a', replaceWith: 'x/y' }])
  assert.ok(rows[0].error)
  assert.ok(hasBlocked(rows))
})

console.log(`\n${passed} assertions groups passed${process.exitCode ? ' (WITH FAILURES)' : ''}`)
