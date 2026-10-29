import { SqlEditor as LightweightEditor, completionPresentation, filterCompletionSources, completionTriggerCharacters } from './editor.js'
import { resolveExecutionRange } from './executionRange.js'
import { requestCompletion, requestSignatureHelp, applyCompletionItem, completionContextKey, getCompletionBehavior } from './completion.js'
import { api, toast } from './api.js'
import { loadMonaco as loadRuntime } from '@enest/plugin-kit/workbench'

export const queryLanguage = (driver) => /mongo|redis|elasticsearch|opensearch/.test(driver) ? 'json' : driver === 'influxdb' || driver === 'influxdb2' ? 'flux' : driver === 'neo4j' ? 'cypher' : 'sql'

/** One retained model per document across Quick and desktop surfaces. */
export class SqlEditor extends LightweightEditor {
  constructor(root, options) {
    super(root, options)
    this.models = new Map(); this.viewStates = new Map(); this.surface = 'quick'; this.documentId = 'draft'; this.disposables = []
    this.monacoHost = document.createElement('div'); this.monacoHost.className = 'monaco-host'; this.monacoHost.hidden = true; root.append(this.monacoHost)
    this.el.ta.setAttribute('aria-label', '查询编辑器')
  }
  get usingMonaco() { return !!this.instance }
  get fontSize() { return this._fontSize || 13 }
  set fontSize(value) {
    this._fontSize = Math.max(11, Math.min(24, Number(value) || 13))
    this.instance?.updateOptions(this.editorFontOptions())
  }
  editorFontOptions() {
    const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-size-base'))
    const scale = Number.isFinite(base) ? Math.min(1.3, Math.max(.85, base / 13)) : 1
    const fontSize = this.fontSize * scale
    return { fontSize, suggestFontSize: fontSize, suggestLineHeight: Math.max(28, Math.ceil(fontSize * 1.7)) }
  }
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
    if (this.usingMonaco) { this.activateModel(); this.instance.updateOptions({ lineNumbers: surface === 'quick' ? 'off' : 'on', ...this.editorFontOptions(), padding: { top: surface === 'quick' ? 5 : 14, bottom: surface === 'quick' ? 5 : 14 } }); this.instance.layout() }
  }
  async enhance() {
    const [{ monaco }, { format }] = await Promise.all([loadRuntime(), import('sql-formatter')])
    this.monaco = monaco; this.format = format
    if (!monaco.languages.getLanguages().some((language) => language.id === 'flux')) {
      monaco.languages.register({ id: 'flux' })
      monaco.languages.setMonarchTokensProvider('flux', { tokenizer: { root: [[/\/\/.*$/, 'comment'], [/"(?:[^"\\]|\\.)*"/, 'string'], [/\b(?:from|range|filter|map|yield|aggregateWindow|group|pivot|keep|drop|sort|limit|join|union)\b/, 'keyword'], [/\b\d+(?:\.\d+)?(?:ms|s|m|h|d|w)?\b/, 'number'], [/[|>=!:]+/, 'operator']] } })
    }
    if (!monaco.languages.getLanguages().some((language) => language.id === 'cypher')) { monaco.languages.register({ id: 'cypher' }); monaco.languages.setMonarchTokensProvider('cypher', { tokenizer: { root: [[/\/\/.*$/, 'comment'], [/"[^"]*"|'[^']*'/, 'string'], [/\b(?:MATCH|WHERE|RETURN|WITH|OPTIONAL|CREATE|MERGE|SET|DELETE|DETACH|UNWIND|ORDER|BY|LIMIT|SKIP|AS)\b/i, 'keyword'], [/\b\d+\b/, 'number']] } }) }
    this.instance = monaco.editor.create(this.monacoHost, {
      automaticLayout: true, model: null, minimap: { enabled: false }, ...this.editorFontOptions(),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 },
      fixedOverflowWidgets: true, tabSize: 2, insertSpaces: true, wordWrap: 'off',
      autoIndent: 'full', autoClosingBrackets: 'always', autoClosingQuotes: 'languageDefined', formatOnPaste: false,
      accessibilitySupport: 'auto', ariaLabel: 'SQL 查询编辑器', quickSuggestions: true,
      wordBasedSuggestions: 'off', parameterHints: { enabled: false },
      suggest: { showKeywords: true, snippetsPreventQuickSuggestions: false, showInlineDetails: true, showStatusBar: false },
      theme: ['dark', 'board'].includes(document.documentElement.dataset.paper) || document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs'
    })
    this.monacoHost.addEventListener('pointerover', event => {
      const row = event.target.closest('.suggest-widget .monaco-list-row')
      if (row) row.title = ['.label-name', '.signature-label', '.details-label'].map(selector => row.querySelector(selector)?.textContent?.trim()).filter(Boolean).join(' · ')
    })
    this.tabAcceptanceDisabled = this.instance.createContextKey('enestSqlTabAcceptanceDisabled', false)
    this.updateCompletionOptions()
    this.instance.addCommand(monaco.KeyCode.Tab, () => { this.instance.trigger('enest.sql', 'hideSuggestWidget', {}); this.completionWanted = false; this.indentSelection(1) }, 'suggestWidgetVisible && enestSqlTabAcceptanceDisabled && !inSnippetMode')
    this.instance.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => { this.instance.trigger('enest.sql', 'hideSuggestWidget', {}); this.completionWanted = false; this.indentSelection(-1) }, 'suggestWidgetVisible && enestSqlTabAcceptanceDisabled && !inSnippetMode')
    this.disposables.push(this.instance.onDidCompositionStart(() => { this.composing = true; this.invalidateCompletionAcceptance(); this.completionWanted = false; this.completionSources = null; this.instance.trigger('enest.sql', 'hideSuggestWidget', {}) }))
    this.disposables.push(this.instance.onDidCompositionEnd(() => { this.composing = false }))
    this.disposables.push(this.instance.onKeyDown(event => { if (event.keyCode === monaco.KeyCode.Escape) { this.invalidateCompletionAcceptance(); this.completionWanted = false; this.completionSources = null } }))
    this.disposables.push(this.instance.onDidBlurEditorText(() => { this.invalidateCompletionAcceptance(); this.completionWanted = false; this.completionSources = null }))
    this.disposables.push(this.instance.onDidChangeCursorPosition(() => { this.invalidateCompletionAcceptance(); this.completionWanted = false; this.completionSources = null }))
    this.disposables.push(this.instance.onDidChangeModelContent(() => {
      if (this.syncing) return
      this.invalidateCompletionAcceptance()
      this.completionWanted = false
      this.completionSources = null
      this.syncTextArea(); this.onChange(this.instance.getValue(), this.getCursor()); this.scheduleDiagnostics()
    }))
    this.disposables.push(this.instance.onDidFocusEditorText(() => api?.ui?.setInputContext?.('editor')))
    const acceptCommand = this.instance.addCommand(0, (_context, item, source, key, replace, snapshot) => {
      this.completionWanted = false
      if (item.nonInsert || this.composing) return
      const model = this.instance.getModel()
      // Monaco first applies our deliberate no-op replacement. It may advance
      // the version by one; no other edit or model switch is allowed here.
      if (model !== snapshot.model || model.getValue() !== source || ![snapshot.modelVersion, snapshot.modelVersion + 1].includes(model.getVersionId())) return
      void this.acceptCandidate(item, source, key, replace, snapshot).catch(error => toast(error.message, 'warn'))
    })
    const rangeAt = (model, from, to) => { const a = model.getPositionAt(from), b = model.getPositionAt(to); return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column) }
    const completionProvider = {
      triggerCharacters: completionTriggerCharacters,
      provideCompletionItems: async (model, position, trigger, token) => {
        if (this.composing || model !== this.instance.getModel()) return { suggestions: [] }
        const sql = model.getValue(), cursor = model.getOffsetAt(position), scope = this.completionScope(), version = model.getVersionId(), key = completionContextKey(scope)
        const request = { sql, cursor, dialect: this.getDialect(), ...scope, modelVersion: version }, sources = this.completionSources
        // Monaco reports Invoke for both typed quick suggestions and manual calls.
        // Its retained suggest model supplies the actual trigger mode; capture it
        // before awaiting metadata, while it still belongs to this request.
        const automatic = this.instance.getContribution('editor.contrib.suggestController')?.model.state === 2
        this.completionWanted = true
        const controller = new AbortController()
        const cancellation = token.onCancellationRequested(() => controller.abort())
        this.completionAbortController?.abort()
        this.completionAbortController = controller
        try {
          // Keep Monaco's loading state until referenced columns arrive. Its public
          // trigger action cannot refresh an already-visible empty suggest widget.
          // Metadata is isolated, cached and coalesced; editing cancels this result.
          const result = this.completionNotice ? { items: [this.completionNotice], replace: { from: cursor, to: cursor } } : await requestCompletion(request, { waitForMetadata: true, signal: controller.signal })
          if (token.isCancellationRequested || !this.completionWanted || model !== this.instance.getModel() || model.getVersionId() !== version || model.getOffsetAt(this.instance.getPosition()) !== cursor || key !== completionContextKey(this.completionScope())) return { suggestions: [] }
          this.updateCompletionOptions(result.config)
          if (automatic && (result.config?.automatic === false || result.context?.prefix?.length < (result.config?.minPrefixLength || 0) && !completionTriggerCharacters.includes(trigger.triggerCharacter))) return { suggestions: [] }
          const replace = result.replace || { from: cursor, to: cursor }
          // Every acceptance is validated before changing text. Refetch after typing so a
          // cached Monaco candidate cannot carry edits for an older document snapshot.
          const items = filterCompletionSources(result.items, sources)
          return { incomplete: true, suggestions: items.map((item, index) => {
            const presentation = completionPresentation(item)
            const range = rangeAt(model, replace.from, replace.to)
            return { label: { label: item.label, detail: presentation.type ? `  ${presentation.type}` : '', description: presentation.description }, insertText: model.getValueInRange(range),
              filterText: sources?.length || item.nonInsert ? model.getValueInRange(range) || item.label : typeof item.filterText === 'string' ? item.filterText : Array.isArray(item.filterText) ? item.filterText.join(' ') : item.label,
              // Revealing row 1 on first layout clips a leading signature row.
              // Keep the first row visible; informational rows accept as a no-op.
              preselect: index === 0,
              sortText: String(index).padStart(5, '0'), kind: monaco.languages.CompletionItemKind[({ column: 'Field', function: 'Function', keyword: 'Keyword', snippet: 'Snippet', value: 'Value', info: 'Text' })[item.kind] || 'Class'], range,
              additionalTextEdits: [],
              command: { id: acceptCommand, title: item.nonInsert ? '提示信息' : '应用 SQL 补全', arguments: [item, sql, key, replace, { model, modelVersion: version, cursor }] }
            }
          }) }
        } catch (error) { console.warn('SQL completion unavailable', error); return { suggestions: [] } }
        finally { cancellation.dispose(); if (this.completionAbortController === controller) this.completionAbortController = null }
      }
    }
    for (const language of ['sql', 'json', 'flux', 'cypher']) this.disposables.push(monaco.languages.registerCompletionItemProvider(language, completionProvider))
    this.disposables.push(monaco.languages.registerSignatureHelpProvider('sql', {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: async (model, position, token) => {
        if (model !== this.instance.getModel()) return null
        const version = model.getVersionId(), scope = this.completionScope(), key = completionContextKey(scope)
        const value = await requestSignatureHelp({ ...scope, sql: model.getValue(), cursor: model.getOffsetAt(position), dialect: this.getDialect() }).catch(() => null)
        if (!value || token.isCancellationRequested || model !== this.instance.getModel() || model.getVersionId() !== version || key !== completionContextKey(this.completionScope())) return null
        return { value, dispose() {} }
      }
    }))
    this.disposables.push(monaco.languages.setLanguageConfiguration('sql', {
      comments: { lineComment: '--', blockComment: ['/*', '*/'] },
      brackets: [['(', ')'], ['[', ']']],
      autoClosingPairs: [{ open: '(', close: ')', notIn: ['string', 'comment'] }, { open: '[', close: ']', notIn: ['string', 'comment'] }, { open: "'", close: "'", notIn: ['string', 'comment'] }, { open: '"', close: '"', notIn: ['string', 'comment'] }],
      onEnterRules: [
        { beforeText: /\(\s*$/, afterText: /^\s*\)/, action: { indentAction: monaco.languages.IndentAction.IndentOutdent } },
        { beforeText: /\(\s*$/, action: { indentAction: monaco.languages.IndentAction.Indent } }
      ]
    }))
    const formattingEdits = (model, range) => {
      if (model !== this.instance.getModel()) return []
      try { return [{ range, text: this.formatSql(model.getValueInRange(range)) }] }
      catch (error) { void toast(`格式化失败：${error.message}`, 'error'); return [] }
    }
    this.disposables.push(monaco.languages.registerDocumentFormattingEditProvider('sql', {
      provideDocumentFormattingEdits: model => formattingEdits(model, model.getFullModelRange())
    }))
    this.disposables.push(monaco.languages.registerDocumentRangeFormattingEditProvider('sql', {
      provideDocumentRangeFormattingEdits: (model, range) => formattingEdits(model, range)
    }))
    const syncTheme = () => {
      const app = document.querySelector('#app')
      const style = getComputedStyle(app || document.documentElement), dark = style.colorScheme === 'dark' || document.documentElement.dataset.scheme === 'dark' || document.documentElement.dataset.theme === 'dark'
      const color = (key, fallback) => { const v = style.getPropertyValue(key).trim(); if (/^#[a-f\d]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join(''); if (/^#[a-f\d]{6,8}$/i.test(v)) return v.slice(0, 7); const match = v.match(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/); return match ? '#' + match.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : fallback }
      const bg = color('--bg', dark ? '#202228' : '#ffffff'), fg = color('--text', dark ? '#dedee3' : '#252932'), accent = color('--accent', '#517ad4')
      monaco.editor.defineTheme('enest-workbench', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: { 'editor.background': bg, 'editor.foreground': fg, 'editorGutter.background': bg, 'editorLineNumber.foreground': color('--text-3', '#8d9098'), 'editorCursor.foreground': accent, 'editor.selectionBackground': accent + '40', 'editorWidget.background': color('--surface', bg), 'editorWidget.border': color('--border', '#999999'), 'focusBorder': accent } })
      monaco.editor.setTheme('enest-workbench')
      this.instance.updateOptions({ fontFamily: style.getPropertyValue('--mono'), ...this.editorFontOptions() })
    }
    syncTheme()
    this.themeObserver = new MutationObserver(syncTheme)
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'data-paper', 'style'] })
    document.addEventListener('database-workbench-theme', syncTheme)
    this.disposables.push({ dispose: () => document.removeEventListener('database-workbench-theme', syncTheme) })
    this.activateModel()
  }
  updateCompletionOptions(behavior = getCompletionBehavior(this.completionScope())) {
    this.tabAcceptanceDisabled?.set(behavior.acceptOnTab === false)
    // Automatic visibility is scoped to the provider response. Disabling Monaco's
    // editor-wide scheduler here would strand automatic=false on the next table.
    const schedule = getCompletionBehavior(this.completionScope())
    this.instance?.updateOptions({ quickSuggestions: true, quickSuggestionsDelay: schedule.delayMs ?? 70, suggestOnTriggerCharacters: true, acceptSuggestionOnEnter: behavior.acceptOnEnter ? 'on' : 'off', tabCompletion: behavior.acceptOnTab === false ? 'off' : 'on', suggest: { selectionMode: behavior.acceptOnTab === false ? 'never' : 'always', snippetsPreventQuickSuggestions: false } })
  }
  refreshCompletion(scope) {
    if (!this.usingMonaco) return super.refreshCompletion(scope)
    // Monaco's pending provider already awaits this metadata update. Retriggering
    // here could cancel it or reopen a widget the user has just dismissed.
  }
  scheduleDiagnostics() {
    clearTimeout(this.diagnosticTimer)
    this.diagnosticTimer = setTimeout(async () => {
      const model = this.instance?.getModel()
      if (!model || model.getLanguageId() !== 'sql') return
      const version = model.getVersionId(), scope = this.completionScope(), key = completionContextKey(scope)
      const result = await requestCompletion({ ...scope, sql: model.getValue(), cursor: model.getOffsetAt(this.instance.getPosition()), dialect: this.getDialect(), modelVersion: version }, { channel: 'diagnostics' }).catch(() => null)
      if (!result || model.isDisposed() || model !== this.instance.getModel() || model.getVersionId() !== version || key !== completionContextKey(this.completionScope())) return
      const severity = { hint: this.monaco.MarkerSeverity.Hint, info: this.monaco.MarkerSeverity.Info, warning: this.monaco.MarkerSeverity.Warning, error: this.monaco.MarkerSeverity.Error }
      this.monaco.editor.setModelMarkers(model, 'enest.sql', (result.diagnostics || []).map(item => { const a = model.getPositionAt(item.from), b = model.getPositionAt(item.to); return { message: item.message, code: item.code, severity: severity[item.severity] || severity.hint, startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column } }))
    }, 400)
  }
  applyPreparedCompletion(prepared) {
    if (!this.usingMonaco) return super.applyPreparedCompletion(prepared)
    this.completionNotice = null
    this.instance.trigger('enest.sql', 'hideSuggestWidget', {})
    const model = this.instance.getModel()
    const rangeAt = edit => { const a = model.getPositionAt(edit.from), b = model.getPositionAt(edit.to); return new this.monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column) }
    const snippetController = prepared.plan.snippet && this.instance.getContribution('snippetController2')
    if (snippetController) {
      const escapeSnippet = value => String(value).replace(/[\\$}]/g, '\\$&')
      const edits = [{ range: rangeAt(prepared.plan), template: prepared.plan.snippet, keepWhitespace: true }, ...(prepared.plan.additionalEdits || []).map(edit => ({ range: rangeAt(edit), template: escapeSnippet(edit.text), keepWhitespace: true }))]
      this.instance.pushUndoStop(); snippetController.cancel(); snippetController.insert(edits, { undoStopBefore: false, undoStopAfter: false }); this.instance.pushUndoStop()
      this.instance.focus(); this.completionWanted = false
      return
    }
    const edits = [prepared.plain, ...(prepared.plain.additionalEdits || [])].map(edit => ({ range: rangeAt(edit), text: edit.text }))
    this.instance.pushUndoStop(); this.instance.executeEdits('enest.sqlCompletion', edits); this.instance.pushUndoStop()
    const a = model.getPositionAt(prepared.selection.from), b = model.getPositionAt(prepared.selection.to)
    this.instance.setSelection(new this.monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column)); this.instance.focus(); this.completionWanted = false
  }
  formatDialect() { return ({ mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgresql', timescale: 'postgresql', cockroachdb: 'postgresql', yugabytedb: 'postgresql', questdb: 'postgresql', tidb: 'mysql', oceanbase: 'mysql', doris: 'mysql', starrocks: 'mysql', mssql: 'transactsql', sqlserver: 'transactsql', oracle: 'plsql', sqlite: 'sqlite' })[this.getDialect()] || 'sql' }
  activateDocument(id, sql = '', cursor) {
    if (this.instance?.getModel() && this.documentId !== id) this.viewStates.set(this.documentId, this.instance.saveViewState())
    if (this.documentId !== id) this.root.querySelector('.db-editor-find')?.setAttribute('hidden', '')
    this.completionWanted = false
    this.documentId = id || 'draft'
    super.setValue(sql, { cursor, silent: true })
    if (this.instance) this.activateModel(sql)
  }
  activateModel(sql) {
    if (!this.instance) return
    let model = this.models.get(this.documentId)
    // Textarea normalizes CRLF to LF. Once retained, the model is authoritative;
    // a toolbar/surface refresh must not turn that mirror into a full-document edit.
    if (sql === undefined) sql = model?.getValue() ?? this.el.ta.value
    if (!model) { model = this.monaco.editor.createModel(sql, queryLanguage(this.getDialect()), this.monaco.Uri.parse(`enest-query:///${this.documentId}`)); this.models.set(this.documentId, model) }
    else if (model.getValue() !== sql) { this.syncing = true; model.pushStackElement(); model.pushEditOperations([], [{ range: model.getFullModelRange(), text: sql }], () => null); model.pushStackElement(); this.syncing = false }
    if (this.instance.getModel() !== model) { this.instance.setModel(model); this.instance.restoreViewState(this.viewStates.get(this.documentId) || null) }
    this.monaco.editor.setModelLanguage(model, queryLanguage(this.getDialect()))
    this.updateCompletionOptions()
    this.scheduleDiagnostics()
  }
  releaseDocument(id) {
    const model = this.models.get(id)
    if (model && model === this.instance?.getModel()) this.instance.setModel(null)
    model?.dispose()
    this.models.delete(id)
    this.viewStates.delete(id)
  }
  disposeDocument(id) { this.releaseDocument(id) }
  syncTextArea() { if (this.instance?.getModel()) { this.el.ta.value = this.instance.getValue(); const selection = this.instance.getSelection(); this.el.ta.setSelectionRange(this.instance.getModel().getOffsetAt(selection.getStartPosition()), this.instance.getModel().getOffsetAt(selection.getEndPosition())) } }
  getValue() { return this.usingMonaco ? this.instance.getValue() : super.getValue() }
  getCursor() { const position = this.usingMonaco ? this.instance.getPosition() : null; return position ? { line: position.lineNumber - 1, ch: position.column - 1 } : super.getCursor() }
  setValue(sql, options = {}) { super.setValue(sql, { ...options, silent: true }); if (this.instance) this.activateModel(sql); if (!options.silent) this.onChange(sql, this.getCursor()) }
  setDialect(dialect) { super.setDialect(dialect); if (this.instance?.getModel()) this.monaco.editor.setModelLanguage(this.instance.getModel(), queryLanguage(dialect)) }
  focus() { if (this.usingMonaco) this.instance.focus(); else super.focus() }
  toggleComment() { if (this.usingMonaco) this.instance.getAction('editor.action.commentLine').run(); else super.toggleComment() }
  showCompletionStatus(message) {
    if (!this.usingMonaco) return super.showCompletionStatus(message)
    this.triggerCompletion(true, { notice: { kind: 'info', nonInsert: true, label: message, presentation: { type: '', description: '' } } })
  }
  triggerCompletion(force, { sources, notice } = {}) {
    if (!this.usingMonaco) return super.triggerCompletion(force, { sources })
    if (this.composing) return
    // The public action only runs while the widget is hidden. Reopen at the
    // current caret when explicitly switching to the field-expansion list.
    this.instance.trigger('enest', 'hideSuggestWidget', {})
    this.instance.focus()
    this.completionSources = sources || null
    this.completionNotice = notice || null
    this.instance.trigger('enest', 'editor.action.triggerSuggest', {})
  }
  indentSelection(direction = 1) {
    if (this.usingMonaco) return this.instance.getAction(direction > 0 ? 'editor.action.indentLines' : 'editor.action.outdentLines').run()
    super.indentSelection(direction)
  }
  openFind(replace = false) {
    if (this.usingMonaco) { this.instance.focus(); return this.instance.getAction(replace ? 'editor.action.startFindReplaceAction' : 'actions.find').run() }
    return super.openFind(replace)
  }
  formatSql(value) {
    const language = queryLanguage(this.getDialect())
    if (language === 'json') return JSON.stringify(JSON.parse(value), null, 2)
    if (language !== 'sql') throw new Error('当前原生查询语言暂不支持自动格式化')
    return this.format(value, { language: this.formatDialect(), keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 })
  }
  async formatDocument(selectionOnly = false) {
    const documentId = this.documentId, source = this.getValue()
    const model = this.instance?.getModel(), selection = this.instance?.getSelection()
    const ta = this.el.ta, start = model ? model.getOffsetAt(selection.getStartPosition()) : ta.selectionStart, end = model ? model.getOffsetAt(selection.getEndPosition()) : ta.selectionEnd
    if (selectionOnly && start === end) throw new Error('请先选择需要格式化的查询文本')
    if (!this.format) { const { format } = await import('sql-formatter'); this.format = format }
    if (this.documentId !== documentId || this.getValue() !== source || (model && model !== this.instance?.getModel())) throw new Error('查询文档已切换或改变，请重新格式化')
    const from = selectionOnly ? start : 0, to = selectionOnly ? end : source.length
    let text
    try { text = this.formatSql(source.slice(from, to)) } catch (error) { throw new Error(`格式化失败：${error.message}`) }
    if (model) {
      const begin = model.getPositionAt(from), finish = model.getPositionAt(to)
      this.instance.pushUndoStop()
      this.instance.executeEdits('enest.format', [{ range: new this.monaco.Range(begin.lineNumber, begin.column, finish.lineNumber, finish.column), text, forceMoveMarkers: true }])
      this.instance.pushUndoStop()
      if (selectionOnly) { const formattedEnd = model.getPositionAt(from + text.length); this.instance.setSelection(new this.monaco.Selection(begin.lineNumber, begin.column, formattedEnd.lineNumber, formattedEnd.column)) }
      else this.instance.setPosition(model.getPositionAt(Math.min(start, text.length)))
      this.instance.focus()
    } else this._replaceRange(from, to, text, selectionOnly ? from : Math.min(start, text.length), selectionOnly ? from + text.length : Math.min(start, text.length))
  }
  insertText(text) {
    if (this.usingMonaco) { this.instance.pushUndoStop(); this.instance.executeEdits('insert', [{ range: this.instance.getSelection(), text }]); this.instance.pushUndoStop() }
    else this._replaceRange(this.el.ta.selectionStart, this.el.ta.selectionEnd, text)
  }
  getSelectionOrStatement(mode) {
    if (!this.usingMonaco) return super.getSelectionOrStatement(mode)
    const model = this.instance.getModel(), selection = this.instance.getSelection()
    return resolveExecutionRange(model.getValue(), {
      start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()),
      cursor: model.getOffsetAt(this.instance.getPosition()), mode, dialect: this.getDialect?.() || this.dialect
    })
  }
}
