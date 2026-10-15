/**
 * com.enest.ccswitch — UI 主控
 * 页面路由（供应商 / 历史切换 / MCP / 会话 / 用量 / 备份 / 项目预设 / 设置）+
 * 应用侧栏（安装探测灰显）+ 供应商卡片网格 + 右侧编辑抽屉 + 弹层 + quick provider + 热键。
 * 命名空间挂 window.CCS.ui。
 */
;(function (global) {
  const A = global.CCS.api
  const P = global.CCS.providers
  const M = global.CCS.mcp
  const S = global.CCS.sessions
  const U = global.CCS.usage
  const H = global.CCS.history
  const SNAP = global.CCS.snapshot
  const PRESETS = global.CCS.presets

  /* —— 全局状态 —— */
  const state = {
    apps: [],            // agent.apps 结果
    installed: new Set(),
    active: new Set(),
    currentApp: 'claude-code',
    page: 'providers',
    snapshots: new Map(), // app → snapshot（活跃比对）
    currentProvider: new Map(), // app → providerId（使用中）
    sessionsCache: null,
    sessionDetail: null,
    sessionListApp: null,
    usageData: null,
    diffPending: null,   // [{ app, provider, diff }]
    editProviderId: null,
    editMcpId: null,
    latencyCache: new Map(), // baseUrl → { ok, latency, status, ts }
    presetTag: ''       // 预设库标签过滤
  }

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => [...document.querySelectorAll(sel)]

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'html') el.innerHTML = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (v !== null && v !== undefined) el.setAttribute(k, String(v))
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined) continue
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return el
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function host(hostname) {
    try { return new URL(hostname).host } catch { return hostname || '—' }
  }
  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return n + ' B'
  }
  function fmtDate(ms) {
    if (!ms) return '—'
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  function fmtAgo(ms) {
    if (!ms) return '—'
    const diff = Date.now() - ms
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
    return Math.floor(diff / 86_400_000) + ' 天前'
  }

  function localToast(msg, type) {
    A.toast(msg, type)
    const box = $('#toasts')
    if (!box) return
    const t = h('div', { class: 'toast ' + (type || ''), text: msg })
    box.appendChild(t)
    setTimeout(() => t.remove(), 2600)
  }

  /** 通用确认弹层（替代 window.confirm，Promise<boolean>） */
  function confirmDialog({ title, text, hint, okText = '确认', danger = false }) {
    return new Promise((resolve) => {
      const modal = $('#modal-confirm')
      if (!modal) { resolve(global.confirm ? global.confirm(text || '') : true); return }
      $('#confirm-title').textContent = title || '确认'
      const txt = $('#confirm-text')
      txt.innerHTML = ''
      txt.appendChild(h('div', { text: text || '' }))
      $('#confirm-hint').textContent = hint || ''
      const ok = $('#btn-confirm-ok')
      ok.textContent = okText
      ok.className = 'btn ' + (danger ? 'danger' : 'primary')
      modal.hidden = false
      const done = (val) => { modal.hidden = true; ok.removeEventListener('click', onOk); resolve(val) }
      const onOk = () => done(true)
      ok.addEventListener('click', onOk)
      modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => done(false), { once: true }))
      modal.addEventListener('click', (e) => { if (e.target === modal) done(false) }, { once: true })
      ok.focus()
    })
  }

  /* ================ 应用侧栏 ================ */
  async function loadApps() {
    try {
      const apps = await A.agentApps()
      // 归一：以本地 APPS 元数据为底，合并宿主探测结果（宿主未列出的应用视为未安装）
      const byId = new Map((apps || []).map(a => [a.app, a]))
      state.apps = P.APPS.map(meta => {
        const hit = byId.get(meta.id)
        return { app: meta.id, id: meta.id, name: meta.name, mode: meta.mode, color: meta.color, configPaths: hit?.configPaths || [], installed: Boolean(hit?.installed), active: Boolean(hit?.active) }
      })
    } catch (e) {
      state.apps = P.APPS.map(a => ({ app: a.id, id: a.id, name: a.name, mode: a.mode, color: a.color, installed: false, active: false, configPaths: [] }))
      console.warn('[ccswitch] agentApps failed:', e)
    }
    state.installed = new Set(state.apps.filter(a => a.installed).map(a => a.app))
    state.active = new Set(state.apps.filter(a => a.active).map(a => a.app))
    renderNavApps()
  }

  function renderNavApps() {
    const box = $('#nav-apps')
    if (!box) return
    box.innerHTML = ''
    for (const meta of P.APPS) {
      const installed = state.installed.has(meta.id)
      const active = state.active.has(meta.id)
      const btn = h('button', {
        class: 'nav-item app-item' + (state.currentApp === meta.id ? ' active' : '') + (installed ? '' : ' disabled'),
        'data-app': meta.id,
        title: meta.name + (installed ? '' : '（未安装/未初始化）'),
        onclick: () => {
          if (!installed) {
            localToast(meta.name + ' 未安装或未初始化，灰显不可操作', 'info')
            return
          }
          state.currentApp = meta.id
          if (['providers', 'backups'].includes(state.page)) {
            refreshCurrentApp()
          } else {
            // 功能页也切换应用上下文
            renderNavApps()
            if (state.page === 'sessions') { state.sessionsCache = null; state.sessionDetail = null; loadSessionsPage() }
            if (state.page === 'usage') { state.usageData = null; loadUsagePage() }
          }
          renderNavApps()
        }
      },
        h('span', { class: 'dot' + (active ? '' : ' off') }),
        h('span', { class: 't', text: meta.name })
      )
      box.appendChild(btn)
    }
  }

  async function refreshCurrentApp() {
    renderNavApps()
    const appName = P.APP_MAP[state.currentApp]?.name || state.currentApp
    const titleEl = $('#providers-title')
    const subEl = $('#providers-sub')
    if (titleEl) titleEl.textContent = appName + ' · 供应商'
    const mode = P.APP_MAP[state.currentApp]?.mode
    if (subEl) subEl.textContent = mode === 'additive' ? '共存式：多选添加 / 移除' : '切换式：单选启用'
    await Promise.all([renderProviders(), loadBackups()])
  }

  /* ================ 供应商页 ================ */
  async function ensureSnapshot(app) {
    if (!state.snapshots.has(app)) {
      try {
        state.snapshots.set(app, await A.agentRead(app))
      } catch (e) {
        state.snapshots.set(app, { files: [], active: false, error: A.errMsg(e) })
      }
    }
    return state.snapshots.get(app)
  }

  function detectCurrentProvider(app, providers) {
    const snap = state.snapshots.get(app)
    if (!snap) return null
    const cur = P.extractCurrent(app, snap) || P.extractCurrentFromText(app, snap.files?.[0]?.content)
    if (!cur) return null
    // 比对 baseUrl（host 级）+ model
    return providers.find(p =>
      p.baseUrl && cur.baseUrl && (
        host(p.baseUrl) === host(cur.baseUrl) ||
        String(p.baseUrl).replace(/\/+$/, '') === String(cur.baseUrl).replace(/\/+$/, '')
      )
    ) || null
  }

  async function renderProviders() {
    const body = $('#providers-body')
    if (!body) return
    const app = state.currentApp

    if (!state.installed.has(app)) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'guide' },
        h('div', { class: 'big', text: '⌾' }),
        h('div', { text: P.APP_MAP[app]?.name + ' 尚未安装或未初始化' }),
        h('div', { class: 'field-hint', text: '安装并首次运行该 CLI 后，此处可管理其供应商配置' })
      ))
      renderSummary()
      return
    }

    const [providers] = await Promise.all([P.loadProviders(), ensureSnapshot(app)])
    const all = P.sorted().filter(p => !p.apps || p.apps.length === 0 || p.apps.includes(app))
    const current = detectCurrentProvider(app, all)
    state.currentProvider.set(app, current?.id || null)

    if (all.length === 0) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'guide' },
        h('div', { class: 'big', text: '⇄' }),
        h('div', { text: '还没有供应商' }),
        h('div', { class: 'field-hint', text: '从「预设库」一键实例化，或「新建」自定义' }),
        h('div', { style: 'margin-top:12px;display:flex;gap:8px;justify-content:center' },
          h('button', { class: 'btn primary', onclick: openPresetLib, text: '打开预设库' }),
          h('button', { class: 'btn ghost', onclick: () => openProviderModal(null), text: '新建供应商' })
        )
      ))
      renderSummary()
      return
    }

    // 标签过滤 chips（含「全部」）
    renderTagChips(all)
    const kw = ($('#provider-search')?.value || '').trim().toLowerCase()
    let filtered = all
    if (kw) filtered = filtered.filter(p => (p.name + ' ' + p.baseUrl + ' ' + p.model + ' ' + P.tagsOf(p).join(' ')).toLowerCase().includes(kw))

    if (filtered.length === 0) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'empty', text: '没有匹配的供应商' }))
      renderSummary(all, current)
      return
    }

    body.innerHTML = ''
    const mode = P.APP_MAP[app]?.mode
    // 当前生效项置顶，其余保持排序
    const ordered = [...filtered].sort((a, b) => (current && current.id === b.id ? 1 : 0) - (current && current.id === a.id ? 1 : 0))
    const grid = h('div', { class: 'grid' })
    ordered.forEach(p => {
      grid.appendChild(renderProviderCard(p, { isCurrent: current && current.id === p.id, mode }))
    })
    body.appendChild(grid)
    renderSummary(all, current)
  }

  /** 顶部状态摘要：当前供应商 + 已配置总数 + 多应用共用同一供应商 */
  function renderSummary(all, current) {
    const strip = $('#summary-strip')
    if (!strip) return
    const list = all || P.sorted().filter(p => !p.apps || p.apps.length === 0 || p.apps.includes(state.currentApp))
    const cur = current !== undefined ? current : detectCurrentProvider(state.currentApp, list)
    strip.hidden = false
    strip.innerHTML = ''
    const items = []
    items.push({ label: '当前生效', value: cur ? cur.name : '官方默认', accent: true })
    items.push({ label: '已配置', value: String(list.length) + ' 个供应商' })
    // 跨应用共用统计：同一 provider 出现在多少个已安装应用
    let shared = 0
    for (const p of list) {
      const n = (p.apps || []).filter(a => state.installed.has(a)).length
      if (n > 1) shared++
    }
    items.push({ label: '多应用共用', value: shared ? String(shared) + ' 个供应商' : '无' })
    const lat = cur?.baseUrl ? state.latencyCache.get(cur.baseUrl) : null
    items.push({
      label: '连通性',
      value: lat ? (lat.ok ? lat.latency + ' ms' : '不可达') : '未测',
      tone: lat ? (lat.ok ? 'ok' : 'danger') : ''
    })
    for (const it of items) {
      strip.appendChild(h('div', { class: 'summary-item' + (it.accent ? ' accent' : '') + (it.tone ? ' tone-' + it.tone : '') },
        h('div', { class: 'summary-value mono', text: it.value }),
        h('div', { class: 'summary-label', text: it.label })
      ))
    }
  }

  function renderTagChips(all) {
    const box = $('#provider-tags')
    if (!box) return
    const counts = new Map()
    for (const p of all) {
      const tags = P.tagsOf(p)
      if (!tags.length) counts.set('未分组', (counts.get('未分组') || 0) + 1)
      for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1)
    }
    box.innerHTML = ''
    const kw = ($('#provider-search')?.value || '').trim().toLowerCase()
    const activeTag = state['_tagFilter:' + state.currentApp] || ''
    const chip = (label, on, onclick) => h('button', {
      class: 'chip' + (on ? ' active' : ''), type: 'button', onclick
    }, label)
    box.appendChild(chip('全部', !activeTag && !kw, () => { state['_tagFilter:' + state.currentApp] = ''; renderProviders() }))
    for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      box.appendChild(chip(tag + ' ' + n, activeTag === tag, () => {
        state['_tagFilter:' + state.currentApp] = activeTag === tag ? '' : tag
        renderProviders()
      }))
    }
  }

  function renderProviderCard(p, { isCurrent, mode }) {
    const app = state.currentApp
    const card = h('div', {
      class: 'card provider-card' + (isCurrent ? ' current' : ''),
      draggable: 'true',
      'data-id': p.id,
      tabindex: '0',
      role: 'button',
      'aria-label': p.name + (isCurrent ? '（当前使用）' : '')
    })

    // 行 1：名称 + 徽章 + 标签 + 拖拽柄
    const row1 = h('div', { class: 'card-row' },
      h('span', { class: 'drag-handle', title: '拖拽排序', text: '⠿' }),
      h('span', { class: 'name', text: p.name }),
      p.isDefault ? h('span', { class: 'tag', text: '默认' }) : null,
      p.universal ? h('span', { class: 'tag', text: '通用' }) : null,
      isCurrent ? h('span', { class: 'badge', text: '当前使用' }) : null
    )
    // 行 2/3：端点 + 模型（mono 右对齐等高对齐）
    const row2 = h('div', { class: 'card-row' },
      h('span', { class: 'k', text: '端点' }),
      h('span', { class: 'v', title: p.baseUrl || '官方默认', text: p.baseUrl ? host(p.baseUrl) : '官方默认' })
    )
    const row3 = h('div', { class: 'card-row' },
      h('span', { class: 'k', text: '模型' }),
      h('span', { class: 'v', title: p.model || '默认', text: p.model || '默认' })
    )
    // 标签行（新 tags 数组）
    const tags = P.tagsOf(p)
    const actions = h('div', { class: 'card-actions' },
      h('button', {
        class: 'btn sm ' + (isCurrent ? '' : 'primary'),
        disabled: isCurrent ? '' : null,
        onclick: () => switchProvider(p)
      }, isCurrent ? '使用中' : mode === 'additive' ? '添加' : '启用'),
      h('button', { class: 'btn sm ghost', onclick: () => openProviderModal(p), text: '编辑' }),
      h('button', {
        class: 'btn sm ghost',
        onclick: async () => {
          const copy = { ...p, id: '', name: p.name + ' 副本', isDefault: false }
          await P.upsertProvider(copy)
          localToast('已复制 ' + p.name, 'success')
          renderProviders()
        },
        text: '复制'
      }),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn sm ghost danger',
        onclick: () => confirmDeleteProvider(p)
      }, '删除')
    )
    card.append(row1, row2, row3)
    if (tags.length) {
      const tagRow = h('div', { class: 'card-row tag-row' })
      for (const t of tags) tagRow.appendChild(h('span', { class: 'tag', text: t }))
      card.appendChild(tagRow)
    }
    card.appendChild(actions)
    // 拖拽排序
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging')
      e.dataTransfer.setData('text/plain', 'reorder:' + p.id)
    })
    card.addEventListener('dragend', () => card.classList.remove('dragging'))
    card.addEventListener('dragover', (e) => {
      e.preventDefault()
      card.classList.add('drop-before')
    })
    card.addEventListener('dragleave', () => card.classList.remove('drop-before'))
    card.addEventListener('drop', async (e) => {
      e.preventDefault()
      card.classList.remove('drop-before')
      const data = e.dataTransfer.getData('text/plain')
      if (data.startsWith('reorder:')) {
        await P.reorder(data.slice(8), p.id)
        renderProviders()
      }
    })
    // 键盘可达：Enter 打开编辑
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); openProviderModal(p) }
    })
    return card
  }

  async function confirmDeleteProvider(p) {
    const app = state.currentApp
    const isCurrent = state.currentProvider.get(app) === p.id
    if (p.isDefault) {
      localToast('默认供应商不可删除', 'error')
      return
    }
    if (isCurrent) {
      localToast('该供应商正在使用中，先切换到其它供应商再删除', 'error')
      return
    }
    // 撤销路径：删除前保留完整对象，确认弹层里给「撤销」toast 入口
    const snapshotItem = JSON.parse(JSON.stringify(p))
    const ok = await confirmDialog({
      title: '删除供应商',
      text: `确定删除「${p.name}」？此操作只移除插件内配置，不改动已写入的应用配置文件。`,
      hint: '删除后可通过提示条内的「撤销」一键恢复。',
      okText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await P.removeProvider(p.id)
      if (p.secretRef) await A.vaultRemove(p.secretRef)
      localToast('已删除 ' + p.name, 'success')
      renderProviders()
      // 可撤销 toast
      const box = $('#toasts')
      if (box) {
        const t = h('div', { class: 'toast undoable' },
          h('span', { text: '已删除「' + p.name + '」' }),
          h('button', {
            class: 'btn sm primary undo-btn', text: '撤销', onclick: async () => {
              try {
                await P.upsertProvider(snapshotItem)
                t.remove()
                localToast('已恢复「' + snapshotItem.name + '」', 'success')
                renderProviders()
              } catch (e) { localToast('恢复失败：' + A.errMsg(e), 'error') }
            }
          })
        )
        box.appendChild(t)
        setTimeout(() => t.remove(), 8000)
      }
    } catch (e) { localToast(A.errMsg(e), 'error') }
  }

  /* —— 切换流程：diff 预览 → 确认 → write → 历史记录 —— */
  async function switchProvider(p, { skipConfirm } = {}) {
    const app = state.currentApp
    try {
      // 通用供应商：多应用同步切换
      const targetApps = p.universal && Array.isArray(p.apps) && p.apps.length > 1 ? p.apps.filter(a => state.installed.has(a)) : [app]
      // 切换前状态（供历史记录与回退）
      const beforeStates = new Map()
      for (const target of targetApps) {
        beforeStates.set(target, await H.readCurrentState(target))
      }
      const diffs = []
      for (const target of targetApps) {
        const snap = await ensureSnapshot(target)
        const diff = P.buildDiff(target, p, snap)
        if (!diff) { localToast(P.APP_MAP[target]?.name + ' 不支持供应商切换，已跳过', 'info'); continue }
        diffs.push({ app: target, provider: p, diff })
      }
      if (diffs.length === 0) return

      const diffConfirmOn = await A.settingsGet('diffConfirm', true)
      if (!skipConfirm && diffConfirmOn !== false) {
        showDiffModal(diffs, beforeStates)
        return
      }
      await applyDiffs(diffs, beforeStates)
    } catch (e) {
      localToast('切换失败：' + A.errMsg(e), 'error')
    }
  }

  function showDiffModal(diffs, beforeStates) {
    state.diffPending = diffs
    state._diffBefore = beforeStates || new Map()
    const first = diffs[0]
    $('#diff-app').textContent = diffs
      .map(d => `${P.APP_MAP[d.app]?.name || d.app} → ${d.provider.name}`)
      .join('；')
    const table = $('#diff-table')
    table.innerHTML = ''
    table.appendChild(h('div', { class: 'diff-head' }, h('span', { text: '字段' }), h('span', { text: '当前' }), h('span', { text: '切换后' })))
    for (const row of first.diff.rows) {
      table.appendChild(h('div', { class: 'diff-row' + (row.changed ? ' changed' : '') },
        h('span', { class: 'k', text: row.k }),
        h('span', { class: 'before', title: row.before, text: row.before }),
        h('span', { class: 'after', title: row.after, text: row.after })
      ))
    }
    if (diffs.length > 1) {
      table.appendChild(h('div', { class: 'field-hint', text: `通用供应商：将同步写入 ${diffs.length} 个应用` }))
    }
    $('#modal-diff').hidden = false
  }

  async function applyDiffs(diffs, beforeStates) {
    const before = beforeStates || state._diffBefore || new Map()
    let lastErr = null
    const written = []
    for (const d of diffs) {
      try {
        await P.applyProvider(d.app, d.provider)
        state.snapshots.delete(d.app)
        written.push(d.app)
      } catch (e) {
        lastErr = e
      }
    }
    if (lastErr) {
      localToast('部分应用切换失败：' + A.errMsg(lastErr), 'error')
    } else {
      localToast(`已切换到 ${diffs[0].provider.name}（已自动备份）`, 'success')
      A.notify('供应商切换', `已切换到 ${diffs[0].provider.name}`)
      // 记入切换历史（环形 50 条），失败不阻塞主流程
      try {
        await H.record(diffs[0].provider, {
          ...(before.get(written[0]) || {}),
          providerId: null,
          name: null
        }, written)
      } catch { /* 历史失败不影响切换 */ }
    }
    $('#modal-diff').hidden = true
    await renderProviders()
  }

  /* ================ 编辑抽屉 ================ */
  function openDrawer() {
    const d = $('#drawer-provider')
    if (!d) return
    d.hidden = false
    d.setAttribute('aria-hidden', 'false')
    // 同帧切换再触发过渡（transform 过渡从 right 滑入）
    requestAnimationFrame(() => d.classList.add('open'))
    const first = $('#pf-name')
    if (first) setTimeout(() => first.focus(), 120)
  }
  function closeDrawer() {
    const d = $('#drawer-provider')
    if (!d || d.hidden) return
    d.classList.remove('open')
    d.setAttribute('aria-hidden', 'true')
    const done = () => { d.hidden = true }
    if (global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) done()
    else setTimeout(done, 200)
  }

  /** 抽屉顶部「从模板开始」：常用预设快捷 chips（前 8 个 + 当前应用相关） */
  function renderDrawerPresetChips(presetInit) {
    const box = $('#pf-preset-chips')
    if (!box) return
    box.innerHTML = ''
    const app = state.currentApp
    const relevant = PRESETS.PRESETS.filter(p => p.apps.includes(app))
    const list = (relevant.length >= 4 ? relevant : PRESETS.PRESETS).slice(0, 8)
    for (const preset of list) {
      box.appendChild(h('button', {
        class: 'chip', type: 'button', title: preset.baseUrl || '官方默认端点',
        onclick: () => {
          const inst = PRESETS.instantiate(preset, { apps: [state.currentApp] })
          fillProviderForm(inst)
          $('#pf-form-hint').textContent = '已套用模板「' + preset.name + '」，补入 API Key 即可保存'
        }
      }, preset.name))
    }
    if (presetInit) $('#pf-form-hint').textContent = '已从预设库带入「' + presetInit.name + '」'
  }

  function fillProviderForm(p) {
    $('#pf-name').value = p.name || ''
    $('#pf-tags').value = P.tagsOf(p).join(', ')
    $('#pf-baseurl').value = p.baseUrl || ''
    $('#pf-apikey').value = ''
    $('#pf-apikey').type = 'password'
    $('#pf-model').value = p.model || ''
    $('#pf-key-hint').textContent = p.secretRef ? '已存密钥（保险库引用），留空则保持不变' : '密钥将存入保险库（vault），配置导出默认脱敏'
    // 目标应用 chips
    const appsBox = $('#pf-apps')
    appsBox.innerHTML = ''
    const selected = new Set(p.apps && p.apps.length ? p.apps : [state.currentApp])
    for (const meta of P.APPS) {
      const chipEl = h('button', {
        class: 'chip' + (selected.has(meta.id) ? ' on' : ''),
        type: 'button',
        'data-app': meta.id,
        onclick: () => chipEl.classList.toggle('on')
      }, meta.name)
      appsBox.appendChild(chipEl)
    }
    // 高级
    const adv = $('#pf-advanced')
    adv.innerHTML = ''
    const envArea = h('textarea', { class: 'mono', placeholder: '额外 env（JSON 对象，如 {"API_TIMEOUT_MS":"30000"}）' })
    envArea.value = p.extraEnv ? JSON.stringify(p.extraEnv, null, 2) : ''
    const tomlArea = h('textarea', { class: 'mono', placeholder: 'TOML 顶层键片段（JSON 表示，仅 toml 应用，如 {"model_reasoning_effort":"high"}）' })
    tomlArea.value = p.tomlExtra ? JSON.stringify(p.tomlExtra, null, 2) : ''
    const uniCheck = h('input', { type: 'checkbox' })
    uniCheck.checked = Boolean(p.universal)
    adv.append(
      h('div', { class: 'field' }, h('span', { text: '额外 env（JSON）' }), envArea),
      h('div', { class: 'field' }, h('span', { text: 'TOML 顶层键片段（JSON 表示）' }), tomlArea),
      h('label', { class: 'field-row', style: 'display:flex;gap:8px;align-items:center' }, uniCheck, h('span', { text: '通用供应商：保存后绑定所选应用，切换时同步写入' }))
    )
    // JSON 源码视图
    $('#pf-json').value = JSON.stringify({
      name: p.name || '', tag: P.tagsOf(p)[0] || '', tags: P.tagsOf(p), baseUrl: p.baseUrl || '',
      model: p.model || '', apps: [...selected], universal: Boolean(p.universal)
    }, null, 2)
    $('#pf-test-result').textContent = ''
    $('#pf-form-hint').textContent = ''
  }

  function openProviderModal(existing, presetInit) {
    state.editProviderId = existing?.id || null
    const p = existing || presetInit || {}
    $('#provider-modal-title').textContent = existing ? '编辑供应商' : '新建供应商'
    fillProviderForm(p)
    renderDrawerPresetChips(presetInit && !existing ? presetInit : null)
    activateFormTab('#provider-form-tabs', 'form')
    openDrawer()
  }

  function activateFormTab(tabsSel, tab) {
    $$(tabsSel + ' button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
    const isForm = tab === 'form'
    const panes = $(tabsSel).parentElement.querySelectorAll('.form-pane')
    if (panes.length >= 2) {
      panes[0].hidden = !isForm
      panes[1].hidden = isForm
    }
  }

  async function saveProviderModal() {
    const isJsonTab = $('#provider-form-tabs button.active')?.dataset.tab === 'json'
    let base
    if (isJsonTab) {
      try {
        base = JSON.parse($('#pf-json').value)
      } catch (e) {
        localToast('JSON 源码解析失败：' + A.errMsg(e), 'error')
        return
      }
    } else {
      base = {
        name: $('#pf-name').value.trim(),
        tags: $('#pf-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
        tag: $('#pf-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean)[0] || '',
        baseUrl: $('#pf-baseurl').value.trim(),
        model: $('#pf-model').value.trim()
      }
      if (!base.name) { localToast('名称必填', 'error'); return }
    }
    const apps = isJsonTab
      ? (Array.isArray(base.apps) ? base.apps : [state.currentApp])
      : $$('#pf-apps .chip.on').map(c => c.dataset.app)
    const tags = Array.isArray(base.tags) && base.tags.length
      ? base.tags.map(s => String(s).trim()).filter(Boolean)
      : (base.tag ? [String(base.tag)] : [])
    const item = {
      id: state.editProviderId || '',
      name: String(base.name || '').trim(),
      tag: tags[0] || '',
      tags,
      baseUrl: String(base.baseUrl || '').trim(),
      model: String(base.model || '').trim(),
      apps,
      universal: isJsonTab ? Boolean(base.universal) : $('#pf-advanced input[type="checkbox"]')?.checked === true
    }
    // 高级片段
    if (!isJsonTab) {
      const areas = $$('#pf-advanced textarea')
      try {
        if (areas[0]?.value.trim()) item.extraEnv = JSON.parse(areas[0].value)
        if (areas[1]?.value.trim()) item.tomlExtra = JSON.parse(areas[1].value)
      } catch (e) {
        localToast('高级片段 JSON 解析失败：' + A.errMsg(e), 'error')
        return
      }
    }
    // 密钥：vault.set → secretRef
    const keyInput = $('#pf-apikey').value.trim()
    if (keyInput) {
      try {
        const res = await A.vaultSet('ccswitch.' + (item.name || Date.now()), keyInput)
        item.secretRef = res?.secretRef || ''
        item.plainSecret = keyInput // 切换瞬间使用；storage 持久化前删除
      } catch (e) {
        localToast('密钥保存失败：' + A.errMsg(e), 'error')
      }
    }
    // 保留原有 secretRef / isDefault
    if (state.editProviderId) {
      const [providers] = await Promise.all([P.loadProviders()])
      const old = providers.find(x => x.id === state.editProviderId)
      if (old) {
        if (!item.secretRef) item.secretRef = old.secretRef
        item.isDefault = old.isDefault
        item.plainSecret = item.plainSecret || old.plainSecret
      }
    }
    const plain = item.plainSecret
    delete item.plainSecret
    await P.upsertProvider(item)
    item.plainSecret = plain
    closeDrawer()
    localToast('已保存 ' + item.name, 'success')
    renderProviders()
  }

  /* ================ 测速 ================ */
  async function testFromDrawer() {
    const url = $('#pf-baseurl')?.value.trim()
    const out = $('#pf-test-result')
    if (!url) { localToast('先填写 Base URL', 'info'); return }
    if (out) out.textContent = '测速中…'
    const r = await U.testEndpoint(url)
    if (r.ok) {
      if (out) out.textContent = `可达 · ${r.latency}ms · HTTP ${r.status}`
      state.latencyCache.set(url, { ok: true, latency: r.latency, status: r.status, ts: Date.now() })
      localToast(`可达 · ${r.latency}ms · HTTP ${r.status}`, 'success')
    } else {
      if (out) out.textContent = '不可达：' + r.error
      localToast('不可达：' + r.error, 'error')
    }
    if (state.page === 'providers') renderSummary()
  }

  /** 卡片测速：对单供应商 baseUrl 发轻量请求并缓存展示 */
  async function testProviderCard(p, btn) {
    if (!p.baseUrl) { localToast('官方默认端点无需测速', 'info'); return }
    const cached = state.latencyCache.get(p.baseUrl)
    const fresh = cached && Date.now() - cached.ts < 60_000
    if (fresh) { renderProviders(); return }
    btn.disabled = true
    btn.textContent = '…'
    const r = await U.testEndpoint(p.baseUrl)
    state.latencyCache.set(p.baseUrl, { ok: r.ok, latency: r.latency, status: r.status, ts: Date.now() })
    btn.disabled = false
    renderProviders()
    if (r.ok) localToast(p.name + ' 可达 · ' + r.latency + 'ms', 'success')
    else localToast(p.name + ' 不可达：' + r.error, 'error')
  }

  /* ================ 预设库 ================ */
  function openPresetLib() {
    state.presetTag = ''
    renderPresetTagFilter()
    renderPresetGrid($('#preset-search')?.value || '')
    $('#modal-presets').hidden = false
  }

  function renderPresetTagFilter() {
    const box = $('#preset-tag-filter')
    if (!box) return
    box.innerHTML = ''
    for (const t of PRESETS.tags()) {
      box.appendChild(h('button', {
        class: 'chip' + (state.presetTag === t ? ' active' : ''),
        onclick: () => {
          state.presetTag = state.presetTag === t ? '' : t
          renderPresetTagFilter()
          renderPresetGrid($('#preset-search')?.value || '')
        }
      }, t))
    }
  }

  function renderPresetGrid(q) {
    const grid = $('#preset-grid')
    let list = PRESETS.search(q)
    if (state.presetTag) list = list.filter(p => p.tag === state.presetTag)
    grid.innerHTML = ''
    if (list.length === 0) {
      grid.appendChild(h('div', { class: 'empty', text: '没有匹配的预设' }))
      return
    }
    for (const preset of list) {
      grid.appendChild(h('div', { class: 'preset-card' },
        h('div', { class: 'card-row' },
          h('span', { class: 'name', text: preset.name }),
          h('span', { class: 'tag', text: preset.tag })
        ),
        h('div', { class: 'url mono', text: preset.baseUrl ? host(preset.baseUrl) : '官方默认端点' }),
        h('div', { class: 'url mono', text: preset.model || '' }),
        h('div', { class: 'card-actions' },
          h('button', {
            class: 'btn sm primary', text: '实例化', onclick: async () => {
              const installedApps = preset.apps.filter(a => state.installed.has(a))
              const inst = PRESETS.instantiate(preset, {
                apps: installedApps.length ? installedApps : preset.apps
              })
              await P.upsertProvider(inst)
              localToast(`已从预设创建「${preset.name}」，可点击编辑补入密钥`, 'success')
              $('#modal-presets').hidden = true
              if (state.page === 'providers') renderProviders()
            }
          }),
          h('button', {
            class: 'btn sm ghost', text: '编辑后添加', onclick: () => {
              $('#modal-presets').hidden = true
              openProviderModal(null, PRESETS.instantiate(preset))
            }
          })
        )
      ))
    }
    $('#preset-source').textContent =
      `共 ${PRESETS.PRESETS.length} 个预设 · ${PRESETS.META.source} · v${PRESETS.META.version}`
  }

  /* ================ 导入导出 ================ */
  async function exportProviders() {
    const payload = P.exportPayload(false)
    try {
      const r = await A.saveTextFile({
        defaultName: 'ccswitch-providers.json',
        filename: 'ccswitch-providers.json',
        content: JSON.stringify(payload, null, 2)
      })
      if (r) localToast('已导出（密钥已脱敏）', 'success')
    } catch (e) { localToast('导出失败：' + A.errMsg(e), 'error') }
  }

  function importProvidersModal() {
    const ta = h('textarea', { class: 'mono', rows: '12', placeholder: '粘贴导出的 JSON（或 cc-switch 兼容格式）' })
    const modal = h('div', { class: 'modal' },
      h('div', { class: 'modal-card' },
        h('div', { class: 'modal-head' }, h('div', { class: 'modal-title', text: '导入供应商' })),
        h('div', { class: 'modal-body' }, ta),
        h('div', { class: 'modal-foot' },
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn ghost', onclick: () => modal.remove(), text: '取消' }),
          h('button', {
            class: 'btn primary', text: '导入', onclick: async () => {
              try {
                const data = JSON.parse(ta.value)
                const res = await P.importPayload(data)
                modal.remove()
                localToast(`导入完成：新增 ${res.added}，跳过 ${res.skipped}`, 'success')
                renderProviders()
              } catch (e) { localToast('导入失败：' + A.errMsg(e), 'error') }
            }
          })
        )
      )
    )
    document.body.appendChild(modal)
  }

  /* ================ 全量快照（备份页） ================ */
  async function exportSnapshot() {
    try {
      const payload = await SNAP.exportAll()
      const r = await A.saveTextFile({
        defaultName: 'ccswitch-full-backup.json',
        filename: 'ccswitch-full-backup.json',
        content: JSON.stringify(payload, null, 2)
      })
      if (r) localToast('全量导出成功（不含密钥明文）', 'success')
    } catch (e) { localToast('导出失败：' + A.errMsg(e), 'error') }
  }

  function importSnapshotModal() {
    const ta = h('textarea', { class: 'mono', rows: '12', placeholder: '粘贴「导出全量 JSON」的内容（也兼容旧的供应商导出格式）' })
    const mergeCheck = h('input', { type: 'checkbox' })
    const modal = h('div', { class: 'modal' },
      h('div', { class: 'modal-card' },
        h('div', { class: 'modal-head' }, h('div', { class: 'modal-title', text: '从 JSON 恢复' })),
        h('div', { class: 'modal-body' },
          ta,
          h('label', { class: 'field-row', style: 'display:flex;gap:8px;align-items:center;margin-top:10px' },
            mergeCheck, h('span', { text: '合并导入（保留现有数据，按名称/ID 去重）；不勾选则覆盖' })),
          h('div', { class: 'field-hint', text: '快照不含密钥明文；secretRef 引用原样保留，跨环境使用需重新录入密钥' })
        ),
        h('div', { class: 'modal-foot' },
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn ghost', onclick: () => modal.remove(), text: '取消' }),
          h('button', {
            class: 'btn primary', text: '恢复', onclick: async () => {
              try {
                const data = JSON.parse(ta.value)
                if (!mergeCheck.checked) {
                  const ok = await confirmDialog({
                    title: '覆盖恢复',
                    text: '覆盖模式将清空当前的供应商 / MCP / 项目预设再写入快照内容。',
                    hint: '建议先「导出全量 JSON」留一份当前状态。',
                    okText: '覆盖恢复',
                    danger: true
                  })
                  if (!ok) return
                }
                const res = await SNAP.importAll(data, { merge: mergeCheck.checked })
                M.resetCache?.()
                P.resetCache?.()
                modal.remove()
                localToast(`恢复完成（${res.mode}）：供应商 +${res.providers.added ?? 0}，MCP ${res.mcp}，项目 ${res.projects}`, 'success')
                renderProviders()
              } catch (e) { localToast('恢复失败：' + A.errMsg(e), 'error') }
            }
          })
        )
      )
    )
    document.body.appendChild(modal)
  }

  /* ================ 切换历史页 ================ */
  async function loadHistoryPage() {
    const body = $('#history-body')
    const list = await H.load()
    $('#history-sub').textContent = `最近 ${H.LIMIT} 次切换记录，可一键回退 · 当前共 ${list.length} 条`
    body.innerHTML = ''
    if (list.length === 0) {
      body.appendChild(h('div', { class: 'guide' },
        h('div', { class: 'big', text: '◷' }),
        h('div', { text: '还没有切换记录' }),
        h('div', { class: 'field-hint', text: '每次确认切换后自动记录（保留最近 50 条），可随时回退' })
      ))
      return
    }
    const wrap = h('div', { class: 'history-list' })
    for (const entry of list) {
      const appNames = (entry.apps || (entry.app ? [entry.app] : []))
        .map(a => P.APP_MAP[a]?.name || a).join('、')
      wrap.appendChild(h('div', { class: 'history-item' },
        h('div', { class: 'history-main' },
          h('div', { class: 'row1' },
            h('span', { class: 'name', text: entry.providerName }),
            h('span', { class: 'tag', text: appNames || '—' }),
            entry.rolledBackFrom ? h('span', { class: 'tag', text: '回退产生' }) : null,
            entry.changed === false ? h('span', { class: 'tag', text: '端点未变' }) : null
          ),
          h('div', { class: 'meta mono' },
            h('span', { text: (entry.baseUrl ? host(entry.baseUrl) : '官方默认') + ' · ' + (entry.model || '默认模型') }),
            entry.prevName ? h('span', { text: ' ← 原为 ' + entry.prevName }) : null
          )
        ),
        h('div', { class: 'history-side' },
          h('span', { class: 'when', title: new Date(entry.at).toLocaleString('zh-CN'), text: fmtAgo(entry.at) }),
          h('button', {
            class: 'btn sm ghost', text: '回退', onclick: async () => {
              const ok = await confirmDialog({
                title: '回退切换',
                text: `将「${P.APP_MAP[entry.app]?.name || entry.app}」恢复到「${entry.prevName || '切换前状态'}」（${entry.prevBaseUrl ? host(entry.prevBaseUrl) : '官方默认'}）。`,
                hint: '回退前宿主自动快照当前状态，可在「备份」页再恢复。',
                okText: '回退'
              })
              if (!ok) return
              try {
                await H.rollback(entry)
                state.snapshots.delete(entry.app)
                localToast('已回退到 ' + (entry.prevName || '切换前状态'), 'success')
                await Promise.all([loadHistoryPage(), renderProviders()])
              } catch (e) { localToast('回退失败：' + A.errMsg(e), 'error') }
            }
          })
        )
      ))
    }
    body.appendChild(wrap)
  }

  /* ================ MCP 页 ================ */
  async function renderMcp() {
    const body = $('#mcp-body')
    const entries = await M.load()
    if (entries.length === 0) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'guide' },
        h('div', { class: 'big', text: '⌗' }),
        h('div', { text: '还没有 MCP 服务器' }),
        h('div', { class: 'field-hint', text: '从模板添加、导入现有配置，或自定义 JSON' })
      ))
      return
    }
    body.innerHTML = ''
    for (const entry of entries) {
      const appsRow = h('div', { class: 'chips' })
      for (const meta of P.APPS) {
        const on = Boolean(entry.apps?.[meta.id])
        appsRow.appendChild(h('button', {
          class: 'chip' + (on ? ' on' : '') + (state.installed.has(meta.id) ? '' : ' off'),
          title: meta.name,
          onclick: async (e) => {
            e.preventDefault()
            if (!state.installed.has(meta.id)) { localToast(meta.name + ' 未安装', 'info'); return }
            const next = !entry.apps?.[meta.id]
            await M.toggleApp(entry.id, meta.id, next)
            e.target.classList.toggle('on', next)
            try {
              await M.syncToApp(meta.id)
              localToast(`已${next ? '启用' : '停用'} ${meta.name} 的 ${entry.id}（写入其 MCP 配置）`, 'success')
            } catch (err) {
              localToast(meta.name + ' 同步失败：' + A.errMsg(err), 'error')
            }
          }
        }, meta.name))
      }
      body.appendChild(h('div', { class: 'card', style: 'margin-bottom:12px' },
        h('div', { class: 'card-row' },
          h('span', { class: 'name', text: entry.name || entry.id }),
          h('span', { class: 'tag', text: entry.spec?.type || 'stdio' }),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn sm ghost', onclick: () => openMcpModal(entry), text: '编辑' }),
          h('button', {
            class: 'btn sm ghost danger', text: '删除', onclick: async () => {
              const ok = await confirmDialog({
                title: '删除 MCP',
                text: `删除 MCP「${entry.id}」？`,
                hint: '将从所有已启用应用的配置文件中同步移除。',
                okText: '删除',
                danger: true
              })
              if (!ok) return
              await M.remove(entry.id)
              for (const appId of Object.keys(entry.apps || {})) {
                if (entry.apps[appId] && state.installed.has(appId)) {
                  try { await M.syncToApp(appId) } catch { /* best-effort */ }
                }
              }
              renderMcp()
            }
          })
        ),
        h('div', { class: 'card-row' },
          h('span', { class: 'k', text: '命令' }),
          h('span', { class: 'v mono', text: entry.spec?.command || entry.spec?.url || '—' })
        ),
        h('div', { class: 'field-hint', text: '点击应用名启用/停用并同步到对应配置文件' }),
        appsRow
      ))
    }
  }

  function openMcpModal(existing, tplInit) {
    state.editMcpId = existing?.id || null
    const spec = existing?.spec || tplInit?.spec || { type: 'stdio' }
    $('#mcp-modal-title').textContent = existing ? '编辑 MCP' : tplInit ? `添加模板：${tplInit.name}` : '新建 MCP'
    $('#mf-name').value = existing?.id || tplInit?.id || ''
    $('#mf-command').value = spec.command || ''
    $('#mf-args').value = Array.isArray(spec.args) ? spec.args.join(' ') : ''
    $('#mf-url').value = spec.url || ''
    $('#mf-headers').value = spec.headers ? JSON.stringify(spec.headers) : ''
    $('#mf-env').value = spec.env ? JSON.stringify(spec.env) : ''
    setMcpType(spec.type === 'http' ? 'http' : 'stdio')
    // apps chips
    const box = $('#mf-apps')
    box.innerHTML = ''
    const selected = new Set(Object.keys(existing?.apps || {}).filter(k => existing.apps[k]))
    if (!existing && !tplInit) selected.add(state.currentApp)
    if (tplInit) selected.add(state.currentApp)
    for (const meta of P.APPS) {
      const chip = h('button', {
        class: 'chip' + (selected.has(meta.id) ? ' on' : ''), type: 'button', 'data-app': meta.id,
        onclick: () => chip.classList.toggle('on')
      }, meta.name)
      box.appendChild(chip)
    }
    $('#mf-json').value = JSON.stringify(spec, null, 2)
    activateFormTab('#mcp-form-tabs', 'form')
    $('#modal-mcp').hidden = false
  }

  function setMcpType(type) {
    $$('#mf-type button').forEach(b => b.classList.toggle('active', b.dataset.v === type))
    $$('.stdio-only').forEach(el => { el.hidden = type !== 'stdio' })
    $$('.http-only').forEach(el => { el.hidden = type !== 'http' })
  }

  async function saveMcpModal() {
    const isJson = $('#mcp-form-tabs button.active')?.dataset.tab === 'json'
    const id = $('#mf-name').value.trim()
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      localToast('名称/ID 必填（字母数字-_）', 'error')
      return
    }
    let spec
    if (isJson) {
      try { spec = JSON.parse($('#mf-json').value) } catch (e) {
        localToast('JSON 解析失败：' + A.errMsg(e), 'error'); return
      }
    } else {
      const type = $('#mf-type button.active')?.dataset.v || 'stdio'
      spec = { type }
      if (type === 'http') {
        spec.url = $('#mf-url').value.trim()
        if ($('#mf-headers').value.trim()) {
          try { spec.headers = JSON.parse($('#mf-headers').value) } catch (e) {
            localToast('headers JSON 解析失败', 'error'); return
          }
        }
      } else {
        spec.command = $('#mf-command').value.trim()
        const args = $('#mf-args').value.trim()
        if (args) spec.args = args.split(/\s+/)
        if ($('#mf-env').value.trim()) {
          try { spec.env = JSON.parse($('#mf-env').value) } catch (e) {
            localToast('env JSON 解析失败', 'error'); return
          }
        }
      }
    }
    const apps = {}
    for (const chip of $$('#mf-apps .chip.on')) apps[chip.dataset.app] = true
    const entry = { id, name: id, spec, apps }
    await M.upsert(entry)
    // 保存并同步到所有已启用且已安装应用
    let synced = 0
    for (const appId of Object.keys(apps)) {
      if (!state.installed.has(appId)) continue
      try { await M.syncToApp(appId); synced++ } catch (e) {
        localToast(P.APP_MAP[appId]?.name + ' 同步失败：' + A.errMsg(e), 'error')
      }
    }
    $('#modal-mcp').hidden = true
    localToast(`已保存 ${id}，同步 ${synced} 个应用`, 'success')
    renderMcp()
  }

  function renderMcpTemplates() {
    const grid = $('#tpl-grid')
    grid.innerHTML = ''
    for (const tpl of M.TEMPLATES) {
      grid.appendChild(h('div', { class: 'preset-card' },
        h('div', { class: 'card-row' }, h('span', { class: 'name', text: tpl.name }), h('span', { class: 'tag', text: tpl.spec.type })),
        h('div', { class: 'url mono', text: tpl.spec.command ? tpl.spec.command + ' ' + (tpl.spec.args || []).join(' ') : tpl.spec.url }),
        tpl.envHint ? h('div', { class: 'field-hint', text: '需要环境变量：' + tpl.envHint }) : null,
        h('button', {
          class: 'btn sm primary', text: '添加', onclick: () => {
            $('#modal-mcp-templates').hidden = true
            openMcpModal(null, tpl)
          }
        })
      ))
    }
  }

  /* ================ 会话页 ================ */
  async function loadSessionsPage() {
    const app = state.currentApp
    const body = $('#sessions-body')
    $('#btn-session-back').hidden = true
    $('#btn-session-export').hidden = true
    $('#sessions-title').textContent = P.APP_MAP[app]?.name + ' · 会话'
    body.innerHTML = ''
    body.appendChild(h('div', { class: 'skeleton', style: 'height:120px' }))
    try {
      if (!state.sessionsCache || state.sessionListApp !== app) {
        state.sessionsCache = await S.listSessions(app)
        state.sessionListApp = app
      }
      renderSessionList()
    } catch (e) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'error-inline', text: '会话目录读取失败：' + A.errMsg(e) + '（该应用可能不支持会话浏览）' }))
    }
  }

  function renderSessionList() {
    const body = $('#sessions-body')
    const kw = ($('#session-search')?.value || '').trim().toLowerCase()
    const list = kw
      ? state.sessionsCache.filter(s => (s.title + s.project + s.sessionId).toLowerCase().includes(kw))
      : state.sessionsCache
    $('#sessions-sub').textContent = `${state.sessionsCache.length} 个会话`
    body.innerHTML = ''
    if (list.length === 0) {
      body.appendChild(h('div', { class: 'empty', text: '没有会话记录' }))
      return
    }
    const wrap = h('div', { class: 'session-list' })
    for (const s of list.slice(0, 200)) {
      const item = h('div', { class: 'session-item', onclick: () => openSessionDetail(s) },
        h('div', { class: 'row1' },
          h('span', { class: 'title', text: s.title || s.sessionId }),
          h('button', {
            class: 'btn sm ghost', text: '复制 resume', onclick: async (e) => {
              e.stopPropagation()
              try {
                await A.copyText(S.resumeCommand(state.currentApp, s.sessionId))
                localToast('已复制：' + S.resumeCommand(state.currentApp, s.sessionId), 'success')
              } catch (err) { localToast(A.errMsg(err), 'error') }
            }
          })
        ),
        h('div', { class: 'meta' },
          h('span', { text: s.project ? s.project.split('/').pop() : '' }),
          h('span', { text: fmtDate(s.lastActiveAt) }),
          h('span', { text: s.messageCount + ' 条消息' }),
          h('span', { text: fmtBytes(s.bytes) })
        )
      )
      wrap.appendChild(item)
    }
    body.appendChild(wrap)
  }

  async function openSessionDetail(s) {
    const body = $('#sessions-body')
    $('#btn-session-back').hidden = false
    $('#btn-session-export').hidden = false
    body.innerHTML = ''
    body.appendChild(h('div', { class: 'skeleton', style: 'height:200px' }))
    try {
      const detail = await S.readSession(state.currentApp, s.file)
      state.sessionDetail = { session: s, detail }
      $('#sessions-sub').textContent = `${s.sessionId.slice(0, 8)} · ${detail.turns.length} 轮${detail.truncated ? ' · 文件超 512KB 已截断' : ''}`
      body.innerHTML = ''
      const wrap = h('div', { class: 'session-detail' })
      for (const turn of detail.turns) {
        wrap.appendChild(renderTurn(turn))
      }
      if (detail.turns.length === 0) {
        wrap.appendChild(h('div', { class: 'empty', text: '未解析出对话轮次' }))
      }
      body.appendChild(wrap)
    } catch (e) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'error-inline', text: '读取失败：' + A.errMsg(e) }))
    }
  }

  function stateSessionSearch() { return $('#session-search')?.value || '' }

  function renderTurn(turn) {
    const search = stateSessionSearch().trim().toLowerCase()
    let text = turn.text || ''
    let hit = false
    if (search) {
      hit = text.toLowerCase().includes(search)
    }
    const textEl = h('div', { class: 'text', text })
    const turnEl = h('div', { class: 'turn collapsed' + (hit ? ' hit expanded' : ''), 'data-role': turn.role },
      h('div', { class: 'turn-head', onclick: () => turnEl.classList.toggle('collapsed') },
        h('span', { class: 'role', text: turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : '工具' }),
        h('span', { class: 'name', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: (turn.title || '') + (turn.isError ? ' · 出错' : '') }),
        turn.usage ? h('span', { class: 'token-chip mono', text: `${U.fmtTokens(turn.usage.input + turn.usage.output)} tok` }) : null,
        h('span', { class: 'token-chip', text: turn.ts ? fmtDate(turn.ts) : '' })
      ),
      h('div', { class: 'turn-body' },
        textEl,
        text.length > 600 ? h('div', {
          class: 'expand-toggle', text: '展开全部', onclick: (e) => {
            e.stopPropagation()
            turnEl.classList.toggle('expanded')
            e.target.textContent = turnEl.classList.contains('expanded') ? '收起' : '展开全部'
          }
        }) : null
      )
    )
    return turnEl
  }

  async function exportSessionMd() {
    if (!state.sessionDetail) return
    try {
      const r = await S.exportMarkdown(
        { ...state.sessionDetail.session, app: state.currentApp },
        state.sessionDetail.detail
      )
      if (r) localToast('已导出 Markdown', 'success')
    } catch (e) { localToast('导出失败：' + A.errMsg(e), 'error') }
  }

  /* ================ 用量页 ================ */
  async function loadUsagePage() {
    const app = state.currentApp
    const body = $('#usage-body')
    body.innerHTML = ''
    body.appendChild(h('div', { class: 'skeleton', style: 'height:80px' }))
    try {
      const data = await U.aggregate(app, {
        onProgress: (done, total) => { $('#usage-sub').textContent = `解析中 ${done}/${total} …` }
      })
      state.usageData = data
      $('#usage-sub').textContent = `${data.files} 个会话文件 · ${data.records} 条请求记录`
      body.innerHTML = ''
      // 汇总卡
      const cards = h('div', { class: 'usage-cards' },
        card('总 Token', U.fmtTokens(data.totals.input + data.totals.output + data.totals.cacheRead)),
        card('输入', U.fmtTokens(data.totals.input)),
        card('输出', U.fmtTokens(data.totals.output)),
        card('缓存读', U.fmtTokens(data.totals.cacheRead)),
        card('请求数', U.fmtTokens(data.totals.requests))
      )
      body.append(cards)
      // 按日趋势
      const dailyBox = h('div', { class: 'chart-box' }, h('h3', { text: '按日趋势（近 30 天）' }), h('canvas', { id: 'chart-daily' }))
      body.appendChild(dailyBox)
      // 年度热力图
      const heatBox = h('div', { class: 'chart-box' }, h('h3', { text: '年度热力图' }), h('canvas', { id: 'chart-heat' }))
      body.appendChild(heatBox)
      // 模型分布
      const modelBox = h('div', { class: 'chart-box' }, h('h3', { text: '模型分布' }))
      const bars = h('div', { class: 'model-bars' })
      const maxM = Math.max(1, ...data.models.map(m => m.tokens))
      for (const m of data.models.slice(0, 12)) {
        bars.appendChild(h('div', { class: 'model-bar' },
          h('span', { class: 'mono', text: m.model }),
          h('span', { class: 'bar' }, h('i', { style: `width:${(m.tokens / maxM) * 100}%` })),
          h('span', { class: 'n', text: U.fmtTokens(m.tokens) })
        ))
      }
      modelBox.appendChild(bars)
      body.appendChild(modelBox)
      // 绘制 canvas
      requestAnimationFrame(() => {
        const c1 = $('#chart-daily')
        const c2 = $('#chart-heat')
        if (c1) U.drawDaily(c1, data.days)
        if (c2) U.drawHeatmap(c2, data.days)
      })
    } catch (e) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'error-inline', text: '用量统计失败：' + A.errMsg(e) }))
    }
  }

  function card(lbl, num) {
    return h('div', { class: 'usage-card' },
      h('div', { class: 'num', text: num }),
      h('div', { class: 'lbl', text: lbl })
    )
  }

  /* ================ 备份页 ================ */
  async function loadBackups() {
    if (state.page !== 'backups') return
    const app = state.currentApp
    const body = $('#backups-body')
    $('#backups-sub').textContent = P.APP_MAP[app]?.name + ' · 切换前自动备份，保留最近 20 份'
    body.innerHTML = ''
    body.appendChild(h('div', { class: 'skeleton', style: 'height:60px' }))
    try {
      const backups = await A.agentBackups(app)
      body.innerHTML = ''
      if (backups.length === 0) {
        body.appendChild(h('div', { class: 'empty', text: '暂无快照（每次切换/写入前自动创建，保留最近 20 份）' }))
        return
      }
      for (const b of backups) {
        body.appendChild(h('div', { class: 'backup-item' },
          h('span', { class: 'when', text: `${new Date(b.createdAt || Date.parse(b.id.replace(/\./g, ':')) || Date.now()).toLocaleString('zh-CN')} · ${b.files.length} 个文件` }),
          h('button', {
            class: 'btn sm ghost danger', text: '恢复', onclick: async () => {
              const ok = await confirmDialog({
                title: '恢复快照',
                text: '恢复到此快照？',
                hint: '恢复前会再自动备份当前状态。',
                okText: '恢复'
              })
              if (!ok) return
              try {
                await A.agentRestore(app, b.id)
                state.snapshots.delete(app)
                localToast('已恢复', 'success')
                await Promise.all([loadBackups(), renderProviders()])
              } catch (e) { localToast('恢复失败：' + A.errMsg(e), 'error') }
            }
          })
        ))
      }
    } catch (e) {
      body.innerHTML = ''
      body.appendChild(h('div', { class: 'error-inline', text: A.errMsg(e) }))
    }
  }

  /* ================ 项目预设页 ================ */
  const PROJECTS_KEY = 'ccswitch.projects.v1'

  async function renderProjects() {
    const body = $('#projects-body')
    const projects = (await A.storageGet(PROJECTS_KEY, [])) || []
    body.innerHTML = ''
    if (projects.length === 0) {
      body.appendChild(h('div', { class: 'guide' },
        h('div', { class: 'big', text: '❖' }),
        h('div', { text: '还没有项目预设' }),
        h('div', { class: 'field-hint', text: '保存当前供应商 + MCP 整套配置，一键应用' })
      ))
      return
    }
    for (const proj of projects) {
      body.appendChild(h('div', { class: 'project-item' },
        h('span', { class: 'name', text: `${proj.name} · ${proj.providerName || '无供应商'} · MCP×${(proj.mcpIds || []).length}` }),
        h('button', {
          class: 'btn sm primary', text: '应用', onclick: async () => {
            try {
              // 应用供应商
              if (proj.provider) {
                await P.applyProvider(state.currentApp, proj.provider)
                state.snapshots.delete(state.currentApp)
              }
              // 应用 MCP
              if (Array.isArray(proj.mcpIds)) {
                const entries = await M.load()
                for (const id of proj.mcpIds) {
                  const hit = entries.find(e => e.id === id)
                  if (hit) {
                    hit.apps = hit.apps || {}
                    hit.apps[state.currentApp] = true
                    await M.upsert(hit)
                  }
                }
                await M.syncToApp(state.currentApp)
              }
              localToast(`已应用项目预设「${proj.name}」`, 'success')
            } catch (e) { localToast('应用失败：' + A.errMsg(e), 'error') }
          }
        }),
        h('button', {
          class: 'btn sm ghost danger', text: '删除', onclick: async () => {
            const ok = await confirmDialog({
              title: '删除项目预设',
              text: `删除项目预设「${proj.name}」？`,
              okText: '删除',
              danger: true
            })
            if (!ok) return
            await A.storageSet(PROJECTS_KEY, projects.filter(x => x.id !== proj.id))
            renderProjects()
          }
        })
      ))
    }
  }

  async function saveCurrentProject() {
    const name = prompt('项目预设名称：')
    if (!name) return
    const providers = P.sorted()
    const currentId = state.currentProvider.get(state.currentApp)
    const current = providers.find(p => p.id === currentId) || null
    const mcpEntries = await M.load()
    const proj = {
      id: 'j' + Date.now().toString(36),
      name,
      app: state.currentApp,
      providerName: current?.name || null,
      provider: current,
      mcpIds: mcpEntries.filter(e => e.apps?.[state.currentApp]).map(e => e.id),
      savedAt: Date.now()
    }
    const projects = (await A.storageGet(PROJECTS_KEY, [])) || []
    projects.unshift(proj)
    await A.storageSet(PROJECTS_KEY, projects)
    localToast('已保存项目预设', 'success')
    renderProjects()
  }

  /* ================ 设置页 ================ */
  async function renderSettings() {
    const body = $('#settings-body')
    body.innerHTML = ''
    const defaultApp = await A.settingsGet('defaultApp', 'claude-code')
    const diffConfirm = await A.settingsGet('diffConfirm', true)
    body.append(
      row('默认应用',
        selectEl(['claude-code', 'codex', 'gemini-cli'], defaultApp, async v => { await A.settingsSet('defaultApp', v) }),
        'Quick 切换与启动时的默认应用'),
      row('切换前 diff 确认',
        switchEl(diffConfirm !== false, async v => { await A.settingsSet('diffConfirm', v) }),
        '关闭后一键直接切换（仍自动快照）'),
      row('备份保留策略', h('span', { class: 'field-hint', text: '宿主自动快照 · 每应用保留最近 20 份' }), null),
      row('切换历史', h('span', { class: 'field-hint', text: '环形保留最近 50 条，可在「切换历史」页回退或清空' }), null),
      row('数据来源', h('span', { class: 'field-hint', text: '功能语义与预设数据复刻自 cc-switch（Apache-2.0）' }), null)
    )
  }

  function row(label, ctrl, desc) {
    return h('div', { class: 'field-row' },
      h('div', { class: 'lbl' }, label, desc ? h('div', { class: 'desc', text: desc }) : null),
      ctrl
    )
  }
  function switchEl(on, onChange) {
    const el = h('input', { type: 'checkbox' })
    el.checked = Boolean(on)
    el.addEventListener('change', () => onChange(el.checked))
    return el
  }
  function selectEl(options, value, onChange) {
    const sel = h('select', { style: 'padding:4px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg)' })
    for (const o of options) {
      const opt = h('option', { value: o, text: P.APP_MAP[o]?.name || o })
      sel.appendChild(opt)
    }
    sel.value = value
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  /* ================ 页面路由 ================ */
  const PAGE_LOADERS = {
    providers: refreshCurrentApp,
    history: loadHistoryPage,
    mcp: renderMcp,
    sessions: loadSessionsPage,
    usage: loadUsagePage,
    backups: () => loadBackups(),
    projects: renderProjects,
    settings: renderSettings
  }

  function navigate(page) {
    state.page = page
    $$('.page').forEach(p => { p.hidden = p.id !== 'page-' + page })
    $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page))
    const loader = PAGE_LOADERS[page]
    if (loader) {
      Promise.resolve(loader()).catch(e => console.warn('[ccswitch] page load:', e))
    }
  }

  /** DOM 可用前的防御：所有启动路径在真实 DOM ready 后执行 */
  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn)
    } else {
      fn()
    }
  }

  /* ================ Quick provider ================ */
  async function registerQuick() {
    try {
      const r = await A.registerQuickProvider({ id: 'ccswitch-providers', explain: '供应商切换：cc <名称> 直达切换' })
      if (!r || r.ok !== true) return
      A.onQuickQuery(async (event) => {
        try {
          const q = String(event.query || '').trim().toLowerCase()
          if (!q || q.length < 1) return
          const providers = P.sorted()
          const hits = providers.filter(p => p.name.toLowerCase().includes(q) || (p.baseUrl || '').toLowerCase().includes(q)).slice(0, 5)
          if (hits.length === 0) return
          await A.respondQuickQuery(event.reqId, hits.map(p => ({
            id: p.id,
            title: 'cc 切换 → ' + p.name,
            subtitle: [p.baseUrl ? host(p.baseUrl) : '官方默认', p.model].filter(Boolean).join(' · '),
            explain: '回车切换该供应商（默认应用）',
            code: 'quick-switch:' + p.id,
            payload: { providerId: p.id }
          })))
        } catch { /* quick 查询失败静默 */ }
      })
    } catch { /* contribute 能力缺失时静默 */ }
  }

  async function handleQuickSwitch(providerId) {
    const providers = await P.loadProviders()
    const p = providers.find(x => x.id === providerId)
    if (!p) return
    const defaultApp = await A.settingsGet('defaultApp', state.currentApp)
    state.currentApp = state.installed.has(defaultApp) ? defaultApp : state.currentApp
    await switchProvider(p)
  }

  /* ================ 主题 ================ */
  function applyTokens() {
    // themeAware：壳子注入 CSS 变量；主动拉取兜底
    A.getThemeTokens().then(res => {
      if (!res?.tokens) return
      for (const [k, v] of Object.entries(res.tokens)) {
        if (k.startsWith('--')) document.documentElement.style.setProperty(k, v)
      }
    }).catch(() => {})
  }

  /* ================ 启动 ================ */
  async function boot() {
    // 事件绑定（DOM 元素缺失时逐项容错，支持 headless 冒烟）
    const bind = (sel, event, fn) => {
      const el = $(sel)
      if (el) el.addEventListener(event, fn)
    }
    $$('.nav-item[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)))
    bind('#nav-collapse', 'click', () => $('#nav')?.classList.toggle('collapsed'))

    bind('#btn-new-provider', 'click', () => openProviderModal(null))
    bind('#btn-preset-lib', 'click', openPresetLib)
    bind('#btn-import', 'click', importProvidersModal)
    bind('#btn-export', 'click', exportProviders)
    bind('#btn-provider-save', 'click', saveProviderModal)
    bind('#provider-search', 'input', () => state.page === 'providers' && renderProviders())
    $$('#provider-form-tabs button').forEach(b => b.addEventListener('click', () => activateFormTab('#provider-form-tabs', b.dataset.tab)))
    bind('#pf-key-view', 'click', () => {
      const el = $('#pf-apikey')
      if (el) el.type = el.type === 'password' ? 'text' : 'password'
    })
    bind('#btn-provider-test', 'click', testFromDrawer)

    // 抽屉关闭：按钮 + 遮罩 + Esc
    $$('[data-drawer-close]').forEach(b => b.addEventListener('click', closeDrawer))
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        const d = $('#drawer-provider')
        if (d && !d.hidden) { e.preventDefault(); closeDrawer() }
      }
    })

    bind('#preset-search', 'input', (e) => renderPresetGrid(e.target.value))
    bind('#btn-mcp-new', 'click', () => openMcpModal(null))
    bind('#btn-mcp-template', 'click', () => { renderMcpTemplates(); const m = $('#modal-mcp-templates'); if (m) m.hidden = false })
    bind('#btn-mcp-import', 'click', async () => {
      try {
        const r = await M.importFromApp(state.currentApp)
        localToast(`从 ${P.APP_MAP[state.currentApp]?.name} 导入 ${r.added} 个 MCP（共发现 ${r.total}）`, 'success')
        renderMcp()
      } catch (e) { localToast('导入失败：' + A.errMsg(e), 'error') }
    })
    bind('#btn-mcp-save', 'click', saveMcpModal)
    $$('#mcp-form-tabs button').forEach(b => b.addEventListener('click', () => activateFormTab('#mcp-form-tabs', b.dataset.tab)))
    $$('#mf-type button').forEach(b => b.addEventListener('click', () => setMcpType(b.dataset.v)))

    bind('#btn-diff-confirm', 'click', () => applyDiffs(state.diffPending || [], state._diffBefore))
    $$('.modal-close, [data-close]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.close
      if (id) { const m = $('#' + id); if (m) m.hidden = true }
    }))
    $$('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true }))

    bind('#session-search', 'input', () => {
      if (state.sessionDetail) return
      if (state.sessionsCache) renderSessionList()
    })
    bind('#btn-session-back', 'click', () => {
      state.sessionDetail = null
      renderSessionList()
      const back = $('#btn-session-back'); if (back) back.hidden = true
      const ex = $('#btn-session-export'); if (ex) ex.hidden = true
    })
    bind('#btn-session-export', 'click', exportSessionMd)
    bind('#btn-backups-refresh', 'click', () => loadBackups())
    bind('#btn-snapshot-export', 'click', exportSnapshot)
    bind('#btn-snapshot-import', 'click', importSnapshotModal)
    bind('#btn-history-refresh', 'click', () => loadHistoryPage())
    bind('#btn-history-clear', 'click', async () => {
      const ok = await confirmDialog({
        title: '清空切换历史',
        text: '清空全部切换记录？回退入口将一并消失。',
        hint: '不影响当前各应用的生效配置。',
        okText: '清空',
        danger: true
      })
      if (!ok) return
      await H.clear()
      localToast('已清空切换历史', 'success')
      loadHistoryPage()
    })
    bind('#btn-project-save', 'click', saveCurrentProject)

    // 生命周期
    A.onEnter(async (event) => {
      const code = event?.code || ''
      if (code === 'mcp') navigate('mcp')
      else if (code === 'sessions') navigate('sessions')
      else if (code === 'settings') navigate('settings')
      else if (code === 'main') navigate('providers')
      if (typeof event?.payload?.providerId === 'string') {
        await handleQuickSwitch(event.payload.providerId)
      }
      // quick 小窗紧凑模式
      if (A.getLaunchMode() === 'quick') document.body.classList.add('quick-mode')
    })
    A.onModeChange((mode) => document.body.classList.toggle('quick-mode', mode === 'quick'))

    // 主题
    applyTokens()
    A.onThemeChange(() => {
      applyTokens()
      if (state.page === 'usage' && state.usageData) loadUsagePage()
    })

    // 启动序列
    await loadApps()
    const defaultApp = await A.settingsGet('defaultApp', 'claude-code')
    if (state.installed.has(defaultApp)) state.currentApp = defaultApp
    navigate('providers')
    registerQuick()

    // 热键（用户在壳子侧为插件配置热键后触发：聚焦并打开）
    A.onHotkey?.(() => { navigate('providers') })
  }

  global.CCS = global.CCS || {}
  global.CCS.ui = { state, boot, navigate, renderProviders, switchProvider }

  domReady(() => { boot().catch(e => console.warn('[ccswitch] boot:', e)) })
})(window)
