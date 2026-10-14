import { SqlEditor as LightweightEditor } from './editor.js'
import { statementAtCursor } from './tokenizer.js'
import { requestCompletion } from './completion.js'
import { api } from './api.js'
import { normalizeShortcut, loadMonaco as loadRuntime } from '@enest/plugin-kit/workbench'

export const queryLanguage = (driver) => /mongo|redis|elasticsearch|opensearch/.test(driver) ? 'json' : driver === 'influxdb' || driver === 'influxdb2' ? 'flux' : driver === 'neo4j' ? 'cypher' : 'sql'

/** One retained model per document across Quick and desktop surfaces. */
export class SqlEditor extends LightweightEditor {
  constructor(root, options) {
    super(root, options)
    this.models = new Map(); this.viewStates = new Map(); this.surface = 'quick'; this.documentId = 'draft'; this.disposables = []
    this.monacoHost = document.createElement('div'); this.monacoHost.className = 'monaco-host'; this.monacoHost.hidden = true; root.append(this.monacoHost)
    this.el.ta.setAttribute('aria-label', '查询编辑器')
  }
  _handleKeydown(event) {
    if (this.commandRegistry && ['Mod+Enter', 'Mod+Shift+Enter', 'Mod+S', 'F5'].includes(normalizeShortcut(event))) return
    super._handleKeydown(event)
  }
  get usingMonaco() { return !!this.instance }
  async setSurface(surface, connected) {
    if (surface === 'quick' && this.usingMonaco) this.syncTextArea()
    this.surface = surface
    if (connected && !this.instance && !this.loading) {
      this.loading = this.enhance().catch((error) => {
        this.root.dataset.editorError = '本地编辑器加载失败，请运行插件构建后重试'
        console.error('Local editor unavailable', error)
      }).finally(() => { this.loading = null })
      await this.loading
    }
    this.monacoHost.hidden = !this.usingMonaco
    this.root.querySelector('.sql-editor').hidden = this.usingMonaco
    if (this.usingMonaco) { this.activateModel(); this.instance.updateOptions({ lineNumbers: surface === 'quick' ? 'off' : 'on', fontSize: surface === 'quick' ? 12 : this.fontSize || 13, padding: { top: surface === 'quick' ? 5 : 14, bottom: surface === 'quick' ? 5 : 14 } }); this.instance.layout() }
  }
  async enhance() {
    const { monaco, format } = await loadRuntime()
    this.monaco = monaco; this.format = format
    if (!monaco.languages.getLanguages().some((language) => language.id === 'flux')) {
      monaco.languages.register({ id: 'flux' })
      monaco.languages.setMonarchTokensProvider('flux', { tokenizer: { root: [[/\/\/.*$/, 'comment'], [/"(?:[^"\\]|\\.)*"/, 'string'], [/\b(?:from|range|filter|map|yield|aggregateWindow|group|pivot|keep|drop|sort|limit|join|union)\b/, 'keyword'], [/\b\d+(?:\.\d+)?(?:ms|s|m|h|d|w)?\b/, 'number'], [/[|>=!:]+/, 'operator']] } })
    }
    if (!monaco.languages.getLanguages().some((language) => language.id === 'cypher')) { monaco.languages.register({ id: 'cypher' }); monaco.languages.setMonarchTokensProvider('cypher', { tokenizer: { root: [[/\/\/.*$/, 'comment'], [/"[^"]*"|'[^']*'/, 'string'], [/\b(?:MATCH|WHERE|RETURN|WITH|OPTIONAL|CREATE|MERGE|SET|DELETE|DETACH|UNWIND|ORDER|BY|LIMIT|SKIP|AS)\b/i, 'keyword'], [/\b\d+\b/, 'number']] } }) }
    this.instance = monaco.editor.create(this.monacoHost, {
      automaticLayout: true, model: null, minimap: { enabled: false }, fontSize: this.fontSize || 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 },
      fixedOverflowWidgets: true, tabSize: 2, insertSpaces: true, wordWrap: 'off',
      accessibilitySupport: 'auto', ariaLabel: 'SQL 查询编辑器', quickSuggestions: true,
      suggest: { showKeywords: true, snippetsPreventQuickSuggestions: false },
      theme: document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs'
    })
    this.disposables.push(this.instance.onDidChangeModelContent(() => {
      if (this.syncing) return
      this.syncTextArea(); this.onChange(this.instance.getValue(), this.getCursor())
    }))
    this.disposables.push(this.instance.onDidFocusEditorText(() => api?.ui?.setInputContext?.('editor')))
    this.disposables.push(monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems: async (model, position, _context, token) => {
        if (model !== this.instance.getModel()) return { suggestions: [] }
        const sql = model.getValue(), cursor = model.getOffsetAt(position), scope = this.getCompletionScope()
        const result = await requestCompletion({ sql, cursor, dialect: this.getDialect(), sessionKey: this.getSessionKey(), ...scope })
        if (token.isCancellationRequested) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const from = model.getPositionAt(result.replace?.from ?? cursor - word.word.length), to = model.getPositionAt(result.replace?.to ?? cursor)
        return { suggestions: (result.items || []).map((item, index) => ({ label: item.label, insertText: item.insertText || item.label, detail: item.detail || item.owner, documentation: item.doc, sortText: String(index).padStart(5, '0'), kind: monaco.languages.CompletionItemKind[item.kind === 'column' ? 'Field' : item.kind === 'function' ? 'Function' : item.kind === 'keyword' ? 'Keyword' : 'Class'], range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column) })) }
      }
    }))
    this.disposables.push(monaco.languages.registerDocumentFormattingEditProvider('sql', {
      provideDocumentFormattingEdits: (model) => {
        try { return [{ range: model.getFullModelRange(), text: format(model.getValue(), { language: this.formatDialect(), keywordCase: 'upper', tabWidth: 2 }) }] } catch { return [] }
      }
    }))
    const syncTheme = () => {
      const style = getComputedStyle(document.documentElement), dark = document.documentElement.dataset.theme === 'dark'
      const color = (key, fallback) => { const v = style.getPropertyValue(key).trim(); if (/^#[a-f\d]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join(''); if (/^#[a-f\d]{6,8}$/i.test(v)) return v.slice(0, 7); const match = v.match(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/); return match ? '#' + match.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : fallback }
      const bg = color('--bg', dark ? '#202228' : '#ffffff'), fg = color('--text', dark ? '#dedee3' : '#252932'), accent = color('--accent', '#517ad4')
      monaco.editor.defineTheme('enest-workbench', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: { 'editor.background': bg, 'editor.foreground': fg, 'editorGutter.background': bg, 'editorLineNumber.foreground': color('--text-3', '#8d9098'), 'editorCursor.foreground': accent, 'editor.selectionBackground': accent + '40', 'editorWidget.background': color('--surface', bg), 'editorWidget.border': color('--border', '#999999'), 'focusBorder': accent } })
      monaco.editor.setTheme('enest-workbench')
      this.instance.updateOptions({ fontFamily: style.getPropertyValue('--mono') })
    }
    syncTheme()
    this.themeObserver = new MutationObserver(syncTheme)
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'style'] })
    this.activateModel()
  }
  formatDialect() { return ({ mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgresql', timescale: 'postgresql', cockroachdb: 'postgresql', yugabytedb: 'postgresql', questdb: 'postgresql', tidb: 'mysql', oceanbase: 'mysql', doris: 'mysql', starrocks: 'mysql', mssql: 'transactsql', sqlserver: 'transactsql', oracle: 'plsql', sqlite: 'sqlite' })[this.getDialect()] || 'sql' }
  activateDocument(id, sql = '', cursor) {
    if (this.instance && this.documentId !== id) this.viewStates.set(this.documentId, this.instance.saveViewState())
    this.documentId = id || 'draft'
    super.setValue(sql, { cursor, silent: true })
    if (this.instance) this.activateModel(sql)
  }
  activateModel(sql = this.el.ta.value) {
    if (!this.instance) return
    let model = this.models.get(this.documentId)
    if (!model) { model = this.monaco.editor.createModel(sql, queryLanguage(this.getDialect()), this.monaco.Uri.parse(`enest-query:///${this.documentId}`)); this.models.set(this.documentId, model) }
    else if (model.getValue() !== sql) { this.syncing = true; model.pushStackElement(); model.pushEditOperations([], [{ range: model.getFullModelRange(), text: sql }], () => null); model.pushStackElement(); this.syncing = false }
    if (this.instance.getModel() !== model) { this.instance.setModel(model); this.instance.restoreViewState(this.viewStates.get(this.documentId) || null) }
    this.monaco.editor.setModelLanguage(model, queryLanguage(this.getDialect()))
  }
  disposeDocument(id) { const model = this.models.get(id); if (model === this.instance?.getModel()) this.instance.setModel(null); model?.dispose(); this.models.delete(id); this.viewStates.delete(id) }
  syncTextArea() { if (this.instance?.getModel()) { this.el.ta.value = this.instance.getValue(); const selection = this.instance.getSelection(); this.el.ta.setSelectionRange(this.instance.getModel().getOffsetAt(selection.getStartPosition()), this.instance.getModel().getOffsetAt(selection.getEndPosition())) } }
  getValue() { return this.usingMonaco ? this.instance.getValue() : super.getValue() }
  getCursor() { const position = this.usingMonaco ? this.instance.getPosition() : null; return position ? { line: position.lineNumber - 1, ch: position.column - 1 } : super.getCursor() }
  setValue(sql, options = {}) { super.setValue(sql, { ...options, silent: true }); if (this.instance) this.activateModel(sql); if (!options.silent) this.onChange(sql, this.getCursor()) }
  setDialect(dialect) { super.setDialect(dialect); if (this.instance?.getModel()) this.monaco.editor.setModelLanguage(this.instance.getModel(), queryLanguage(dialect)) }
  focus() { if (this.usingMonaco) this.instance.focus(); else super.focus() }
  toggleComment() { if (this.usingMonaco) this.instance.getAction('editor.action.commentLine').run(); else super.toggleComment() }
  triggerCompletion(force) { if (this.usingMonaco) this.instance.trigger('enest', 'editor.action.triggerSuggest', {}); else return super.triggerCompletion(force) }
  async formatDocument() { if (this.usingMonaco) return this.instance.getAction('editor.action.formatDocument').run(); const { format } = await loadRuntime(); this.setValue(format(this.getValue(), { language: this.formatDialect(), keywordCase: 'upper' })) }
  insertText(text) { if (this.usingMonaco) this.instance.executeEdits('insert', [{ range: this.instance.getSelection(), text }]); else { const ta = this.el.ta; this.setValue(ta.value.slice(0, ta.selectionStart) + text + ta.value.slice(ta.selectionEnd)) } }
  getSelectionOrStatement(mode) {
    if (!this.usingMonaco) return super.getSelectionOrStatement(mode)
    const model = this.instance.getModel(), sql = model.getValue(), selection = this.instance.getSelection()
    if (mode === 'all') return { sql, start: 0, end: sql.length }
    if (!selection.isEmpty()) return { sql: model.getValueInRange(selection), start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()) }
    return statementAtCursor(sql, model.getOffsetAt(this.instance.getPosition()))
  }
}
