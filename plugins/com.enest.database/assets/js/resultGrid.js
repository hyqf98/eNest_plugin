/**
 * resultGrid.js — 结果网格：虚拟滚动、行状态 CRUD、变更集
 * 可见控件极少：状态徽标；选中行/有脏变更时出现选择条
 * 提交/放弃仅在存在脏变更时出现；其余走右键
 */
import { toast } from './api.js'
import { uid } from './store.js'
import { openCtxMenu } from './ctxMenu.js'
import { enhanceSelect } from './dropdown.js'

const ROW_H = 28

export class ResultGrid {
  constructor(root, opts = {}) {
    this.root = root
    this.onSelectionChange = opts.onSelectionChange || (() => {})
    this.onCommit = opts.onCommit || (() => {})
    this.onRevert = opts.onRevert || (() => {})
    this.onExport = opts.onExport || (() => {})
    this.onImport = opts.onImport || (() => {})
    this.onGenerateSql = opts.onGenerateSql || (() => {})
    this.onRefresh = opts.onRefresh || (() => {})
    this.onExportCsv = opts.onExportCsv || null
    this.onContextMenu = opts.onContextMenu || null
    this.onPageChange = opts.onPageChange || (() => {})
    this.onPageSizeChange = opts.onPageSizeChange || (() => {})
    this.data = null
    this.tableRef = null
    this.editable = false
    this.readOnly = false
    this.rowIdentity = null
    this.columns = []
    this.rows = []
    this.rowState = new Map()
    this.insertedRows = []
    this.selectedRows = new Set()
    this.cellSel = null
    // —— 视图层（排序 / 筛选 / 分页）：仅决定展示顺序，模型行索引（rows/rowState/selectedRows 键）不变 ——
    this.sortCol = null // 列索引 | null
    this.sortDir = null // 'asc' | 'desc' | null（三态：none → asc → desc → none）
    this.filterOpen = false
    this.filters = {} // 列索引 -> 关键词（contains，客户端过滤）
    this.page = 0
    this.pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 200
    this.viewAllIdxs = [] // 筛选+排序后的全部模型行索引（不含新增行）
    this.viewIdxs = [] // 当前页切片 + 新增行，_renderRows 按此渲染
    this._build()
    this._bind()
  }

  _build() {
    this.root.innerHTML = `
      <div class="grid-bar">
        <span class="badge" data-el="badge">—</span>
        <div class="grid-selbar" data-el="selbar" hidden></div>
        <div class="spacer"></div>
        <button type="button" class="btn sm rg-filter-toggle" data-el="filterToggle" hidden title="列筛选">筛选</button>
        <span class="grid-meta" data-el="status"></span>
      </div>
      <div class="grid-body" data-el="body">
        <div class="grid-head" data-el="head"></div>
        <div class="grid-viewport" data-el="viewport">
          <div class="grid-canvas" data-el="canvas"></div>
        </div>
        <input class="cell-editor" data-el="cellEditor" hidden />
      </div>
      <div class="rg-pager" data-el="pager" hidden></div>
      <div class="grid-cellview" data-el="cellview" hidden></div>
    `
    this.el = {
      badge: this.root.querySelector('[data-el=badge]'),
      selbar: this.root.querySelector('[data-el=selbar]'),
      filterToggle: this.root.querySelector('[data-el=filterToggle]'),
      head: this.root.querySelector('[data-el=head]'),
      viewport: this.root.querySelector('[data-el=viewport]'),
      canvas: this.root.querySelector('[data-el=canvas]'),
      status: this.root.querySelector('[data-el=status]'),
      cellEditor: this.root.querySelector('[data-el=cellEditor]'),
      pager: this.root.querySelector('[data-el=pager]'),
      cellview: this.root.querySelector('[data-el=cellview]')
    }
  }

