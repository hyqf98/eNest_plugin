/**
 * editor.js — 轻量多 Tab SQL 编辑器（DB-E1）
 * textarea + 高亮层叠加；补全浮层；快捷键
 */
import { highlightHtml, statementAtCursor } from './tokenizer.js'
import { resolveExecutionRange } from './executionRange.js'
import {
  requestCompletion,
  ensureCompletionColumns,
  validateCompletionItem,
  filterItems,
  applyCompletionItem,
  kindMeta, completionContextKey, getCompletionBehavior
} from './completion.js'
import { state, activeSession, activeEditor, updateSessionEditorSql } from './store.js'
import { toast } from './api.js'

export const projectionSources = ['projection', 'columnSet']
export const completionTriggerCharacters = ['.', ' ', '*', ',', '(', '=']
export const filterCompletionSources = (items = [], sources) => sources?.length ? items.filter(item => sources.some(source => source === 'queryTemplate' ? item.id?.startsWith('template:') : source === item.source)) : items

/** Keep the candidate's name, type and description inside the same compact row. */
export function completionPresentation(item) {
  if (item.presentation) return item.presentation
  if (projectionSources.includes(item.source) || item.kind === 'snippet') {
    const sql = item.editPlan?.text || item.insertText || ''
    return { type: '', description: sql.replace(/\s+/g, ' ').trim() || item.detail || '' }
  }
  return { type: '', description: item.detail || item.doc || '' }
}

/** 补全列表 label 渲染：按 _matchRanges 高亮模糊命中的字符 */
function highlightLabel(it) {
  const label = String(it.label || '')
  const ranges = Array.isArray(it._matchRanges) ? it._matchRanges : null
  if (!ranges?.length) return escape(label)
  const set = new Set(ranges.filter((i) => i >= 0 && i < label.length))
  let out = ''
  for (let i = 0; i < label.length; i++) {
    out += set.has(i) ? `<b class="comp-hit">${escape(label[i])}</b>` : escape(label[i])
  }
  return out
}

export function newlineEdit(value, start, end = start) {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1, before = value.slice(lineStart, start)
  const indent = before.match(/^[\t ]*/)[0], opening = /[([{]\s*$/.test(before)
  const closing = /^\s*[)\]}]/.test(value.slice(end))
  const nextIndent = indent + (opening ? '  ' : '')
  const text = '\n' + nextIndent + (opening && closing ? '\n' + indent : '')
  return { start, end, text, cursor: start + 1 + nextIndent.length }
}

export function indentEdit(value, start, end, direction = 1) {
  if (start === end && direction > 0) return { start, end, text: '  ', selectionStart: start + 2, selectionEnd: start + 2 }
  const from = value.lastIndexOf('\n', start - 1) + 1
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  let to = value.indexOf('\n', last); if (to < 0) to = value.length
  const lines = value.slice(from, to).split('\n'), offsets = []
  const text = lines.map(line => { const removed = direction < 0 ? (line.match(/^(?: {1,2}|\t)/)?.[0].length || 0) : 0; offsets.push(direction > 0 ? 2 : -removed); return direction > 0 ? '  ' + line : line.slice(removed) }).join('\n')
  const shiftStart = Math.max(from, start + offsets[0]), shiftEnd = Math.max(shiftStart, end + offsets.reduce((a, b) => a + b, 0))
  return { start: from, end: to, text, selectionStart: shiftStart, selectionEnd: shiftEnd }
}

export function commentEdit(value, start, end, prefix = '--') {
  const from = value.lastIndexOf('\n', start - 1) + 1
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  let to = value.indexOf('\n', last); if (to < 0) to = value.length
  const lines = value.slice(from, to).split('\n'), remove = lines.every(line => !line.trim() || line.trimStart().startsWith(prefix))
  const updated = lines.map(line => { if (!line.trim()) return line; const indentation = line.match(/^[\t ]*/)[0], content = line.slice(indentation.length); return remove ? indentation + content.slice(prefix.length).replace(/^ /, '') : indentation + prefix + ' ' + content })
  const text = updated.join('\n'), firstDelta = updated[0].length - lines[0].length
  return { start: from, end: to, text, selectionStart: Math.max(from, start + firstDelta), selectionEnd: Math.max(from, end + text.length - (to - from)) }
}

