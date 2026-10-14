import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { loadManifestValidator } from './validate-manifests.mjs'

const validate = loadManifestValidator()
const manifest = (cmds) => ({
  id: 'com.test.commands', name: 'Commands', version: '1.0.0', main: 'index.html', description: 'fixture',
  icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: [] },
  features: [{ code: 'feature', cmds }]
})

test('manifest schema accepts mixed text, regex and over commands', () => {
  assert.equal(validate(manifest([
    '翻译',
    { type: 'regex', label: '链接', match: '/^https?:\\/\\//i', minLength: 1 },
    { type: 'regex', label: '兼容', regex: '/value/' },
    { type: 'over', label: '搜索', exclude: '/^skip/i', minLength: 1, maxLength: 10000 }
  ])), true, JSON.stringify(validate.errors))
})

test('manifest schema rejects missing rules, unsupported context types and invalid fields', () => {
  for (const cmd of [
    ' ', { type: 'regex', label: '没有表达式' }, { type: 'regex', label: '链接', match: 'https://' },
    { type: 'regex', label: '', match: '/x/' }, { type: 'over', label: '文本', minLength: -1 },
    { type: 'over', label: '文本', maxLength: 1.5 }, { type: 'over', label: '文本', exclude: '/x/zz' },
    { type: 'over', label: '文本', minLenght: 1 }, { type: 'img', label: '图片' },
    { type: 'files', label: '文件' }, { type: 'regex', label: '过长', match: `/${'x'.repeat(2047)}/` }
  ]) assert.equal(validate(manifest([cmd])), false, JSON.stringify(cmd))
})

test('sample text handlers keep name commands and bound content recommendations', () => {
  const readPlugin = (id) => JSON.parse(readFileSync(new URL(`../plugins/${id}/plugin.json`, import.meta.url), 'utf8'))
  const translate = readPlugin('com.enest.translate')
  const todos = readPlugin('com.enest.todos')
  const calculator = readPlugin('com.enest.calculator')
  for (const plugin of [translate, todos, calculator]) {
    assert.equal(validate(plugin), true, `${plugin.id}: ${JSON.stringify(validate.errors)}`)
  }
  const commands = (plugin) => plugin.features.find((feature) => feature.code === 'main').cmds
  assert.deepEqual(commands(translate).filter((cmd) => typeof cmd === 'string'), ['翻译', 'translate', 'fy'])
  assert.deepEqual(commands(todos).filter((cmd) => typeof cmd === 'string'), ['todo', '待办', '清单'])
  assert.deepEqual(commands(calculator).filter((cmd) => typeof cmd === 'string'), ['计算器', 'calc', 'js'])
  assert.deepEqual(commands(translate).find((cmd) => cmd.type === 'over'), {
    type: 'over', label: '翻译文本', minLength: 1, maxLength: 10000
  })
  assert.deepEqual(commands(todos).find((cmd) => cmd.type === 'over'), {
    type: 'over', label: '添加到待办', minLength: 1, maxLength: 500
  })

  const command = commands(calculator).find((cmd) => cmd.type === 'regex')
  assert.equal(command.minLength, 3)
  // Only the trusted expression shipped by this repository is executed in this test.
  const delimiter = command.match.lastIndexOf('/')
  const pattern = new RegExp(command.match.slice(1, delimiter), command.match.slice(delimiter + 1))
  for (const input of ['1 + 2', '(3.5*2)-1', '2^8', '10%3', '.5 / 2', '1+\n2', `1+${'1'.repeat(4094)}`]) {
    assert.equal(pattern.test(input), true, input)
  }
  for (const input of ['12', 'hello', 'https://example.com/1+2', 'alert(1)', '1;2', '1+2=3', `${'1'.repeat(4095)}+1`, `1+${'1'.repeat(4094)}\n`]) {
    assert.equal(pattern.test(input), false, input)
  }
})
