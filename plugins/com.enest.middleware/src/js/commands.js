import { normalizeShortcut } from '@enest/plugin-kit/workbench'

const areas = {
  workspace: ['workspace', 'messages', 'messageTopic', 'publish', 'publishTopic', 'headers', 'json'],
  messages: ['messages', 'messageTopic'], publish: ['publish', 'publishTopic', 'headers', 'json'],
  assist: ['messageTopic', 'publishTopic', 'headers', 'json'], json: ['json']
}
export const COMMANDS = [
  { id: 'mw.focusSearch', label: '聚焦当前任务搜索', shortcut: 'Mod+F', scope: 'workspace', group: '工作区' },
  { id: 'mw.closeTab', label: '关闭当前工作标签', shortcut: 'Mod+W', scope: 'workspace', group: '工作区' },
  { id: 'mw.settings', label: '打开插件设置', shortcut: 'Mod+Shift+,', scope: 'workspace', group: '工作区' },
  { id: 'mw.queryMessages', label: '查询消息', shortcut: 'Mod+Enter', scope: 'messages', group: '消息查询' },
  { id: 'mw.send', label: '发送当前消息', shortcut: 'Mod+Enter', scope: 'publish', group: '消息发布' },
  { id: 'mw.preview', label: '切换消息预览', shortcut: 'Mod+Shift+P', scope: 'publish', group: '消息发布' },
  { id: 'mw.complete', label: '显示输入提示', shortcut: 'Mod+Space', scope: 'assist', group: 'Topic / JSON / Header' },
  { id: 'mw.formatJson', label: '格式化 JSON 内容', shortcut: 'Alt+Shift+F', scope: 'json', group: 'JSON 编辑器' }
]
const byId = new Map(COMMANDS.map(command => [command.id, command]))
export const isComposing = event => event.isComposing || event.keyCode === 229 || event.key === 'Process'
export function shortcutFromEvent(event) {
  const key = ({ Comma: ',', Period: '.', Slash: '/', Semicolon: ';', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' })[event.code] || event.key
  return normalizeShortcut({ key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey })
}
export const scopesOverlap = (left, right) => areas[left].some(area => areas[right].includes(area))
export const shortcutFor = (id, bindings = {}) => bindings[id] ?? byId.get(id)?.shortcut ?? ''
export function displayShortcut(value, mac = /Mac/.test(globalThis.navigator?.platform || '')) {
  return value ? value.split('+').map(part => ({ Mod: mac ? 'Command' : 'Ctrl', Alt: mac ? 'Option' : 'Alt', Space: 'Space' })[part] || part).join('+') : '未设置'
}
export function shortcutError(id, value) {
  const command = byId.get(id)
  if (!command) return '未知的命令'
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 60) return '快捷键格式无效'
  if (value === command.shortcut) return ''
  const parts = value.split('+'), key = parts.at(-1), modifiers = parts.slice(0, -1)
  if (!modifiers.length || modifiers.some(part => !['Mod', 'Alt', 'Shift'].includes(part)) || new Set(modifiers).size !== modifiers.length || !/^(?:[A-Z0-9,./;\[\]\\=-]|Space|Enter|F(?:[1-9]|1[0-2]))$/.test(key)) return '请使用 Ctrl / Command、Alt 或 Shift 组成的快捷键'
  const canonical = ['Mod', 'Alt', 'Shift'].filter(part => modifiers.includes(part)).concat(key).join('+')
  if (canonical !== value) return '快捷键顺序应为 Ctrl / Command、Alt、Shift、按键'
  if (!modifiers.includes('Mod') && !modifiers.includes('Alt') || value === 'Alt+F4') return '此组合用于文本输入或系统操作'
  if (/^Mod\+(?:[ACVXYZQWRLTN]|Shift\+[WQZRNT])$/.test(value)) return '此组合保留给文本编辑、系统或工作标签操作'
  return ''
}
export function validateBindings(bindings = {}) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('快捷键配置无效')
  const output = {}
  for (const [id, value] of Object.entries(bindings)) {
    const error = shortcutError(id, value)
    if (error) throw new Error(`${byId.get(id)?.label || id}：${error}`)
    if (value !== byId.get(id).shortcut) output[id] = value
  }
  for (let i = 0; i < COMMANDS.length; i++) for (let j = i + 1; j < COMMANDS.length; j++) {
    const left = COMMANDS[i], right = COMMANDS[j], key = shortcutFor(left.id, output)
    if (key && key === shortcutFor(right.id, output) && scopesOverlap(left.scope, right.scope)) throw new Error(`“${left.label}”与“${right.label}”的快捷键冲突`)
  }
  return output
}

/** Handlers retain their owning page; changing the active tab never redirects an action. */
export class MiddlewareCommands {
  constructor() { this.bindings = {}; this.handlers = new Set() }
  configure(bindings = {}) { this.bindings = validateBindings(bindings) }
  shortcut(id) { return shortcutFor(id, this.bindings) }
  register(id, { element, run, isActive = () => true }) {
    if (!byId.has(id)) throw new Error(`未知命令：${id}`)
    const entry = { id, element, run, isActive }
    this.handlers.add(entry)
    return () => this.handlers.delete(entry)
  }
  handle(event) {
    if (event.defaultPrevented || isComposing(event) || event.target?.closest?.('[data-mw-shortcut], [data-mw-composing], dialog[open], .connection-drawer')) return false
    const chord = shortcutFromEvent(event)
    const entry = [...this.handlers].find(handler => this.shortcut(handler.id) === chord && handler.element.contains(event.target) && handler.isActive())
    if (!entry) return false
    event.preventDefault(); event.stopPropagation()
    Promise.resolve().then(() => { if (entry.isActive()) return entry.run() }).catch(error => globalThis.dispatchEvent?.(new CustomEvent('mw-command-error', { detail: error })))
    return true
  }
}
export const commands = new MiddlewareCommands()
