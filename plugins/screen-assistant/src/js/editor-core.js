/** Pure edit history and image-space geometry; canvas work stays in main.js. */
;(function (root) {
  function selection(start, end, width, height) {
    const x1 = Math.max(0, Math.min(width, Math.round(Math.min(start.x, end.x))))
    const y1 = Math.max(0, Math.min(height, Math.round(Math.min(start.y, end.y))))
    const x2 = Math.max(0, Math.min(width, Math.round(Math.max(start.x, end.x))))
    const y2 = Math.max(0, Math.min(height, Math.round(Math.max(start.y, end.y))))
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }
  class EditHistory {
    constructor(limit = 40) { this.limit = limit; this.operations = []; this.cursor = 0 }
    push(operation) {
      if (this.cursor >= this.limit) return false
      this.operations = this.operations.slice(0, this.cursor)
      this.operations.push(structuredClone(operation)); this.cursor += 1
      return true
    }
    undo() { if (this.cursor > 0) this.cursor -= 1; return this.current() }
    redo() { if (this.cursor < this.operations.length) this.cursor += 1; return this.current() }
    clear() { this.operations = []; this.cursor = 0 }
    current() { return this.operations.slice(0, this.cursor) }
    get canUndo() { return this.cursor > 0 }
    get canRedo() { return this.cursor < this.operations.length }
  }
  function elapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60)
    return `${hours ? `${hours}:` : ''}${String(hours ? minutes % 60 : minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }
  root.ScreenEditorCore = { selection, EditHistory, elapsed }
})(globalThis)

// ESM 命名导出（原为 IIFE 挂 globalThis；React 迁移后按模块导入，行为不变）
const { selection, EditHistory, elapsed } = globalThis.ScreenEditorCore
export { selection, EditHistory, elapsed }