  _bind() {
    this.el.selbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sel]')
      if (!btn) return
      const k = btn.dataset.sel
      if (k === 'commit') this.onCommit()
      else if (k === 'revert') this.revertAll()
      else if (k === 'insert') this.insertRow()
      else if (k === 'more') this.openOverflowMenu(e)
    })

    this.el.viewport.addEventListener('contextmenu', (e) => {
      const rowEl = e.target.closest('[data-row]')
      const cell = e.target.closest('[data-r][data-c]')
      if (cell) {
        this.cellSel = { row: Number(cell.dataset.r), col: cell.dataset.c }
        this._renderRows()
      } else if (rowEl) {
        const idx = Number(rowEl.dataset.row)
        this.selectedRows.add(idx)
        this._renderRows()
        this.onSelectionChange(this.selectedRows)
      }
      e.preventDefault()
      if (this.onContextMenu) this.onContextMenu(e, this.cellSel)
      else this.openCellContextMenu(e)
    })

    this.el.viewport.addEventListener('scroll', () => this._renderRows())
    // 视口宽度变化 → 列模板（minmax 下限）重算，避免小视口横向滚动/大视口列过窄
    window.addEventListener('resize', () => {
      if (!this.columns.length) return
      this._renderHead()
      this._renderRows()
    })
    this.el.viewport.addEventListener('dblclick', (e) => {
      const cell = e.target.closest('[data-r][data-c]')
      if (!cell) return
      this._beginEdit(cell.dataset.r, cell.dataset.c)
    })
    this.el.viewport.addEventListener('click', (e) => {
      const rowEl = e.target.closest('[data-row]')
      if (!rowEl) return
      const idx = Number(rowEl.dataset.row)
      if (e.target.classList.contains('row-check')) {
        if (e.target.checked) this.selectedRows.add(idx)
        else this.selectedRows.delete(idx)
        this._renderRows()
        this.onSelectionChange(this.selectedRows)
        return
      }
      const cell = e.target.closest('[data-r][data-c]')
      this.cellSel = cell ? { row: Number(rowEl.dataset.row), col: cell.dataset.c } : null
      this._renderRows()
    })
    this.el.cellEditor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this._commitEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this._cancelEdit()
      }
    })
    this.el.cellEditor.addEventListener('blur', () => this._commitEdit())

    this.el.head.addEventListener('click', (e) => {
      const th = e.target.closest('.th[data-c]')
      if (!th || e.target.closest('input')) return
      this._cycleSort(Number(th.dataset.c))
    })
    this.el.head.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-filter-c]')
      if (!inp) return
      this.filters[Number(inp.dataset.filterC)] = inp.value
      this._applyView({ resetScroll: true })
    })

    this.el.filterToggle.addEventListener('click', () => {
      this.filterOpen = !this.filterOpen
      if (!this.filterOpen) this.filters = {}
      this._renderHead()
      this._applyView({ resetScroll: true })
    })

    this.el.pager.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pager]')
      if (!btn) return
      const k = btn.dataset.pager
      if (k === 'prev') this.page = Math.max(0, this.page - 1)
      else if (k === 'next') this.page = Math.min(this._pageCount() - 1, this.page + 1)
      else if (k === 'go') {
        const v = Number(btn.dataset.page)
        if (Number.isFinite(v)) this.page = Math.min(Math.max(0, v), this._pageCount() - 1)
      }
      this._applyView({ resetScroll: true })
    })
    this.el.pager.addEventListener('change', (e) => {
      if (e.target.dataset?.pagerSelect !== 'size') return
      const v = Number(e.target.value)
      if (!Number.isFinite(v) || v <= 0) return
      this.pageSize = v
      this.page = 0
      this.onPageSizeChange(v)
      this._applyView({ resetScroll: true })
    })

    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'F2' && this.cellSel) {
        e.preventDefault()
        this._beginEdit(this.cellSel.row, this.cellSel.col)
      }
    })
    this.root.tabIndex = 0
  }

  /* ── 视图层：排序 / 筛选 / 分页（均为客户端，模型索引不变）── */

  /** 排序比较：NULL 最小，数字/日期可比则数值比较，否则字符串本地化比较 */
  _cmpRows(ci) {
    const dir = this.sortDir === 'desc' ? -1 : 1
    const col = this.columns[ci]
    const numeric = col?.dataType ? /int|number|decimal|double|float|real|bit/i.test(col.dataType) : false
    return (a, b) => {
      const va = a[ci]
      const vb = b[ci]
      if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : -dir
      if (vb === null || vb === undefined) return dir
      if (numeric || (typeof va === 'number' && typeof vb === 'number')) {
        const na = Number(va)
        const nb = Number(vb)
        if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * dir
      }
      return String(va).localeCompare(String(vb), 'zh-Hans-CN', { numeric: true }) * dir
    }
  }

  /** 列头三态排序：none → asc → desc → none */
  _cycleSort(ci) {
    if (this.sortCol !== ci) {
      this.sortCol = ci
      this.sortDir = 'asc'
    } else if (this.sortDir === 'asc') this.sortDir = 'desc'
    else {
      this.sortCol = null
      this.sortDir = null
    }
    this._renderHead()
    this._applyView({ resetScroll: true })
  }

  /** 单元格匹配文本（过滤用，不截断长文本） */
  _cellText(idx, ci) {
    const st = this.rowState.get(idx)
    const row = this.rows[idx]
    const raw =
      st && (st.status === 'inserted' || st.status === 'dirty') ? st.current?.[ci] : row?.[ci]
    if (raw === null || raw === undefined) return 'NULL'
    if (typeof raw === 'object') return JSON.stringify(raw)
    return String(raw)
  }

  _pageCount() {
    return Math.max(1, Math.ceil(this.viewAllIdxs.length / this.pageSize))
  }

  /** 过滤 + 排序 + 分页 → viewIdxs；sort/filter/page 变化后调用 */
  _applyView({ resetScroll = false } = {}) {
    const hasFilter = Object.values(this.filters).some((v) => String(v ?? '').trim() !== '')
    let idxs = [...this.rows.keys()]
    if (hasFilter) {
      idxs = idxs.filter((i) =>
        Object.entries(this.filters).every(([ci, kw]) => {
          const q = String(kw ?? '').trim().toLowerCase()
          if (!q) return true
          return this._cellText(i, Number(ci)).toLowerCase().includes(q)
        })
      )
    }
    if (this.sortCol != null && this.sortDir) {
      const cmp = this._cmpRows(this.sortCol)
      // 排序时优先用脏值/新增值比较，保证编辑后顺序即时反映
      idxs.sort((a, b) => cmp(this._sortRow(a), this._sortRow(b)))
    }
    this.viewAllIdxs = idxs
    // 页码越界（过滤后行数变少）回退到最后一页
    if (this.page >= this._pageCount()) this.page = this._pageCount() - 1
    if (this.page < 0) this.page = 0
    const start = this.page * this.pageSize
    this.viewIdxs = idxs.slice(start, start + this.pageSize).concat(this.insertedRows.map((r) => r._idx))
    if (resetScroll) this.el.viewport.scrollTop = 0
    this._renderRows()
  }

  /** 排序比较用行数据：脏行取 current，干净行取原行 */
  _sortRow(idx) {
    const st = this.rowState.get(idx)
    if (st && (st.status === 'dirty' || st.status === 'inserted') && st.current) return st.current
    return this.rows[idx]
  }

  _renderSelbar() {
    const bar = this.el.selbar
    if (!bar) return
    const pending = this.pendingChanges()
    const dirty = pending.length > 0
    const sel = this.selectedRows.size
    const canWrite = this.editable && !this.readOnly
    const show = sel > 0 || dirty
    bar.hidden = !show
    if (!show) {
      bar.innerHTML = ''
      return
    }
    const parts = []
    if (sel) parts.push(`<span class="muted sm">${sel} 行</span>`)
    if (dirty) parts.push(`<span class="badge warn">变更 ${pending.length}</span>`)
    if (dirty && canWrite) {
      parts.push(`<button type="button" class="btn sm primary" data-sel="commit">提交</button>`)
      parts.push(`<button type="button" class="btn sm" data-sel="revert">放弃</button>`)
    }
    if (canWrite) parts.push(`<button type="button" class="btn sm" data-sel="insert">新增</button>`)
    parts.push(
      `<button type="button" class="btn icon" data-sel="more" title="更多" aria-label="更多">⋯</button>`
    )
    bar.innerHTML = parts.join('')
  }

  openOverflowMenu(ev) {
    const canWrite = this.editable && !this.readOnly
    const items = []
    if (canWrite) {
      items.push(['dup', '复制行'], ['delete', '标记删除', { danger: true }], ['revert', '回滚本地'], 'sep')
    }
    items.push(
      ['copy-cell', '复制单元格'],
      ['copy-row-json', '行 JSON'],
      'sep',
      ['preview', 'SQL 预览'],
      ['gen-sql', '生成 DML'],
      ['export', '导出…'],
      ['import', '导入 CSV'],
      ['refresh', '刷新']
    )
    openCtxMenu(ev, items, (k) => {
      if (k === 'dup') this.duplicateRow()
      else if (k === 'delete') this.markDeleteSelected()
      else if (k === 'revert') this.revertAll()
      else if (k === 'copy-cell') this.copyActiveCell()
      else if (k === 'copy-row-json') this.copyRowJson()
      else if (k === 'preview') this.onGenerateSql('preview')
      else if (k === 'gen-sql') this.onGenerateSql('update')
      else if (k === 'export') this.onExport()
      else if (k === 'import') this.onImport()
      else if (k === 'refresh') this.onRefresh()
    })
  }

  openCellContextMenu(ev) {
    const canWrite = this.editable && !this.readOnly
    const dirty = this.pendingChanges().length > 0
    const items = [
      ['copy-cell', '复制单元格'],
      ['copy-row-json', '行 JSON'],
      'sep',
      ['export-csv', '导出表格'],
      ['export', '导出…'],
      ['refresh', '刷新']
    ]
    if (canWrite) {
      items.push('sep', ['edit', '编辑单元格'], ['dup', '复制行'], ['delete', '标记删除', { danger: true }])
      if (dirty) {
        items.push('sep', ['commit', '提交变更'], ['revert', '放弃变更'], ['dml', '生成 DML'])
      } else {
        items.push('sep', ['dml', '生成 DML'], ['import', '导入表格'])
      }
    } else {
      items.push('sep', ['dml', '生成 DML'])
    }
    openCtxMenu(ev, items, (k) => {
      if (k === 'copy-cell') this.copyActiveCell()
      else if (k === 'copy-row-json') this.copyRowJson()
      else if (k === 'export-csv') {
        if (this.onExportCsv) this.onExportCsv()
        else this.onExport()
      } else if (k === 'export') this.onExport()
      else if (k === 'refresh') this.onRefresh()
      else if (k === 'edit') {
        if (this.cellSel) this._beginEdit(this.cellSel.row, this.cellSel.col)
      } else if (k === 'dup') this.duplicateRow()
      else if (k === 'delete') this.markDeleteSelected()
      else if (k === 'commit') this.onCommit()
      else if (k === 'revert') this.revertAll()
      else if (k === 'import') this.onImport()
      else if (k === 'dml') this.onGenerateSql('update')
    })
  }

  copyActiveCell() {
    const sel = this.cellSel
    if (!sel) {
      toast('请先选中单元格', 'warn')
      return
    }
    const row = this._getRow(sel.row)
    if (!row) return
    const ci = Number(sel.col)
    const st = this._ensureState(sel.row)
    const raw = st.status === 'inserted' || st.status === 'dirty' ? st.current?.[ci] : row[ci]
    const text = raw === null || raw === undefined ? 'NULL' : String(raw)
    try {
      navigator.clipboard?.writeText(text)
    } catch {
      /* ignore */
    }
    toast('已复制单元格', 'success')
  }

  copyRowJson() {
    const sel = this.cellSel
    const idx = sel?.row ?? [...this.selectedRows][0]
    if (idx == null) {
      toast('请先选中一行', 'warn')
      return
    }
    const row = this._getRow(idx)
    if (!row) return
    const st = this._ensureState(idx)
    const values = st.status === 'inserted' || st.status === 'dirty' ? st.current : row
    const obj = {}
    this.columns.forEach((c, i) => {
      obj[this._colLabel(c)] = values?.[i] ?? null
    })
    try {
      navigator.clipboard?.writeText(JSON.stringify(obj, null, 2))
    } catch {
      /* ignore */
    }
    toast('已复制行 JSON', 'success')
  }

  discardChange(idx) {
    const st = this.rowState.get(idx)
    if (!st) return
    if (st.insert || idx >= this.rows.length) {
      this.insertedRows = this.insertedRows.filter((r) => r._idx !== idx)
      this.rowState.delete(idx)
    } else {
      st.current = st.original ? st.original.slice() : st.current
      st.status = 'clean'
      st.error = ''
    }
    this._applyView()
    this.onRevert()
  }

  setResult({ result, tableRef, readOnly, driverUpdatable, pageSize }) {
    this.data = result || null
    this.columns = result?.columns || []
    this.rows = Array.isArray(result?.rows) ? result.rows : []
    this.rowIdentity = result?.rowIdentity || null
    if (!this.rowIdentity?.keyColumns?.length && this.columns.length) {
      const pkIdx = []
      const keyColumns = []
      this.columns.forEach((c, i) => {
        if (c?.primaryKey || c?.pk) {
          keyColumns.push(this._colLabel(c))
          pkIdx.push(i)
        }
      })
      if (keyColumns.length) {
        this.rowIdentity = {
          keyColumns,
          keys: this.rows.map((row) => pkIdx.map((i) => row[i]))
        }
      }
    }
    this.tableRef = tableRef || null
    this.readOnly = !!readOnly
    this.editable =
      !readOnly &&
      !!driverUpdatable &&
      !!(this.rowIdentity?.keyColumns?.length || tableRef) &&
      !this.readOnly
    if (result?.tableRef && !this.tableRef) this.tableRef = result.tableRef
    this.rowState.clear()
    this.insertedRows = []
    this.selectedRows.clear()
    this.cellSel = null
    this._lastChangeIdxs = null
    // 新结果集：视图状态归零（pageSize 取传入持久化值）
    const ps = Number(pageSize)
    if (ps > 0) this.pageSize = ps
    this.sortCol = null
    this.sortDir = null
    this.filters = {}
    this.page = 0
    this.filterOpen = false
    this.el.viewport.scrollTop = 0
    this._renderHead()
    this._applyView()
  }

  setTableRef(tableRef) {
    this.tableRef = tableRef
    if (tableRef && this.rowIdentity?.keyColumns?.length) this.editable = !this.readOnly
    this._renderBadge()
  }

  _renderBadge() {
    const b = this.el.badge
    if (!b) return
    if (!this.data && !this.insertedRows.length) {
      b.textContent = '—'
      b.className = 'badge'
      return
    }
    if (this.readOnly) {
      b.textContent = '只读'
      b.className = 'badge warn'
      return
    }
    if (!this.editable) {
      b.textContent = '只读'
      b.className = 'badge warn'
      return
    }
    const pending = this.pendingChanges().length
    b.textContent = pending ? `变更 ${pending}` : '可编辑'
    b.className = pending ? 'badge accent' : 'badge ok'
  }

  _colLabel(col) {
    return col?.name ?? String(col)
  }

  _gridTemplate() {
    const n = this.columns.length
    // 数据列下限 100px 仅在容器放得下时生效；小视口改为可压缩（minmax(0,1fr)），
    // 由 .th/.td 的 ellipsis 接管截断，避免画布超宽出现横向滚动硬裁切
    const w = this.el.viewport?.clientWidth || 0
    const fixed = 36 + 44 + 72
    const fits = w > 0 && w >= fixed + Math.max(n, 1) * 100 + 24
    this._colsFit = fits
    return `36px 44px repeat(${Math.max(n, 1)}, minmax(${fits ? 100 : 0}px, 1fr)) 72px`
  }

  /** 行宽模式：列放得下时用 0（消除 .tr min-width:max-content 造成的画布超宽/横向滚动）；
      列多放不下时保留 max-content（宽表可横向滚动查看，不丢数据） */
  _rowWidth() {
    return this._colsFit ? '0' : 'max-content'
  }

  _renderHead() {
    const cols = this.columns
    const tpl = this._gridTemplate()
    const cells = [
      '<div class="th sel"><input type="checkbox" data-act="sel-all" /></div>',
      '<div class="th idx">#</div>'
    ]
      .concat(
        cols.map((c, i) => {
          const pk = c?.primaryKey ? '<span class="pk">PK</span>' : ''
          const type = c?.dataType ? `<span class="col-type">${escape(c.dataType)}</span>` : ''
          const sorted = this.sortCol === i && this.sortDir
          const arrow = sorted
            ? `<span class="sort-ind" style="color:var(--accent);font-size:10px">${this.sortDir === 'asc' ? '▲' : '▼'}</span>`
            : ''
          return `<div class="th${sorted ? ' sorted' : ''}" data-c="${i}" style="cursor:pointer" title="点击排序（升序 → 降序 → 取消）">${escape(this._colLabel(c))}${pk}${type}${arrow}</div>`
        })
      )
      .join('')
    let html = `<div class="tr head-row" style="grid-template-columns:${tpl};min-width:${this._rowWidth()}">${cells}</div>`
    if (this.filterOpen && cols.length) {
      const fcells = [
        '<div class="th sel"></div>',
        '<div class="th idx">#</div>'
      ]
        .concat(
          cols.map((c, i) => {
            const v = escape(this.filters[i] ?? '')
            return `<div class="th" data-fc="${i}"><input type="text" class="rg-filter-input" data-filter-c="${i}" value="${v}" placeholder="筛选…" style="width:100%;min-width:60px;box-sizing:border-box;padding:2px 6px;font-size:11px;font-family:var(--font);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xs);color:var(--text);outline:none" /></div>`
          })
        )
        .join('')
      html += `<div class="tr rg-filter-row" style="grid-template-columns:${tpl};min-width:${this._rowWidth()}">${fcells}</div>`
    }
    this.el.head.innerHTML = html
    this.el.filterToggle.hidden = !cols.length
    this.el.filterToggle.classList.toggle('active', this.filterOpen)
    this.el.filterToggle.style.color = this.filterOpen ? 'var(--accent)' : ''
    this.el.head.querySelector('[data-act=sel-all]')?.addEventListener('change', (e) => {
      // 全选作用于当前视图（排序/筛选/分页后的可见行）
      if (e.target.checked) this.viewIdxs.forEach((i) => this.selectedRows.add(i))
      else this.selectedRows.clear()
      this._renderRows()
      this.onSelectionChange(this.selectedRows)
    })
  }

  _allRowIndices() {
    return [...this.rows.keys(), ...this.insertedRows.map((r) => r._idx)]
  }

  _getRow(idx) {
    if (idx < this.rows.length) return this.rows[idx]
    return this.insertedRows.find((r) => r._idx === idx)?.values || null
  }

  _ensureState(idx) {
    if (!this.rowState.has(idx)) {
      const original = this._getRow(idx)
      this.rowState.set(idx, {
        status: 'clean',
        original,
        current: original ? original.slice() : null,
        selected: false,
        error: '',
        key: this._keyOf(idx),
        insert: idx >= this.rows.length
      })
    }
    return this.rowState.get(idx)
  }

  _keyOf(idx) {
    const ri = this.rowIdentity
    if (!ri?.keyColumns?.length) return null
    if (idx >= this.rows.length) return null
    const keyVals = ri.keys?.[idx]
    if (keyVals) {
      const key = {}
      ri.keyColumns.forEach((col, i) => {
        key[col] = keyVals[i]
      })
      return key
    }
    // 无 keys 矩阵时用列 primaryKey 从当前行取值
    const row = this.rows[idx]
    if (!row) return null
    const key = {}
    for (const name of ri.keyColumns) {
      const ci = this.columns.findIndex((c) => this._colLabel(c) === name)
      if (ci < 0) return null
      key[name] = row[ci]
    }
    return key
  }

  _renderRows() {
    const viewport = this.el.viewport
    const canvas = this.el.canvas
    const view = this.viewIdxs
    const total = view.length
    const scrollTop = viewport.scrollTop
    const h = viewport.clientHeight || 300
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5)
    const end = Math.min(total, Math.ceil((scrollTop + h) / ROW_H) + 5)
    canvas.style.height = `${total * ROW_H}px`
    canvas.style.paddingTop = `${start * ROW_H}px`

    const frag = document.createDocumentFragment()
    for (let vi = start; vi < end; vi++) {
      const i = view[vi]
      const row = this._getRow(i)
      if (!row) continue
      const st = this._ensureState(i)
      const tr = document.createElement('div')
      tr.className = `tr row-${st.status}${this.selectedRows.has(i) ? ' selected' : ''}`
      tr.dataset.row = i
      tr.style.height = `${ROW_H}px`
      tr.style.gridTemplateColumns = this._gridTemplate()
      tr.style.minWidth = this._rowWidth()
      const checked = this.selectedRows.has(i) ? 'checked' : ''
      // 行号与分页栏「from-to」同语义：全局连续（含过滤/排序后的视图顺序），插入行接续编号
      const rowNo = this.page * this.pageSize + vi + 1
      let html = `<div class="td sel"><input type="checkbox" class="row-check" ${checked} /></div><div class="td idx">${rowNo}</div>`
      this.columns.forEach((col, ci) => {
        const raw = row[ci]
        const cur = st.status === 'inserted' || st.status === 'dirty' ? st.current?.[ci] : raw
        const dirtyCell = st.status === 'dirty' && st.original?.[ci] !== st.current?.[ci]
        const isNull = cur === null || cur === undefined
        const cls = [
          'td',
          col?.primaryKey ? 'pk-cell' : '',
          isNull ? 'null-cell' : '',
          dirtyCell ? 'dirty-cell' : '',
          this.cellSel?.row === i && String(this.cellSel?.col) === String(ci) ? 'cell-active' : ''
        ]
          .filter(Boolean)
          .join(' ')
        const text = isNull ? 'NULL' : formatCell(cur)
        html += `<div class="${cls}" data-r="${i}" data-c="${ci}" title="${escape(text)}">${escape(text)}</div>`
      })
      const statusText =
        st.status === 'clean'
          ? ''
          : st.status === 'dirty'
            ? '已修改'
            : st.status === 'inserted'
              ? '新增'
              : st.status === 'deleted'
                ? '删除'
                : st.status === 'failed'
                  ? '失败'
                  : st.status
      html += `<div class="td status ${st.status}">${statusText}${
        st.error ? `<span class="err" title="${escape(st.error)}">!</span>` : ''
      }</div>`
      tr.innerHTML = html
      frag.appendChild(tr)
    }
    canvas.replaceChildren(frag)
    this._renderPager()
    this._renderStatus()
    this._renderBadge()
    this._renderSelbar()
  }

  /** 底部分页条：客户端分页（宿主 db.execute 无 offset 能力） */
  _renderPager() {
    const pager = this.el.pager
    if (!pager) return
    const total = this.viewAllIdxs.length
    if (!this.columns.length || !this.rows.length) {
      pager.hidden = true
      pager.style.display = ''
      pager.dataset.sig = ''
      return
    }
    pager.hidden = false
    pager.style.display = 'flex'
    const pages = this._pageCount()
    const page = Math.min(this.page, pages - 1)
    const sizes = [50, 100, 200, 500]
    if (!sizes.includes(this.pageSize)) sizes.unshift(this.pageSize)
    const from = total ? page * this.pageSize + 1 : 0
    const to = Math.min(total, (page + 1) * this.pageSize)
    // 滚动也会触发 _renderRows：内容未变时跳过重建，避免 select 交互被打断
    const sig = `${from}-${to}/${total}/${pages}/${this.pageSize}`
    if (pager.dataset.sig === sig) return
    pager.dataset.sig = sig
    pager.innerHTML = `
      <span class="muted sm">${from}-${to} / ${total} 行 · 客户端分页</span>
      <button type="button" class="btn sm" data-pager="prev" ${page <= 0 ? 'disabled' : ''}>‹</button>
      <span class="muted sm">${page + 1} / ${pages}</span>
      <button type="button" class="btn sm" data-pager="next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
      <select data-pager-select="size" title="每页行数">
        ${sizes.map((s) => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s} 行/页</option>`).join('')}
      </select>
    `
    enhanceSelect(pager.querySelector('[data-pager-select=size]'))
  }

  _renderStatus() {
    const data = this.data
    const parts = []
    if (data) {
      const filtered = this.viewAllIdxs.length
      const total = this.rows.length
      // 行数：过滤/排序生效时展示 过滤后/总数
      parts.push(
        filtered === total ? `${total} 行` : `行 ${filtered}/${total}`
      )
      if (data.affectedRows != null) parts.push(`影响 ${data.affectedRows}`)
      if (data.durationMs != null) parts.push(`${data.durationMs} ms`)
      // 达到 maxRows 截断时提示（宿主 QueryResult.truncated）
      if (data.truncated) parts.push('已达行数上限，结果可能被截断')
    }
    const pending = this.pendingChanges()
    if (pending.length) parts.push(`变更 ${pending.length}`)
    if (this.tableRef) {
      parts.push(
        `表 ${[this.tableRef.database, this.tableRef.schema, this.tableRef.table].filter(Boolean).join('.')}`
      )
    }
    this.el.status.textContent = parts.join(' · ')
  }

  _beginEdit(rowIdx, colIdx) {
    if (this.readOnly || !this.editable) {
      toast(this.readOnly ? '连接只读' : '结果集不可编辑', 'warn')
      return
    }
    const st = this._ensureState(rowIdx)
    if (st.status === 'deleted') return
    const cell = this.el.viewport.querySelector(`[data-r="${rowIdx}"][data-c="${colIdx}"]`)
    if (!cell) return
    const ci = Number(colIdx)
    const val = st.current?.[ci]
    const ed = this.el.cellEditor
    ed.hidden = false
    ed.value = val === null || val === undefined ? '' : String(val)
    ed.dataset.r = rowIdx
    ed.dataset.c = ci
    ed.style.left = cell.offsetLeft + 'px'
    ed.style.top = cell.offsetTop + 'px'
    ed.style.width = Math.max(80, cell.offsetWidth) + 'px'
    ed.style.height = cell.offsetHeight + 'px'
    this.el.canvas.appendChild(ed)
    ed.focus()
    ed.select()
    this._editOriginalNull = val === null || val === undefined
  }

  _commitEdit() {
    const ed = this.el.cellEditor
    if (ed.hidden) return
    const rowIdx = Number(ed.dataset.r)
    const ci = Number(ed.dataset.c)
    const col = this.columns[ci]
    let value = ed.value
    if (value === '' && this._editOriginalNull) value = null
    else if (col?.dataType && /int|number|decimal|double|float|bigint/i.test(col.dataType)) {
      if (value !== null && value !== '') {
        const n = Number(value)
        value = Number.isNaN(n) ? value : n
      }
    } else if (col?.dataType && /bool/i.test(col.dataType)) {
      if (value === 'true' || value === 'TRUE' || value === '1') value = true
      else if (value === 'false' || value === 'FALSE' || value === '0') value = false
    }
    this._applyCell(rowIdx, ci, value)
    ed.hidden = true
    this._applyView()
  }

  _cancelEdit() {
    this.el.cellEditor.hidden = true
  }

  _applyCell(rowIdx, ci, value) {
    const st = this._ensureState(rowIdx)
    if (!st.current) st.current = st.original ? st.original.slice() : this.columns.map(() => null)
    const prev = st.current[ci]
    if (prev === value) return
    st.current[ci] = value
    if (st.insert) st.status = 'inserted'
    else if (st.original?.[ci] === value) {
      const dirty = st.current.some((v, i) => v !== st.original[i])
      st.status = dirty ? 'dirty' : 'clean'
    } else st.status = 'dirty'
  }

  insertRow(fromIdx) {
    if (this.readOnly || !this.editable) {
      toast('当前结果集不可写', 'warn')
      return
    }
    const cols = this.columns
    let values = cols.map(() => null)
    if (fromIdx != null) {
      const src = this._getRow(fromIdx)
      if (src) values = src.slice()
    }
    const idx = this.rows.length + this.insertedRows.length
    this.insertedRows.push({ _idx: idx, values })
    this._ensureState(idx)
    const st = this.rowState.get(idx)
    st.status = 'inserted'
    st.current = values
    st.insert = true
    // 新增行永远追加在当前页尾部可见
    this.viewIdxs = this.viewIdxs.concat([idx])
    this.el.viewport.scrollTop = this.el.viewport.scrollHeight
    this._renderRows()
  }

  duplicateRow() {
    const idx = this.cellSel?.row ?? [...this.selectedRows][0]
    if (idx == null) {
      toast('请先选中一行', 'warn')
      return
    }
    this.insertRow(idx)
  }

  markDeleteSelected() {
    const indices = new Set(this.selectedRows)
    if (this.cellSel) indices.add(this.cellSel.row)
    if (!indices.size) {
      toast('请先选中要删除的行', 'warn')
      return
    }
    if (!this.rowIdentity?.keyColumns?.length && !this.tableRef) {
      toast('无主键，无法生成 DELETE', 'error')
      return
    }
    for (const i of indices) {
      const st = this._ensureState(i)
      if (st.insert) {
        this.insertedRows = this.insertedRows.filter((r) => r._idx !== i)
        this.rowState.delete(i)
        continue
      }
      if (st.status === 'deleted') st.status = 'clean'
      else st.status = 'deleted'
    }
    this.selectedRows.clear()
    this._applyView()
  }

  revertAll() {
    this.rowState.clear()
    this.insertedRows = []
    this.selectedRows.clear()
    this.cellSel = null
    this._applyView()
    toast('已放弃本地变更', 'info')
    this.onRevert()
  }

  pendingChanges() {
    const out = []
    for (const [idx, st] of this.rowState) {
      if (st.status === 'clean') continue
      if (!st.status) continue
      out.push({ idx, ...st })
    }
    return out
  }

  toRowChanges() {
    const table = this._tableRefForChange()
    if (!table) return []
    const cols = this.columns.map((c) => this._colLabel(c))
    const changes = []
    for (const [idx, st] of this.rowState) {
      const kind =
        st.status === 'failed'
          ? st.failType || (st.insert ? 'inserted' : 'dirty')
          : st.status
      if (kind === 'clean') continue
      if (kind === 'dirty') {
        const set = {}
        const original = {}
        cols.forEach((name, i) => {
          original[name] = st.original?.[i]
          if (st.current?.[i] !== st.original?.[i]) set[name] = st.current?.[i]
        })
        if (!Object.keys(set).length) continue
        const key = st.key || this._keyOf(idx)
        if (!key) {
          toast('无主键，无法提交修改', 'error')
          continue
        }
        changes.push({ type: 'update', table, key, set, original, _idx: idx })
      } else if (kind === 'inserted') {
        const values = {}
        cols.forEach((name, i) => {
          const v = st.current?.[i]
          if (v !== null && v !== undefined) values[name] = v
        })
        changes.push({ type: 'insert', table, values, _idx: idx })
      } else if (kind === 'deleted') {
        const key = st.key || this._keyOf(idx)
        if (!key) {
          toast('无主键，无法提交删除', 'error')
          continue
        }
        changes.push({ type: 'delete', table, key, _idx: idx })
      }
    }
    this._lastChangeIdxs = changes.map((c) => c._idx)
    return changes
  }

  _tableRefForChange() {
    if (this.tableRef) return this.tableRef
    if (this.data?.tableRef) return this.data.tableRef
    return null
  }

  /**
   * @param batchResult 宿主 BatchResult
   * @param changes 本次提交的 RowChange[]（含 _idx），用于 index → 本地行映射
   */
  applyBatchResult(batchResult, changes) {
    const results = batchResult?.results || []
    const list = Array.isArray(changes) && changes.length ? changes : this.toRowChanges()
    let anyFail = false
    const touched = new Set()
    results.forEach((r) => {
      const idxInBatch = typeof r?.index === 'number' ? r.index : results.indexOf(r)
      const src = list[idxInBatch]
      const localIdx = src?._idx ?? this._lastChangeIdxs?.[idxInBatch]
      if (localIdx == null) return
      const st = this.rowState.get(localIdx)
      if (!st) return
      touched.add(localIdx)
      if (r.ok) {
        if (st.insert || st.status === 'inserted') {
          this.insertedRows = this.insertedRows.filter((x) => x._idx !== localIdx)
          this.rowState.delete(localIdx)
        } else {
          st.original = st.current ? st.current.slice() : st.original
          st.status = 'clean'
          st.error = ''
          st.key = st.key || this._keyOf(localIdx)
        }
      } else {
        st.failType = st.insert ? 'inserted' : st.status === 'deleted' ? 'deleted' : st.status === 'inserted' ? 'inserted' : 'dirty'
        if (st.failType === 'clean' || !st.failType) st.failType = 'dirty'
        st.status = 'failed'
        st.error = r.error || '提交失败'
        anyFail = true
      }
    })
    this._applyView()
    return { anyFail, results }
  }

  sqlPreview(changes) {
    const table = this._tableRefForChange()
    if (!table) return '-- 缺少表引用'
    const t = quoteIdent([table.database, table.schema, table.table].filter(Boolean).join('.'))
    return (changes || this.toRowChanges())
      .map((c) => {
        if (c.type === 'update') {
          const sets = Object.entries(c.set)
            .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
            .join(', ')
          const wh = Object.entries(c.key)
            .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
            .join(' AND ')
          return `UPDATE ${t} SET ${sets} WHERE ${wh};`
        }
        if (c.type === 'insert') {
          const keys = Object.keys(c.values)
          return `INSERT INTO ${t} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys
            .map((k) => sqlLiteral(c.values[k]))
            .join(', ')});`
        }
        if (c.type === 'delete') {
          const wh = Object.entries(c.key)
            .map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`)
            .join(' AND ')
          return `DELETE FROM ${t} WHERE ${wh};`
        }
        return `-- ${c.type}`
      })
      .join('\n')
  }

  getExportData(scope = 'all') {
    const cols = this.columns.map((c) => this._colLabel(c))
    let rows
    if (scope === 'selected' && this.selectedRows.size) {
      rows = [...this.selectedRows].map((i) => this._getRow(i)).filter(Boolean)
    } else {
      // 按当前视图顺序导出（含排序/筛选）；新增行随其后
      rows = this.viewAllIdxs.map((i) => this._getRow(i)).filter(Boolean)
      rows = rows.concat(this.insertedRows.map((r) => r.values))
    }
    return { cols, rows }
  }
}

function formatCell(v) {
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function quoteIdent(name) {
  if (!name) return ''
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

export { ROW_H, uid }
