import test from 'node:test'
import assert from 'node:assert/strict'
import { diagramLabelStart, fenceClosing, fenceContentRange, fenceOpening, htmlTextStart, mathContentStart } from '../src/cm/clickMap.js'
import { widgetSourceRange } from '../src/cm/widgetSource.js'

test('code hit testing shares the original UTF-16 text, including leading blank lines and trailing whitespace', () => {
  const source = '  ~~~~JS title\n\nconst 名称 = "😀"  \n~~~\n  ~~~~'
  const { from, to, info } = fenceContentRange(source)
  assert.equal(info, 'js')
  assert.equal(source.slice(from, to), '\nconst 名称 = "😀"  \n~~~')
  assert.equal(from + source.slice(from, to).indexOf('😀'), source.indexOf('😀'))
})

test('only compatible fence markers close a block', () => {
  assert.deepEqual(fenceOpening(' ~~~~ A `B` '), { marker: '~~~~', info: 'A `B`' })
  assert.equal(fenceOpening('```A`B`'), null)
  assert.equal(fenceClosing('   ~~~~~ \t', '~~~~'), true)
  for (const closing of ['```', '~~~', '    ~~~~', '~~~~ more']) {
    const source = `~~~~\nbody\n${closing}`
    const { from, to } = fenceContentRange(source)
    assert.equal(source.slice(from, to), `body\n${closing}`)
  }
})

test('empty and unclosed fences keep valid positions', () => {
  assert.deepEqual(fenceContentRange('```\n```'), { from: 4, to: 4, info: '' })
  assert.deepEqual(fenceContentRange('```js'), { from: 5, to: 5, info: 'js' })
  assert.deepEqual(fenceContentRange('~'), null)
})

test('diagram and math clicks can enter the source without selecting a delimiter', () => {
  const diagram = '```mermaid\ngraph TD\n```'
  assert.equal(fenceContentRange(diagram).from, diagram.indexOf('graph'))
  for (const source of ['$$x+y$$', '  $$ \n    x ^ 2\n$$']) {
    assert.equal(mathContentStart(source), source.indexOf('x'))
  }
})

test('only unambiguous literal diagram labels and HTML text nodes get interior caret positions', () => {
  const diagram = 'graph LR\n A[想法] --> B{写下来?}\n B -->|是| C["结构化"]\n C --> D[重复]\n D --> E[重复]'
  for (const label of ['想法', '写下来?', '是', '结构化']) assert.equal(diagramLabelStart(diagram, label), diagram.indexOf(label))
  for (const ambiguous of ['graph', 'LR', '重复', '法', '不存在']) assert.equal(diagramLabelStart(diagram, ambiguous), null)
  const html = '<span title="title">正文</span><b>正文二</b>'
  assert.equal(htmlTextStart(html, '正文二'), html.indexOf('正文二'))
  assert.equal(htmlTextStart(html, '正文'), null)
  assert.equal(htmlTextStart(html, 'title'), null)
})

test('widget hit testing resolves only live DOM in this document, not another occurrence or an obsolete offset', () => {
  const source = '```js\n名字\n```'
  const documentText = `${source}\n\n${source}`
  const second = documentText.lastIndexOf(source)
  const dom = { isConnected: true }
  const view = {
    contentDOM: { contains: candidate => candidate === dom },
    state: { doc: { length: documentText.length }, sliceDoc: (from, to) => documentText.slice(from, to) },
    posAtDOM: () => second,
  }
  assert.deepEqual(widgetSourceRange(view, dom, source), { from: second, to: second + source.length })
  assert.equal(widgetSourceRange(view, { isConnected: true }, source), null)
  assert.equal(widgetSourceRange(view, dom, 'obsolete'), null)
  view.posAtDOM = () => { throw new Error('no longer in the editor') }
  assert.equal(widgetSourceRange(view, dom, source), null)
  dom.isConnected = false
  assert.equal(widgetSourceRange(view, dom, source), null)
})
