import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { EditorView, ViewPlugin, highlightActiveLine, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { createInlinePlugin, inlineMarkdownSyntax } from './inlineDecorations.js'
import { initialLiveState, liveField, setComposing, setEditorFocus, setLiveOpts, toggleLive } from './liveBlocks.js'
import { parseBlocks } from './blocks.js'
import { blockPointerSelection } from './blockWidgets.js'
import { tableNavigationKeymap } from './tableUI.js'
import { changedText } from '../js/textChange.js'
import { wrapSelection, toggleLinePrefix, insertBlock, FENCE_TEXT, TABLE_TEXT, LINK_TEXT, IMAGE_TEXT } from './formatOps.js'

const listeners = new WeakMap()
const setTypewriterEffect = StateEffect.define()
const typewriterField = StateField.define({
  create: () => false,
  update(value, transaction) {
    return transaction.effects.find(effect => effect.is(setTypewriterEffect))?.value ?? value
  },
  provide: field => EditorView.contentAttributes.from(field, enabled => ({ 'data-typewriter': enabled ? 'on' : 'off' }))
})

export function setTypewriter(view, enabled) {
  if (view.state.field(typewriterField) !== enabled) view.dispatch({ effects: setTypewriterEffect.of(enabled) })
}

const typewriterScroll = ViewPlugin.fromClass(class {
  update(update) {
    const { view } = update
    if (!update.selectionSet && !update.docChanged) return
    if (!view.state.field(typewriterField) || !view.hasFocus || !view.state.selection.main.empty) return
    if (update.transactions.some(transaction => transaction.isUserEvent('select.pointer'))) return
    view.requestMeasure({
      key: this,
      read(editor) {
        if (!editor.hasFocus || editor.composing || !editor.state.field(typewriterField)) return 0
        const caret = editor.coordsAtPos(editor.state.selection.main.head, editor.state.selection.main.assoc || 1)
        if (!caret) return 0
        const viewport = editor.scrollDOM.getBoundingClientRect()
        return (caret.top + caret.bottom - viewport.top - viewport.bottom) / 2
      },
      write(delta, editor) { if (Math.abs(delta) > 8) editor.scrollDOM.scrollTop += delta }
    })
  }
})

const compositionGuard = ViewPlugin.fromClass(class {
  constructor(view) { this.win = view.dom.ownerDocument.defaultView; this.frame = 0 }
  destroy() { this.win.cancelAnimationFrame(this.frame) }
}, { eventHandlers: {
  compositionstart(_event, view) {
    this.win.cancelAnimationFrame(this.frame)
    view.dispatch({ effects: setComposing.of(true) })
    return false
  },
  compositionend(_event, view) {
    this.win.cancelAnimationFrame(this.frame)
    this.frame = this.win.requestAnimationFrame(() => {
      if (!view.compositionStarted) view.dispatch({ effects: setComposing.of(false) })
    })
    return false
  }
} })

const formatKeymap = [
  { key: 'Mod-b', run: view => wrapSelection(view, '**') },
  { key: 'Mod-i', run: view => wrapSelection(view, '*') },
  { key: 'Mod-e', run: view => wrapSelection(view, '`') },
  { key: 'Mod-k', run: view => insertBlock(view, LINK_TEXT, 1) },
  { key: 'Mod-Shift-k', run: view => insertBlock(view, IMAGE_TEXT, 2) },
  { key: 'Mod-Shift-l', run: view => insertBlock(view, FENCE_TEXT, 4) },
  { key: 'Mod-Shift-g', run: view => insertBlock(view, TABLE_TEXT, 2) },
  { key: 'Mod-Shift-7', run: view => toggleLinePrefix(view, '- [ ] ') },
  { key: 'Mod-Shift-8', run: view => toggleLinePrefix(view, '- ') },
  { key: 'Mod-Shift-9', run: view => toggleLinePrefix(view, '1. ') },
  { key: 'Mod-Shift-u', run: view => toggleLinePrefix(view, '> ') },
  ...[1, 2, 3, 4, 5, 6].map(level => ({ key: `Mod-${level}`, run: view => toggleLinePrefix(view, '#'.repeat(level) + ' ') })),
  { key: 'Mod-/', run: view => toggleLive(view) }
]

const searchPanelTheme = EditorView.baseTheme({
  '.cm-panel.cm-search': { padding: '8px 10px', background: 'var(--surface, #fff)', borderTop: '1px solid var(--border, #ddd)', fontFamily: 'var(--font, inherit)', fontSize: '12.5px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' },
  '.cm-panel.cm-search input[type=text], .cm-panel.cm-search button': { padding: '4px 8px', border: '1px solid var(--border, #ddd)', borderRadius: '7px', background: 'var(--bg, #fafafa)', color: 'var(--text, #222)' },
  '.cm-searchMatch': { background: 'color-mix(in srgb, var(--accent, #3b82f6) 25%, transparent)' },
  '.cm-searchMatch-selected': { outline: '1px solid var(--accent, #3b82f6)' }
})

function createState(doc, { opts, live = true, typewriter = false, editing = false, selection } = {}) {
  return EditorState.create({
    doc, selection,
    extensions: [
      history(), highlightSelectionMatches(), highlightActiveLine(),
      markdown({ base: markdownLanguage, extensions: [inlineMarkdownSyntax], codeLanguages: languages }),
      keymap.of([...tableNavigationKeymap, ...formatKeymap, ...historyKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
      EditorView.lineWrapping, searchPanelTheme, blockPointerSelection,
      liveField.init(state => initialLiveState(state, opts, live, editing)),
      createInlinePlugin(liveField),
      typewriterField.init(() => typewriter), typewriterScroll, compositionGuard,
      EditorView.focusChangeEffect.of((_state, focus) => setEditorFocus.of(focus)),
      EditorView.updateListener.of(update => {
        const setup = listeners.get(update.view)
        if (!setup) return
        if (update.docChanged) setup.onChange?.(update.state.doc.toString(), update.state.field(liveField).blocks)
        if (update.selectionSet) setup.onSelection?.(update.state.selection.main.head)
        const enabled = update.state.field(liveField).config.enabled
        if (enabled !== update.startState.field(liveField).config.enabled) setup.onLiveChange?.(enabled)
      }),
      EditorView.contentAttributes.of({ spellcheck: 'false', id: 'write', 'aria-label': 'Markdown 正文', 'aria-multiline': 'true' }),
      EditorView.editorAttributes.from(liveField, field => ({ 'data-md-source': field.config.enabled ? 'off' : 'on' })),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'inherit' }, '.cm-activeLine': { backgroundColor: 'transparent' } })
    ]
  })
}

