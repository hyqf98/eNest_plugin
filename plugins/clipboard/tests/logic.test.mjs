/** 纯逻辑自测：password-kit 熵/密码短语、clipboard 文本变换。
    运行：node --test plugins-logic.test.mjs （需 Node 18+，WebCrypto 走 globalThis.crypto） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const pwCore = await import(join(root, 'plugins/password-kit/src/js/core.mjs'))
const tk = await import(join(root, 'plugins/clipboard/src/js/textkit.js'))

// —— password-kit ——
test('熵估计与生成约束', () => {
  assert.equal(pwCore.entropyEstimate({ length: 16, sets: ['lower', 'upper', 'digit', 'symbol'] }), 99)
  assert.throws(() => pwCore.generatePassword({ length: 3 }), /6–128/)
  assert.throws(() => pwCore.generatePassword({ length: 8, sets: [] }), /至少选择一种字符集/)
})
test('生成密码满足每类至少一个字符', () => {
  for (let i = 0; i < 30; i++) {
    const pw = pwCore.generatePassword({ length: 12, sets: ['lower', 'upper', 'digit', 'symbol'] })
    assert.equal(pw.length, 12)
    assert.match(pw, /[a-z]/)
    assert.match(pw, /[A-Z]/)
    assert.match(pw, /[0-9]/)
    assert.ok(/[!@#$%^&*_\-+=?]/.test(pw), '含符号')
  }
})
test('PIN：长度与纯数字', () => {
  const pin = pwCore.generatePin(8)
  assert.equal(pin.length, 8)
  assert.match(pin, /^\d{8}$/)
  assert.throws(() => pwCore.generatePin(2), /4–16/)
  assert.equal(pwCore.pinEntropy(6), 19)
})
test('密码短语：词数、分隔符、熵', () => {
  const phrase = pwCore.generatePassphrase({ words: 5, separator: '.', capitalize: true })
  const parts = phrase.split('.')
  assert.ok(parts.length === 5 || parts.length === 6, '5 词或带数字后缀 6 段')
  const words = parts.filter((p) => /^[A-Z][a-z]+$/.test(p))
  assert.equal(words.length, 5)
  for (const w of words) assert.ok(pwCore.PASSPHRASE_WORDLIST.includes(w.toLowerCase()), '词在词表内')
  assert.ok(pwCore.passphraseEntropy({ words: 5 }) >= 59)
  // 空分隔符
  const joined = pwCore.generatePassphrase({ words: 3, separator: '', appendNumber: false })
  assert.doesNotMatch(joined, /[.\-_ ]/)
})
test('词表无重复且规模稳定', () => {
  const list = pwCore.PASSPHRASE_WORDLIST
  assert.equal(new Set(list).size, list.length)
  assert.ok(list.length > 1400)
})
test('检查器：guessEntropy 与规则提示', () => {
  assert.ok(pwCore.guessEntropy('Tr0ub4dour&3') > 40)
  assert.equal(pwCore.guessEntropy(''), 0)
  assert.ok(pwCore.guessEntropy('123456') < 30)
  const issues = pwCore.strengthIssues('123456')
  assert.ok(issues.some((s) => s.includes('12 位')))
  assert.ok(pwCore.strengthIssues('abcdefgh1').some((s) => s.includes('大写')))
  assert.ok(pwCore.crackTimeEstimate(128).seconds > pwCore.crackTimeEstimate(40).seconds)
})

// —— clipboard textkit ——
test('formatJson：格式化与压缩、非法输入报错', () => {
  assert.equal(tk.formatJson('{"a":1}'), '{\n  "a": 1\n}')
  assert.equal(tk.formatJson(' { "a" : [ 1 , 2 ] } ', { minify: true }), '{"a":[1,2]}')
  assert.throws(() => tk.formatJson('{bad}'), SyntaxError)
})
test('uniqueLines / sortLines', () => {
  assert.equal(tk.uniqueLines('a\nb\na\n b \nc'), 'a\nb\nc')
  assert.equal(tk.uniqueLines('a\n\nb', { dropEmpty: true }), 'a\nb')
  assert.equal(tk.sortLines('b\na\nc'), 'a\nb\nc')
  assert.equal(tk.sortLines('b\na\nc', 'desc'), 'c\nb\na')
})
test('changeCase 六种', () => {
  assert.equal(tk.changeCase('hello world', 'upper'), 'HELLO WORLD')
  assert.equal(tk.changeCase('HeLLo World', 'lower'), 'hello world')
  assert.equal(tk.changeCase('hello world', 'camel'), 'helloWorld')
  assert.equal(tk.changeCase('helloWorld', 'snake'), 'hello_world')
  assert.equal(tk.changeCase('hello world', 'kebab'), 'hello-world')
  assert.equal(tk.changeCase('hello world', 'title'), 'Hello World')
})
test('stripFormatting / regexReplace', () => {
  assert.equal(tk.stripFormatting('  a \n\n b\tc  '), 'a b c')
  assert.equal(tk.regexReplace('a1b22c333', '\\d+', '-'), 'a-b-c-')
  assert.equal(tk.regexReplace('john smith', '(\\w+) (\\w+)', '$2 $1'), 'smith john')
  assert.throws(() => tk.regexReplace('x', '(', 'y'), /正则表达式无效/)
  assert.throws(() => tk.regexReplace('x', '', 'y'), /为空/)
})
test('normalizeSnippet：默认标题与截断', () => {
  const s = tk.normalizeSnippet({ body: '  first line\nsecond' })
  assert.equal(s.title, 'first line')
  assert.equal(s.body, '  first line\nsecond')
  assert.throws(() => tk.normalizeSnippet({ body: '   ' }), /为空/)
  const long = tk.normalizeSnippet({ body: 'x'.repeat(6000), maxBody: 5000 })
  assert.equal(long.body.length, 5000)
})
