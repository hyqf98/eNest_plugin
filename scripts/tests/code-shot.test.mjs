import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = new URL('../../plugins/', import.meta.url)
function load(relative, name) {
  const context = vm.createContext({ structuredClone })
  vm.runInContext(readFileSync(new URL(relative, root), 'utf8'), context)
  return context[name]
}
const core = load('com.enest.code-shot/src/js/code-core.js', 'CodeCore')
const kinds = tokens => tokens.map(token => token.kind)
const texts = tokens => tokens.map(token => token.text).join('')
const plain = value => JSON.parse(JSON.stringify(value))

// ---------- 语言识别 ----------
test('detects languages from extension hints and structural clues', () => {
  assert.equal(core.detectLanguage('const a = 1', 'main.ts'), 'typescript')
  assert.equal(core.detectLanguage('print(1)', 'x.py'), 'python')
  assert.equal(core.detectLanguage('{"a": 1}'), 'json')
  assert.equal(core.detectLanguage('#!/bin/bash\necho hi'), 'bash')
  assert.equal(core.detectLanguage('def greet(name):\n    return name'), 'python')
  assert.equal(core.detectLanguage('SELECT * FROM users WHERE id = 1'), 'sql')
  assert.equal(core.detectLanguage('fn main() -> i32 { 0 }'), 'rust')
  assert.equal(core.detectLanguage('name := "go"'), 'go')
  assert.equal(core.detectLanguage('public static void main(String[] a) {}'), 'java')
  assert.equal(core.detectLanguage('<div class="a">hi</div>'), 'html')
  assert.equal(core.detectLanguage('let x: number = 1;'), 'typescript')
  assert.equal(core.detectLanguage(''), 'plaintext')
  assert.equal(core.detectLanguage('hello world'), 'plaintext', 'weak signals stay plain')
})

// ---------- tokenizer 基础四类 ----------
test('tokenizer labels keywords, strings, numbers and comments', () => {
  const js = core.tokenize('const n = 42; // count', 'javascript')[0]
  assert.equal(js[0].kind, 'keyword')
  assert.equal(js[0].text, 'const')
  assert.ok(js.some(token => token.kind === 'number' && token.text === '42'))
  assert.deepEqual(plain(js.filter(token => token.kind === 'comment').map(token => token.text)), ['// count'])
  assert.equal(texts(js), 'const n = 42; // count')

  const py = core.tokenize("msg = 'it\\'s ok'  # 注释", 'python')[0]
  assert.ok(py.some(token => token.kind === 'string' && token.text.includes("it\\'s ok")))
  assert.ok(py.some(token => token.kind === 'comment' && token.text.includes('注释')))

  const sql = core.tokenize('SELECT id -- list', 'sql')[0]
  assert.equal(sql[0].kind, 'plain', 'SQL keywords are matched lowercase only')
  assert.equal(sql.find(token => token.kind === 'comment').text, '-- list')

  const sh = core.tokenize('echo "home" # run', 'bash')[0]
  assert.equal(sh[0].kind, 'keyword', 'echo is in the bash keyword list')
  assert.equal(sh[0].text, 'echo')
  assert.ok(sh.some(token => token.kind === 'comment'))
})

test('keywords cover all eleven languages and stay case-sensitive for code, case-insensitive for SQL', () => {
  for (const lang of ['javascript', 'typescript', 'json', 'python', 'java', 'go', 'rust', 'css', 'html', 'sql', 'bash']) {
    assert.ok(core.KEYWORDS[lang].length > 0, lang)
  }
  const sqlLower = core.tokenize('select from where', 'sql')[0].filter(token => token.kind === 'keyword')
  assert.equal(sqlLower.length, 3, 'SQL keywords lowercase hit')
})

test('strings escape correctly and template literals span content', () => {
  const line = core.tokenize('const s = "a\\"b" + `tpl ${x}`', 'javascript')[0]
  const strings = plain(line.filter(token => token.kind === 'string').map(token => token.text))
  assert.deepEqual(strings, ['"a\\"b"', '`tpl ${x}`'])
})

test('multi-line comments do not corrupt a single line and CSS/HTML tokenize', () => {
  const css = core.tokenize('body { color: #fff /* note */ }', 'css')[0]
  assert.ok(css.some(token => token.kind === 'comment' && token.text === '/* note */'))
  assert.ok(css.some(token => token.kind === 'plain' && token.text.includes('body')))
  assert.ok(css.some(token => token.kind === 'plain' && token.text.includes('#fff')), 'color literal stays inline in plain run')
  const html = core.tokenize('<div class="box">text</div>', 'html')[0]
  assert.ok(html.some(token => token.kind === 'keyword' && token.text === '<div'))
  assert.ok(html.some(token => token.kind === 'string' && token.text === '"box"'))
  const comment = core.tokenize('<!-- hidden -->', 'html')[0]
  assert.deepEqual(plain(kinds(comment)), ['comment'])
})

test('tokenize preserves text content and splits lines', () => {
  const source = 'let a = 1\nlet b = 2'
  const lines = core.tokenize(source, 'javascript')
  assert.equal(lines.length, 2)
  assert.equal(lines.map(line => texts(line)).join('\n'), source)
})

// ---------- 排版 ----------
test('layout wraps long lines and keeps gutter numbers on wrap heads', () => {
  const tokens = core.tokenize('const value = "abcdefgh"', 'javascript')
  const rows = core.layoutLines(tokens, 10)
  assert.ok(rows.length > 1, 'wraps into multiple rows')
  assert.equal(rows[0].number, 1)
  assert.equal(rows[1].number, '', 'continuation rows carry no number')
  assert.equal(rows.map(row => row.tokens.map(token => token.text).join('')).join(''), 'const value = "abcdefgh"')
})

test('gutter width follows digit count', () => {
  assert.equal(core.gutterWidth(1), 1)
  assert.equal(core.gutterWidth(9), 1)
  assert.equal(core.gutterWidth(10), 2)
  assert.equal(core.gutterWidth(999), 3)
})

// ---------- 主题派生色板 ----------
test('syntax palette derives only from theme tokens with dark/light fallbacks', () => {
  const dark = core.syntaxPalette({ '--accent': '#e98654', '--ok': '#77bfa4', '--text-2': '#adb3b8', '--surface': '#202326' }, 'dark')
  assert.equal(dark.background, '#202326')
  assert.equal(dark.keyword, '#e98654')
  assert.equal(dark.string, '#77bfa4')
  assert.equal(dark.comment, '#adb3b8')
  const light = core.syntaxPalette({}, 'light')
  assert.equal(light.background, '#ffffff')
  assert.equal(light.plain, '#292c2e')
  const darkFallback = core.syntaxPalette({}, 'dark')
  assert.equal(darkFallback.background, '#202326')
  assert.ok(darkFallback.number === darkFallback.keyword, 'number falls back to accent/link family, no new hue')
})

test('measure returns widest line length', () => {
  assert.equal(core.measure('ab\ncdef'), 4)
  assert.equal(core.measure(''), 0)
})