export class SqlEditor {
  constructor(root, opts = {}) {
    this.root = root
    this.onChange = opts.onChange || (() => {})
    this.onExecute = opts.onExecute || (() => {})
    this.onExecuteAll = opts.onExecuteAll || (() => {})
    this.onSave = opts.onSave || (() => {})
    this.getSessionKey = opts.getSessionKey || (() => '')
    this.getDialect = opts.getDialect || (() => 'mysql')
    this.getCompletionScope = opts.getCompletionScope || (() => ({}))
    this.completionSequence = 0
    this.completionTimer = null
    this.completionState = null
    this.completionAcceptanceSequence = 0
    this.dialect = 'mysql'
    this.perfMode = false
    this._build()
    this._bind()
  }

  _build() {
    this.root.innerHTML = `
      <div class="sql-editor">
        <div class="gutter" data-el="gutter"></div>
        <div class="editor-scroll">
          <div class="editor-wrap">
            <pre class="hl" data-el="hl" aria-hidden="true"></pre>
            <textarea class="ta" data-el="ta" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
          </div>
          <div class="current-line" data-el="curline"></div>
        </div>
        <div class="completion-popup" data-el="popup" role="listbox" aria-label="SQL 补全" hidden></div>
      </div>
    `
    this.el = {
      gutter: this.root.querySelector('[data-el=gutter]'),
      hl: this.root.querySelector('[data-el=hl]'),
      ta: this.root.querySelector('[data-el=ta]'),
      curline: this.root.querySelector('[data-el=curline]'),
      popup: this.root.querySelector('[data-el=popup]')
    }
  }

  querySelector(sel) {
    return this.root.querySelector(sel)
  }

