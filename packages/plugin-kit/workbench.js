/** Shared DOM primitives. No host globals are required by selection/command models. */
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

let monacoPromise
export async function loadMonaco() {
  monacoPromise ||= import('./vendor/monaco.js').catch(error => { monacoPromise = null; throw error })
  return monacoPromise
}

export class SelectionModel {
  constructor() { this.selected = new Set(); this.anchor = null }
  select(id, orderedIds, { additive = false, range = false } = {}) {
    if (range && this.anchor !== null && orderedIds.includes(this.anchor)) {
      if (!additive) this.selected.clear()
      const start = orderedIds.indexOf(this.anchor), end = orderedIds.indexOf(id)
      if (end >= 0) orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((key) => this.selected.add(key))
    } else {
      if (!additive) this.selected.clear()
      if (additive && this.selected.has(id)) this.selected.delete(id)
      else this.selected.add(id)
      this.anchor = id
    }
    return [...this.selected]
  }
  retain(ids) { const allowed = new Set(ids); this.selected.forEach((id) => { if (!allowed.has(id)) this.selected.delete(id) }); if (!allowed.has(this.anchor)) this.anchor = null }
  clear() { this.selected.clear(); this.anchor = null }
}

export function normalizeShortcut(event) {
  const parts = []
  if (event.metaKey || event.ctrlKey) parts.push('Mod')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const key = event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (!['Control', 'Meta', 'Shift', 'Alt'].includes(key)) parts.push(key)
  return parts.join('+')
}

export class CommandRegistry {
  constructor() { this.commands = new Map(); this.bindings = {} }
  register(command) {
    if (!command.id || typeof command.run !== 'function') throw new TypeError('Command requires id and run')
    this.commands.set(command.id, command)
    return () => this.commands.delete(command.id)
  }
  list(query = '') { const q = query.trim().toLowerCase(); return [...this.commands.values()].filter((cmd) => `${cmd.label} ${cmd.id}`.toLowerCase().includes(q)) }
  shortcut(id) { return this.bindings[id] ?? this.commands.get(id)?.shortcut ?? '' }
  setBinding(id, shortcut) {
    const duplicate = [...this.commands.keys()].find((key) => key !== id && shortcut && this.shortcut(key) === shortcut)
    if (duplicate) throw new Error(`与“${this.commands.get(duplicate).label}”冲突`)
    this.bindings[id] = shortcut
  }
  async run(id) {
    const command = this.commands.get(id)
    if (!command || command.enabled?.() === false) return false
    await command.run(); return true
  }
  handle(event, { inEditor = false } = {}) {
    if (event.isComposing || event.defaultPrevented) return false
    const chord = normalizeShortcut(event)
    const command = [...this.commands.values()].find((cmd) => this.shortcut(cmd.id) === chord && (!inEditor || cmd.inEditor) && cmd.enabled?.() !== false)
    if (!command) return false
    event.preventDefault(); event.stopPropagation()
    void this.run(command.id)
    return true
  }
}

/** Native dialog handles focus containment, Escape and restoration inside the plugin view. */
export function createDialog({ title, content = '', className = '', onClose, restoreInputContext, host = globalThis.enest } = {}) {
  const previous = document.activeElement
  const dialog = document.createElement('dialog')
  dialog.className = `wb-dialog ${className}`
  dialog.setAttribute('aria-label', title || '对话框')
  dialog.innerHTML = `<header class="wb-dialog-head"><strong>${escapeHtml(title)}</strong><button type="button" data-dialog-close aria-label="关闭">关闭</button></header><div class="wb-dialog-body">${content}</div>`
  document.body.append(dialog)
  const close = () => dialog.close()
  dialog.querySelector('[data-dialog-close]').addEventListener('click', close)
  dialog.addEventListener('keydown', (event) => event.stopPropagation())
  dialog.addEventListener('close', () => {
    dialog.remove(); previous?.focus?.(); onClose?.()
    const context = typeof restoreInputContext === 'function' ? restoreInputContext() : restoreInputContext || (previous?.closest?.('.editor-host, .monaco-editor, textarea, input') ? 'editor' : previous?.closest?.('.terminal, .xterm') ? 'terminal' : 'workbench')
    host?.ui?.setInputContext?.(context)
  }, { once: true })
  dialog.showModal()
  host?.ui?.setInputContext?.('overlay')
  return { dialog, body: dialog.querySelector('.wb-dialog-body'), close }
}

export function bindDockResize(handle, target, { axis = 'x', min = 160, max = 640, invert = false, onChange = () => {} } = {}) {
  if (!handle || !target) return () => {}
  const prop = axis === 'x' ? 'width' : 'height'
  handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal')
  const apply = (size) => { const bounded = Math.round(Math.min(max, Math.max(min, size))); target.style[prop] = `${bounded}px`; handle.setAttribute('aria-valuenow', String(bounded)); return bounded }
  let stopDrag = () => {}
  const pointer = (event) => {
    stopDrag()
    event.preventDefault(); handle.setPointerCapture(event.pointerId)
    const start = axis === 'x' ? event.clientX : event.clientY
    const size = target.getBoundingClientRect()[prop]
    const move = (next) => apply(size + ((axis === 'x' ? next.clientX : next.clientY) - start) * (invert ? -1 : 1))
    const up = (next) => { move(next); onChange(target.getBoundingClientRect()[prop]); stopDrag() }
    stopDrag = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', stopDrag); if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId) }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up, { once: true }); handle.addEventListener('pointercancel', stopDrag, { once: true })
  }
  const key = (event) => {
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    if (!direction) return
    event.preventDefault(); onChange(apply(target.getBoundingClientRect()[prop] + direction * (invert ? -1 : 1) * 16))
  }
  handle.addEventListener('pointerdown', pointer); handle.addEventListener('keydown', key)
  return () => { stopDrag(); handle.removeEventListener('pointerdown', pointer); handle.removeEventListener('keydown', key) }
}
