/**
 * com.enest.remote-desktop — 应用界面 React 版（原 src/js/app.js 命令式逻辑等价迁移）
 * 外围（顶部条 / 资产树 / 最近列表 / 会话 Tab / 对话框 / 通知）由 React 渲染，
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变。
 * 画布区保持命令式：session wrap（statusbar / canvas / overlay / info-pop）按原
 * innerHTML 模板创建并挂入 #sessions，noVNC / RDP wasm 的连接与数据流零改动；
 * 业务核心 store.js / connection.js / vnc-session.js / rdp-session.js / novnc-loader.js 原样复用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import { createNativeSurfaces } from '@enest/native-surfaces'
import '../js/novnc-loader.js'
import '../js/store.js'
import '../js/connection.js'
import '../js/vnc-session.js'
import '../js/rdp-session.js'

const host = createNativeSurfaces(window.enest || window.zapi || null)
const store = window.RdpStore.createStore()
const { esc } = window.RdpStore
const { testConnection, friendlyError, parseUri } = window.RdpConnection

const PHASE_TEXT = { idle: '待连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '连接失败', closed: '已断开' }
const phaseText = (phase) => PHASE_TEXT[phase] || phase

function formatDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export function App() {
  const [mode, setMode] = useState(host?.getLaunchMode?.() === 'quick' ? 'quick' : 'shell')
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  const [activeId, setActiveId] = useState(null)
  const [hasSessions, setHasSessions] = useState(false)
  const [notice, setNotice] = useState(null) // { text, type }

  const sessionsRef = useRef(new Map()) // sessionId → { id, profile, session, input?, wrap, overlay, infoPop, stateEl, zoom, startedAt, connectedAt }
  const collapsedGroupsRef = useRef(new Set())
  const noticeTimerRef = useRef(0)
  const sessionsElRef = useRef(null)
  const dialogRef = useRef(null)
  const searchRef = useRef(null)
  const groupJumpRef = useRef(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const recentRef = useRef([])

  const bump = useCallback(() => setTick((n) => n + 1), [])

  /* ── 通知 ── */
  const toast = useCallback((message, type = 'info') => {
    setNotice({ text: String(message), type })
    clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), type === 'error' ? 6500 : 2400)
  }, [])
  const safely = useCallback((fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((err) => toast(friendlyError(err), 'error')), [toast])

  /* ── 模式 ── */
  const applyMode = useCallback((next) => {
    if (next && typeof next === 'object') next = next.mode
    const m = next === 'quick' ? 'quick' : 'shell'
    setMode(m)
    if (m === 'quick') host?.ui?.setHeight?.(360).catch?.(() => {})
    bump()
  }, [bump])

  /* ── 资产树（原 renderTree 等价） ── */
  const filteredProfiles = useCallback(() => {
    const { profiles, ui } = store.state
    const q = (ui.search || '').trim().toLowerCase()
    return profiles.filter((p) => {
      if (ui.selectedGroupId && p.groupId !== ui.selectedGroupId) return false
      if (!q) return true
      return (p.name + ' ' + p.host + ' ' + p.tags.join(' ')).toLowerCase().includes(q)
    })
  }, [])

  const renderTreeBuckets = useCallback(() => {
    const profiles = filteredProfiles()
    const buckets = new Map([['', []]])
    for (const group of store.state.groups) buckets.set(group.id, [])
    for (const p of profiles) {
      if (!buckets.has(p.groupId)) buckets.set('', [...(buckets.get('') || []), p])
      else buckets.get(p.groupId).push(p)
    }
    return buckets
  }, [filteredProfiles])

  const toggleGroup = useCallback((groupId) => {
    const collapsed = collapsedGroupsRef.current
    if (collapsed.has(groupId)) collapsed.delete(groupId)
    else collapsed.add(groupId)
    bump()
  }, [bump])

  const onTreeItemKeyDown = useCallback((event, p) => {
    if (event.target !== event.currentTarget || event.isComposing || !['Enter', ' '].includes(event.key)) return
    event.preventDefault()
    void openSession(p)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onTreeItemClick = useCallback((event, p) => {
    const act = event.target?.dataset?.act
    if (act === 'edit') { event.stopPropagation(); openProfileDialog(p) }
    else if (act === 'remove') { event.stopPropagation(); safely(() => removeProfileFlow(p))() }
    else if (act === 'test') { event.stopPropagation(); safely(() => runTest(p))() }
    else void openSession(p)
  }, [safely]) // eslint-disable-line react-hooks/exhaustive-deps

  function profileMenuItems(p) {
    return [
      { key: 'connect', label: '连接', onSelect: safely(() => openSession(p)) },
      { key: 'test', label: '连接测试', onSelect: safely(() => runTest(p)) },
      { key: 'edit', label: '编辑', onSelect: () => openProfileDialog(p) },
      { key: 'copy', label: '复制地址', hint: `${p.host}:${p.port}`, onSelect: safely(async () => {
        await host.clipboard.writeText(`${p.host}:${p.port}`)
        toast('已复制地址', 'success')
      }) },
      { sep: true },
      { key: 'remove', label: '删除', danger: true, onSelect: safely(() => removeProfileFlow(p)) },
    ]
  }

  /** 右键与可点击菜单都绑定当前资产，保留真实连接测试。 */
  const onTreeItemMenu = (event, p) => {
    event.preventDefault()
    event.stopPropagation()
    const items = profileMenuItems(p)
    window.PluginKit.openMenu(event, items, key => {
      void items.find(item => item.key === key)?.onSelect?.()
    }, { align: 'end' })
  }

  /* ── 最近列表（原 renderRecent / reconnectRecent 等价） ── */
  const reconnectRecent = useCallback(async (entry) => {
    const profile = store.state.profiles.find((p) => p.id === entry.profileId) ||
      { ...entry, id: entry.profileId, tunnel: { enabled: false }, viewOnly: false }
    await openSession(profile)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 会话（画布区命令式，原 openSession / activateSession / closeSession 等价） ── */
  const openSession = useCallback(async (profile, options = {}) => {
    const sessions = sessionsRef.current
    const existing = [...sessions.values()].find((s) => s.profile.id === profile.id)
    if (existing) { activateSession(existing.id); return existing.id }
    if (sessions.size >= 4 && modeRef.current === 'shell') { toast('最多同时保持 4 个会话', 'error'); return null }
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
        <button class="pk-btn pk-btn-ghost pk-btn-sm" data-cmd="info" title="会话信息">信息</button>
        <button class="pk-btn pk-btn-ghost pk-btn-sm" data-cmd="reconnect" title="重连">重连</button>
        <button class="pk-btn pk-btn-ghost pk-btn-sm" data-cmd="more" title="截图 / 贴图" aria-haspopup="menu">⋯</button>
        <button class="pk-btn pk-btn-danger pk-btn-sm" data-cmd="close" title="断开">断开</button>
      </div>
      <div class="canvas-wrap" data-zoom="fit">
        <div class="canvas-viewport" role="region" aria-label="远程桌面视口" title="1:1 时可用滚动条移动视口；滚轮仍发送到远端">
          <canvas tabindex="0" aria-label="远程桌面画布"></canvas>
        </div>
        <div class="session-overlay">
          <div class="skeleton"></div>
          <div>正在建立${profile.protocol === 'rdp' ? ' RDP' : ' VNC'} 连接…</div>
          <div class="hint">${esc(profile.host)}:${profile.port}${profile.tunnel.enabled ? ' · SSH 隧道' : ''}</div>
        </div>
        <dl class="info-pop"></dl>
      </div>`
    sessionsElRef.current.append(wrap)
    setHasSessions(true)

    const canvas = wrap.querySelector('canvas')
    const overlay = wrap.querySelector('.session-overlay')
    const infoPop = wrap.querySelector('.info-pop')
    const stateEl = wrap.querySelector('.state')

    const entry = {
      id, profile, canvas, wrap, overlay, infoPop, stateEl,
      session: null, input: null, zoom: 'fit', startedAt: Date.now(), connectedAt: 0
    }
    sessions.set(id, entry)

    const viewport = wrap.querySelector('.canvas-viewport')

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
      entry.input = window.RdpSession.attachRdpInput(canvas, session)
    } else {
      // noVNC 自带键盘处理；画布容器声明 overlay 输入上下文
      canvas.addEventListener('focusin', () => host?.ui?.setInputContext?.('overlay')?.catch?.(() => {}))
    }

    session.on('state', (payload) => {
      const { phase, reason } = payload
      stateEl.textContent = phaseText(phase)
      stateEl.className = 'state ' + phase
      if (phase === 'connected') {
        entry.connectedAt = Date.now()
        overlay.hidden = true
        canvas.focus({ preventScroll: true })
      } else if (phase === 'error') {
        overlay.hidden = false
        overlay.innerHTML = `<div class="reason">${esc(reason || '连接失败')}</div>
          <button class="pk-btn pk-btn-primary" data-retry>重试</button>
          <button class="pk-btn pk-btn-ghost" data-back>返回</button>`
        overlay.querySelector('[data-retry]').onclick = () => { overlay.hidden = true; session.reconnectNow() }
        overlay.querySelector('[data-back]').onclick = () => void closeSession(id)
      } else if (phase === 'reconnecting') {
        overlay.hidden = false
        overlay.innerHTML = `<div class="skeleton"></div><div>${esc(reason || '重连中…')}</div><div class="hint">重连不清屏，画面保留</div>`
      } else if (phase === 'closed') {
        overlay.hidden = false
        overlay.innerHTML = `<div>${esc(reason || '已断开')}</div><button class="pk-btn pk-btn-ghost" data-back>返回</button>`
        overlay.querySelector('[data-back]').onclick = () => void closeSession(id)
      }
      bump()
    })
    session.on('stats', (stats) => {
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
    session.on('disconnect', async (payload) => {
      await store.pushRecent({
        profileId: profile.id, name: profile.name, host: profile.host, port: profile.port,
        protocol: profile.protocol, when: Date.now(),
        durationMs: entry.connectedAt ? Date.now() - entry.connectedAt : 0,
        ok: false
      })
      bump()
      if (!payload?.wasConnected) toast(`${profile.name}：${payload?.reason || '连接失败'}`, 'error')
    })

    // 状态条命令
    wrap.querySelector('[data-cmd="close"]').onclick = () => void closeSession(id)
    wrap.querySelector('[data-cmd="reconnect"]').onclick = () => session.reconnectNow()
    wrap.querySelector('[data-cmd="info"]').onclick = () => infoPop.classList.toggle('show')
    wrap.querySelector('[data-cmd="more"]').onclick = (event) => {
      window.PluginKit.openMenu(event.currentTarget, [
        ['shot', '截图保存'],
        ['pin', '贴图到桌面'],
      ], (key) => {
        if (key === 'shot') safely(() => saveScreenshot(entry))()
        if (key === 'pin') safely(() => pinScreenshot(entry))()
      }, { align: 'end' })
    }
    for (const btn of wrap.querySelectorAll('.zoom-seg button')) {
      btn.onclick = () => {
        entry.zoom = btn.dataset.zoom
        wrap.querySelector('.canvas-wrap').dataset.zoom = entry.zoom
        if (entry.zoom !== '1:1') viewport.scrollTo(0, 0)
        wrap.querySelectorAll('.zoom-seg button').forEach((b) => b.classList.toggle('active', b === btn))
        session.setZoom?.(entry.zoom)
      }
      if (btn.dataset.zoom === 'fit') btn.classList.add('active')
    }

    activateSession(id)
    void session.connect()
    return id
  }, [bump, safely, toast]) // eslint-disable-line react-hooks/exhaustive-deps

  const activateSession = useCallback((id) => {
    for (const [key, entry] of sessionsRef.current) entry.wrap.classList.toggle('active', key === id)
    setActiveId(id)
  }, [])

  const closeSession = useCallback(async (id) => {
    const sessions = sessionsRef.current
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    try { await entry.session.disconnect() } catch { /* 已断 */ }
    entry.input?.destroy?.()
    entry.wrap.remove()
    const next = [...sessions.keys()][0]
    if (next) activateSession(next)
    else {
      setActiveId(null)
      setHasSessions(false)
      if (modeRef.current === 'quick') host?.ui?.setHeight?.(360).catch?.(() => {})
    }
    bump()
  }, [activateSession, bump])

  /* ── 截图 ── */
  const saveScreenshot = async (entry) => {
    const dataUrl = entry.session.screenshot?.()
    if (!dataUrl) { toast('画布尚未就绪', 'error'); return }
    const result = await host?.shell?.saveFile?.({ defaultName: `${entry.profile.name}-${Date.now()}.png`, dataUrl })
    if (result?.ok) toast('截图已保存', 'success')
  }
  const pinScreenshot = async (entry) => {
    const dataUrl = entry.session.screenshot?.()
    if (!dataUrl) { toast('画布尚未就绪', 'error'); return }
    await host?.pin?.open?.({ dataUrl, title: entry.profile.name })
  }

  /* ── 资产对话框（原 openProfileDialog 等价；dialog 内容保持命令式模板） ── */
  const openProfileDialog = useCallback((profile) => {
    const dialog = dialogRef.current
    const isEdit = !!profile
    const value = profile || { name: '', host: '', port: 5901, protocol: 'vnc', username: '', groupId: '', tags: [], tunnel: { enabled: false, sshProfileId: '' }, viewOnly: false }
    const groups = store.state.groups
    dialog.innerHTML = `
      <form method="dialog">
        <div class="dlg-head"><h3>${isEdit ? '编辑连接' : '新建连接'}</h3><button type="button" class="pk-btn pk-btn-ghost pk-btn-sm" data-close>✕</button></div>
        <div class="dlg-body">
          <div class="form-grid">
            <div class="form-row"><label for="f-name">名称</label><input id="f-name" name="name" value="${esc(value.name)}" placeholder="如：办公机" required data-input-context="editor" /></div>
            <div class="form-row"><label for="f-group">分组</label>
              <select id="f-group" name="groupId">
                <option value="">未分组</option>
                ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === value.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
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
            <div class="form-row form-row-full"><label for="f-password">密码 ${isEdit && value.hasPassword ? '（已保存，留空 = 不修改）' : ''}</label><input id="f-password" name="password" type="password" autocomplete="new-password" placeholder="${isEdit && value.hasPassword ? '••••••（不修改请留空）' : '无密码可留空'}" data-input-context="editor" /></div>
            <div class="form-row form-row-full"><label for="f-tags">标签（逗号分隔）</label><input id="f-tags" name="tags" value="${esc((value.tags || []).join(', '))}" placeholder="生产, 内网" data-input-context="editor" /></div>
            <label class="form-check"><input type="checkbox" name="tunnelEnabled" ${value.tunnel?.enabled ? 'checked' : ''} />经 SSH 隧道（需本插件独立 SSH 连接资料）</label>
            <label class="form-check"><input type="checkbox" name="viewOnly" ${value.viewOnly ? 'checked' : ''} />只读（禁止远端键鼠）</label>
          </div>
          <div class="form-hint">密码经 vault 加密保存，任何界面不回读明文。</div>
        </div>
        <div class="dlg-foot">
          ${isEdit ? '<button type="button" class="pk-btn pk-btn-danger f-delete" id="f-delete">删除</button>' : ''}
          <button type="button" class="pk-btn pk-btn-ghost" data-close>取消</button>
          <button type="submit" class="pk-btn pk-btn-primary">保存</button>
        </div>
      </form>`
    dialog.showModal()
    const protocolSel = dialog.querySelector('#f-protocol')
    const portInput = dialog.querySelector('#f-port')
    protocolSel.onchange = () => { portInput.value = protocolSel.value === 'rdp' ? 3389 : 5901 }
    dialog.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => dialog.close() })
    const deleteBtn = dialog.querySelector('#f-delete')
    if (deleteBtn) deleteBtn.onclick = safely(async () => { await store.removeProfile(profile.id); dialog.close(); bump(); toast('已删除', 'success') })
    dialog.querySelector('form').onsubmit = safely(async (event) => {
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
        tags: String(values.tags || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        hasPassword: (isEdit && profile.hasPassword) || String(values.password || '').length > 0,
        tunnel: { enabled: values.tunnelEnabled === 'on', sshProfileId: profile?.tunnel?.sshProfileId || '' },
        viewOnly: values.viewOnly === 'on'
      }
      const password = String(values.password || '')
      await store.upsertProfile(next, password.length > 0 ? password : undefined)
      dialog.close()
      bump()
      toast(isEdit ? '已保存' : '已创建', 'success')
    })
  }, [bump, safely, toast])

  const removeProfileFlow = useCallback(async (profile) => {
    await store.removeProfile(profile.id)
    bump()
    toast('已删除', 'success')
  }, [bump, toast])

  /* ── 连接测试 ── */
  const runTest = useCallback(async (profile) => {
    toast(`正在测试 ${profile.name} …`)
    const result = await testConnection(profile)
    const ok = result.ok ? '成功' : '失败'
    toast(`${profile.name}：连接${ok}${result.reason ? ' — ' + result.reason : ''}`, result.ok ? 'success' : 'error')
    await store.pushRecent({
      profileId: profile.id, name: profile.name, host: profile.host, port: profile.port,
      protocol: profile.protocol, when: Date.now(), durationMs: 0, ok: result.ok
    })
    bump()
  }, [bump, toast])

  /* ── 导入导出 / URI ── */
  const exportFlow = useCallback(async () => {
    const json = store.exportJson()
    const result = await host?.shell?.saveTextFile?.({ defaultName: `rdp-profiles-${new Date().toISOString().slice(0, 10)}.json`, content: json })
    if (result?.ok) toast('已导出（密码不包含）', 'success')
  }, [toast])

  const importFlow = useCallback(async () => {
    const pasted = await host?.clipboard?.readText?.() || ''
    const uri = parseUri(pasted)
    if (uri) {
      await store.upsertProfile({
        name: uri.name || uri.host, host: uri.host, port: uri.port, protocol: uri.protocol,
        username: uri.username, hasPassword: false, viewOnly: uri.viewOnly, tunnel: { enabled: false }
      }, uri.password || undefined)
      bump()
      toast('已从 URI 新建资产', 'success')
      return
    }
    // 非 URI：尝试 JSON 导入（粘贴）
    try {
      const imported = await store.importJson(pasted)
      bump()
      toast(`已导入 ${imported.profiles} 个连接、${imported.groups} 个分组（密码需重录）`, 'success')
    } catch (err) {
      toast('粘贴内容不是 vnc:// rdp:// URI 或有效 JSON', 'error')
    }
  }, [bump, toast])

  const uriGo = useCallback(async () => {
    const input = document.getElementById('uri-input')
    const uri = parseUri(input.value)
    if (!uri) { toast('格式：vnc://host:5901 或 rdp://user@host:3389', 'error'); return }
    const profile = {
      id: 'rdp_' + Math.random().toString(36).slice(2, 10),
      name: uri.name || uri.host, host: uri.host, port: uri.port, protocol: uri.protocol,
      username: uri.username, hasPassword: false, viewOnly: uri.viewOnly,
      tunnel: { enabled: false }, tags: []
    }
    await openSession(profile, { password: uri.password })
  }, [openSession, toast]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 顶层接线（原底部 onclick 绑定 + 启动装配等价） ── */
  useEffect(() => {
    let alive = true
    void (async () => {
      await store.loadAll()
      if (!alive) return
      if (searchRef.current) searchRef.current.value = store.state.ui.search || ''
      if (groupJumpRef.current) groupJumpRef.current.value = store.state.ui.selectedGroupId || ''
      applyMode(modeRef.current)
      setLoaded(true)
      host?.ui?.setTitle?.('远程桌面')?.catch?.(() => {})
    })()
    const offMode = host?.onModeChange?.(applyMode)
    const offEnter = host?.onEnter?.((event) => applyMode(event?.mode || modeRef.current))
    const offClose = host?.onBeforeClose?.(async () => {
      await Promise.allSettled([...sessionsRef.current.values()].map((entry) => entry.session.disconnect()))
    })
    return () => {
      alive = false
      offMode?.(); offEnter?.(); offClose?.()
    }
  }, [applyMode])

  /* ── 渲染派生（原 renderTree / renderRecent / renderTabs 等价的视图层投影） ── */
  const buckets = loaded ? renderTreeBuckets() : null
  const recent = store.state.recent
  recentRef.current = recent
  const recentHidden = recent.length === 0
  const emptyGuideHidden = !(recent.length === 0 && store.state.profiles.length === 0)

  const treeGroups = []
  if (buckets) {
    const pushGroup = (label, items, groupId) => {
      if (groupId != null && items.length === 0 && store.state.ui.selectedGroupId) return
      treeGroups.push({ label, items, groupId })
    }
    pushGroup('未分组', buckets.get('') || [], '')
    for (const group of store.state.groups) pushGroup(group.name, buckets.get(group.id) || [], group.id)
  }
  const treeEmpty = buckets && treeGroups.every((g) => g.items.length === 0)

  return (
    <div className="app" id="app" data-mode={mode}>
      {/* 顶部条：quick=会话状态条 / shell=标题与操作 */}
      <header className="topbar" id="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">▣</span><strong>远程桌面</strong><span className="mode-label" id="mode-label">{mode === 'quick' ? ' · Quick' : ''}</span></div>
        <nav className="tabs" id="tabs" aria-label="会话">
          {mode !== 'quick' && [...sessionsRef.current.values()].map((entry) => {
            const phase = entry.session?.state?.phase || 'connecting'
            return (
              <div key={entry.id} className={'tab' + (entry.id === activeId ? ' active' : '')}>
                <button type="button" className="tab-select" aria-pressed={entry.id === activeId} onClick={() => activateSession(entry.id)}>
                  <span className={`dot ${phase}`}></span>
                  <span className="label">{entry.profile.name}</span>
                  <span className="proto">{entry.profile.protocol.toUpperCase()}</span>
                </button>
                <button type="button" className="close" title="关闭" aria-label={'关闭 ' + entry.profile.name}
                  onClick={() => void closeSession(entry.id)}>✕</button>
              </div>
            )
          })}
        </nav>
        <div className="topbar-end">
          <button className="pk-btn pk-btn-ghost" id="btn-new" title="新建连接" onClick={() => openProfileDialog(null)}>＋ 新建</button>
          <MoreMenu
            ariaLabel="更多操作"
            items={[
              { key: 'import', label: '导入 JSON / 粘贴 URI', onSelect: safely(importFlow) },
              // quick 模式沿用原行为：不暴露导出（单窗口无落盘入口）
              mode === 'quick' ? null : { key: 'export', label: '导出 JSON（密码为空）', onSelect: safely(exportFlow) },
            ].filter(Boolean)}
          />
          <span className="spacer"></span>
          <button className="pk-btn pk-btn-ghost" id="btn-shell-expand" title="在桌面展开" hidden={mode !== 'quick'} onClick={() => host?.ui?.openInShell?.()}>↗ 展开</button>
        </div>
      </header>

      <div className="workspace" id="workspace">
        {/* 左侧：资产侧栏（shell 模式） */}
        <aside className="side" id="side">
          <div className="side-tools">
            <input
              id="search" ref={searchRef} type="search" placeholder="搜索名称 / 主机 / 标签"
              aria-label="搜索连接资产" data-input-context="editor"
              onInput={safely(async (event) => { await store.setUi({ search: event.target.value }); bump() })}
            />
          </div>
          <div className="tree" id="tree">
            {!loaded ? <div className="empty">加载中…</div> : (
              <>
                {treeEmpty && store.state.ui.selectedGroupId ? null : treeGroups.map((g) => {
                  if (g.groupId != null && collapsedGroupsRef.current.has(g.groupId)) {
                    return (
                      <div key={g.groupId || '__ungrouped'} className="group-head" onClick={() => toggleGroup(g.groupId)}>
                        <span>▸</span><span>{esc(g.label)}</span><span className="count mono">{g.items.length}</span>
                      </div>
                    )
                  }
                  return (
                    <GroupBlock
                      key={g.groupId || '__ungrouped'} label={g.label} items={g.items} groupId={g.groupId}
                      onToggle={toggleGroup} onItemClick={onTreeItemClick} onItemKeyDown={onTreeItemKeyDown}
                      onItemMenu={onTreeItemMenu} menuItems={profileMenuItems}
                    />
                  )
                })}
                {treeEmpty && store.state.ui.selectedGroupId && (
                  <div className="empty">没有匹配的资产<button className="pk-btn pk-btn-ghost pk-btn-sm tree-empty-new" id="tree-empty-new" onClick={() => openProfileDialog(null)}>新建连接</button></div>
                )}
              </>
            )}
          </div>
          <div className="side-foot">
            <select
              id="group-jump" ref={groupJumpRef} aria-label="分组筛选"
              onChange={safely(async (event) => { await store.setUi({ selectedGroupId: event.target.value }); bump() })}
            ><option value="">全部分组</option></select>
          </div>
        </aside>

        {/* 主区：未连接=欢迎/最近；连接后=会话画布 */}
        <main className="main" id="main">
          <section className="welcome" id="welcome" hidden={hasSessions}>
            <div className="hero">
              <h2>远程桌面</h2>
              <p>VNC 与 RDP 双协议，支持 SSH 隧道直达内网。</p>
              <div className="quick-uri">
                <input
                  id="uri-input" type="text" placeholder="粘贴 vnc://host:5901 或 rdp://user@host:3389"
                  aria-label="快速连接 URI" data-input-context="editor"
                  onKeyDown={(event) => { if (event.key === 'Enter') safely(uriGo)() }}
                />
                <button className="pk-btn pk-btn-primary" id="btn-uri-go" onClick={safely(uriGo)}>连接</button>
              </div>
            </div>
            <div className="recent" id="recent-panel" hidden={recentHidden}>
              <div className="panel-head"><h3>最近连接</h3><MoreMenu buttonClassName="pk-btn-sm" ariaLabel="最近连接更多操作" items={[
                { key: 'clear', label: '清空最近记录', danger: true, onSelect: safely(async () => { await store.clearRecent(); bump() }) },
              ]} /></div>
              <div className="recent-list" id="recent-list">
                {recent.length === 0 ? <div className="empty">暂无最近连接</div> : recent.slice(0, 10).map((r, index) => {
                  const when = new Date(r.when)
                  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
                  const dur = r.durationMs > 0 ? formatDuration(r.durationMs) : ''
                  return (
                    <div key={`${r.profileId}-${r.when}-${index}`} className="recent-row" data-index={index} role="button" tabIndex={0}
                      onClick={safely(() => reconnectRecent(r))}
                      onKeyDown={event => {
                        if (event.isComposing || !['Enter', ' '].includes(event.key)) return
                        event.preventDefault(); safely(() => reconnectRecent(r))()
                      }}>
                      <span className="proto-badge">{r.protocol.toUpperCase()}</span>
                      <span className="name">{esc(r.name)} <span className="mono recent-addr">{esc(r.host)}:{r.port}</span></span>
                      <span className="dur">{dur}</span>
                      <span className="when mono">{hhmm}</span>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="empty-guide" id="empty-guide" hidden={emptyGuideHidden}>
              <p>还没有连接资产。</p>
              <button className="pk-btn pk-btn-primary" id="btn-empty-new" onClick={() => openProfileDialog(null)}>新建连接</button>
            </div>
          </section>
          <div className="sessions" id="sessions" ref={sessionsElRef} hidden={!hasSessions}></div>
        </main>
      </div>

      <dialog id="profile-dialog" ref={dialogRef}></dialog>
      <div className="notice" id="notice" role="status" aria-live="polite" hidden={!notice} data-type={notice?.type}>
        {notice?.text ?? ''}
      </div>
    </div>
  )
}

/* 资产树分组块：group-head + 展开的 tree-item 列表。
   行内更多菜单与右键共用连接 / 测试 / 编辑 / 复制地址 / 删除动作。 */
function GroupBlock({ label, items, groupId, onToggle, onItemClick, onItemKeyDown, onItemMenu, menuItems }) {
  return (
    <>
      <div className="group-head" onClick={() => onToggle(groupId)}>
        <span>▾</span><span>{esc(label)}</span><span className="count mono">{items.length}</span>
      </div>
      {items.map((p) => (
        <div
          key={p.id} className="tree-item" tabIndex={0} role="group" aria-label={p.name} data-row-actions
          onClick={(e) => onItemClick(e, p)}
          onKeyDown={(e) => onItemKeyDown(e, p)}
          onContextMenu={(e) => onItemMenu(e, p)}
        >
          <span className="proto-badge">{p.protocol.toUpperCase()}</span>
          <span className="name" title={esc(p.name)}>{esc(p.name)}</span>
          {p.tunnel.enabled ? <span className="tunnel" title="经 SSH 隧道"> tunnel</span> : null}
          <span className="meta mono">{esc(p.host)}:{p.port}</span>
          <span className="pk-row-actions">
            <MoreMenu buttonClassName="pk-btn-sm" ariaLabel={p.name + ' 的更多操作'} items={menuItems(p)} />
          </span>
        </div>
      ))}
    </>
  )
}