export function createEditor({ parent, initialText, opts = {}, onChange, onSelection, onLiveChange, live = true, typewriter = false, focus = true }) {
  const state = createState(initialText, { opts, live, typewriter, editing: focus })
  const view = new EditorView({ state, parent })
  listeners.set(view, { onChange, onSelection, onLiveChange })
  if (focus) view.focus()
  return view
}

export function resetEditorDocument(view, text, { preserveSelection = false, opts } = {}) {
  const previous = view.state
  const doc = previous.toText(text)
  const { config } = previous.field(liveField)
  if (preserveSelection && doc.eq(previous.doc)) return
  const selection = preserveSelection ? previous.selection.map(previous.changes(changedText(previous.doc.toString(), doc.toString())), 1) : undefined
  const scrollTop = preserveSelection ? view.scrollDOM.scrollTop : 0
  view.setState(createState(doc, { opts: opts ?? config.opts, live: config.enabled, typewriter: previous.field(typewriterField), editing: view.hasFocus, selection }))
  view.scrollDOM.scrollTop = scrollTop
}

export function updateLiveOpts(view, opts, syncFocus = false) {
  const effects = []
  if (view.state.field(liveField).config.opts !== opts) effects.push(setLiveOpts.of(opts))
  if (syncFocus) effects.push(setEditorFocus.of(view.hasFocus), setComposing.of(false))
  if (effects.length) view.dispatch({ effects })
  view.requestMeasure()
}

export function extractOutline(text, blocks = parseBlocks(text)) {
  return blocks.filter(block => block.type === 'heading').map(block => ({
    level: block.level, text: block.style === 'setext' ? block.text.slice(0, block.text.lastIndexOf('\n')).trim().replace(/\s+/g, ' ') : block.text.replace(/^ {0,3}#{1,6}(?:\s+|$)/, '').replace(/\s+#+\s*$/, '').trim(), from: block.from
  }))
}

export function computeStats(text) {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const words = cjk + (text.match(/[A-Za-z0-9_'-]+/g) || []).length
  return { chars: text.length, words, lines: text.split('\n').length, readMinutes: Math.max(1, Math.round(words / 300)) }
}

export { parseBlocks, toggleLive, EditorView, EditorState, markdown }
