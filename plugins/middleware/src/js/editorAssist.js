import { collectJsonKeys, jsonSuggestions, newlineEdit } from './editorSuggestions.js'
import { commands, displayShortcut, isComposing } from './commands.js'
import { jsonRuleSuggestions } from './completionRules.js'

let nextId = 0
function insertText(input, item) {
  input.focus()
  input.setSelectionRange(item.from ?? input.selectionStart, item.to ?? input.selectionEnd)
  // Native editing keeps browser undo/redo available; fallback supports non-Chromium previews.
  if (!document.execCommand('insertText', false, item.text)) {
    input.setRangeText(item.text, input.selectionStart, input.selectionEnd, 'end')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (Number.isInteger(item.caret)) input.setSelectionRange(item.caret, item.caret)
}
function caretRect(input) {
  const rect = input.getBoundingClientRect()
  if (input.tagName !== 'TEXTAREA') return { left: rect.left, top: rect.bottom + 4 }
  const style = getComputedStyle(input)
  const mirror = document.createElement('div')
  mirror.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;'
  for (const property of ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'tabSize']) mirror.style[property] = style[property]
  mirror.style.width = `${input.clientWidth}px`
  mirror.textContent = input.value.slice(0, input.selectionStart)
  const cursor = document.createElement('span')
  cursor.textContent = input.value.slice(input.selectionStart, input.selectionStart + 1) || '\u200b'
  mirror.append(cursor)
  document.body.append(mirror)
  const position = { left: rect.left + cursor.offsetLeft - input.scrollLeft, top: rect.top + cursor.offsetTop + (parseFloat(style.lineHeight) || 20) - input.scrollTop + 4 }
  mirror.remove()
  return position
}

