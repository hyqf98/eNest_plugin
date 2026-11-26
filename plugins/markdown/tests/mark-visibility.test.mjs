import test from 'node:test'
import assert from 'node:assert/strict'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import MarkdownIt from 'markdown-it'
import { createInlinePlugin, inlineMarkDecorations, selectionTouches } from '../src/cm/inlineDecorations.js'
import { InlineImage, InlineMath, TaskCheckbox } from '../src/cm/inlineWidgets.js'
import { inlineMarkdownSyntax, renderTaskLists } from '../src/render/inlineSyntax.js'

const language = markdown({ base: markdownLanguage, extensions: [inlineMarkdownSyntax] })
const live = { config: { enabled: true, editing: true }, blocks: [] }
function entries(set) {
  const result = []
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    result.push({ from: cursor.from, to: cursor.to, ...cursor.value.spec })
  }
  return result
}
function marks(doc, selection, model = live) {
  const state = EditorState.create({ doc, selection, extensions: [language, EditorState.allowMultipleSelections.of(true)] })
  return entries(inlineMarkDecorations(state, [{ from: 0, to: doc.length }], model, new Map()))
}
function media(doc, selection) {
  const field = StateField.define({ create: () => live, update: previous => previous })
  const state = EditorState.create({ doc, selection, extensions: [language, field, createInlinePlugin(field)] })
  return state.facet(EditorView.decorations).filter(value => typeof value !== 'function').flatMap(entries)
}

test('真实选区触及语法两端才揭示，不向左右多一字；非空选区按半开区间相交', () => {
  assert.equal(selectionTouches([{ from: 1, to: 1 }], 2, 8), false)
  assert.equal(selectionTouches([{ from: 8, to: 8 }], 2, 8), true)
  assert.equal(selectionTouches([{ from: 8, to: 8 }], 2, 8, false), false)
  assert.equal(selectionTouches([{ from: 8, to: 12 }], 2, 8), false)
  assert.equal(selectionTouches([{ from: 0, to: 1 }, { from: 5, to: 9 }], 2, 8), true)
})

test('点在中文粗体第二个字始终是同一源码下标，两个定界符只成对展开', () => {
  const doc = '前 **粗体** 后'
  const source = marks(doc, { anchor: doc.indexOf('体') })
  const syntax = source.filter(part => part.class === 'md-syntax-marker')
  assert.deepEqual(syntax.map(({ from, to }) => [from, to]), [[2, 4], [6, 8]])
  assert.deepEqual(source.find(part => part.class === 'md-strong'), { from: 4, to: 6, class: 'md-strong' })
  const rendered = marks(doc, { anchor: 0 })
  assert.deepEqual(rendered.filter(part => !part.class && !part.widget), [{ from: 2, to: 4 }, { from: 6, to: 8 }])
  assert.deepEqual(marks(doc, { anchor: 5 }, { ...live, config: { enabled: true, editing: false } }), rendered)
})

test('多选区可同时编辑高亮和强调，引用前缀永远是真实文字而非占位 widget', () => {
  const doc = '> ==高亮== 和 *斜体*'
  const selection = EditorSelection.create([EditorSelection.cursor(doc.indexOf('亮')), EditorSelection.cursor(doc.indexOf('体'))])
  const parts = marks(doc, selection)
  assert.equal(parts.filter(part => part.class === 'md-syntax-marker').length, 4)
  assert.deepEqual(parts.find(part => part.class === 'md-quote-prefix'), { from: 0, to: 1, class: 'md-quote-prefix' })
  assert.equal(marks(doc, { anchor: 0 }).find(part => part.from === 0).class, 'md-syntax-marker')
})

test('表格、元数据、代码块、行内代码中的标记不产生正文公式或高亮', () => {
  const doc = '正文 `==保留== $x$`\n\n```md\n==字面量== $y$\n```\n\n| 值 |\n| --- |\n| $z$ |'
  assert.ok(marks(doc, { anchor: 0 }).some(part => part.class === 'md-code'))
  assert.ok(!marks(doc, { anchor: 0 }).some(part => part.class === 'md-highlight'))
  assert.ok(!media(doc, { anchor: 0 }).some(part => part.widget instanceof InlineMath))
  const source = '---\n标题: ==原样==\n---'
  assert.ok(!marks(source, { anchor: 0 }, { ...live, blocks: [{ type: 'meta', from: 0, to: source.length }] }).some(part => part.class === 'md-highlight'))
})

test('公式和重复引用图片保留各自源码范围；进入其中一个不影响另一处', () => {
  const image = '![同图][id]{width=40%}', formula = '$e^{i\\pi}+1=0$'
  const doc = `${image}\n\n${formula}\n\n${image}\n\n[id]: <assets/图.png>`
  const values = media(doc, { anchor: doc.lastIndexOf(image) + 3 })
  assert.deepEqual(values.filter(part => part.widget instanceof InlineImage).map(({ from, to }) => [from, to]), [[0, image.length]])
  assert.equal(values.find(part => part.widget instanceof InlineImage).widget.image.url, 'assets/图.png')
  assert.deepEqual(values.filter(part => part.widget instanceof InlineMath).map(({ from, to }) => doc.slice(from, to)), [formula])
})

test('嵌套代码中的等号不截断高亮；转义、未闭合与美元价格保留原文', () => {
  const doc = '😀 ==`a==b` **亮**==；\\$转义；$20 和 $30；==未闭合'
  const parts = marks(doc, { anchor: 0 })
  assert.equal(doc.slice(parts.find(part => part.class === 'md-highlight').from, parts.find(part => part.class === 'md-highlight').to), '`a==b` **亮**')
  assert.ok(parts.some(part => part.class === 'md-code'))
  assert.ok(parts.some(part => part.class === 'md-strong'))
  assert.ok(!media(doc, { anchor: 0 }).some(part => part.widget instanceof InlineMath))
})

test('只有 GFM 任务项呈现复选框；编辑列表前缀时保留完整的 Markdown 标记', () => {
  const doc = '- [x] 完成\n- 普通 [x] 文本\n\n普通 [ ] 提示'
  const preview = marks(doc, { anchor: doc.length })
  assert.equal(preview.filter(part => part.widget instanceof TaskCheckbox).length, 1)
  assert.ok(!marks(doc, { anchor: 0 }).some(part => part.widget instanceof TaskCheckbox))
  const exported = new MarkdownIt().use(renderTaskLists).render(`${doc}\n\n[x]: /target`)
  assert.equal(exported.match(/type="checkbox"/g).length, 1)
  assert.match(exported, /disabled checked/)
  assert.match(exported, /普通 <a href="\/target">x<\/a> 文本/)
})
