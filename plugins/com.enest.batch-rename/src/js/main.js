/* 批量重命名 — localFiles.fromDrop 句柄队列 + 规则链（core.mjs 纯函数）+ 实时预览
   → fs.renameBatch(confirmed) → 结果报告 + storage 撤销映射（反向 renameBatch）。 */
import { applyRules, hasBlocked } from './core.mjs'

;(function () {
  const api = window.enest || window.zapi
  const $ = (id) => document.getElementById(id)
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(2)} GB`
  }

  const kit = window.PluginKit.create({ title: '批量重命名', height: 560 })

  const state = {
    files: [],      // { handleId, name, size, dir }
    rules: [],      // 规则链（core.mjs 结构 + UI 状态）
    rows: [],       // 预览行
    lastRun: null,  // 撤销映射 [{ handleId, from, to }]
    seq: 0
  }

  const status = (text) => { $('status').textContent = text || '' }

  // —— 文件队列 ——
  async function addFiles(fileList, selected = false) {
    const list = Array.from(fileList || [])
    if (!list.length) return
    try {
      const handles = selected ? list : await api.localFiles.fromDrop(list)
      let added = 0
      for (const h of handles) {
        if (h.kind !== 'file') continue
        if (state.files.some((f) => f.name === h.name && f.size === h.size)) continue
        state.files.push({ handleId: h.id, name: h.name, size: h.size, dir: '' })
        added++
      }
      status(`已加入 ${added} 个文件`)
      render()
    } catch (err) {
      kit.toast(err?.message || '拖入失败', 'error')
    }
  }

  function renderQueue() {
    const list = $('file-list')
    const has = state.files.length > 0
    list.hidden = !has
    $('drop-zone').hidden = has
    $('clear-queue').hidden = !has
    $('queue-count').textContent = has ? `（${state.files.length}）` : ''
    list.innerHTML = ''
    state.files.forEach((f, i) => {
      const li = document.createElement('li')
      const idx = document.createElement('span')
      idx.className = 'f-index'
      idx.textContent = String(i + 1)
      const name = document.createElement('span')
      name.className = 'f-name'
      name.textContent = f.name
      name.title = f.name
      const size = document.createElement('span')
      size.className = 'f-size'
      size.textContent = fmtBytes(f.size)
      const del = document.createElement('button')
      del.textContent = '移除'
      del.addEventListener('click', () => {
        state.files.splice(i, 1)
        render()
      })
      li.append(idx, name, size, del)
      list.append(li)
    })
  }

  // —— 规则链 ——
  function ruleTemplate(type) {
    switch (type) {
      case 'replace': return { type, find: '', replaceWith: '', caseSensitive: false, regex: false }
      case 'number': return { type, start: 1, step: 1, width: 2, position: 'prefix', separator: '_', keepBase: true }
      case 'date': return { type, source: 'mtime', pattern: 'YYYYMMDD', position: 'suffix', separator: '_' }
      case 'case': return { type, mode: 'upper' }
      case 'ext': return { type, ext: '' }
      default: return null
    }
  }

  const RULE_LABEL = { replace: '查找替换', number: '序号', date: '日期', case: '大小写', ext: '扩展名' }

  function renderRules() {
    const list = $('rule-list')
    list.innerHTML = ''
    if (!state.rules.length) {
      const li = document.createElement('li')
      li.className = 'rule-empty'
      li.textContent = '还没有规则——添加一条开始预览'
      list.append(li)
      return
    }
    state.rules.forEach((rule, idx) => {
      const li = document.createElement('li')
      li.className = 'rule-item'
      li.draggable = true
      li.dataset.idx = String(idx)
      const order = document.createElement('span')
      order.className = 'r-order'
      order.textContent = `${idx + 1}.`
      const kind = document.createElement('span')
      kind.className = 'r-kind'
      kind.textContent = RULE_LABEL[rule.type] || rule.type
      li.append(order, kind)
      // 每类规则参数控件
      const field = (labelText, inputEl) => {
        const label = document.createElement('label')
        label.append(document.createTextNode(labelText), inputEl)
        return label
      }
      const text = (value, key, placeholder) => {
        const el = document.createElement('input')
        el.type = 'text'
        el.value = value ?? ''
        if (placeholder) el.placeholder = placeholder
        el.addEventListener('input', () => { rule[key] = el.value; schedulePreview() })
        return el
      }
      const num = (value, key, min, max) => {
        const el = document.createElement('input')
        el.type = 'number'
        el.value = value
        if (min !== undefined) el.min = String(min)
        if (max !== undefined) el.max = String(max)
        el.addEventListener('input', () => { rule[key] = Number(el.value); schedulePreview() })
        return el
      }
      const check = (value, key, textContent) => {
        const label = document.createElement('label')
        const el = document.createElement('input')
        el.type = 'checkbox'
        el.checked = value === true
        el.addEventListener('change', () => { rule[key] = el.checked; schedulePreview() })
        label.append(el, document.createTextNode(textContent))
        return label
      }
      const select = (value, key, options) => {
        const el = document.createElement('select')
        for (const [v, t] of options) {
          const opt = document.createElement('option')
          opt.value = v
          opt.textContent = t
          if (v === value) opt.selected = true
          el.append(opt)
        }
        el.addEventListener('change', () => { rule[key] = el.value; schedulePreview() })
        return el
      }
      switch (rule.type) {
        case 'replace':
          li.append(field('查找', text(rule.find, 'find', '要替换的内容')))
          li.append(field('替换为', text(rule.replaceWith, 'replaceWith', '留空即删除')))
          li.append(check(rule.caseSensitive, 'caseSensitive', '区分大小写'))
          li.append(check(rule.regex, 'regex', '正则'))
          break
        case 'number':
          li.append(field('起始', num(rule.start, 'start', 0)))
          li.append(field('步进', num(rule.step, 'step', 1)))
          li.append(field('位数', num(rule.width, 'width', 1, 10)))
          li.append(select(rule.position, 'position', [['prefix', '前缀'], ['suffix', '后缀']]))
          li.append(field('分隔', text(rule.separator, 'separator', '_')))
          li.append(check(rule.keepBase !== false, 'keepBase', '保留原名'))
          break
        case 'date':
          li.append(select(rule.source, 'source', [['mtime', '原文件时间'], ['now', '当前时间']]))
          li.append(field('格式', text(rule.pattern, 'pattern', 'YYYYMMDD')))
          li.append(select(rule.position, 'position', [['prefix', '前缀'], ['suffix', '后缀']]))
          li.append(field('分隔', text(rule.separator, 'separator', '_')))
          break
        case 'case':
          li.append(select(rule.mode, 'mode', [['upper', '全大写'], ['lower', '全小写'], ['title', '首字母大写']]))
          break
        case 'ext':
          li.append(field('新扩展名', text(rule.ext, 'ext', '如 jpg（留空删除）')))
          break
      }
      const del = document.createElement('button')
      del.className = 'r-del'
      del.textContent = '删除'
      del.addEventListener('click', () => {
        state.rules.splice(idx, 1)
        render()
      })
      li.append(del)
      // 拖拽排序
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/rule-idx', String(idx)) })
      li.addEventListener('dragover', (e) => e.preventDefault())
      li.addEventListener('drop', (e) => {
        e.preventDefault()
        const from = Number(e.dataTransfer.getData('text/rule-idx'))
        if (!Number.isInteger(from) || from === idx) return
        const [moved] = state.rules.splice(from, 1)
        state.rules.splice(idx, 0, moved)
        render()
      })
      list.append(li)
    })
  }

  // —— 预览 ——
  let previewTimer = null
  function schedulePreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(renderPreview, 120)
  }

  function renderPreview() {
    const errBox = $('rule-error')
    errBox.hidden = true
    let rows = []
    try {
      // fromDrop 不回目录：同名冲突保守按同一目录分组（批量改名通常发生在同一目录）
      rows = applyRules(
        state.files.map((f) => ({ id: f.handleId, name: f.name, mtime: f.mtime, dir: '/batch' })),
        state.rules
      )
    } catch (err) {
      errBox.textContent = `规则参数错误：${err.message}`
      errBox.hidden = false
      rows = state.files.map((f) => ({ id: f.handleId, oldName: f.name, newName: f.name, error: null }))
    }
    state.rows = rows
    const table = $('preview-table')
    table.innerHTML = ''
    if (!state.files.length) {
      const p = document.createElement('p')
      p.className = 'rule-empty'
      p.textContent = '加入文件后这里显示 原名 → 新名 预览'
      table.append(p)
    } else {
      const head = document.createElement('div')
      head.className = 'pv-row pv-head'
      for (const t of ['原名', '', '新名', '状态']) {
        const s = document.createElement('span')
        s.textContent = t
        head.append(s)
      }
      table.append(head)
      const blocked = hasBlocked(rows)
      const changed = rows.filter((r) => r.newName !== r.oldName && !r.error).length
      for (const row of rows) {
        const div = document.createElement('div')
        div.className = 'pv-row' + (row.error ? ' blocked' : '')
        const oldEl = document.createElement('span')
        oldEl.className = 'pv-name'
        oldEl.textContent = row.oldName
        oldEl.title = row.oldName
        const arrow = document.createElement('span')
        arrow.className = 'pv-arrow'
        arrow.textContent = '→'
        const newEl = document.createElement('span')
        newEl.className = 'pv-name pv-new'
        newEl.textContent = row.newName
        newEl.title = row.newName
        const note = document.createElement('span')
        note.className = 'pv-note'
        note.textContent = row.error || (row.newName === row.oldName ? '（不变）' : '')
        div.append(oldEl, arrow, newEl, note)
        table.append(div)
      }
      $('preview-meta').textContent = blocked
        ? `${changed} 个将改名 · ${rows.filter((r) => r.error).length} 个异常（禁止执行）`
        : `${changed} 个将改名`
      $('run-btn').disabled = blocked || changed === 0
    }
  }

  function render() {
    renderQueue()
    renderRules()
    renderPreview()
    $('undo-btn').hidden = !state.lastRun
  }

  // —— 执行 ——
  async function run() {
    const items = state.rows
      .filter((r) => r.newName !== r.oldName && !r.error)
      .map((r) => ({ handleId: r.id, newName: r.newName }))
    if (!items.length) return
    const dlg = $('confirm-dialog')
    $('confirm-summary').textContent = `将改名 ${items.length} 个文件（仅同目录，不移动）`
    const list = $('confirm-list')
    list.innerHTML = ''
    for (const item of items.slice(0, 60)) {
      const li = document.createElement('li')
      li.textContent = `${item.newName}`
      list.append(li)
    }
    if (items.length > 60) {
      const li = document.createElement('li')
      li.textContent = `… 共 ${items.length} 项`
      list.append(li)
    }
    const choice = await new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true })
      dlg.showModal()
    })
    if (choice !== 'ok') return
    $('run-btn').disabled = true
    try {
      const result = await api.fs.renameBatch({ items, confirmed: true })
      // 撤销映射：成功项记录 to → from（句柄在宿主侧已跟随新名）
      state.lastRun = result.results
        .filter((r) => r.ok)
        .map((r) => ({ handleId: r.handleId, from: r.oldName, to: r.newName }))
      if (result.failed > 0) {
        kit.toast(`完成：成功 ${result.succeeded}，失败 ${result.failed}`, 'warn')
        const failedRows = result.results.filter((r) => !r.ok)
        status(`失败明细：${failedRows.map((r) => `${r.newName}（${r.error}）`).join('；')}`)
      } else {
        kit.toast(`已改名 ${result.succeeded} 个文件`, 'success')
        status('')
      }
      await saveUndo()
      // 成功项移出队列
      const okIds = new Set(result.results.filter((r) => r.ok).map((r) => r.handleId))
      state.files = state.files.filter((f) => !okIds.has(f.handleId))
      render()
    } catch (err) {
      kit.toast(err?.message || '执行失败', 'error')
      $('run-btn').disabled = false
    }
  }

  // —— 撤销 ——
  async function saveUndo() {
    await kit.save('undoMap', state.lastRun || []).catch(() => {})
  }

  async function undo() {
    if (!state.lastRun?.length) return
    const items = state.lastRun.map((m) => ({ handleId: m.handleId, newName: m.from }))
    try {
      const result = await api.fs.renameBatch({ items, confirmed: true })
      const undone = result.results.filter((r) => r.ok).length
      kit.toast(undone === items.length ? `已撤销 ${undone} 个` : `撤销 ${undone}/${items.length}（其余文件已变化）`, undone === items.length ? 'success' : 'warn')
      state.lastRun = null
      await saveUndo()
    } catch (err) {
      kit.toast(err?.message || '撤销失败（文件可能已被移动）', 'error')
    }
  }

  async function loadUndo() {
    const saved = await kit.load('undoMap', [])
    state.lastRun = Array.isArray(saved) && saved.length ? saved : null
    $('undo-btn').hidden = !state.lastRun
  }

  // —— 双形态 ——
  kit.onMode((mode) => {
    document.documentElement.dataset.mode = mode
    if (mode === 'quick') void api.ui.setHeight(state.files.length ? 620 : 480).catch(() => {})
  })

  // —— 绑定 ——
  {
    const zone = $('drop-zone')
    const app = document.querySelector('.rn-app')
    let depth = 0
    app.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('armed') })
    app.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('armed') })
    app.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; zone.classList.remove('armed')
      void addFiles(e.dataTransfer?.files)
    })
  }
  const pickFiles = () => void api.localFiles.pick({ kind: 'file', access: 'read', multiple: true }).then(handles => addFiles(handles, true)).catch(error => kit.toast(error.message, 'error'))
  $('pick-btn').addEventListener('click', () => pickFiles())
  $('clear-queue').addEventListener('click', () => { state.files = []; render() })
  $('rule-add').addEventListener('change', (e) => {
    const type = e.target.value
    e.target.value = ''
    if (!type) return
    const rule = ruleTemplate(type)
    if (rule) { state.rules.push(rule); render() }
  })
  $('run-btn').addEventListener('click', () => void run())
  $('undo-btn').addEventListener('click', () => void undo())

  render()
  void loadUndo()
})()