/** One anchored list, shared by Topic/name inputs and JSON editing; no secondary dialog. */
export function attachSuggestions(input, { getItems, label = '输入建议', auto = true, getPreferences, isActive = () => input.isConnected && !input.closest('[hidden]') } = {}) {
  const list = document.createElement('div')
  list.className = 'mw-suggestions'
  list.id = `mw-suggestions-${++nextId}`
  list.role = 'listbox'
  list.setAttribute('aria-label', label)
  list.hidden = true
  document.body.append(list)
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', list.id)
  input.setAttribute('aria-expanded', 'false')
  let items = [], selected = 0, composing = false, snapshot = null
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant') }
  const position = () => {
    const rect = caretRect(input)
    const width = Math.min(390, window.innerWidth - 16)
    list.style.width = `${width}px`
    list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
    list.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - 90))}px`
    list.style.maxHeight = `${Math.min(244, Math.max(76, window.innerHeight - rect.top - 8))}px`
  }
  const highlight = () => {
    [...list.children].forEach((node, index) => node.setAttribute('aria-selected', String(index === selected)))
    const row = list.children[selected]
    if (row) { input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }) }
  }
  const accept = index => {
    const item = items[index]
    if (!item || !isActive() || composing || !snapshot || input.value !== snapshot.value || input.selectionStart !== snapshot.caret || input.selectionEnd !== snapshot.caret) { close(); return }
    close(); insertText(input, item); close()
  }
  const show = explicit => {
    if (!isActive() || composing || document.activeElement !== input || input.selectionStart !== input.selectionEnd) return close()
    items = (getItems?.(input.value, input.selectionStart, explicit) || []).slice(0, 12)
    if (!items.length) return close()
    selected = 0
    snapshot = { value: input.value, caret: input.selectionStart }
    list.replaceChildren()
    items.forEach((item, index) => {
      const row = document.createElement('div')
      row.className = 'mw-suggestion'
      row.id = `${list.id}-${index}`
      row.role = 'option'
      row.title = [item.label, item.detail].filter(Boolean).join(' · ')
      const name = document.createElement('span'); name.className = 'suggestion-name'; name.textContent = item.label
      const detail = document.createElement('span'); detail.className = 'suggestion-detail'; detail.textContent = item.detail || ''
      row.append(name, detail)
      row.addEventListener('pointerdown', event => { event.preventDefault(); accept(index) })
      list.append(row)
    })
    list.hidden = false
    input.setAttribute('aria-expanded', 'true')
    position(); highlight()
  }
  const onInput = () => auto && getPreferences?.()?.autoSuggest !== false ? show(false) : close()
  const onKey = event => {
    if (isComposing(event) || composing) return
    if (list.hidden) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; highlight(); return }
    if (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); accept(selected); return }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) close()
  }
  const onScroll = event => { if (!list.contains(event.target)) close() }
  const compositionStart = () => { composing = true; input.dataset.mwComposing = 'true'; close() }
  const compositionEnd = () => { composing = false; delete input.dataset.mwComposing; onInput() }
  const unregister = commands.register('mw.complete', { element: input, isActive: () => isActive() && !composing, run: () => show(true) })
  input.addEventListener('input', onInput); input.addEventListener('keydown', onKey); input.addEventListener('blur', close); input.addEventListener('click', close)
  input.addEventListener('compositionstart', compositionStart); input.addEventListener('compositionend', compositionEnd)
  window.addEventListener('resize', close); document.addEventListener('scroll', onScroll, true)
  document.addEventListener('mw-productivity-changed', close)
  return { close, show: () => show(true), destroy() {
    input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKey); input.removeEventListener('blur', close); input.removeEventListener('click', close)
    input.removeEventListener('compositionstart', compositionStart); input.removeEventListener('compositionend', compositionEnd)
    window.removeEventListener('resize', close); document.removeEventListener('scroll', onScroll, true); document.removeEventListener('mw-productivity-changed', close); delete input.dataset.mwComposing; unregister(); list.remove()
  } }
}

export function attachJsonEditor(input, status, { getPreferences = () => ({}), connection = {}, isActive = () => input.isConnected && !input.closest('[hidden]') } = {}) {
  let keys = collectJsonKeys(input.value)
  const update = () => {
    const found = collectJsonKeys(input.value)
    keys = [...new Set([...keys, ...found])].slice(0, 200)
    if (!status) return
    if (!input.value.trim()) { status.textContent = `JSON 或纯文本 · ${displayShortcut(commands.shortcut('mw.complete'))} 提示`; status.dataset.state = 'idle'; return }
    try { JSON.parse(input.value); status.textContent = 'JSON 格式有效'; status.dataset.state = 'valid' }
    catch { status.textContent = '纯文本 / 尚未完成的 JSON'; status.dataset.state = 'idle' }
  }
  input.addEventListener('input', update)
  const suggestions = attachSuggestions(input, { label: 'JSON 建议', isActive, getPreferences, getItems: (value, caret) => {
    const preferences = getPreferences(), seen = new Set()
    const items = [...jsonRuleSuggestions(value, caret, preferences, connection), ...(preferences.builtins !== false ? jsonSuggestions(value, caret, keys) : [])]
    return items.filter(item => { const key = `${item.from}:${item.text}`; if (seen.has(key)) return false; seen.add(key); return true })
  } })
  const format = () => {
    try {
      const text = JSON.stringify(JSON.parse(input.value), null, 2)
      suggestions.close()
      insertText(input, { from: 0, to: input.value.length, text })
      update()
      return true
    } catch (error) {
      if (status) { status.textContent = `无法格式化：${error.message}`; status.dataset.state = 'error' }
      return false
    }
  }
  const onKey = event => {
    if (event.defaultPrevented || isComposing(event) || input.dataset.mwComposing) return
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); insertText(input, newlineEdit(input.value, input.selectionStart, input.selectionEnd)); suggestions.close()
    } else if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault(); insertText(input, { text: '  ' }); suggestions.close()
    }
  }
  input.addEventListener('keydown', onKey)
  const unregister = commands.register('mw.formatJson', { element: input, isActive, run: format })
  document.addEventListener('mw-productivity-changed', update)
  update()
  return { format, close: suggestions.close, destroy() { unregister(); suggestions.destroy(); input.removeEventListener('input', update); input.removeEventListener('keydown', onKey); document.removeEventListener('mw-productivity-changed', update) } }
}
