/**
 * com.enest.remote-desktop — 应用入口（quick/shell 双形态）
 * Quick：未连接=最近列表+快速新建；连接后画布占满小窗（顶部 28px 状态条）。
 * Shell：左资产侧栏（搜索+分组树）+ 右多会话 Tab（非激活保活）。
 */
;(function () {
  'use strict'

  const host = window.enest || window.zapi || null
  const $ = selector => document.querySelector(selector)
  const store = window.RdpStore.createStore()
  const { esc } = window.RdpStore
  const { testConnection, friendlyError, parseUri } = window.RdpConnection

  const app = $('#app'), tree = $('#tree'), tabs = $('#tabs'), sessionsEl = $('#sessions')
  const welcome = $('#welcome'), recentList = $('#recent-list'), modeLabel = $('#mode-label')
  const dialog = $('#profile-dialog'), noticeEl = $('#notice')
  const uriInput = $('#uri-input')

  let mode = host?.getLaunchMode?.() || 'shell'
  let activeSessionId = null
  let collapsedGroups = new Set()
  let noticeTimer = null
  /** sessionId → { id, profile, session, input?, el, canvas, statusEls, zoom, startedAt } */
  const sessions = new Map()

  /* ── 通知 ── */
  function toast(message, type = 'info') {
    noticeEl.textContent = String(message)
    noticeEl.dataset.type = type
    noticeEl.hidden = false
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { noticeEl.hidden = true }, type === 'error' ? 6500 : 2400)
  }
  host?.ui?.toast ? null : null
  const safely = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(err => toast(friendlyError(err), 'error'))

  /* ── 模式 ── */
  function applyMode(next) {
    mode = next === 'quick' ? 'quick' : 'shell'
    app.dataset.mode = mode
    modeLabel.textContent = mode === 'quick' ? ' · Quick' : ''
    $('#btn-shell-expand').hidden = mode !== 'quick'
    if (mode === 'quick') { host?.ui?.setHeight?.(360).catch?.(() => {}) }
    renderAll()
  }
  host?.onModeChange?.(applyMode)
  host?.onEnter?.(event => applyMode(event?.mode || mode))

  /* ── 侧栏树 ── */
  function filteredProfiles() {
    const { profiles, ui } = store.state
    const q = (ui.search || '').trim().toLowerCase()
    return profiles.filter(p => {
      if (ui.selectedGroupId && p.groupId !== ui.selectedGroupId) return false
      if (!q) return true
      return (p.name + ' ' + p.host + ' ' + p.tags.join(' ')).toLowerCase().includes(q)
    })
  }

  function renderTree() {
    if (mode === 'quick') return
    const profiles = filteredProfiles()
    const groups = new Map()
    for (const group of store.state.groups) groups.set(group.id, group)
    const buckets = new Map([['', []]])
    for (const group of store.state.groups) buckets.set(group.id, [])
    for (const p of profiles) {
      if (!buckets.has(p.groupId)) { buckets.set('', [...(buckets.get('') || []), p]) }
      else buckets.get(p.groupId).push(p)
    }
    const fragment = document.createDocumentFragment()
    const appendGroup = (label, items, groupId) => {
      if (groupId != null && items.length === 0 && store.state.ui.selectedGroupId) return
      if (groupId != null) {
        const head = document.createElement('div')
        head.className = 'group-head'
        const collapsed = collapsedGroups.has(groupId)
        head.innerHTML = `<span>${collapsed ? '▸' : '▾'}</span><span>${esc(label)}</span><span class="count mono">${items.length}</span>`
        head.onclick = () => { collapsedGroups.has(groupId) ? collapsedGroups.delete(groupId) : collapsedGroups.add(groupId); renderTree() }
        fragment.append(head)
        if (collapsed) return
      }
      for (const p of items) {
        const item = document.createElement('div')
        item.className = 'tree-item'
        item.tabIndex = 0
        item.innerHTML = `<span class="proto-badge">${p.protocol.toUpperCase()}</span>
          <span class="name" title="${esc(p.name)}">${esc(p.name)}</span>
          ${p.tunnel.enabled ? '<span class="tunnel" title="经 SSH 隧道"> tunnel</span>' : ''}
          <span class="meta mono">${esc(p.host)}:${p.port}</span>
          <span class="actions">
            <button data-act="test" title="连接测试">测</button>
            <button data-act="edit" title="编辑">改</button>
            <button data-act="remove" title="删除">删</button>
          </span>`
        item.onclick = event => {
          const act = event.target?.dataset?.act
          if (act === 'edit') { event.stopPropagation(); openProfileDialog(p) }
          else if (act === 'remove') { event.stopPropagation(); safely(() => removeProfileFlow(p))() }
          else if (act === 'test') { event.stopPropagation(); safely(() => runTest(p))() }
          else openSession(p)
        }
        item.onkeydown = event => { if (event.key === 'Enter') openSession(p) }
        fragment.append(item)
      }
    }
    appendGroup('未分组', buckets.get('') || [], '')
    for (const group of store.state.groups) appendGroup(group.name, buckets.get(group.id) || [], group.id)
    if (fragment.childElementCount === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.innerHTML = '没有匹配的资产<button class="ghost" style="margin-left:8px" id="tree-empty-new">新建连接</button>'
      fragment.append(empty)
    }
    tree.replaceChildren(fragment)
    const emptyNew = tree.querySelector('#tree-empty-new')
    if (emptyNew) emptyNew.onclick = () => openProfileDialog(null)
  }

  /* ── 最近列表 ── */
  function renderRecent() {
    const recent = store.state.recent
    $('#recent-panel').hidden = recent.length === 0 && store.state.profiles.length > 0 ? true : recent.length === 0
    $('#empty-guide').hidden = !(recent.length === 0 && store.state.profiles.length === 0)
    const rows = recent.slice(0, 10).map((r, index) => {
      const when = new Date(r.when)
      const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
      const dur = r.durationMs > 0 ? formatDuration(r.durationMs) : ''
      return `<div class="recent-row" data-index="${index}">
        <span class="proto-badge">${r.protocol.toUpperCase()}</span>
        <span class="name">${esc(r.name)} <span class="mono" style="color:var(--text-3)">${esc(r.host)}:${r.port}</span></span>
        <span class="dur">${dur}</span>
        <span class="when mono">${hhmm}</span>
      </div>`
    }).join('')
    recentList.innerHTML = rows || '<div class="empty">暂无最近连接</div>'
    recentList.querySelectorAll('.recent-row').forEach(row => {
      row.onclick = safely(() => reconnectRecent(recent[Number(row.dataset.index)]))
    })
  }

  function formatDuration(ms) {
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  }

  async function reconnectRecent(entry) {
    const profile = store.state.profiles.find(p => p.id === entry.profileId) ||
      { ...entry, id: entry.profileId, tunnel: { enabled: false }, viewOnly: false }
    await openSession(profile)
  }

  /* ── 会话 ── */
  async function openSession(profile, options = {}) {
    const existing = [...sessions.values()].find(s => s.profile.id === profile.id)
    if (existing) { activateSession(existing.id); return existing.id }
    if (sessions.size >= 4 && mode === 'shell') { toast('最多同时保持 4 个会话', 'error'); return null }
    const id = 's_' + profile.id
    const wrap = document.createElement('div')
    wrap.className = 'session'
    wrap.dataset.id = id
    wrap.innerHTML = `
      <div class="statusbar">
        <span class="state">连接中</span>
        <span class="metric latency mono"></span>
        <span class="metric fps mono"></span>
        <span class="metric res mono"></span>
        <span class="spacer"></span>
        <div class="zoom-seg" role="group" aria-label="缩放">
          <button data-zoom="fit">适应</button><button data-zoom="1:1">1:1</button><button data-zoom="stretch">拉伸</button>
        </div>
        <button class="ghost" data-cmd="info" title="会话信息">信息</button>
        <button class="ghost" data-cmd="shot" title="截图保存">截图</button>
        <button class="ghost" data-cmd="pin" title="贴图">贴图</button>
        <button class="ghost" data-cmd="reconnect" title="重连">重连</button>
        <button class="ghost" data-cmd="close" title="断开">断开</button>
      </div>
      <div class="canvas-wrap" data-zoom="fit">
        <canvas tabindex="0" aria-label="远程桌面画布"></canvas>
        <div class="session-overlay">
          <div class="skeleton"></div>
          <div>正在建立${profile.protocol === 'rdp' ? ' RDP' : ' VNC'} 连接…</div>
          <div class="hint">${esc(profile.host)}:${profile.port}${profile.tunnel.enabled ? ' · SSH 隧道' : ''}</div>
        </div>
        <dl class="info-pop"></dl>
      </div>`
    sessionsEl.append(wrap)
    sessionsEl.hidden = false
    welcome.hidden = true

    const canvas = wrap.querySelector('canvas')
    const overlay = wrap.querySelector('.session-overlay')
    const infoPop = wrap.querySelector('.info-pop')
    const stateEl = wrap.querySelector('.state')

    const entry = {
      id, profile, canvas, wrap, overlay, infoPop, stateEl,
      session: null, input: null, zoom: 'fit', startedAt: Date.now(), connectedAt: 0
    }
    sessions.set(id, entry)

    const factory = profile.protocol === 'rdp' ? window.RdpSession : window.VncSession
    const session = factory.create(profile, {
      canvas,
      sshSessionId: options.sshSessionId,
      password: options.password,
      quality: host?.settings?.get ? await host.settings.get('quality').catch?.(() => null) ?? 'auto' : 'auto',
      zoom: 'fit'
    })
    entry.session = session
    if (profile.protocol === 'rdp') {
      window.NovncLoader && null
      entry.input = window.RdpSession.attachRdpInput(canvas, session)
    } else {
      // noVNC 自带键盘处理；画布容器声明 overlay 输入上下文
      canvas.addEventListener('focusin', () => host?.ui?.setInputContext?.('overlay')?.catch?.(() => {}))
    }

    session.on('state', payload => {
      const { phase, reason } = payload
      stateEl.textContent = phaseText(phase, reason)
      stateEl.className = 'state ' + phase
      if (phase === 'connected') {
        entry.connectedAt = Date.now()
        overlay.hidden = true
        canvas.focus()
      } else if (phase === 'error') {
        overlay.hidden = false
        overlay.innerHTML = `<div class="reason">${esc(reason || '连接失败')}</div>
          <button class="primary" data-retry>重试</button>
          <button class="ghost" data-back>返回</button>`
        overlay.querySelector('[data-retry]').onclick = () => { overlay.hidden = true; session.reconnectNow() }
        overlay.querySelector('[data-back]').onclick = () => closeSession(id)
      } else if (phase === 'reconnecting') {
        overlay.hidden = false
        overlay.innerHTML = `<div class="skeleton"></div><div>${esc(reason || '重连中…')}</div><div class="hint">重连不清屏，画面保留</div>`
      } else if (phase === 'closed') {
        overlay.hidden = false
        overlay.innerHTML = `<div>${esc(reason || '已断开')}</div><button class="ghost" data-back>返回</button>`
        overlay.querySelector('[data-back]').onclick = () => closeSession(id)
      }
      renderTabs()
    })
    session.on('stats', stats => {
      wrap.querySelector('.latency').textContent = stats.latencyMs ? `${stats.latencyMs}ms` : ''
      wrap.querySelector('.fps').textContent = stats.fps ? `${stats.fps}fps` : ''
      wrap.querySelector('.res').textContent = stats.resolution || ''
      entry.infoPop.innerHTML = `
        <dt>协议</dt><dd>${profile.protocol.toUpperCase()}</dd>
        <dt>分辨率</dt><dd class="mono">${esc(stats.resolution || '—')}</dd>
        <dt>帧率</dt><dd class="mono">${stats.fps || '—'} fps</dd>
        <dt>延迟</dt><dd class="mono">${stats.latencyMs ? stats.latencyMs + ' ms' : '—'}</dd>
        <dt>编码</dt><dd>${esc(stats.encoding || '—')}</dd>
        <dt>时长</dt><dd class="mono">${formatDuration(entry.connectedAt ? Date.now() - entry.connectedAt : 0)}</dd>`
    })
    session.on('disconnect', async payload => {
      await store.pushRecent({
        profileId: profile.id, name: profile.name, host: profile.host, port: profile.port,
        protocol: profile.protocol, when: Date.now(),
        durationMs: entry.connectedAt ? Date.now() - entry.connectedAt : 0,
        ok: false
      })
      renderRecent()
      if (!payload?.wasConnected) toast(`${profile.name}：${payload?.reason || '连接失败'}`, 'error')
    })

    // 状态条命令
    wrap.querySelector('[data-cmd="close"]').onclick = () => closeSession(id)
    wrap.querySelector('[data-cmd="reconnect"]').onclick = () => session.reconnectNow()
    wrap.querySelector('[data-cmd="info"]').onclick = () => infoPop.classList.toggle('show')
    wrap.querySelector('[data-cmd="shot"]').onclick = safely(() => saveScreenshot(entry))
    wrap.querySelector('[data-cmd="pin"]').onclick = safely(() => pinScreenshot(entry))
    for (const btn of wrap.querySelectorAll('.zoom-seg button')) {
      btn.onclick = () => {
        entry.zoom = btn.dataset.zoom
        wrap.querySelector('.canvas-wrap').dataset.zoom = entry.zoom
        wrap.querySelectorAll('.zoom-seg button').forEach(b => b.classList.toggle('active', b === btn))
        session.setZoom?.(entry.zoom)
      }
      if (btn.dataset.zoom === 'fit') btn.classList.add('active')
    }

    activateSession(id)
    renderTabs()
    void session.connect()
    return id
  }

  function phaseText(phase, reason) {
    const map = { idle: '待连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '连接失败', closed: '已断开' }
    return map[phase] || phase
  }

  function activateSession(id) {
    activeSessionId = id
    for (const [key, entry] of sessions) entry.wrap.classList.toggle('active', key === id)
    renderTabs()
  }

  async function closeSession(id) {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    try { await entry.session.disconnect() } catch { /* 已断 */ }
    entry.input?.destroy?.()
    entry.wrap.remove()
    const next = [...sessions.keys()][0]
    if (next) activateSession(next)
    else {
      activeSessionId = null
      sessionsEl.hidden = true
      welcome.hidden = false
      if (mode === 'quick') host?.ui?.setHeight?.(360).catch?.(() => {})
    }
    renderTabs()
    renderRecent()
  }

  /* ── 截图 ── */
  async function saveScreenshot(entry) {
    const dataUrl = entry.session.screenshot?.()
    if (!dataUrl) { toast('画布尚未就绪', 'error'); return }
    const result = await host?.shell?.saveFile?.({ defaultName: `${entry.profile.name}-${Date.now()}.png`, dataUrl })
    if (result?.ok) toast('截图已保存', 'success')
  }

  async function pinScreenshot(entry) {
    const dataUrl = entry.session.screenshot?.()
    if (!dataUrl) { toast('画布尚未就绪', 'error'); return }
    await host?.pin?.open?.({ dataUrl, title: entry.profile.name })
  }

  /* ── 会话 Tab ── */
  function renderTabs() {
    if (mode === 'quick') { tabs.replaceChildren(); return }
    const fragment = document.createDocumentFragment()
    for (const [id, entry] of sessions) {
      const tab = document.createElement('button')
      tab.className = 'tab' + (id === activeSessionId ? ' active' : '')
      const phase = entry.session.state.phase
      tab.innerHTML = `<span class="dot ${phase}"></span>
        <span class="label">${esc(entry.profile.name)}</span>
        <span class="proto">${entry.profile.protocol.toUpperCase()}</span>
        <span class="close" title="关闭">✕</span>`
      tab.onclick = event => {
        if (event.target?.classList?.contains('close')) { void closeSession(id); return }
        activateSession(id)
      }
      fragment.append(tab)
    }
    tabs.replaceChildren(fragment)
  }

  /* ── 资产对话框 ── */
  function openProfileDialog(profile) {
    const isEdit = !!profile
    const value = profile || { name: '', host: '', port: 5901, protocol: 'vnc', username: '', groupId: '', tags: [], tunnel: { enabled: false, sshProfileId: '' }, viewOnly: false }
    const groups = store.state.groups
    dialog.innerHTML = `
      <form method="dialog">
        <div class="dlg-head"><h3>${isEdit ? '编辑连接' : '新建连接'}</h3><button type="button" class="ghost" data-close>✕</button></div>
        <div class="dlg-body">
          <div class="form-grid">
            <div class="form-row"><label for="f-name">名称</label><input id="f-name" name="name" value="${esc(value.name)}" placeholder="如：办公机" required data-input-context="editor" /></div>
            <div class="form-row"><label for="f-group">分组</label>
              <select id="f-group" name="groupId">
                <option value="">未分组</option>
                ${groups.map(g => `<option value="${esc(g.id)}" ${g.id === value.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-row"><label for="f-protocol">协议</label>
              <select id="f-protocol" name="protocol">
                <option value="vnc" ${value.protocol === 'vnc' ? 'selected' : ''}>VNC</option>
                <option value="rdp" ${value.protocol === 'rdp' ? 'selected' : ''}>RDP</option>
              </select>
            </div>
            <div class="form-row"><label for="f-port">端口</label><input id="f-port" name="port" type="number" min="1" max="65535" value="${value.port}" class="mono" required data-input-context="editor" /></div>
            <div class="form-row"><label for="f-host">主机</label><input id="f-host" name="host" value="${esc(value.host)}" placeholder="host 或 IP" required data-input-context="editor" /></div>
            <div class="form-row"><label for="f-username">用户名</label><input id="f-username" name="username" value="${esc(value.username)}" autocomplete="off" data-input-context="editor" /></div>
            <div class="form-row" style="grid-column: 1 / -1"><label for="f-password">密码 ${isEdit && value.hasPassword ? '（已保存，留空 = 不修改）' : ''}</label><input id="f-password" name="password" type="password" autocomplete="new-password" placeholder="${isEdit && value.hasPassword ? '••••••（不修改请留空）' : '无密码可留空'}" data-input-context="editor" /></div>
            <div class="form-row" style="grid-column: 1 / -1"><label for="f-tags">标签（逗号分隔）</label><input id="f-tags" name="tags" value="${esc((value.tags || []).join(', '))}" placeholder="生产, 内网" data-input-context="editor" /></div>
            <label class="form-check"><input type="checkbox" name="tunnelEnabled" ${value.tunnel?.enabled ? 'checked' : ''} />经 SSH 隧道（需先在 SSH 插件连接）</label>
            <label class="form-check"><input type="checkbox" name="viewOnly" ${value.viewOnly ? 'checked' : ''} />只读（禁止远端键鼠）</label>
          </div>
          <div class="form-hint">密码经 vault 加密保存，任何界面不回读明文。</div>
        </div>
        <div class="dlg-foot">
          ${isEdit ? '<button type="button" class="ghost danger" id="f-delete" style="margin-right:auto">删除</button>' : ''}
          <button type="button" class="ghost" data-close>取消</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>`
    dialog.showModal()
    const protocolSel = dialog.querySelector('#f-protocol')
    const portInput = dialog.querySelector('#f-port')
    protocolSel.onchange = () => { portInput.value = protocolSel.value === 'rdp' ? 3389 : 5901 }
    dialog.querySelector('[data-close]').onclick = () => dialog.close()
    const deleteBtn = dialog.querySelector('#f-delete')
    if (deleteBtn) deleteBtn.onclick = safely(async () => { await store.removeProfile(profile.id); dialog.close(); renderAll(); toast('已删除', 'success') })
    dialog.querySelector('form').onsubmit = safely(async event => {
      event.preventDefault()
      const values = Object.fromEntries(new FormData(event.target))
      const next = {
        ...profile,
        name: String(values.name || '').trim() || String(values.host),
        host: String(values.host || '').trim(),
        port: Number(values.port),
        protocol: values.protocol === 'rdp' ? 'rdp' : 'vnc',
        username: String(values.username || ''),
        groupId: String(values.groupId || ''),
        tags: String(values.tags || '').split(/[,，]/).map(t => t.trim()).filter(Boolean),
        hasPassword: (isEdit && profile.hasPassword) || String(values.password || '').length > 0,
        tunnel: { enabled: values.tunnelEnabled === 'on', sshProfileId: profile?.tunnel?.sshProfileId || '' },
        viewOnly: values.viewOnly === 'on'
      }
      const password = String(values.password || '')
      await store.upsertProfile(next, password.length > 0 ? password : undefined)
      dialog.close()
      renderAll()
      toast(isEdit ? '已保存' : '已创建', 'success')
    })
  }

  async function removeProfileFlow(profile) {
    await store.removeProfile(profile.id)
    renderAll()
    toast('已删除', 'success')
  }

  /* ── 连接测试 ── */
  async function runTest(profile) {
    toast(`正在测试 ${profile.name} …`)
    const result = await testConnection(profile)
    const ok = result.ok ? '成功' : '失败'
    toast(`${profile.name}：连接${ok}${result.reason ? ' — ' + result.reason : ''}`, result.ok ? 'success' : 'error')
    await store.pushRecent({
      profileId: profile.id, name: profile.name, host: profile.host, port: profile.port,
      protocol: profile.protocol, when: Date.now(), durationMs: 0, ok: result.ok
    })
  }

  /* ── 导入导出 / URI ── */
  async function exportFlow() {
    const json = store.exportJson()
    const result = await host?.shell?.saveTextFile?.({ defaultName: `rdp-profiles-${new Date().toISOString().slice(0, 10)}.json`, content: json })
    if (result?.ok) toast('已导出（密码不包含）', 'success')
  }

  async function importFlow() {
    const pasted = await host?.clipboard?.readText?.() || ''
    const uri = parseUri(pasted)
    if (uri) {
      await store.upsertProfile({
        name: uri.name || uri.host, host: uri.host, port: uri.port, protocol: uri.protocol,
        username: uri.username, hasPassword: false, viewOnly: uri.viewOnly, tunnel: { enabled: false }
      }, uri.password || undefined)
      renderAll()
      toast('已从 URI 新建资产', 'success')
      return
    }
    // 非 URI：尝试 JSON 导入（粘贴）
    try {
      const imported = await store.importJson(pasted)
      renderAll()
      toast(`已导入 ${imported.profiles} 个连接、${imported.groups} 个分组（密码需重录）`, 'success')
    } catch (err) {
      toast('粘贴内容不是 vnc:// rdp:// URI 或有效 JSON', 'error')
    }
  }

  async function uriGo() {
    const uri = parseUri(uriInput.value)
    if (!uri) { toast('格式：vnc://host:5901 或 rdp://user@host:3389', 'error'); return }
    const profile = {
      id: 'rdp_' + Math.random().toString(36).slice(2, 10),
      name: uri.name || uri.host, host: uri.host, port: uri.port, protocol: uri.protocol,
      username: uri.username, hasPassword: false, viewOnly: uri.viewOnly,
      tunnel: { enabled: false }, tags: []
    }
    await openSession(profile, { password: uri.password })
  }

  /* ── 顶层接线 ── */
  $('#btn-new').onclick = () => openProfileDialog(null)
  $('#btn-empty-new').onclick = () => openProfileDialog(null)
  $('#btn-export').onclick = safely(exportFlow)
  $('#btn-import').onclick = safely(importFlow)
  $('#btn-uri-go').onclick = safely(uriGo)
  uriInput.addEventListener('keydown', event => { if (event.key === 'Enter') safely(uriGo)() })
  $('#btn-clear-recent').onclick = safely(async () => { await store.clearRecent(); renderRecent() })
  $('#btn-shell-expand').onclick = () => host?.ui?.openInShell?.()
  $('#search').addEventListener('input', safely(async event => { await store.setUi({ search: event.target.value }); renderTree() }))
  $('#group-jump').addEventListener('change', safely(async event => { await store.setUi({ selectedGroupId: event.target.value }); renderTree() }))

  // 优雅断开：Tab 关闭 / 卸载前等待会话 shutdown + recent 落盘
  host?.onBeforeClose?.(async () => {
    await Promise.allSettled([...sessions.values()].map(entry => entry.session.disconnect()))
  })

  function renderAll() { renderTree(); renderRecent(); renderTabs() }

  /* ── 启动 ── */
  (async () => {
    await store.loadAll()
    $('#search').value = store.state.ui.search || ''
    $('#group-jump').value = store.state.ui.selectedGroupId || ''
    applyMode(mode)
    host?.ui?.setTitle?.('远程桌面')?.catch?.(() => {})
  })()
})()
