/**
 * markdown v2 —— 渲染态表格的交互接线（列宽拖拽 / 右键增删行列）。
 * 表格以 widget 渲染，写回源码走 EditorView.dispatch，触发重渲染。
 * 列宽只存插件 storage（不在 md 源码里留痕迹）。
 */
import {
  parseTable, serializeTable, insertColumn, deleteColumn, insertRow, deleteRow,
  getTableWidths, setTableWidths, loadPersistedWidths,
} from '../render/tableOps.js'

const MIN_COL = 48
let widthsReady = false

/** 给渲染出的 <table> 加 colgroup 并按保存的宽度应用 */
function applyWidths(tableEl, widths) {
  if (!widths || !widths.length) return
  const cols = tableEl.querySelectorAll('col')
  widths.forEach((w, i) => { if (cols[i] && w) cols[i].style.width = `${w}px` })
}

function ensureColgroup(tableEl, count) {
  let cg = tableEl.querySelector('colgroup')
  if (!cg) {
    cg = document.createElement('colgroup')
    for (let i = 0; i < count; i++) cg.appendChild(document.createElement('col'))
    tableEl.insertBefore(cg, tableEl.firstChild)
  }
  while (cg.children.length < count) cg.appendChild(document.createElement('col'))
  tableEl.style.tableLayout = 'fixed'
  return cg
}

/** 读出当前每列实际宽度（px） */
function currentWidths(tableEl) {
  const firstRow = tableEl.querySelector('tr')
  if (!firstRow) return []
  return Array.from(firstRow.children).map((cell) => Math.round(cell.getBoundingClientRect().width))
}

/**
 * 主接线。
 * @param wrap  widget 根元素
 * @param view  EditorView（用于 dispatch 写回源码）
 * @param blockFrom 表格块在文档中的起始偏移
 * @param blockText 表格块源码
 */
export function wireTable(wrap, view, blockFrom, blockText, requestEdit) {
  const tableEl = wrap.querySelector('table.md-table')
  if (!tableEl) return
  const parsed = parseTable(blockText)
  if (!parsed) return

  const colCount = parsed.header.length
  ensureColgroup(tableEl, colCount)
  applyWidths(tableEl, getTableWidths(blockText))
  // 首次接线时加载持久化宽度，完成后再应用一次（避免首帧丢失用户列宽）
  if (!widthsReady) {
    void loadPersistedWidths().then(() => {
      widthsReady = true
      if (wrap.isConnected) applyWidths(tableEl, getTableWidths(blockText))
    })
  }

  /* —— 列宽拖拽手柄：悬停列边界时出现 —— */
  const handles = document.createElement('div')
  handles.className = 'md-table-handles'
  wrap.appendChild(handles)

  const rebuildHandles = () => {
    handles.innerHTML = ''
    const cols = currentWidths(tableEl)
    let acc = 0
    const tableRect = tableEl.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    cols.forEach((w, i) => {
      acc += w
      if (i === cols.length - 1) return // 最后一列右边界不做拖拽（避免撑破容器）
      const h = document.createElement('div')
      h.className = 'md-table-col-handle'
      h.style.left = `${tableRect.left - wrapRect.left + acc}px`
      h.dataset.col = String(i)
      handles.appendChild(h)
    })
  }
  rebuildHandles()

  let dragState = null
  handles.addEventListener('mousedown', (e) => {
    const h = e.target.closest('.md-table-col-handle')
    if (!h) return
    e.preventDefault()
    e.stopPropagation()
    const colIndex = Number(h.dataset.col)
    const widths = currentWidths(tableEl)
    dragState = {
      colIndex,
      startX: e.clientX,
      startWidths: widths,
      next: widths[colIndex + 1] ?? MIN_COL,
    }
    document.body.classList.add('md-col-resizing')
  })

  const onMove = (e) => {
    if (!dragState) return
    const delta = e.clientX - dragState.startX
    const left = Math.max(MIN_COL, dragState.startWidths[dragState.colIndex] + delta)
    const realDelta = left - dragState.startWidths[dragState.colIndex]
    const right = Math.max(MIN_COL, (dragState.startWidths[dragState.colIndex + 1] ?? MIN_COL) - realDelta)
    const widths = [...dragState.startWidths]
    widths[dragState.colIndex] = left
    if (widths[dragState.colIndex + 1] !== undefined) widths[dragState.colIndex + 1] = right
    const cols = tableEl.querySelectorAll('col')
    widths.forEach((w, i) => { if (cols[i]) cols[i].style.width = `${w}px` })
    dragState.lastWidths = widths
    rebuildHandles()
  }

  const onUp = () => {
    if (!dragState) return
    if (dragState.lastWidths) setTableWidths(blockText, dragState.lastWidths)
    dragState = null
    document.body.classList.remove('md-col-resizing')
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  // widget 销毁时解绑（观察自身移除）
  const cleanupObserver = new MutationObserver(() => {
    if (!wrap.isConnected) {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      cleanupObserver.disconnect()
    }
  })
  cleanupObserver.observe(document.body, { childList: true, subtree: true })

  /* —— 右键菜单：增删行列 —— */
  tableEl.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const cell = e.target.closest('th,td')
    const row = e.target.closest('tr')
    const colIndex = cell ? Array.from(row.children).indexOf(cell) : 0
    const rowIndex = row && row.parentElement?.tagName === 'TBODY'
      ? Array.from(row.parentElement.children).indexOf(row)
      : -1
    openTableMenu(e.clientX, e.clientY, {
      colIndex,
      rowIndex,
      colCount,
      rowCount: parsed.rows.length,
      apply(transform) {
        const next = transform(parsed)
        view.dispatch({ changes: { from: blockFrom, to: blockFrom + blockText.length, insert: serializeTable(next) } })
      },
      resetWidths() {
        tableEl.querySelectorAll('col').forEach((c) => { c.style.width = '' })
        setTableWidths(blockText, [])
      },
    })
  })

  /* 单元格点击定位由 BlockWidget 的 mousedown 统一处理（Typora 手感），此处不再重复接管 */
}

