/* Small host adapters, not a page template. Each plugin owns its layout. */
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  function create(options = {}) {
    const api = window.enest || window.zapi
    const disposers = [], modeListeners = new Set(), settingListeners = new Set()
    let query = '', destroyed = false, noticeTimer
    const kit = { mode: api?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell', settings: { ...options.defaults } }
    const safely = promise => Promise.resolve(promise).catch(error => kit.toast(error?.message || String(error), 'error'))
    const configure = () => {
      if (kit.mode === 'quick' && options.quickPlaceholder && api?.quickInput) {
        return api.quickInput.configure({ placeholder: options.quickPlaceholder, value: query })
      }
    }
    const applyMode = mode => {
      if (mode && typeof mode === 'object') mode = mode.mode
      kit.mode = mode === 'quick' ? 'quick' : 'shell'
      document.documentElement.dataset.mode = kit.mode
      if (kit.mode === 'quick') {
        if (options.height) safely(api?.ui?.setHeight?.(options.height))
        safely(configure())
      }
      for (const cb of modeListeners) cb(kit.mode)
    }
    kit.onMode = cb => { modeListeners.add(cb); return () => modeListeners.delete(cb) }
    kit.onSettings = cb => { settingListeners.add(cb); return () => settingListeners.delete(cb) }
    kit.setQuery = value => { query = String(value ?? ''); if (kit.mode === 'quick') safely(configure()) }
    kit.toast = (message, type = 'info') => {
      let el = document.getElementById('plugin-notice')
      if (!el) { el = document.createElement('div'); el.id = 'plugin-notice'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.append(el) }
      el.textContent = String(message); el.dataset.type = type; el.hidden = false
      clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el.hidden = true }, type === 'error' ? 6500 : 2400)
    }
    kit.copy = async text => {
      if (!api?.clipboard?.writeText) throw new Error('剪贴板接口不可用')
      await api.clipboard.writeText(String(text)); kit.toast('已复制', 'success'); return true
    }
    kit.saveText = async (name, content) => {
      if (!api?.shell?.saveTextFile) throw new Error('保存接口不可用，请更新 eNest')
      const result = await api.shell.saveTextFile({ defaultName: name, content: String(content) })
      if (result?.ok) kit.toast('已保存', 'success')
      return result
    }
    kit.saveFile = async (name, dataUrl) => {
      if (!api?.shell?.saveFile) throw new Error('文件保存接口不可用，请更新 eNest')
      const result = await api.shell.saveFile({ defaultName: name, dataUrl })
      if (result?.ok) kit.toast('已保存', 'success')
      return result
    }
    kit.load = async (key, fallback) => {
      const value = await api?.storage?.get?.(key)
      return value === undefined || value === null ? structuredClone(fallback) : value
    }
    const writes = new Map()
    kit.save = (key, value) => {
      if (!api?.storage?.set) return Promise.reject(new Error('插件存储不可用'))
      const snapshot = structuredClone(value)
      const next = (writes.get(key) || Promise.resolve()).catch(() => {}).then(() => api.storage.set(key, snapshot))
      writes.set(key, next)
      return next
    }
    const focus = event => {
      const target = event.target
      const context = target?.closest?.('[data-input-context]')?.dataset.inputContext
      const overlay = target?.closest?.('dialog[open], [role="dialog"]')
      const editor = target?.closest?.('textarea,input,[contenteditable="true"]')
      safely(api?.ui?.setInputContext?.(context || (overlay ? 'overlay' : editor ? 'editor' : 'workbench')))
    }
    const keyboard = event => {
      if (event.isComposing || event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.shiftKey && !event.altKey && kit.mode === 'quick' && !document.querySelector('dialog[open], [role="dialog"]')) {
        event.preventDefault(); safely(api?.ui?.openInShell?.()); return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && kit.mode === 'quick') {
        event.preventDefault(); safely(api?.ui?.focusSearch?.()); return
      }
      if (event.key === 'Escape' && kit.mode === 'quick' && !document.querySelector('dialog[open], [role="dialog"]')) {
        event.preventDefault(); safely(api?.quickInput?.escape?.())
      }
    }
    document.addEventListener('focusin', focus)
    document.addEventListener('keydown', keyboard)
    disposers.push(() => document.removeEventListener('focusin', focus), () => document.removeEventListener('keydown', keyboard))
    if (api?.onModeChange) disposers.push(api.onModeChange(applyMode))
    if (api?.onEnter) disposers.push(api.onEnter(event => { applyMode(event.mode || kit.mode) }))
    if (api?.quickInput?.onChange) disposers.push(api.quickInput.onChange(value => { query = value; options.onQuery?.(value) }))
    if (api?.quickInput?.onAction) disposers.push(api.quickInput.onAction(action => {
      if (action === 'clear') { query = ''; options.onQuery?.('') }
      options.onAction?.(action)
    }))
    if (api?.settings?.onChange) disposers.push(api.settings.onChange(({ key, value }) => {
      kit.settings[key] = value
      for (const cb of settingListeners) cb(kit.settings, key)
    }))
    kit.ready = Promise.all(Object.keys(kit.settings).map(async key => {
      const value = await api?.settings?.get?.(key)
      if (value !== undefined && value !== null) kit.settings[key] = value
    })).then(() => { for (const cb of settingListeners) cb(kit.settings); return kit.settings }).catch(error => { kit.toast(`读取设置失败：${error.message}`, 'error'); return kit.settings })
    if (api?.onBeforeClose) disposers.push(api.onBeforeClose(() => Promise.allSettled([...writes.values()])))
    kit.destroy = () => { if (destroyed) return; destroyed = true; clearTimeout(noticeTimer); disposers.splice(0).forEach(fn => fn?.()); modeListeners.clear(); settingListeners.clear() }
    if (api?.onDestroy) disposers.push(api.onDestroy(kit.destroy))
    document.querySelectorAll('[data-open-settings]').forEach(button => button.addEventListener('click', () => safely(api?.ui?.openSettings?.())))
    if (options.title) safely(api?.ui?.setTitle?.(options.title))
    applyMode(kit.mode)
    return kit
  }

  // —— 组件工厂（波 0 增量；纯主题 token 渲染，返回 { el, update?, destroy? }）——
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }
  /** 数据表格：列头排序 / 等宽右对齐数字列 / 行 hover。columns: { key, label, num?, sortable?, width? } */
  function dataTable(options) {
    const columns = options.columns || []
    const sortState = { key: options.sortBy || null, dir: options.sortDir || 'asc' }
    const root = el('div', 'pk-table-wrap')
    const table = el('table', 'pk-table')
    const thead = el('thead'), headRow = el('tr')
    const headCells = new Map()
    const renderHead = () => {
      headRow.replaceChildren()
      headCells.clear()
      for (const col of columns) {
        const th = el('th', (col.num ? 'pk-num ' : '') + (col.sortable ? 'pk-sortable' : ''), col.label)
        if (col.width) th.style.width = col.width
        if (col.sortable) {
          th.setAttribute('role', 'columnheader')
          th.addEventListener('click', () => {
            if (sortState.key === col.key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc'
            else { sortState.key = col.key; sortState.dir = col.num ? 'desc' : 'asc' }
            update(options.rows || [], true)
          })
        }
        headCells.set(col.key, th)
        headRow.append(th)
      }
      for (const [key, th] of headCells) {
        const active = sortState.key === key
        th.classList.toggle('pk-sorted-asc', active && sortState.dir === 'asc')
        th.classList.toggle('pk-sorted-desc', active && sortState.dir === 'desc')
      }
    }
    thead.append(headRow)
    const tbody = el('tbody')
    table.append(thead, tbody)
    root.append(table)
    const renderRows = rows => {
      tbody.replaceChildren()
      for (const row of rows) {
        const tr = el('tr')
        tr.addEventListener('click', () => options.onRowClick?.(row))
        if (options.onRowContextMenu) tr.addEventListener('contextmenu', event => { event.preventDefault(); options.onRowContextMenu(event, row) })
        for (const col of columns) {
          const value = col.render ? col.render(row) : row[col.key]
          const td = el('td', col.num ? 'pk-num pk-mono' : '', value == null ? '' : String(value))
          tr.append(td)
        }
        tbody.append(tr)
      }
    }
    const applySort = rows => {
      const col = columns.find(c => c.key === sortState.key)
      if (!col) return rows
      const dir = sortState.dir === 'desc' ? -1 : 1
      return [...rows].sort((a, b) => {
        const av = a[col.key], bv = b[col.key]
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true }) * dir
      })
    }
    const update = (rows, keepSort) => {
      if (!keepSort && !sortState.key) { sortState.key = options.sortBy || null }
      renderHead()
      renderRows(applySort(rows))
      root.classList.toggle('pk-empty', !rows.length)
    }
    update(options.rows || [])
    return { el: root, update, sortBy: () => ({ ...sortState }) }
  }

  /** hex dump：偏移 + 16 字节 hex + ASCII 三列（等宽）。bytes: Uint8Array */
  function hexDump(bytes, options = {}) {
    const root = el('pre', 'pk-hexdump')
    root.setAttribute('aria-readonly', 'true')
    const perLine = options.perLine || 16
    const lines = []
    for (let offset = 0; offset < bytes.length; offset += perLine) {
      const slice = bytes.subarray(offset, Math.min(offset + perLine, bytes.length))
      const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ')
      const ascii = [...slice].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('')
      lines.push(offset.toString(16).padStart(8, '0') + '  ' + hex.padEnd(perLine * 3 - 1, ' ') + '  |' + ascii + '|')
    }
    root.textContent = lines.join('\n') || '(empty)'
    return { el: root }
  }

  /** 双栏工作台骨架：侧栏 + 内容；容器查询在窄容器折叠侧栏（见 .pk-workbench CSS） */
  function workbench(options = {}) {
    const root = el('div', 'pk-workbench')
    const side = el('aside', 'pk-workbench-side')
    const main = el('section', 'pk-workbench-main')
    root.append(side, main)
    const nav = el('nav', 'pk-workbench-nav')
    side.append(nav)
    const buttons = new Map()
    let current = options.items?.[0]?.id ?? null
    const select = id => {
      current = id
      for (const [key, btn] of buttons) btn.classList.toggle('pk-active', key === id)
      options.onSelect?.(id, main)
    }
    for (const item of options.items || []) {
      const btn = el('button', 'pk-workbench-nav-item', item.label ?? item.id)
      btn.type = 'button'
      btn.addEventListener('click', () => select(item.id))
      buttons.set(item.id, btn)
      nav.append(btn)
    }
    select(current)
    return { el: root, side, main, select, current: () => current }
  }

  /** 状态徽章：ok / warn / danger / info（主题 token 上色） */
  function badge(status, text) {
    const node = el('span', 'pk-badge pk-badge-' + (status || 'info'), text ?? status ?? '')
    return node
  }

  /** 快捷输入条适配器：quick 模式桥接 enest.quickInput；shell 模式渲染本地输入框 */
  function quickBar(kit, options = {}) {
    const root = el('div', 'pk-quickbar')
    const input = el('input', 'pk-quickbar-input')
    input.type = 'search'
    input.placeholder = options.placeholder || ''
    input.setAttribute('data-input-context', 'editor')
    root.append(input)
    let last = ''
    const commit = value => { if (value !== last) { last = value; options.onQuery?.(value) } }
    input.addEventListener('input', () => commit(input.value))
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); options.onSubmit?.(input.value) }
      if (event.key === 'ArrowDown') { event.preventDefault(); options.onNext?.() }
      if (event.key === 'ArrowUp') { event.preventDefault(); options.onPrev?.() }
      if (event.key === 'Escape') { event.preventDefault(); options.onEscape?.() }
    })
    if (kit.mode === 'quick') {
      root.classList.add('pk-quickbar-native')
      input.addEventListener('focus', () => kit.safely?.(window.enest?.ui?.setInputContext?.('editor')))
    }
    return {
      el: root, input,
      setValue: value => { input.value = value ?? ''; commit(input.value) },
      focus: () => input.focus()
    }
  }

  /** 命令面板：⌘K 浮层。items: { id, label, hint?, run }；输入即过滤（label/hint） */
  function commandPalette(options = {}) {
    const overlay = el('div', 'pk-palette-overlay')
    overlay.hidden = true
    const panel = el('div', 'pk-palette')
    const input = el('input', 'pk-palette-input')
    input.type = 'search'
    input.placeholder = options.placeholder || '输入命令…'
    input.setAttribute('data-input-context', 'overlay')
    const list = el('ul', 'pk-palette-list')
    panel.append(input, list)
    overlay.append(panel)
    let items = options.items || []
    let filtered = items
    let active = 0
    const render = () => {
      list.replaceChildren()
      filtered.forEach((item, i) => {
        const li = el('li', 'pk-palette-item' + (i === active ? ' pk-active' : ''))
        li.append(el('span', 'pk-palette-label', item.label))
        if (item.hint) li.append(el('span', 'pk-palette-hint pk-mono', item.hint))
        li.addEventListener('click', () => { hide(); item.run?.() })
        list.append(li)
      })
      list.classList.toggle('pk-empty', !filtered.length)
    }
    const filter = () => {
      const q = input.value.trim().toLowerCase()
      filtered = !q ? items : items.filter(it => (it.label + ' ' + (it.hint ?? '')).toLowerCase().includes(q))
      active = 0
      render()
    }
    const show = () => { overlay.hidden = false; input.value = ''; filter(); input.focus() }
    const hide = () => { overlay.hidden = true }
    const toggle = () => (overlay.hidden ? show() : hide())
    input.addEventListener('input', filter)
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, filtered.length - 1); render() }
      if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); render() }
      if (event.key === 'Enter') { event.preventDefault(); const item = filtered[active]; if (item) { hide(); item.run?.() } }
    })
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) hide() })
    const onKey = event => {
      if (event.isComposing || event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && (options.hotkey !== false)) {
        event.preventDefault(); toggle()
      }
      if (event.key === 'Escape' && !overlay.hidden) { event.preventDefault(); hide() }
    }
    document.addEventListener('keydown', onKey)
    render()
    return {
      el: overlay, show, hide, toggle,
      setItems: next => { items = next || []; filter() },
      destroy: () => document.removeEventListener('keydown', onKey)
    }
  }

  window.PluginKit = {
    create, escape,
    dataTable, hexDump, workbench, badge, quickBar, commandPalette
  }
})()
