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

  // —— 自定义下拉：隐藏原生 <select>，保留其 DOM/取值/change 契约，UI 由 kit 接管 —— //
  const selectInstances = new Map() // native select → instance
  function buildSelect(native) {
    const originalClass = native.className
    native.classList.add('pk-select-native')
    const wrapper = document.createElement('div')
    wrapper.className = 'pk-select' + (originalClass ? ' ' + originalClass : '')
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'pk-select-trigger'
    trigger.disabled = native.disabled
    trigger.setAttribute('role', 'combobox')
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    // 可访问名：aria-label 优先；包裹式 label 只取其直接文本节点（排除 option 文本）
    const labelEl = native.labels && native.labels[0]
    const labelText = labelEl
      ? [...labelEl.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ').trim()
      : ''
    trigger.setAttribute('aria-label', String(native.getAttribute('aria-label') || labelText || '下拉选择').trim())
    const valueEl = document.createElement('span')
    valueEl.className = 'pk-select-value'
    trigger.append(valueEl)
    const menu = document.createElement('div')
    menu.className = 'pk-select-menu'
    menu.setAttribute('role', 'listbox')
    menu.hidden = true
    wrapper.append(trigger, menu)
    native.insertAdjacentElement('afterend', wrapper)

    let open = false, activeIndex = -1
    const readOptions = () => {
      const list = []
      const walk = (parent, group) => {
        for (const node of parent.children) {
          if (node.tagName === 'OPTGROUP') walk(node, node.getAttribute('label') || '')
          else if (node.tagName === 'OPTION') list.push({ value: node.value, label: node.textContent, disabled: node.disabled, group })
        }
      }
      walk(native, '')
      return list
    }
    const optionEls = () => [...menu.querySelectorAll('.pk-select-option')]
    const sync = () => {
      valueEl.textContent = (native.selectedOptions[0] || native.options[0] || {}).textContent || ''
      for (const el of optionEls()) {
        const selected = el.dataset.value === native.value
        el.classList.toggle('selected', selected)
        el.setAttribute('aria-selected', String(selected))
      }
    }
    const rebuild = () => {
      const frag = document.createDocumentFragment()
      let lastGroup = null
      for (const opt of readOptions()) {
        if (opt.group && opt.group !== lastGroup) {
          const head = document.createElement('div')
          head.className = 'pk-select-group'
          head.textContent = opt.group
          frag.append(head)
          lastGroup = opt.group
        }
        const item = document.createElement('div')
        item.className = 'pk-select-option' + (opt.disabled ? ' disabled' : '')
        item.dataset.value = opt.value
        item.setAttribute('role', 'option')
        item.textContent = opt.label
        item.addEventListener('click', () => { if (!opt.disabled) choose(opt.value) })
        item.addEventListener('mousemove', () => setActive(optionEls().indexOf(item), false))
        frag.append(item)
      }
      menu.replaceChildren(frag)
      sync()
    }
    const choose = value => {
      close()
      if (native.value !== value) {
        native.value = value
        native.dispatchEvent(new Event('input', { bubbles: true })) // 与原生 select 行为对齐：input + change 都派发
        native.dispatchEvent(new Event('change', { bubbles: true }))
      }
      trigger.focus()
    }
    const setActive = (index, scroll = true) => {
      activeIndex = index
      const els = optionEls()
      els.forEach((el, i) => el.classList.toggle('active', i === index))
      if (scroll) els[index]?.scrollIntoView({ block: 'nearest' })
    }
    const position = () => {
      const rect = trigger.getBoundingClientRect()
      menu.style.minWidth = rect.width + 'px'
      const below = window.innerHeight - rect.bottom, above = rect.top
      menu.style.maxHeight = Math.min(280, Math.max(150, Math.max(below, above) - 20)) + 'px'
      // 与壳 Radix Select 同策略：按弹层实际内容高度判断，仅当下方真正放不下且上方更宽裕时才向上翻
      const content = Math.min(menu.scrollHeight, 280)
      menu.classList.toggle('up', below < content && above > below)
    }
    const openMenu = () => {
      if (trigger.disabled || open) return
      open = true
      rebuild()
      position()
      menu.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      const selected = optionEls().findIndex(el => el.classList.contains('selected'))
      setActive(selected >= 0 ? selected : 0)
    }
    const close = () => {
      open = false
      menu.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
    }
    trigger.addEventListener('click', () => (open ? close() : openMenu()))
    trigger.addEventListener('keydown', event => {
      if (event.isComposing) return
      const els = optionEls()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!open) return openMenu()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        let next = activeIndex + delta
        while (els[next] && els[next].classList.contains('disabled')) next += delta
        if (next >= 0 && next < els.length) setActive(next)
      } else if ((event.key === 'Enter' || event.key === ' ') && open) {
        event.preventDefault()
        els[activeIndex]?.click()
      } else if (event.key === 'Escape' && open) {
        event.preventDefault()
        close()
      } else if (event.key === 'Home' && open) {
        event.preventDefault(); setActive(0)
      } else if (event.key === 'End' && open) {
        event.preventDefault(); setActive(els.length - 1)
      } else if (open && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase()
        const hit = els.findIndex(el => !el.classList.contains('disabled') && el.textContent.trim().toLowerCase().startsWith(key))
        if (hit >= 0) setActive(hit)
      }
    })
    const onDocPointer = event => { if (open && !wrapper.contains(event.target)) close() }
    document.addEventListener('pointerdown', onDocPointer)
    const onNativeChange = () => sync()
    native.addEventListener('change', onNativeChange)
    rebuild()
    return {
      el: wrapper, trigger,
      refresh: () => { rebuild(); sync() },
      destroy: () => {
        document.removeEventListener('pointerdown', onDocPointer)
        native.removeEventListener('change', onNativeChange)
        selectInstances.delete(native)
        wrapper.remove()
        native.classList.remove('pk-select-native')
      }
    }
  }
  /** 把作用域内的原生 <select> 升级为自定义下拉（幂等；动态插入的会自动升级） */
  function upgradeSelects(scope = document) {
    const made = []
    for (const native of (scope || document).querySelectorAll('select')) {
      if (selectInstances.has(native)) continue
      if (native.closest('template')) continue
      selectInstances.set(native, buildSelect(native))
      made.push(selectInstances.get(native))
    }
    // 顺带把所有已升级实例的标签/选中态同步一次（覆盖 JS 直接改 .value 的场景）
    for (const instance of selectInstances.values()) instance.refresh()
    return made
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => upgradeSelects(), { once: true })
  else upgradeSelects()
  let selectUpgradeTimer = 0
  new MutationObserver(() => {
    clearTimeout(selectUpgradeTimer)
    selectUpgradeTimer = setTimeout(() => upgradeSelects(), 60)
  }).observe(document.documentElement, { childList: true, subtree: true })

  window.PluginKit = {
    create, escape, upgradeSelects,
    dataTable, hexDump, workbench, badge, quickBar, commandPalette
  }
})()