/* ---------------- 表格右键菜单（DOM 直出，脱离 React） ---------------- */

let openMenuEl = null
function closeMenu() {
  openMenuEl?.remove()
  openMenuEl = null
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onDocKey, true)
}
function onDocDown(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu() }
function onDocKey(e) { if (e.key === 'Escape') closeMenu() }

function openTableMenu(x, y, ctx) {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'md-table-menu'
  const item = (label, fn, disabled) => {
    const b = document.createElement('button')
    b.textContent = label
    if (disabled) { b.disabled = true; b.classList.add('is-disabled') }
    b.addEventListener('click', () => { closeMenu(); fn() })
    menu.appendChild(b)
  }
  const sep = () => { const d = document.createElement('div'); d.className = 'md-menu-sep'; menu.appendChild(d) }
  const label = (t) => { const d = document.createElement('div'); d.className = 'md-menu-label'; d.textContent = t; menu.appendChild(d) }

  label('列')
  item('向左插入列', () => ctx.apply((t) => insertColumn(t, ctx.colIndex)))
  item('向右插入列', () => ctx.apply((t) => insertColumn(t, ctx.colIndex + 1)))
  item('删除此列', () => ctx.apply((t) => deleteColumn(t, ctx.colIndex)), ctx.colCount <= 1)
  sep()
  label('行')
  item('向上插入行', () => ctx.apply((t) => insertRow(t, Math.max(0, ctx.rowIndex))), ctx.rowIndex < 0)
  item('向下插入行', () => ctx.apply((t) => insertRow(t, ctx.rowIndex + 1)), ctx.rowIndex < 0)
  item('删除此行', () => ctx.apply((t) => deleteRow(t, ctx.rowIndex)), ctx.rowIndex < 0)
  sep()
  item('重置列宽', () => ctx.resetWidths())

  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 12)}px`
  openMenuEl = menu
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onDocKey, true)
}