  _bind() {
    const ta = this.el.ta
    ta.addEventListener('input', event => this._handleInput(event))
    ta.addEventListener('compositionstart', () => { this.composing = true; this.closeCompletion() })
    ta.addEventListener('compositionend', () => { this.composing = false; this._scheduleCompletion(false) })
    ta.addEventListener('scroll', () => this._syncScroll())
    ta.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (this.completionState?.open) {
          e.preventDefault()
          return
        }
        this._highlight()
      }
    })
    ta.addEventListener('keydown', (e) => this._handleKeydown(e))
    ta.addEventListener('click', () => {
      if (this.completionState?.open) this.closeCompletion()
      this._highlight()
    })
    ta.addEventListener('blur', () => {
      // 点击补全项前延迟关闭
      setTimeout(() => {
        if (!this.el.popup.contains(document.activeElement)) this.closeCompletion()
      }, 120)
    })

    this.el.popup.addEventListener('mousedown', (e) => {
      const item = e.target.closest('[data-idx]')
      if (!item) return
      e.preventDefault()
      void this.acceptCompletion(Number(item.dataset.idx)).catch(error => toast(error.message, 'warn'))
    })
    this.el.popup.addEventListener('mousemove', (e) => {
      const item = e.target.closest('[data-idx]')
      if (!item) return
      const idx = Number(item.dataset.idx)
      if (this.completionState && this.completionState.index !== idx) {
        this.completionState.index = idx
        this._renderCompletion()
      }
    })

  }

  setDialect(dialect) {
    this.dialect = dialect || 'mysql'
    this._highlight()
  }

  setValue(sql, { cursor, silent } = {}) {
    this.closeCompletion()
    this.el.ta.value = sql || ''
    if (cursor) {
      const pos = this._offsetFromLineCh(cursor)
      try {
        this.el.ta.setSelectionRange(pos, pos)
      } catch {
        /* ignore */
      }
    }
    this.perfMode = (sql || '').length > 200_000
    this._highlight()
    if (!silent) this.onChange(this.getValue(), this.getCursor())
  }

  getValue() {
    return this.el.ta.value
  }

  getCursor() {
    return this.getLineCh(this.el.ta.selectionStart)
  }

  getLineCh(offset) {
    const text = this.el.ta.value.slice(0, offset)
    const lines = text.split('\n')
    return { line: lines.length - 1, ch: lines[lines.length - 1].length }
  }

  _offsetFromLineCh({ line = 0, ch = 0 } = {}) {
    const lines = this.el.ta.value.split('\n')
    let off = 0
    for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1
    return off + ch
  }

  focus() {
    this.el.ta.focus()
  }

  _handleInput(event) {
    this.invalidateCompletionAcceptance()
    const sql = this.getValue()
    this.perfMode = sql.length > 200_000
    this._highlight()
    this.onChange(sql, this.getCursor())
    if (!this.composing && !event?.isComposing) this._scheduleCompletion(false)
  }

  _handleKeydown(e) {
    if (e.defaultPrevented || e.isComposing) return
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') {
      const wasOpen = this.completionState?.open
      this.closeCompletion()
      if (wasOpen) e.preventDefault()
      return
    }
    // 补全导航
    if (this.completionState?.open) {
      const st = this.completionState
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) this.closeCompletion()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeCompletion()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        st.index = (st.index + 1) % Math.max(1, st.items.length)
        this._renderCompletion()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        st.index = (st.index - 1 + st.items.length) % Math.max(1, st.items.length)
        this._renderCompletion()
        return
      }
      if (e.key === 'PageDown') {
        e.preventDefault()
        st.index = Math.min(st.items.length - 1, st.index + 8)
        this._renderCompletion()
        return
      }
      if (e.key === 'PageUp') {
        e.preventDefault()
        st.index = Math.max(0, st.index - 8)
        this._renderCompletion()
        return
      }
      const behavior = st.behavior || getCompletionBehavior(this.completionScope())
      if (!mod && !e.altKey && !e.shiftKey && (e.key === 'Enter' && behavior.acceptOnEnter || e.key === 'Tab' && behavior.acceptOnTab)) {
        e.preventDefault()
        void this.acceptCompletion(st.index).catch(error => toast(error.message, 'warn'))
        return
      }
    }

    if (!this.commandRegistry && mod && e.code === 'Space') {
      e.preventDefault()
      this.triggerCompletion(true)
      return
    }
    if (!this.commandRegistry && mod && e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) this.onExecuteAll()
      else this.onExecute({ mode: 'current' })
      return
    }
    if (!this.commandRegistry && mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      this.onSave()
      return
    }
    if (!this.commandRegistry && mod && e.key === '/') {
      e.preventDefault()
      this.toggleComment()
      return
    }
    if (!this.commandRegistry && e.key === 'F5') {
      e.preventDefault()
      this.onExecute({ mode: 'current' })
      return
    }
    if (e.key === 'Enter' && !mod && !e.altKey) { e.preventDefault(); this._newline(); return }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault()
      this._indent(e.shiftKey ? -1 : 1)
      return
    }
  }

  _replaceRange(start, end, text, selectionStart = start + text.length, selectionEnd = selectionStart) {
    const ta = this.el.ta, scrollTop = ta.scrollTop, scrollLeft = ta.scrollLeft
    ta.focus(); ta.setSelectionRange(start, end)
    // insertText joins the browser's native undo history; setRangeText is the fallback.
    const previous = ta.value
    try { document.execCommand('insertText', false, text) } catch { /* unsupported browser */ }
    if (ta.value === previous && previous.slice(start, end) !== text) ta.setRangeText(text, start, end, 'end')
    ta.setSelectionRange(selectionStart, selectionEnd)
    ta.scrollTop = scrollTop; ta.scrollLeft = scrollLeft
    this._highlight(); this.onChange(ta.value, this.getCursor())
  }

  _indent(dir) {
    const ta = this.el.ta, edit = indentEdit(ta.value, ta.selectionStart, ta.selectionEnd, dir)
    this._replaceRange(edit.start, edit.end, edit.text, edit.selectionStart, edit.selectionEnd)
  }

  indentSelection(direction = 1) { this._indent(direction) }

  _newline() {
    const ta = this.el.ta, edit = newlineEdit(ta.value, ta.selectionStart, ta.selectionEnd)
    this._replaceRange(edit.start, edit.end, edit.text, edit.cursor)
  }

  toggleComment() {
    const ta = this.el.ta, prefix = /^(flux|influxdb2?|cypher|neo4j)$/.test(this.getDialect()) ? '//' : '--'
    const edit = commentEdit(ta.value, ta.selectionStart, ta.selectionEnd, prefix)
    this._replaceRange(edit.start, edit.end, edit.text, edit.selectionStart, edit.selectionEnd)
  }

  openFind(replace = false) {
    this.closeCompletion()
    let panel = this.root.querySelector('.db-editor-find')
    if (!panel) {
      panel = document.createElement('div'); panel.className = 'db-editor-find'; panel.setAttribute('role', 'search')
      panel.innerHTML = '<label>查找<input data-find-query aria-label="查找查询文本"></label><label data-replace-row>替换<input data-find-replacement aria-label="替换为"></label><button type="button" data-find-next>下一处</button><button type="button" data-find-replace>替换</button><button type="button" data-find-all>全部替换</button><span data-find-status role="status"></span><button type="button" data-find-close aria-label="关闭查找">×</button>'
      this.root.append(panel)
      const query = panel.querySelector('[data-find-query]'), replacement = panel.querySelector('[data-find-replacement]'), status = panel.querySelector('[data-find-status]')
      const next = () => {
        if (!query.value) { status.textContent = ''; return false }
        const value = this.el.ta.value, offset = this.el.ta.selectionEnd
        const at = value.indexOf(query.value, offset), start = at < 0 ? value.indexOf(query.value) : at
        status.textContent = start < 0 ? '没有匹配项' : at < 0 ? '已回到开头' : '已找到'
        if (start < 0) return false
        this.el.ta.setSelectionRange(start, start + query.value.length); this._highlightCurrentLine(); return true
      }
      panel.querySelector('[data-find-next]').onclick = next
      panel.querySelector('[data-find-replace]').onclick = () => {
        const ta = this.el.ta
        if (query.value && ta.value.slice(ta.selectionStart, ta.selectionEnd) === query.value) this._replaceRange(ta.selectionStart, ta.selectionEnd, replacement.value)
        next(); replacement.focus()
      }
      panel.querySelector('[data-find-all]').onclick = () => {
        if (!query.value) return
        const source = this.el.ta.value, matches = source.split(query.value), count = matches.length - 1
        if (count) this._replaceRange(0, source.length, matches.join(replacement.value), 0)
        status.textContent = `已替换 ${count} 处`; replacement.focus()
      }
      const close = () => { panel.hidden = true; this.focus() }
      panel.querySelector('[data-find-close]').onclick = close
      panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close() } else if (event.key === 'Enter') { event.preventDefault(); next() } })
    }
    panel.hidden = false
    panel.querySelector('[data-replace-row]').hidden = !replace; panel.querySelector('[data-find-replace]').hidden = !replace; panel.querySelector('[data-find-all]').hidden = !replace
    const input = panel.querySelector('[data-find-query]'), ta = this.el.ta
    if (ta.selectionEnd > ta.selectionStart) input.value = ta.value.slice(ta.selectionStart, ta.selectionEnd)
    input.focus(); input.select()
  }

  _syncScroll() {
    const { scrollTop, scrollLeft } = this.el.ta
    const scrollParent = this.root.querySelector('.editor-scroll')
    if (scrollParent) {
      // ta 是滚动主体；同步高亮层即可
    }
    this.el.hl.scrollTop = scrollTop
    this.el.hl.scrollLeft = scrollLeft
    this.el.gutter.scrollTop = scrollTop
    if (this.completionState?.open) this._placePopup()
  }

  _highlight() {
    const sql = this.el.ta.value
    const dialect = this.getDialect() || this.dialect
    if (this.perfMode) {
      this.el.hl.textContent = sql
      this.el.gutter.textContent = sql
        .split('\n')
        .map((_, i) => i + 1)
        .join('\n')
    } else {
      this.el.hl.innerHTML = highlightHtml(sql, dialect) + '\n'
      const lineCount = sql.split('\n').length
      let gut = ''
      for (let i = 1; i <= lineCount; i++) gut += i + '\n'
      this.el.gutter.textContent = gut
    }
    this._highlightCurrentLine()
  }

  _highlightCurrentLine() {
    const cursor = this.getCursor()
    const taStyle = getComputedStyle(this.el.ta)
    const lh = parseFloat(taStyle.lineHeight) || 20
    const pad = parseFloat(taStyle.paddingTop) || 8
    this.el.curline.style.top = `${pad + cursor.line * lh - this.el.ta.scrollTop}px`
    this.el.curline.style.height = `${lh}px`
  }

  _scheduleCompletion(isManual) {
    clearTimeout(this.completionTimer)
    if (this.composing) return
    const behavior = getCompletionBehavior(this.completionScope())
    // Table profiles are resolved by the engine, after parsing the current SQL.
    // Keep scheduling enabled so leaving a manual-only table can restore suggestions.
    this.completionTimer = setTimeout(() => this.triggerCompletion(isManual), isManual ? 0 : behavior.delayMs)
  }

  async triggerCompletion(force, { sources } = {}) {
    if (this.composing) return
    const ta = this.el.ta
    const sql = ta.value
    const cursor = ta.selectionStart
    const ch = cursor > 0 ? sql[cursor - 1] : ''
    const isWord = /[A-Za-z0-9_$\u4e00-\u9fff]/.test(ch)
    const isTrigger = completionTriggerCharacters.includes(ch)
    const behavior = getCompletionBehavior(this.completionScope())
    if (!force && !isTrigger && !isWord) {
      this.closeCompletion()
      return
    }
    const stmt = statementAtCursor(sql, cursor)
    const sessionKey = this.getSessionKey()
    const dialect = this.getDialect() || this.dialect
    const scope = this.completionScope(), key = completionContextKey(scope), sequence = ++this.completionSequence
    this.completionAbortController?.abort()
    const controller = new AbortController()
    this.completionAbortController = controller
    try {
      const res = await requestCompletion({
        sessionKey,
        sql,
        cursor,
        dialect,
        statementSql: stmt.sql,
        ...scope
      }, { waitForMetadata: true, signal: controller.signal })
      if (sequence !== this.completionSequence || ta.value !== sql || ta.selectionStart !== cursor || key !== completionContextKey(this.completionScope())) return
      const prefix = this._prefixAt(sql, cursor)
      const resolvedBehavior = res.config || behavior
      if (!force && (resolvedBehavior.automatic === false || !isTrigger && prefix.length < resolvedBehavior.minPrefixLength)) return this.closeCompletion()
      const available = filterCompletionSources(res.items, sources)
      const items = sources?.length || res._unified || force && !prefix ? available : filterItems(available, prefix)
      this.completionState = {
        open: true,
        items,
        index: Math.max(0, items.findIndex(item => !item.nonInsert)),
        replace: res.replace || { from: cursor, to: cursor },
        local: !!res._local,
        source: sql,
        contextKey: key,
        cursor,
        sources,
        behavior: resolvedBehavior,
        emptyMessage: res.reason || (sources?.length ? '将光标放在 SELECT 的星号或字段处' : '无建议')
      }
      this._renderCompletion()
    } catch (e) {
      if (sequence !== this.completionSequence || ta.value !== sql || key !== completionContextKey(this.completionScope())) return
      // 自动触发静默；手动 Ctrl+Space 才提示
      if (force) {
        const msg = e?.code === 'HOST_LAG' || e?.code === 'NO_API' ? '补全暂不可用' : String(e.message || e)
        this.completionState = { open: true, items: [], emptyMessage: msg, source: sql, contextKey: key, cursor }
        this._renderCompletion()
        return
      }
      this.closeCompletion()
    } finally {
      if (this.completionAbortController === controller) this.completionAbortController = null
    }
  }

  _prefixAt(sql, cursor) {
    let i = cursor
    while (i > 0 && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(sql[i - 1])) i--
    return sql.slice(i, cursor)
  }

  _renderCompletion() {
    const st = this.completionState
    const popup = this.el.popup
    if (!st?.open || !st.items?.length) {
      if (st?.open) {
        popup.hidden = false
        popup.innerHTML = `<div class="comp-empty">${escape(st.emptyMessage || '无建议')}</div>`
        this._placePopup()
      } else {
        popup.hidden = true
      }
      return
    }
    popup.hidden = false
    const rows = st.items
      .map((it, idx) => {
        const meta = kindMeta(it.kind)
        const active = idx === st.index ? ' active' : ''
        const { type, description } = completionPresentation(it)
        return `<div class="comp-item${active}${it.nonInsert ? ' comp-info' : ''}" data-idx="${idx}" role="option" aria-disabled="${!!it.nonInsert}" aria-selected="${idx === st.index}" title="${escape([it.label, it.detail, description].filter(Boolean).join(' · '))}">
          <span class="comp-kind" data-kind="${escape(it.kind)}" aria-hidden="true">${escape(meta.mark || '')}</span>
          <span class="comp-label">${highlightLabel(it)}${type ? `<span class="comp-type">${escape(type)}</span>` : ''}</span>
          ${description ? `<span class="comp-detail">${escape(description)}</span>` : ''}
        </div>`
      })
      .join('')
    popup.innerHTML = rows
    this._placePopup()
    const active = popup.querySelector('.comp-item.active')
    active?.scrollIntoView({ block: 'nearest' })

  }

  _placePopup() {
    const ta = this.el.ta
    const popup = this.el.popup
    const cursor = ta.selectionStart
    const before = ta.value.slice(0, cursor)
    const lines = before.split('\n')
    const line = lines.length - 1
    const taStyle = getComputedStyle(ta)
    const lh = parseFloat(taStyle.lineHeight) || 20
    const padT = parseFloat(taStyle.paddingTop) || 8
    const padL = parseFloat(taStyle.paddingLeft) || 8
    this.completionMeasure ||= document.createElement('canvas').getContext('2d')
    this.completionMeasure.font = `${taStyle.fontStyle} ${taStyle.fontWeight} ${taStyle.fontSize} ${taStyle.fontFamily}`
    const tabSize = parseInt(taStyle.tabSize, 10) || 2
    let column = 0
    const text = [...lines.at(-1)].map(char => { const width = char === '\t' ? tabSize - column % tabSize : 1; column += width; return char === '\t' ? ' '.repeat(width) : char }).join('')
    const rect = ta.getBoundingClientRect()
    const textWidth = this.completionMeasure.measureText(text).width + (parseFloat(taStyle.letterSpacing) || 0) * [...text].length
    const left = rect.left + padL + textWidth - ta.scrollLeft
    const caretTop = rect.top + padT + line * lh - ta.scrollTop
    const below = Math.max(0, innerHeight - caretTop - lh - 12), above = Math.max(0, caretTop - 12)
    const preferred = Math.min(300, popup.scrollHeight)
    const placeBelow = below >= Math.min(preferred, 112) || below >= above
    const height = Math.min(preferred, placeBelow ? below : above)
    popup.style.position = 'fixed'
    popup.style.maxHeight = `${height}px`
    popup.style.maxWidth = `${Math.min(480, innerWidth - 16)}px`
    popup.style.left = `${Math.max(8, Math.min(left, innerWidth - popup.offsetWidth - 8))}px`
    popup.style.top = `${Math.max(8, placeBelow ? caretTop + lh + 4 : caretTop - height - 4)}px`
  }

  completionScope() { return { ...this.getCompletionScope(), sessionKey: this.getSessionKey(), documentId: this.documentId, dialect: this.getDialect() } }
  refreshCompletion(scope) {
    // Active requests already wait for their metadata. Never reopen a dismissed list.
  }
  async acceptCompletion(idx) {
    const st = this.completionState, item = st?.items?.[idx]
    if (!st?.open || !item || item.nonInsert) return
    if (this.el.ta.selectionStart !== st.cursor) { this.closeCompletion(); return }
    this.closeCompletion()
    await this.acceptCandidate(item, st.source, st.contextKey, st.replace)
  }
  invalidateCompletionAcceptance() {
    this.completionAcceptanceSequence++
    this.completionNotice = null
    this.completionAbortController?.abort()
    this.completionAbortController = null
    this.acceptanceAbortController?.abort()
    this.acceptanceAbortController = null
  }
  showCompletionStatus(message) {
    this.completionState = { open: true, index: 0, items: [{ kind: 'info', nonInsert: true, label: message, presentation: { type: '', description: '' } }], cursor: this.el.ta.selectionStart }
    this._renderCompletion()
  }
  async acceptCandidate(item, source, contextKey, replace, snapshot = {}) {
    if (item.nonInsert) return
    this.acceptanceAbortController?.abort()
    const controller = new AbortController()
    this.acceptanceAbortController = controller
    const sequence = ++this.completionAcceptanceSequence, scope = this.completionScope()
    const model = this.instance?.getModel(), version = model?.getVersionId()
    const cursor = model ? model.getOffsetAt(this.instance.getPosition()) : this.el.ta.selectionStart
    const modelVersion = snapshot.modelVersion ?? version
    const current = () => !controller.signal.aborted && sequence === this.completionAcceptanceSequence && source === this.getValue() && contextKey === completionContextKey(this.completionScope()) && (model ? model === this.instance.getModel() && model.getVersionId() === version && model.getOffsetAt(this.instance.getPosition()) === cursor : this.el.ta.selectionStart === cursor)
    const valid = async candidate => current() && await validateCompletionItem(candidate, scope, { modelVersion, documentId: this.documentId }) && current()
    if (!await valid(item)) return
    if (item.resolve?.kind === 'templateColumns') {
      this.showCompletionStatus(`正在读取 ${item.resolve.table.name} 的字段…`)
      await ensureCompletionColumns(scope, [item.resolve.table])
      if (!current()) return
      const response = await requestCompletion({ ...scope, sql: source, cursor: snapshot.cursor ?? cursor, modelVersion }, { waitForMetadata: true, channel: 'accept', signal: controller.signal })
      if (!current()) return
      const resolved = response.items?.find(candidate => candidate.id === item.id)
      if (!resolved || resolved.resolve) { this.showCompletionStatus(response.reason || '字段暂不可用，请稍后重新选择'); return }
      item = resolved
    }
    const { prepareEdits } = await import('@db/sql-intelligence/runtime/editorEdits.js')
    if (!await valid(item)) { if (current()) this.showCompletionStatus('查询上下文已变化，请重新选择补全'); return }
    const prepared = prepareEdits(source, item, replace)
    if (!current()) return
    this.applyPreparedCompletion(prepared)
    applyCompletionItem(item)
  }
  applyPreparedCompletion(prepared) {
    // One native replacement keeps compound edits in one undo step.
    this._replaceRange(0, this.getValue().length, prepared.result, prepared.selection.from, prepared.selection.to)
    this.closeCompletion()
  }
  expandColumns() {
    this.focus()
    return this.triggerCompletion(true, { sources: projectionSources })
  }
  showTemplates() {
    this.focus()
    return this.triggerCompletion(true, { sources: ['queryTemplate'] })
  }
  closeCompletion() {
    this.invalidateCompletionAcceptance()
    this.completionSequence++
    clearTimeout(this.completionTimer)
    if (this.completionState) this.completionState.open = false
    this.el.popup.hidden = true
  }

  getSelectionOrStatement(mode) {
    const ta = this.el.ta
    return resolveExecutionRange(ta.value, { start: ta.selectionStart, end: ta.selectionEnd, cursor: ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd, mode, dialect: this.getDialect?.() || this.dialect })
  }
}

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function bindEditorToStore(editor) {
  editor.onChange = (sql, cursor) => {
    const ed = activeEditor()
    if (!ed) return
    updateSessionEditorSql(ed, sql, cursor)
  }
  void state
  void activeSession
}
