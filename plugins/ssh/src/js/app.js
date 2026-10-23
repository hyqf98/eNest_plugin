import { createCommandActions } from './commandActions.js'
import { decodeTerminalData } from './terminalData.js'

/**
 * com.github.eNest.ssh — minimalist UI shell
 * Storage keys unchanged: ssh.profiles/groups/history/snippets/ui
 * API: enest.ssh.* · vault secretRef · settings.register followShellTheme
 */
;(function () {
  const api = window.SshApi
  const store = window.SshStore
  const dict = window.SshDict
  const Term = window.SshTerm
  const $ = (id) => document.getElementById(id)

  const sessions = new Map()
  const commandActions = createCommandActions({
    getSession: activeSession,
    send: (sessionId, data) => api.sshWrite(sessionId, data),
    beforeExecute: async (command, session) => {
      const danger = dict.matchDanger(command, store.findProfile(session.profileId)?.env)
      if (!danger) return true
      return confirmDialog(danger.reason + '\n\n' + command, { title: '危险命令', okText: '仍要执行', danger: true })
    },
    onExecuted: (command, session) => { store.pushHistory({ profileId: session.profileId, command, ts: Date.now() }); session.lastCommand = ''; getCompletion().hide(); if ($('drawer')?.classList.contains('open')) renderRight() },
    onInserted: () => { getCompletion().hide(); renderHintMeta() },
    onError: error => toast(api.errMessage(error), 'warn'),
  })
  let activeSessionId = null
  let terminalLayout = 'single', splitTabs = []
  let completionController = null
  let hostSshReady = false
  let followShellTheme = true
  let ctxCloseHandler = null
  let ctxReturnFocus = null

  /* ========== utils ========== */
  function toast(msg, type) {
    api.toast(msg, type)
  }
  function err(e) {
    return api.errMessage(e)
  }
  function isPerm(e) {
    return String(err(e)).includes('permission denied')
  }
  function fmtTime(ts) {
    if (!ts) return '—'
    try {
      return new Date(ts).toLocaleString()
    } catch {
      return String(ts)
    }
  }
  function fmtRelTime(ts) {
    if (!ts) return ''
    const diff = Date.now() - ts
    if (diff < 60e3) return '刚刚'
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前'
    return fmtTime(ts)
  }
  function envClass(env) {
    if (env === 'prod') return 'badge env-prod'
    if (env === 'staging') return 'badge env-staging'
    if (env === 'dev') return 'badge env-dev'
    return 'badge'
  }
  function statusLabel(st) {
    return (
      {
        connecting: '连接中',
        connected: '已连接',
        disconnected: '已断开',
        exited: '已退出',
      }[st] || st || ''
    )
  }
  function profileTitle(p) {
    return p.name || p.username + '@' + p.host
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /* ========== context menu ========== */
  function closeContextMenu(restoreFocus = false) {
    const menu = $('ctx-menu')
    if (menu) {
      menu.classList.remove('show')
      menu.hidden = true
      menu.innerHTML = ''
    }
    if (ctxCloseHandler) {
      document.removeEventListener('click', ctxCloseHandler, true)
      document.removeEventListener('keydown', ctxCloseHandler, true)
      document.removeEventListener('contextmenu', ctxCloseHandler, true)
      ctxCloseHandler = null
    }
    if (restoreFocus && ctxReturnFocus?.isConnected) ctxReturnFocus.focus()
  }

  function showContextMenu(x, y, items) {
    const menu = $('ctx-menu')
    if (!menu || !items || !items.length) return
    closeContextMenu()
    ctxReturnFocus = document.activeElement

    const html = items
      .map((it, i) => {
        if (it.sep) return '<div class="ctx-sep"></div>'
        if (it.title) return '<div class="ctx-label">' + escapeHtml(it.title) + '</div>'
        const cls = 'ctx-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : '')
        return (
          '<button type="button" class="' +
          cls +
          '" data-idx="' +
          i +
          '" role="menuitem"' +
          (it.disabled ? ' disabled' : '') +
          ' title="' +
          escapeHtml(it.label || '') +
          '">' +
          escapeHtml(it.label || '') +
          '</button>'
        )
      })
      .join('')
    menu.innerHTML = html
    menu.hidden = false
    menu.classList.add('show')

    const vw = window.innerWidth
    const vh = window.innerHeight
    menu.style.left = '0px'
    menu.style.top = '0px'
    const rect = menu.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
    menu.onkeydown = event => {
      const buttons = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')], index = buttons.indexOf(document.activeElement)
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContextMenu(true); return }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : -1
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
    }
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus()

    menu.onclick = (ev) => {
      const btn = ev.target.closest('.ctx-item')
      if (!btn || btn.disabled) return
      const item = items[Number(btn.dataset.idx)]
      closeContextMenu()
      if (item && typeof item.onAct === 'function') void item.onAct()
    }

    ctxCloseHandler = (ev) => {
      if (menu.contains(ev.target)) return
      closeContextMenu()
    }
    setTimeout(() => {
      document.addEventListener('click', ctxCloseHandler, true)
      document.addEventListener('keydown', ctxCloseHandler, true)
      document.addEventListener('contextmenu', ctxCloseHandler, true)
    }, 0)
  }

  function showMenuFromEl(el, items) {
    if (!el) return
    const r = el.getBoundingClientRect()
    showContextMenu(r.left, r.bottom + 4, items)
  }

  function bindCtx(el, builder) {
    if (!el) return
    el.oncontextmenu = (ev) => {
      const items = typeof builder === 'function' ? builder(ev) : builder
      if (!items || !items.length) return
      ev.preventDefault()
      ev.stopPropagation()
      showContextMenu(ev.clientX, ev.clientY, items)
    }
  }

  /* ========== sidebar / drawer / FAB ========== */
  function setSidebarCollapsed(collapsed, persist) {
    const app = $('app')
    const side = $('sidebar')
    const isCollapsed = !!collapsed
    if (app) app.classList.toggle('side-collapsed', isCollapsed)
    if (side) side.dataset.collapsed = isCollapsed ? '1' : '0'
    const toggleBtn = $('btn-toggle-side')
    if (toggleBtn) {
      toggleBtn.textContent = isCollapsed ? '☰' : '»'
      const label = isCollapsed ? '展开侧栏' : '收起侧栏'
      toggleBtn.title = label
      toggleBtn.setAttribute('aria-label', label)
      toggleBtn.dataset.tip = label
    }
    if (persist !== false) store.setUi({ sidebarCollapsed: isCollapsed })
  }

  function toggleSidebar() {
    const side = $('sidebar')
    const collapsed = side ? side.dataset.collapsed === '1' : false
    setSidebarCollapsed(!collapsed)
  }

  function setDrawerOpen(open, persist) {
    const drawer = $('drawer')
    const scrim = $('drawer-scrim')
    const isOpen = !!open
    if (drawer) {
      drawer.classList.toggle('open', isOpen)
      drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
      drawer.inert = !isOpen
    }
    if (scrim) scrim.hidden = !isOpen
    // 抽屉盖在终端区之上（z-index:40 > term-search 所在层）；
    // 打开时收起终端搜索浮层，关闭时恢复，避免搜索 UI 半截被埋在抽屉下
    if (isOpen && termSearch.visible) closeTermSearch()
    document.querySelectorAll('#rail-drawer, [data-navigation="history"], [data-navigation="snippets"]').forEach((button) => {
      button.classList.toggle('active', isOpen && (!button.dataset.navigation || button.dataset.navigation === store.state.ui.rightTab))
    })
    if (persist !== false) store.setUi({ drawerOpen: isOpen })
  }

  function openCollection(tab) {
    const open = $('drawer').classList.contains('open') && store.state.ui.rightTab === tab
    store.setUi({ rightTab: tab }); renderRight(); setDrawerOpen(!open)
    if (!open) $('right-search')?.focus()
  }

  function toggleDrawer() {
    const drawer = $('drawer')
    const open = drawer ? !drawer.classList.contains('open') : true
    setDrawerOpen(open)
  }

  function updateFab() {
    const fab = $('fab')
    if (!fab) return
    const s = activeSession()
    const selected = store.state.ui.selectedProfileId
    const hasProfile = !!(selected && store.findProfile(selected)) || store.state.profiles.length > 0
    const canTerm = !!(
      (s && (s.status === 'connected' || s.status === 'connecting' || s.sessionId)) ||
      (selected && store.findProfile(selected)) ||
      (hasProfile && store.state.profiles.length)
    )
    const tips = window.EnestTips
    if (canTerm) {
      const label = '打开终端'
      if (tips) tips.setTip(fab, label)
      else {
        fab.title = label
        fab.setAttribute('aria-label', label)
      }
      fab.textContent = '⌘'
      fab.dataset.mode = 'term'
    } else {
      const label = '新建连接'
      if (tips) tips.setTip(fab, label)
      else {
        fab.title = label
        fab.setAttribute('aria-label', label)
      }
      fab.textContent = '+'
      fab.dataset.mode = 'new'
    }
  }

  async function fabAction() {
    const fab = $('fab')
    const mode = fab && fab.dataset.mode === 'term' ? 'term' : 'new'
    if (mode === 'new') {
      openProfileForm(null)
      return
    }
    const id = store.state.ui.selectedProfileId
    const p = id ? store.findProfile(id) : store.state.profiles[0]
    if (!p) {
      openProfileForm(null)
      return
    }
    store.setUi({ selectedProfileId: p.id, centerTab: 'term' })
    renderCenterTabs()
    await connectProfile(p)
  }

  /* ========== top status ========== */
  function renderTopStatus() {
    const s = activeSession()
    const nameEl = $('top-name')
    const subEl = $('top-sub')
    const dot = $('top-dot')
    if (!nameEl) return
    if (s) {
      const p = store.findProfile(s.profileId)
      nameEl.textContent = p ? profileTitle(p) : s.profileId
      const bits = []
      const st = statusLabel(s.status)
      if (st) bits.push(st)
      if (p && p.host) bits.push((p.username || '') + '@' + p.host)
      if (subEl) subEl.textContent = bits.join(' · ')
      if (dot) {
        dot.className = 'status-dot ' + (s.status || '')
      }
    } else {
      nameEl.textContent = 'SSH'
      if (subEl) subEl.textContent = store.state.profiles.length ? store.state.profiles.length + ' 连接' : ''
      if (dot) dot.className = 'status-dot'
    }
    updateFab()
  }

  /* ========== selection toolbar ========== */
  function renderSelBar() {
    const bar = $('sel-bar')
    if (!bar) return
    const id = store.state.ui.selectedProfileId
    const p = id ? store.findProfile(id) : null
    if (!p) {
      bar.hidden = true
      bar.innerHTML = ''
      return
    }
    bar.hidden = false
    bar.innerHTML =
      '<span class="sel-name">' +
      escapeHtml(profileTitle(p)) +
      '</span>' +
      '<button class="icon-btn" data-sel="connect" title="连接" aria-label="连接" data-tip="连接">↗</button>' +
      '<button class="icon-btn" data-sel="edit" title="编辑" aria-label="编辑" data-tip="编辑">✎</button>' +
      '<button class="icon-btn" data-sel="more" title="更多操作" aria-label="更多操作" data-tip="更多操作">⋯</button>'
    bar.onclick = (ev) => {
      const b = ev.target.closest('[data-sel]')
      if (!b) return
      const act = b.dataset.sel
      if (act === 'connect') void actions.connectProfileById(p.id)
      else if (act === 'edit') actions.editProfile(p.id)
      else if (act === 'more') showMenuFromEl(b, profileMenuItems(p.id) || [])
    }
  }

  /* ========== actions ========== */
  const actions = {
    async connectProfileById(id) {
      const profile = store.findProfile(id)
      store.setUi({ selectedProfileId: id, centerTab: 'term' })
      renderCenterTabs()
      if (profile) await connectProfile(profile)
      else toast('连接配置不存在', 'error')
    },
    editProfile(id) {
      const profile = store.findProfile(id)
      if (profile) openProfileForm(profile)
    },
    duplicateProfile(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const copy = {
        ...store.clone(profile),
        id: store.uid('prof'),
        name: (profile.name || '连接') + ' 副本',
        secretRef: undefined,
        lastConnectedAt: undefined,
      }
      store.upsertProfile(copy)
      renderLeft()
      toast('已复制', 'success')
    },
    async deleteProfile(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const ok = await confirmDialog('删除「' + profile.name + '」？', {
        title: '删除连接',
        okText: '删除',
        danger: true,
      })
      if (!ok) return
      if (profile.secretRef) {
        try {
          await api.vaultRemove(profile.secretRef)
        } catch {
          /* ignore */
        }
      }
      store.removeProfile(id)
      if (store.state.ui.selectedProfileId === id) store.setUi({ selectedProfileId: '' })
      renderLeft()
      renderTopStatus()
      toast('已删除', 'success')
    },
    async copySshCommand(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const cmd =
        'ssh ' +
        (profile.username ? profile.username + '@' : '') +
        profile.host +
        (profile.port && profile.port !== 22 ? ' -p ' + profile.port : '')
      try {
        await api.copyText(cmd)
        toast('已复制', 'success')
      } catch (e) {
        toast(err(e), 'error')
      }
    },
    async moveProfileToGroup(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const flat = []
      const walk = (parentId, depth) => {
        for (const g of store.childrenOf(parentId)) {
          flat.push({ id: g.id, name: '　'.repeat(depth) + g.name, plain: g.name })
          walk(g.id, depth + 1)
        }
      }
      walk('', 0)
      const hint = flat.length ? flat.map((g) => g.plain).join(' / ') : '未分组'
      const name = await promptDialog('移动到分组', hint, '')
      if (name == null) return
      const trimmed = String(name).trim()
      if (!trimmed) {
        store.upsertProfile({ ...profile, groupId: '' })
        renderLeft()
        return
      }
      const target = flat.find((g) => g.plain === trimmed || g.name === name)
      if (!target) {
        toast('未找到分组', 'warn')
        return
      }
      store.upsertProfile({ ...profile, groupId: target.id })
      renderLeft()
    },
    async exportOneProfile(id) {
      const profile = store.findProfile(id)
      if (!profile) return
      const copy = store.clone(profile)
      delete copy.secretRef
      if (copy.proxy) copy.proxy = { ...copy.proxy, secretRef: undefined, ephemeralSecret: undefined }
      if (copy.jump) copy.jump = { ...copy.jump, secretRef: undefined }
        if (copy.jumps) copy.jumps = copy.jumps.map(hop => ({ ...hop, secretRef: undefined, ephemeralSecret: undefined }))
      downloadJson('enest-ssh-' + (profile.name || profile.id) + '.json', {
        format: 'enest.ssh.export',
        version: 1,
        exportedAt: new Date().toISOString(),
        profiles: [copy],
        groups: [],
      })
    },
    async openTerminalFor(id) {
      const profile = store.findProfile(id)
      if (!profile) {
        toast('连接配置不存在', 'error')
        return
      }
      store.setUi({ selectedProfileId: id, centerTab: 'term' })
      renderCenterTabs()
      await connectProfile(profile)
    },
    viewHistoryFor(id) {
      store.setUi({
        rightTab: 'history',
        drawerOpen: true,
        historyScope: 'current',
        selectedProfileId: id || store.state.ui.selectedProfileId,
      })
      setDrawerOpen(true, false)
      const scope = $('right-scope')
      if (scope) {
        scope.value = 'current'
        syncSelectLabels()
      }
      const s = Array.from(sessions.values()).find((x) => x.profileId === id)
      if (s) setActiveTab(s.tabId)
      renderRight()
    },
    async toggleMetricsFor(id) {
      let s = Array.from(sessions.values()).find((x) => x.profileId === id)
      if (!s) {
        const p = store.findProfile(id)
        if (!p) return
        s = ensureSession(p.id)
      }
      if (s.tabId !== activeSessionId) setActiveTab(s.tabId)
      store.setUi({ centerTab: 'metrics' })
      renderCenterTabs()
      if (s.metricsOn) {
        await stopMetrics(s)
        store.setUi({ monitorOn: false })
      } else if (s.sessionId) {
        syncMetricsInterval()
        await startMetrics(s)
      } else {
        toast('请先连接', 'warn')
      }
      renderMetrics()
    },
    openSftpFor(id) {
      const s = Array.from(sessions.values()).find((x) => x.profileId === id)
      if (s) setActiveTab(s.tabId)
      store.setUi({ centerTab: 'sftp' })
      renderCenterTabs()
      renderSftp()
    },
  }

  function profileMenuItems(profileId) {
    const p = store.findProfile(profileId)
    if (!p) return null
    return [
      { primary: true, label: '连接', onAct: () => void actions.connectProfileById(profileId) },
      { label: '终端', onAct: () => void actions.openTerminalFor(profileId) },
      { label: p.favorite ? '取消收藏' : '收藏连接', onAct: () => { store.upsertProfile({ ...p, favorite: !p.favorite }); renderLeft() } },
      { label: '编辑', onAct: () => actions.editProfile(profileId) },
      { label: '复制', onAct: () => actions.duplicateProfile(profileId) },
      { label: '删除', danger: true, onAct: () => void actions.deleteProfile(profileId) },
      { sep: true },
      { label: '历史', onAct: () => actions.viewHistoryFor(profileId) },
      { label: '移动分组', onAct: () => void actions.moveProfileToGroup(profileId) },
      { label: '复制命令', onAct: () => void actions.copySshCommand(profileId) },
      { label: '监控', onAct: () => void actions.toggleMetricsFor(profileId) },
      { label: 'SFTP', onAct: () => actions.openSftpFor(profileId) },
      { label: '导出', onAct: () => void actions.exportOneProfile(profileId) },
    ]
  }

  function groupMenuItems(groupId) {
    const g = groupId ? store.findGroup(groupId) : null
    const items = [
      {
        primary: true,
        label: '新建连接',
        onAct: () => {
          store.setUi({ selectedGroupId: groupId || '' })
          openProfileForm(null)
        },
      },
    ]
    if (g) {
      items.push(
        { sep: true },
        {
          label: '新建子组',
          onAct: async () => {
            const name = await promptDialog('新建子分组', '名称', '')
            if (!name) return
            store.upsertGroup({
              id: store.uid('grp'),
              name,
              parentId: g.id,
              color: '',
              sort: store.state.groups.length,
              collapsed: false,
            })
            renderLeft()
          },
        },
        {
          label: '重命名',
          onAct: async () => {
            const name = await promptDialog('重命名分组', '', g.name)
            if (!name) return
            store.upsertGroup({ ...g, name })
            renderLeft()
          },
        },
        {
          label: '删除分组',
          danger: true,
          onAct: async () => {
            const childCount = store.state.profiles.filter((p) => {
              const ids = new Set([groupId])
              let ch = true
              while (ch) {
                ch = false
                for (const gg of store.state.groups) {
                  if (gg.parentId && ids.has(gg.parentId) && !ids.has(gg.id)) {
                    ids.add(gg.id)
                    ch = true
                  }
                }
              }
              return ids.has(p.groupId || '')
            }).length
            const orphan = await confirmDialog('删除分组？连接将移入未分组。', {
              title: '删除分组',
              okText: '删除并移动',
              cancelText: '取消',
            })
            if (orphan === true) {
              store.removeGroup(groupId, 'orphan')
            } else if (orphan === false) {
              const cascade = await confirmDialog('级联删除分组及其 ' + childCount + ' 个连接？', {
                title: '级联删除',
                okText: '级联删除',
                danger: true,
              })
              if (!cascade) return
              store.removeGroup(groupId, 'cascade')
            } else {
              return
            }
            renderLeft()
          },
        }
      )
    } else {
      items.push(
        { sep: true },
        {
          label: '新建分组',
          onAct: async () => {
            const name = await promptDialog('新建分组', '名称', '')
            if (!name) return
            store.upsertGroup({
              id: store.uid('grp'),
              name,
              parentId: '',
              color: '',
              sort: store.state.groups.length,
              collapsed: false,
            })
            renderLeft()
          },
        }
      )
    }
    return items
  }

  function sessionTabMenuItems(tabId) {
    const s = sessions.get(tabId)
    if (!s) return null
    return [
      {
        primary: true,
        label: s.status === 'connected' ? '重连' : '连接',
        onAct: () => { setActiveTab(tabId); void connectActive(true) },
      },
      { label: '终端', onAct: () => void actions.openTerminalFor(s.profileId) },
      {
        label: '断开',
        disabled: !s.sessionId,
        onAct: async () => {
          await disconnectSession(s)
        },
      },
      { label: '重命名标签', onAct: async () => { const name = await promptDialog('重命名标签', '留空使用连接名称', s.title || ''); if (name != null) { s.title = name.trim().slice(0, 120); persistWorkspace(); renderSessionTabs(); mountActiveTerminal() } } },
      { label: s.pinned ? '取消固定标签' : '固定标签', onAct: () => { s.pinned = !s.pinned; orderPinnedTabs(); persistWorkspace(); renderSessionTabs() } },
      { label: '关闭', danger: true, onAct: () => void closeTab(tabId) },
      { sep: true },
      { label: '历史', onAct: () => actions.viewHistoryFor(s.profileId) },
      { label: '监控', onAct: () => void actions.toggleMetricsFor(s.profileId) },
      { label: 'SFTP', onAct: () => actions.openSftpFor(s.profileId) },
    ]
  }

  function historyItemMenuItems(histId) {
    const h = store.state.history.find((x) => x.id === histId)
    const target = activeSession()
    if (!h) return null
    return [
      { primary: true, label: '填入', onAct: () => void fillHint(h.command, target) },
      { label: '执行', onAct: () => void runHint(h.command, target) },
      {
        label: '复制',
        onAct: async () => {
          try {
            await api.copyText(h.command || '')
          } catch (e) {
            toast(err(e), 'error')
          }
        },
      },
      { sep: true },
      {
        label: '删除',
        danger: true,
        onAct: () => {
          store.state.history = store.state.history.filter((x) => x.id !== histId)
          store.queueSave('history', true)
          renderRight()
        },
      },
    ]
  }

  function snippetMenuItems(snipId) {
    const s = store.state.snippets.find((x) => x.id === snipId)
    const target = activeSession()
    if (!s) return null
    return [
      { primary: true, label: '填入', onAct: () => void fillHint(s.command, target) },
      { label: '执行', onAct: () => void runHint(s.command, target) },
      { sep: true },
      {
        label: '编辑',
        onAct: async () => {
          const title = await promptDialog('标题', '', s.title)
          const command = await promptDialog('命令', '', s.command)
          if (command == null) return
          store.upsertSnippet({ ...s, title: title || s.title, command: command || s.command })
          renderRight()
        },
      },
      {
        label: '复制',
        onAct: async () => {
          try {
            await api.copyText(s.command || '')
          } catch (e) {
            toast(err(e), 'error')
          }
        },
      },
      { sep: true },
      {
        label: '删除',
        danger: true,
        onAct: async () => {
          if (!(await confirmDialog('删除常用命令？', { title: '删除', danger: true }))) return
          store.removeSnippet(snipId)
          renderRight()
        },
      },
    ]
  }

  /* 唯一的「更多」菜单：导航动作 + 当前会话动作。
     rail 在侧栏收起/展开两种状态下都可见，因此它承担全插件唯一的 ⋯ 入口；
     会话级动作同时在会话标签右键菜单里可达（sessionTabMenuItems）。 */
  function sideMoreItems() {
    const s = activeSession()
    return [
      { primary: true, label: '新建连接', onAct: () => openProfileForm(null) },
      { label: '新建分组', onAct: () => void newGroup() },
      { sep: true },
      {
        label: store.state.ui.filterRecent ? '取消最近筛选' : '最近连接',
        onAct: () => {
          store.setUi({ filterRecent: !store.state.ui.filterRecent })
          renderLeft()
        },
      },
      { sep: true },
      { label: '历史与常用', onAct: () => toggleDrawer() },
      { label: '导出', onAct: () => void exportAssets(true) },
      { label: '导入', onAct: () => void importAssets() },
      { sep: true },
      {
        label: '重连',
        disabled: !s,
        onAct: () => { if (!s || sessions.get(s.tabId) !== s) return; setActiveTab(s.tabId); void connectActive(true) },
      },
      {
        label: '断开',
        disabled: !(s && s.sessionId),
        onAct: async () => {
          if (!s) return
          await disconnectSession(s)
        },
      },
      {
        label: '监控',
        disabled: !s,
        onAct: () => {
          if (!s) return
          store.setUi({ centerTab: 'metrics' })
          renderCenterTabs()
          renderMetrics()
        },
      },
      {
        label: 'SFTP',
        disabled: !s,
        onAct: () => {
          if (!s) return
          store.setUi({ centerTab: 'sftp' })
          renderCenterTabs()
          renderSftp()
        },
      },
      { label: '字号 +', onAct: () => bumpFont(1) },
      { label: '字号 −', onAct: () => bumpFont(-1) },
    ]
  }

  function drawerMoreItems() {
    return [
      {
        primary: true,
        label: '新建常用',
        onAct: async () => {
          const title = await promptDialog('标题', '', '')
          if (title == null) return
          const command = await promptDialog('命令', '', '')
          if (!command) return
          store.upsertSnippet({
            id: store.uid('snip'),
            title,
            command,
            tags: [],
            sort: store.state.snippets.length,
            pinned: false,
          })
          store.setUi({ rightTab: 'snippets' })
          renderRight()
        },
      },
      { label: '导出常用', onAct: () => void exportSnippets() },
      { sep: true },
      {
        label: '清空历史',
        danger: true,
        onAct: () => void clearHistory(),
      },
    ]
  }

  function sftpMoreItems() {
    const raw = api.raw
    const hasMkdir = typeof raw?.ssh?.sftp?.mkdir === 'function'
    const hasRename = typeof raw?.ssh?.sftp?.rename === 'function'
    const hasDelete = typeof raw?.ssh?.sftp?.delete === 'function'
    const hasChmod = typeof raw?.ssh?.sftp?.chmod === 'function'
    const hasSel = !!activeSession()?.sftp?.selected
    return [
      { primary: true, label: '刷新', onAct: () => void sftpRefresh() },
      { label: '上传', onAct: () => void sftpUpload() },
      { label: '下载', disabled: !hasSel, onAct: () => void sftpDownload() },
      { sep: true },
      { label: '新建文件夹', disabled: !hasMkdir, onAct: () => void sftpMkdir() },
      { label: '重命名', disabled: !hasRename || !hasSel, onAct: () => void sftpRename() },
      { label: '删除', danger: true, disabled: !hasDelete || !hasSel, onAct: () => void sftpDelete() },
      { label: '权限…', disabled: !hasChmod || !hasSel, onAct: () => void sftpChmod() },
    ]
  }

  async function newGroup() {
    const name = await promptDialog('新建分组', '名称', '')
    if (!name) return
    store.upsertGroup({
      id: store.uid('grp'),
      name,
      parentId: store.state.ui.selectedGroupId || '',
      color: '',
      sort: store.state.groups.length,
      collapsed: false,
    })
    renderLeft()
  }

  function bumpFont(delta) {
    const next = Math.max(10, Math.min(24, (Number(store.state.ui.fontSize) || 13) + delta))
    store.setUi({ fontSize: next }, true)
    for (const s of sessions.values()) s.term?.setFontSize?.(next)
  }

  async function copyTerm() {
    const s = activeSession()
    const text = s?.term?.getSelection?.() || s?.buffer || ''
    if (!text) {
      toast('无可复制内容', 'warn')
      return
    }
    try {
      await api.copyText(text)
    } catch (e) {
      toast(err(e), 'error')
    }
  }

  async function clearHistory() {
    const scope = store.state.ui.historyScope
    const pid = activeSession()?.profileId
    const msg = scope === 'current' && pid ? '清空当前连接历史？' : '清空全部历史？'
    if (!(await confirmDialog(msg, { title: '清空历史', danger: true, okText: '清空' }))) return
    if (scope === 'current' && pid) {
      store.state.history = store.state.history.filter((h) => h.profileId !== pid || h.pinned)
    } else {
      store.state.history = store.state.history.filter((h) => h.pinned)
    }
    store.queueSave('history', true)
    renderRight()
  }

  /* ========== dialogs ========== */
  function confirmDialog(message, opts) {
    return new Promise((resolve) => {
      const root = $('confirm-root')
      const title = $('confirm-title')
      const body = $('confirm-body')
      const ok = $('confirm-ok')
      const cancel = $('confirm-cancel')
      title.textContent = (opts && opts.title) || '确认'
      body.textContent = message
      ok.textContent = (opts && opts.okText) || '确定'
      cancel.textContent = (opts && opts.cancelText) || '取消'
      ok.className = 'btn ' + ((opts && opts.danger) ? 'danger' : 'primary')
      const done = (v) => {
        root.classList.remove('show')
        ok.onclick = null
        cancel.onclick = null
        document.removeEventListener('keydown', onKey, true)
        resolve(v)
      }
      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          done(false)
        }
      }
      ok.onclick = () => done(true)
      cancel.onclick = () => done(false)
      document.addEventListener('keydown', onKey, true)
      root.classList.add('show')
    })
  }

  function promptDialog(title, placeholder, initial, opts) {
    return new Promise((resolve) => {
      const root = $('prompt-root')
      const titleEl = $('prompt-title')
      titleEl.textContent = title
      const input = $('prompt-input')
      input.placeholder = placeholder || ''
      input.value = initial || ''
      // 可访问性：输入框语义跟随弹窗标题；密码场景掩码显示
      input.setAttribute('aria-label', title)
      const secret = !!(opts && opts.secret)
      input.type = secret ? 'password' : 'text'
      if (secret) input.setAttribute('autocomplete', 'off')
      else input.removeAttribute('autocomplete')
      const note = $('prompt-note')
      if (note) note.textContent = (opts && opts.note) || ''
      const done = (v) => {
        root.classList.remove('show')
        $('prompt-ok').onclick = null
        $('prompt-cancel').onclick = null
        resolve(v)
      }
      $('prompt-ok').onclick = () => done(input.value)
      $('prompt-cancel').onclick = () => done(null)
      root.classList.add('show')
      setTimeout(() => input.focus(), 30)
    })
  }

  async function downloadJson(filename, data) {
    try {
      const text = JSON.stringify(data, null, 2)
      if (api.raw?.shell?.saveTextFile) return !!(await api.raw.shell.saveTextFile({ defaultName: filename, content: text }))?.ok
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      return true
    } catch (e) {
      toast('下载失败：' + err(e), 'error')
      return false
    }
  }

  /* ========== theme ========== */
  function onTheme() {
    for (const s of sessions.values()) {
      if (s.term) s.term.setTheme()
    }
    renderMetrics()
  }

  async function registerPluginSettings() {
    await api.settingsRegister({
      id: 'ssh.prefs',
      title: 'SSH',
      items: [
        {
          key: 'followShellTheme',
          type: 'switch',
          label: '跟随壳子主题',
          default: true,
        },
        { key: 'workbenchSettings', type: 'page', label: 'SSH 详细设置与快捷键', entry: { code: 'settings' } },
      ],
    })
    const follow = await api.settingsGet('followShellTheme', true)
    followShellTheme = follow !== false && follow !== 'false' && follow !== 0
    return followShellTheme
  }

  async function initPluginTheme() {
    const follow = await registerPluginSettings()
    await api.initTheme(onTheme, { followShellTheme: follow })
    try {
      api.raw?.onEnter?.(async () => {
        const next = await api.settingsGet('followShellTheme', true)
        const val = next !== false && next !== 'false' && next !== 0
        if (val !== followShellTheme) {
          followShellTheme = val
          await api.initTheme(onTheme, { followShellTheme: val })
          onTheme()
        }
      })
    } catch {
      /* optional */
    }
  }

  /* ========== sessions ========== */
  function orderPinnedTabs() {
    const ordered = [...sessions.values()].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
    sessions.clear()
    for (const session of ordered) sessions.set(session.tabId, session)
  }

  function persistWorkspace() {
    const workspace = store.normalizeWorkspace({ tabs: [...sessions.values()], activeTabId: activeSessionId, layout: terminalLayout, splitTabs }, store.state.profiles)
    // Explicitly whitelist metadata: no credentials, live session IDs, output or buffers.
    store.setUi({ workspace, openProfileIds: workspace.tabs.map(tab => tab.profileId) }, true)
  }

  function restoreWorkspace() {
    const workspace = store.state.ui.workspace
    if (!workspace?.tabs?.length) return
    for (const tab of workspace.tabs) sessions.set(tab.tabId, { ...createSession(tab.profileId, tab.tabId), title: tab.title, pinned: tab.pinned, status: 'disconnected', restored: true })
    activeSessionId = workspace.activeTabId
    terminalLayout = workspace.layout
    splitTabs = workspace.splitTabs
  }

  function createSession(profileId, tabId = store.uid('sess')) {
    return { tabId, profileId, sessionId: null, status: 'idle', error: '', buffer: '', metrics: [], metricsOn: false, metricsTimer: null, term: null, sftp: { path: '.', entries: [], error: '', selected: '' }, lastCommand: '', commandStart: 0, title: '', pinned: false }
  }

  function ensureSession(profileId, forceNew) {
    // 同一 profile 已有非 exited 会话时复用，避免重复 Tab
    for (const s of sessions.values()) {
      if (!forceNew && s.profileId === profileId && s.status !== 'exited') {
        setActiveTab(s.tabId)
        return s
      }
    }
    const s = createSession(profileId)
    sessions.set(s.tabId, s)
    setActiveTab(s.tabId)
    return s
  }

  function activeSession() {
    return sessions.get(activeSessionId) || null
  }

  function setActiveTab(tabId) {
    activeSessionId = tabId
    queueMicrotask(() => window.dispatchEvent(new Event('ssh-workspace-change')))
    persistWorkspace()
    renderSessionTabs()
    mountActiveTerminal()
    renderMetrics()
    renderSftp()
    renderHintMeta()
    renderTopStatus()
    updateFab()
  }

  /** Keep legacy layers mounted; workbench hints belong to the footer, never over terminal output. */
  function ensureCompletionLayer(wrap) {
    let box = document.getElementById('completion-list')
    if (!box) {
      box = document.createElement('div')
      box.id = 'completion-list'
      box.className = 'completion-list'
    }
    if (box.parentElement !== wrap) wrap.appendChild(box)
    let meta = document.getElementById('hint-meta')
    if (!meta) {
      meta = document.createElement('div')
      meta.id = 'hint-meta'
      meta.className = 'hint-meta'
    }
    const statusbar = document.querySelector('.wb-statusbar')
    const parent = statusbar || wrap
    if (meta.parentElement !== parent) parent.insertBefore(meta, statusbar?.querySelector('button') || null)
  }

  function setTerminalLayout(layout, tabIds) {
    terminalLayout = ['horizontal', 'vertical'].includes(layout) ? layout : 'single'
    splitTabs = tabIds || [...new Set([activeSessionId, ...sessions.keys()])].filter(Boolean).slice(0, 4)
    persistWorkspace()
    mountActiveTerminal()
  }

  function mountActiveTerminal() {
    const panel = $('panel-term'), active = activeSession()
    if (!panel) return
    const compact = document.documentElement.dataset.launchMode === 'quick'
    let ids = terminalLayout !== 'single' && !compact ? splitTabs.filter(id => sessions.has(id)) : []
    if (active && !ids.includes(active.tabId)) {
      if (ids.length >= 4) ids[ids.length - 1] = active.tabId
      else ids.push(active.tabId)
    }
    if (!ids.length && active) ids = [active.tabId]
    if (!compact && terminalLayout !== 'single' && JSON.stringify(ids) !== JSON.stringify(splitTabs)) { splitTabs = ids; persistWorkspace() }
    if (!active) {
      panel.innerHTML = '<div class="term-wrap" id="term-wrap"><div class="term-empty"><div class="empty-copy">选择左侧连接，或新建服务器连接</div><button class="btn sm primary" data-new>新建连接</button></div></div>'
      panel.querySelector('[data-new]').onclick = () => openProfileForm(null)
      ensureCompletionLayer($('term-wrap')); return
    }
    panel.dataset.layout = ids.length > 1 ? terminalLayout : 'single'
    // Keep terminal instances and DOM alive; only move their wrapper when splitting.
    const wrappers = new Map([...panel.querySelectorAll('[data-term-wrapper]')].map(el => [el.dataset.termWrapper, el]))
    for (const id of ids) {
      const session = sessions.get(id)
      let wrap = wrappers.get(id)
      if (!wrap) {
        wrap = document.createElement('div'); wrap.className = 'term-wrap'; wrap.dataset.termWrapper = id
        const title = document.createElement('div'); title.className = 'wb-terminal-title'
        const host = document.createElement('div'); host.className = 'term-host'
        const banner = document.createElement('div'); banner.className = 'term-banner'
        wrap.append(title, banner, host)
        wrap.addEventListener('pointerdown', () => { if (activeSessionId !== id) setActiveTab(id) }, true)
        wrap.addEventListener('focusin', () => { if (activeSessionId !== id) setActiveTab(id) })
        if (!session.term) {
          session.term = Term.createTerminal(host, {
            onData(data) { if (activeSessionId !== id) setActiveTab(id); void sendInput(data) },
            onKeyEvent(event) { return getCompletion().keydown(event, session) },
            onCommandState(event) { getCompletion().terminalState(session, event) },
            onResize(cols, rows) { if (session.sessionId) void api.sshResize(session.sessionId, cols, rows).catch(() => {}) },
            onSelection(text) { if (text && store.state.ui.selectCopy) void api.copyText(text).catch(() => {}) },
            onSelectionState() { if (activeSessionId === id) window.dispatchEvent(new Event('ssh-selection-change')) },
          })
          if (session.buffer) session.term.write(session.buffer)
        } else host.replaceWith(session.term.el)
      }
      wrap.id = id === activeSessionId ? 'term-wrap' : ''
      wrap.classList.toggle('active-terminal', id === activeSessionId)
      const title = wrap.querySelector('.wb-terminal-title')
      title.textContent = session.title || profileTitle(store.findProfile(session.profileId) || { name: session.profileId })
      const banner = wrap.querySelector('.term-banner')
      banner.classList.toggle('show', !!session.error || !session.sessionId && session.status !== 'connecting')
      banner.replaceChildren()
      if (session.error || !session.sessionId && session.status !== 'connecting') {
        const text = document.createElement('span'); text.textContent = session.error || (session.restored ? '已恢复标签 · 当前未连接，点击连接继续' : '尚未连接')
        const reconnect = document.createElement('button'); reconnect.className = 'btn sm'; reconnect.textContent = '连接'; reconnect.onclick = () => { setActiveTab(id); void connectActive(true) }
        banner.append(text, reconnect)
      }
      panel.append(wrap)
    }
    for (const child of [...panel.children]) if (!ids.includes(child.dataset.termWrapper)) child.remove()
    const wrap = [...panel.children].find(x => x.dataset.termWrapper === activeSessionId)
    ensureCompletionLayer(wrap)
    requestAnimationFrame(() => { for (const id of ids) sessions.get(id)?.term?.fit?.() })
  }

  async function sendInput(data) {
    const s = activeSession()
    if (!s || !s.sessionId) return
    const snapshot = s.term?.readCommand?.()
    getCompletion().input(data, s)
    s.term?.noteInput?.(data)
    try {
      await api.sshWrite(s.sessionId, data)
      if (data === '\r' || data === '\n') {
        if (snapshot?.text.trim() && store.state.ui.recordHistory) store.pushHistory({ profileId: s.profileId, command: snapshot.text, ts: Date.now() })
        s.lastCommand = ''
      }
    } catch (e) { s.term?.invalidateCommand?.(); toast(api.errMessage(e), 'error') }
  }

  function termFocus() {
    const s = activeSession()
    if (s?.term?.focus) s.term.focus()
  }

  async function resizePty(cols, rows) {
    const s = activeSession()
    if (!s || !s.sessionId) return
    try {
      await api.sshResize(s.sessionId, cols, rows)
    } catch {
      /* silent */
    }
  }

  /* ========== connect lifecycle ========== */
  function buildConnectPayload(profile, ephemeralPassword, jumpPassword) {
    const size = activeSession()?.term?.getSize?.() || { cols: 120, rows: 32 }
    const payload = {
      profileId: profile.id,
      host: profile.host,
      port: Number(profile.port) || 22,
      username: profile.username,
      authType: profile.authType || 'password',
      secretRef: profile.secretRef || undefined,
      privateKeyHandleId: profile.privateKeyHandleId || undefined,
      proxy: profile.proxy ? { ...profile.proxy } : undefined,
      keepAliveSec: Number(profile.keepAliveSec) || 30,
      timeoutMs: Number(profile.timeoutMs) || 20000,
      term: profile.term || 'xterm-256color',
      cols: size.cols || Number(profile.cols) || 120,
      rows: size.rows || Number(profile.rows) || 32,
      fingerprintPolicy: profile.fingerprintPolicy || 'tofu',
    }
    // 只传 secretRef / ephemeral password；绝不把明文写入 profile
    if (ephemeralPassword) payload.password = ephemeralPassword
    if (profile.jump && profile.jump.host) {
      payload.jump = {
        host: profile.jump.host,
        port: Number(profile.jump.port) || 22,
        username: profile.jump.username || profile.username,
        authType: profile.jump.authType || (profile.jump.privateKeyHandleId || profile.jump.privateKeyHint ? 'key' : 'password'),
        privateKeyHandleId: profile.jump.privateKeyHandleId || undefined,
        secretRef: profile.jump.secretRef || undefined,
      }
      if (jumpPassword) payload.jump.ephemeralSecret = jumpPassword
    }
    if (profile.jumps?.length) payload.jumps = profile.jumps.map(hop => ({ host: hop.host, port: hop.port, username: hop.username, authType: hop.authType, privateKeyHandleId: hop.privateKeyHandleId, secretRef: hop.secretRef }))
    return payload
  }

  async function connectProfile(profile, opts) {
    if (!profile || !profile.host) {
      toast('连接配置无效', 'error')
      return null
    }
    hostSshReady = api.hasHostSsh()
    const chosen = opts?.tabId ? sessions.get(opts.tabId) : null
    const s = chosen?.profileId === profile.id ? chosen : ensureSession(profile.id, !!opts?.newSession)
    setActiveTab(s.tabId)
    if (s.sessionId && s.status === 'connected') {
      s.term && s.term.focus()
      return s
    }

    if (s.status === 'connecting') return s
    const revision = (s.connectRevision || 0) + 1
    s.connectRevision = revision
    const ownsConnection = () => sessions.get(s.tabId) === s && s.connectRevision === revision
    const payload = buildConnectPayload(profile, opts?.ephemeralPassword, opts?.jumpPassword)
    s.status = 'connecting'
    s.error = ''
    renderSessionTabs()
    mountActiveTerminal()
    renderTopStatus()
    window.dispatchEvent(new Event('ssh-workspace-change'))

    try {
      const hasCredentials = await completePayloadCredentials(payload)
      if (!ownsConnection()) return null
      if (!hasCredentials) { s.status = 'disconnected'; renderSessionTabs(); mountActiveTerminal(); window.dispatchEvent(new Event('ssh-workspace-change')); toast('已取消连接', 'warn'); return s }
      s.term && s.term.writeln('\r\n\x1b[33m…\x1b[0m ' + profile.username + '@' + profile.host + '\r\n')
      const res = await api.sshConnect(payload)
      const sessionId = res && (res.sessionId || res.id || res.sessionID)
      if (!sessionId) throw new Error('ssh.connect 未返回 sessionId')
      if (!ownsConnection()) { await api.sshDisconnect(sessionId).catch(() => {}); return null }
      s.sessionId = sessionId
      s.outputDecoder = null
      s.status = 'connected'
      s.restored = false
      s.error = ''
      profile.lastConnectedAt = Date.now()
      store.upsertProfile({ ...profile })
      s.lastCommand = ''
      if (s.term) {
        const size = s.term.getSize()
        void api.sshResize(sessionId, size.cols, size.rows).catch(() => {})
        // Allow layout to settle, but never take focus back from a control the user chose meanwhile.
        const focusBeforeConnect = document.activeElement
        setTimeout(() => {
          if (ownsConnection() && activeSessionId === s.tabId && document.activeElement === focusBeforeConnect) s.term?.focus()
        }, 50)
      }
      if (store.state.ui.monitorOn) void startMetrics(s)
      window.dispatchEvent(new CustomEvent('ssh-workspace-change', { detail: { connected: activeSessionId === s.tabId, tabId: s.tabId } }))
      toast('已连接', 'success')
      renderLeft()
      renderHintMeta()
    } catch (e) {
      if (!ownsConnection()) return null
      s.status = 'disconnected'
      s.error = api.friendlyConnectError(e)
      s.term && s.term.writeln('\x1b[31m[SSH]\x1b[0m ' + s.error + '\r\n')
      toast(s.error, 'error')
    }
    renderSessionTabs()
    mountActiveTerminal()
    renderTopStatus()
    updateFab()
    return s
  }

  async function connectActive(reconnect) {
    const s = activeSession()
    if (!s) return
    const profile = store.findProfile(s.profileId)
    if (!profile) {
      toast('连接配置不存在', 'error')
      return
    }
    if (reconnect) {
      s.connectRevision = (s.connectRevision || 0) + 1
      if (s.sessionId) {
        try {
          await api.sshDisconnect(s.sessionId)
        } catch {
          /* ignore */
        }
      }
      s.sessionId = null
      s.status = 'disconnected'
    }
    if (sessions.get(s.tabId) !== s) return
    await connectProfile(profile, { tabId: s.tabId })
  }

  async function disconnectSession(s, silent) {
    if (!s) return
    s.connectRevision = (s.connectRevision || 0) + 1
    if (s.metricsOn) await stopMetrics(s)
    if (s.sessionId) {
      try {
        await api.sshDisconnect(s.sessionId)
      } catch (e) {
        if (!silent) {
          const msg = err(e)
          toast(msg.includes('not found') ? '会话已断开' : '断开失败：' + msg, 'warn')
        }
      }
    }
    s.sessionId = null
    s.outputDecoder = null
    s.status = 'disconnected'
    renderSessionTabs()
    mountActiveTerminal()
    renderTopStatus()
    updateFab()
  }

  async function closeTab(tabId) {
    const s = sessions.get(tabId)
    if (!s) return
    if (s.pinned && !(await confirmDialog('关闭这个固定标签？', { title: '关闭固定标签', okText: '关闭' }))) return
    if (s.status === 'connected' || s.status === 'connecting') {
      const ok = await confirmDialog('断开并关闭？', {
        title: '关闭会话',
        okText: '关闭',
        danger: true,
      })
      if (!ok) return
      await disconnectSession(s, true)
    }
    // 关 Tab 必停监控（Spec SSH-F8）
    if (s.metricsOn) await stopMetrics(s)
    if (s.sessionId) {
      try {
        await api.sshDisconnect(s.sessionId)
      } catch {
        /* ignore */
      }
      s.sessionId = null
    }
    if (s.term) {
      try {
        s.term.dispose()
      } catch {
        /* ignore */
      }
    }
    sessions.delete(tabId)
    if (activeSessionId === tabId) {
      const next = sessions.keys().next()
      activeSessionId = next.done ? null : next.value
    }
    splitTabs = splitTabs.filter(id => id !== tabId)
    persistWorkspace()
    renderSessionTabs()
    mountActiveTerminal()
    renderMetrics()
    renderSftp()
    renderTopStatus()
    updateFab()
    window.dispatchEvent(new CustomEvent('ssh-workspace-change'))
  }

  /* ========== host events ========== */
  function bindSshEvents() {
    api.on('ssh.data', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      const data = d.data != null ? d.data : d.chunk != null ? d.chunk : d.output
      if (!sid || data == null) return
      for (const s of sessions.values()) {
        if (s.sessionId === sid) {
          const text = decodeTerminalData(s, data)
          s.buffer += text
          if (s.buffer.length > 400000) s.buffer = s.buffer.slice(-400000)
          if (s.term) s.term.write(text)
        }
      }
    })

    api.on('ssh.exit', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      for (const s of sessions.values()) {
        if (s.sessionId === sid || (!sid && s.sessionId && d.profileId === s.profileId)) {
          s.status = 'exited'
          const code = d.code != null ? d.code : d.exitCode
          s.error = '已退出' + (code != null ? ' (' + code + ')' : '')
          if (s.term) s.term.writeln('\r\n\x1b[31m[SSH]\x1b[0m ' + s.error + '\r\n')
          if (s.metricsOn) void stopMetrics(s)
          s.sessionId = null
          s.outputDecoder = null
        }
      }
      renderSessionTabs()
      mountActiveTerminal()
      renderTopStatus()
    })

    api.on('ssh.error', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      const message = d.message || d.error || 'SSH 错误'
      for (const s of sessions.values()) {
        if (!sid || s.sessionId === sid) {
          s.error = String(message)
          if (s.term) s.term.writeln('\r\n\x1b[31m[SSH]\x1b[0m ' + s.error + '\r\n')
        }
      }
      toast(message, 'error')
      mountActiveTerminal()
    })

    api.on('ssh.metrics', (payload) => {
      const d = payload || {}
      const sid = d.sessionId || d.id
      const metrics = d.metrics || d.sample || d.data || d
      for (const s of sessions.values()) {
        if (s.sessionId === sid) {
          s.metrics.push({ ts: d.ts || Date.now(), ...normalizeMetrics(metrics) })
          if (s.metrics.length > 120) s.metrics = s.metrics.slice(-120)
          if (activeSessionId === s.tabId) renderMetrics()
        }
      }
    })

    // 传输进度：宿主推送 { sessionId, direction, path, transferred, total, done?, error? }
    api.onSshTransfer((payload) => onTransferEvent(payload))
  }

  function normalizeMetrics(m) {
    if (!m || typeof m !== 'object') return { cpu: 0, memPercent: 0 }
    const mem = m.mem || m.memory || {}
    return {
      cpu: Number(m.cpu ?? m.cpuPercent ?? 0),
      memUsed: Number(mem.used ?? m.memUsed ?? 0),
      memTotal: Number(mem.total ?? m.memTotal ?? 0),
      memPercent: Number(mem.percent ?? m.memPercent ?? 0),
      load1: Number(m.load1 ?? m.load ?? 0),
      disks: Array.isArray(m.disks)
        ? m.disks
        : Array.isArray(m.disk)
          ? m.disk.map((d) => ({
              mount: d.mount || d.filesystem || '',
              usedPercent: Number(d.usedPercent ?? d.usedPct ?? d.usePercent ?? 0),
              used: d.used,
              total: d.total,
            }))
          : [],
      net: Array.isArray(m.net)
        ? m.net
        : m.net && typeof m.net === 'object'
          ? m.net
          : {},
      uptime: m.uptime ?? m.uptimeSec,
      top: Array.isArray(m.top)
        ? m.top
        : Array.isArray(m.topProcesses)
          ? m.topProcesses.map((p) => ({
              pid: p.pid,
              user: p.user,
              cpu: Number(p.cpu ?? p.cpuPercent ?? 0),
              memPercent: Number(p.memPercent ?? p.mem ?? 0),
              cmd: p.cmd || p.command || '',
            }))
          : [],
      error: m.error || m.sampleError || null,
    }
  }

  /* ========== metrics ========== */
  /** 采集间隔唯一读取源：store.state.ui.monitorIntervalMs */
  function monitorIntervalMs() {
    return Number(store.state.ui.monitorIntervalMs) || 5000
  }

  /** 把输入框当前值同步进 store（用户改值未触发 change 时兜底） */
  function syncMetricsInterval() {
    const input = $('metrics-interval')
    if (!input) return
    const v = Number(input.value)
    if (v && v !== store.state.ui.monitorIntervalMs) store.setUi({ monitorIntervalMs: v })
  }

  async function startMetrics(s) {
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    try {
      await api.metricsStart(s.sessionId, monitorIntervalMs())
      s.metricsOn = true
      store.setUi({ monitorOn: true })
    } catch (e) {
      s.metricsOn = false
      const msg = err(e)
      toast(
        msg.includes('功能未就绪') || !api.hasHostSsh()
          ? '功能未就绪'
          : '监控启动失败：' + msg,
        'error'
      )
    }
    renderMetrics()
  }

  async function stopMetrics(s) {
    if (!s) return
    try {
      if (s.sessionId) await api.metricsStop(s.sessionId)
    } catch {
      /* ignore */
    }
    s.metricsOn = false
    renderMetrics()
  }

  function levelClass(pct, warn, danger) {
    if (pct >= danger) return 'danger'
    if (pct >= warn) return 'warn'
    return ''
  }

  function drawSpark(canvas, values, color, warn, danger, last) {
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 200
    const h = canvas.clientHeight || 36
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (!values.length) return
    const max = Math.max(100, ...values)
    const min = 0
    const n = values.length
    ctx.beginPath()
    values.forEach((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * w
      const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    let stroke = color
    if (last >= danger) stroke = cssGet('--danger')
    else if (last >= warn) stroke = cssGet('--warn')
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  function cssGet(name, fb) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb
    } catch {
      return fb
    }
  }

  function renderMetrics() {
    const body = $('metrics-body')
    const status = $('metrics-status')
    const toggle = $('metrics-toggle')
    const s = activeSession()
    if (!body) return
    if (!s) {
      body.innerHTML = '<div class="empty">无会话</div>'
      if (status) status.textContent = ''
      if (toggle) toggle.textContent = '开启'
      return
    }
    if (status) {
      status.textContent =
        statusLabel(s.status) +
        (s.metricsOn ? ' · 采集中' : '') +
        (s.metrics.length ? ' · ' + s.metrics.length : '')
    }
    if (toggle) toggle.textContent = s.metricsOn ? '停止' : '开启'

    const last = s.metrics[s.metrics.length - 1]
    if (!last) {
      body.innerHTML = '<div class="empty">' + (s.metricsOn ? '采样中…' : '未开启监控') + '</div>'
      return
    }
    if (last.error) {
      body.innerHTML = '<div class="empty">' + escapeHtml(last.error) + '</div>'
      return
    }

    const warn = Number(store.state.ui.warnThreshold) || 85
    const danger = Number(store.state.ui.dangerThreshold) || 95
    const cpus = s.metrics.map((m) => Number(m.cpu) || 0)
    const mems = s.metrics.map((m) => Number(m.memPercent) || 0)
    const cpuLvl = levelClass(last.cpu, warn, danger)
    const memLvl = levelClass(last.memPercent, warn, danger)

    let disksHtml = ''
    if (last.disks && last.disks.length) {
      disksHtml =
        '<div class="disk-row"><h3>磁盘</h3>' +
        last.disks
          .map((d) => {
            const pct = Number(d.usedPercent ?? d.percent ?? 0)
            const lvl = levelClass(pct, warn, danger)
            return (
              '<div class="disk-item"><div class="lbl"><span>' +
              escapeHtml(d.mount || d.name || '/') +
              '</span><span>' +
              pct.toFixed(1) +
              '%</span></div><div class="bar"><i class="' +
              lvl +
              '" style="width:' +
              Math.min(100, pct) +
              '%"></i></div></div>'
            )
          })
          .join('') +
        '</div>'
    }

    let procHtml = ''
    if (last.top && last.top.length) {
      procHtml =
        '<div class="proc-table"><h3>Top</h3><table><thead><tr>' +
        '<th>PID</th><th>USER</th><th>CPU%</th><th>MEM%</th><th>CMD</th>' +
        '</tr></thead><tbody>' +
        last.top
          .slice(0, 10)
          .map(
            (p) =>
              '<tr><td>' +
              escapeHtml(p.pid) +
              '</td><td>' +
              escapeHtml(p.user || p.username || '') +
              '</td><td>' +
              escapeHtml(p.cpu ?? '') +
              '</td><td>' +
              escapeHtml(p.mem ?? p.memPercent ?? '') +
              '</td><td>' +
              escapeHtml(p.command || p.cmd || '') +
              '</td></tr>'
          )
          .join('') +
        '</tbody></table></div>'
    }

    let netRx = '—'
    let netTx = '—'
    const netRaw = last.net
    if (Array.isArray(netRaw) && netRaw.length) {
      const rx = netRaw.reduce((a, n) => a + (Number(n.rxKbps ?? n.rx) || 0), 0)
      const tx = netRaw.reduce((a, n) => a + (Number(n.txKbps ?? n.tx) || 0), 0)
      netRx = fmtNum(rx)
      netTx = fmtNum(tx)
    } else if (netRaw && typeof netRaw === 'object') {
      netRx = fmtNum(netRaw.rxKbps ?? netRaw.rx)
      netTx = fmtNum(netRaw.txKbps ?? netRaw.tx)
    }

    body.innerHTML =
      '<div class="metric-grid">' +
      '<div class="metric-card"><h3>CPU</h3><div class="val ' +
      cpuLvl +
      '">' +
      (last.cpu != null ? Number(last.cpu).toFixed(1) : '—') +
      '%</div><canvas id="spark-cpu"></canvas></div>' +
      '<div class="metric-card"><h3>内存</h3><div class="val ' +
      memLvl +
      '">' +
      (last.memPercent != null ? Number(last.memPercent).toFixed(1) : '—') +
      '%</div><div style="color:var(--text-3);font-size:10px;margin-top:2px">' +
      fmtBytes(last.memUsed) +
      ' / ' +
      fmtBytes(last.memTotal) +
      '</div><canvas id="spark-mem"></canvas></div>' +
      '<div class="metric-card"><h3>Load</h3><div class="val">' +
      (last.load1 != null ? Number(last.load1).toFixed(2) : '—') +
      '</div></div>' +
      '<div class="metric-card"><h3>Net</h3><div class="val" style="font-size:13px">↓' +
      netRx +
      ' ↑' +
      netTx +
      '</div></div>' +
      '<div class="metric-card"><h3>Uptime</h3><div class="val" style="font-size:13px">' +
      escapeHtml(String(last.uptime ?? '—')) +
      '</div></div>' +
      '</div>' +
      disksHtml +
      procHtml

    const accent = cssGet('--accent', '#5b8cff')
    drawSpark($('spark-cpu'), cpus, accent, warn, danger, last.cpu)
    drawSpark($('spark-mem'), mems, accent, warn, danger, last.memPercent)
  }

  function fmtNum(v) {
    if (v == null || v === '') return '—'
    return String(v)
  }

  function fmtBytes(n) {
    if (n == null || n === 0) return '—'
    const num = Number(n)
    if (!isFinite(num)) return String(n)
    if (num > 1024 * 1024 * 1024) return (num / 1024 / 1024 / 1024).toFixed(1) + 'G'
    if (num > 1024 * 1024) return (num / 1024 / 1024).toFixed(1) + 'M'
    if (num > 1024) return (num / 1024).toFixed(1) + 'K'
    return String(num)
  }

  /* ========== term search（Cmd/Ctrl+F 动态浮层） ========== */
  const termSearch = { el: null, input: null, info: null, visible: false }

  /** 惰性创建搜索浮层 DOM（class 沿用 term-search 命名风格） */
  function ensureTermSearchEl() {
    if (termSearch.el && document.body.contains(termSearch.el)) return termSearch.el
    const wrap = $('term-wrap')
    if (!wrap) return null
    const el = document.createElement('div')
    el.className = 'term-search'
    el.hidden = true
    el.innerHTML =
      '<input type="search" placeholder="搜索终端…" aria-label="搜索终端" />' +
      '<span class="term-search-info" aria-live="polite"></span>' +
      '<button class="icon-btn" data-act="prev" title="上一个" aria-label="上一个">↑</button>' +
      '<button class="icon-btn" data-act="next" title="下一个" aria-label="下一个">↓</button>' +
      '<button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">×</button>'
    wrap.appendChild(el)
    termSearch.el = el
    termSearch.input = el.querySelector('input')
    termSearch.info = el.querySelector('.term-search-info')
    el.onclick = (ev) => {
      const act = ev.target?.closest('[data-act]')?.dataset?.act
      if (act === 'prev') runTermSearch('prev')
      else if (act === 'next') runTermSearch('next')
      else if (act === 'close') closeTermSearch()
    }
    termSearch.input.addEventListener('input', () => runTermSearch('next'))
    termSearch.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        runTermSearch(ev.shiftKey ? 'prev' : 'next')
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        closeTermSearch()
      }
    })
    // 「当前/总数」计数：addon 加载后每次 find 都会回调 { resultIndex, resultCount }
    applySearchCountHook()
    return el
  }

  /** 给当前激活终端挂搜索计数回调（addon 可能尚未注入，每次浮层创建时重挂） */
  function applySearchCountHook() {
    const s = activeSession()
    if (!s?.term?.setOnSearchResults) return
    s.term.setOnSearchResults((r) => {
      if (!termSearch.visible || !termSearch.info) return
      clearTimeout(searchCountTimer)
      const count = r && r.resultCount
      if (!count) {
        termSearch.info.textContent = '无匹配'
        return
      }
      const idx = (r.resultIndex >= 0 ? r.resultIndex : 0) + 1
      termSearch.info.textContent = idx + '/' + count
    })
  }

  function openTermSearch() {
    const s = activeSession()
    if (!s?.term) {
      toast('请先连接终端', 'warn')
      return
    }
    const el = ensureTermSearchEl()
    if (!el) return
    applySearchCountHook()
    el.hidden = false
    termSearch.visible = true
    const q = termSearch.input.value
    if (q) runTermSearch('next')
    else termSearch.info.textContent = s.term.hasSearch?.() ? '' : '基础模式'
    setTimeout(() => termSearch.input?.focus(), 20)
  }

  function closeTermSearch() {
    const s = activeSession()
    if (s?.term?.clearSearch) s.term.clearSearch()
    if (termSearch.el) termSearch.el.hidden = true
    termSearch.visible = false
    clearTimeout(searchCountTimer)
    termFocus()
  }

  /** 「当前/总数」计数看门狗：回调未在窗口内到达则降级为方向箭头，避免停在「…」 */
  let searchCountTimer = null
  function armSearchCountWatchdog(dir) {
    clearTimeout(searchCountTimer)
    searchCountTimer = setTimeout(() => {
      if (termSearch.visible && termSearch.info && termSearch.info.textContent === '…') {
        termSearch.info.textContent = dir === 'prev' ? '↑' : '↓'
      }
    }, 350)
  }

  function runTermSearch(dir) {
    const s = activeSession()
    const q = (termSearch.input?.value || '').trim()
    if (!s?.term || !q) {
      if (termSearch.info) termSearch.info.textContent = ''
      return
    }
    const res =
      dir === 'prev'
        ? s.term.searchPrev(q, { caseSensitive: false })
        : s.term.search(q, { caseSensitive: false })
    if (termSearch.info) {
      // 命中时优先显示「当前/总数」：addon 模式由 onDidChangeResults 异步刷新（350ms 看门狗降级）；
      // 降级模式（无 addon）由 term.js 的 fallbackReport 在 search() 内同步上报计数
      if (res && res.ok) {
        if (s.term.hasSearch?.()) {
          termSearch.info.textContent = '…'
          armSearchCountWatchdog(dir)
        } else if (typeof s.term.setOnSearchResults === 'function') {
          applySearchCountHook() // 确保 fallback 计数回调已挂到当前会话
          termSearch.info.textContent = dir === 'prev' ? '↑' : '↓'
        } else {
          termSearch.info.textContent = dir === 'prev' ? '↑' : '↓'
        }
      } else {
        termSearch.info.textContent = '无匹配'
      }
    }
  }

  /* ========== sftp ========== */
  async function sftpRefresh() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const path = ($('sftp-path')?.value || s.sftp.path || '.').trim() || '.'
    try {
      const res = await api.sftpList(s.sessionId, path)
      // 宿主直接返回 SftpEntry[]；也兼容 { entries|files|list, path }
      let entries
      let resolvedPath = path
      if (Array.isArray(res)) {
        entries = res
      } else {
        entries = (res && (res.entries || res.files || res.list)) || []
        if (res && typeof res.path === 'string' && res.path) resolvedPath = res.path
      }
      s.sftp = {
        path: resolvedPath,
        entries: Array.isArray(entries) ? entries : [],
        error: '',
        selected: s.sftp.selected || '',
      }
    } catch (e) {
      const msg = err(e)
      s.sftp = { ...s.sftp, error: api.hasHostSsh() ? msg : '功能未就绪' }
      toast(s.sftp.error, 'error')
    }
    renderSftp()
  }

  async function sftpDownload() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const name = s.sftp.selected
    if (!name) {
      toast('请先选择文件', 'warn')
      return
    }
    const remote = joinPath(s.sftp.path || '.', name)
    const picked = await api.pickLocalFile({ kind: 'directory', access: 'write' })
    if (!picked?.id) return
    trackTransfer(s.sessionId, 'down', remote)
    try {
      const res = await api.sftpDownload(s.sessionId, remote, picked.id)
      if (res && res.ok === false) throw new Error(res.error || res.message || '下载失败')
      // 宿主若无 ssh.transfer 推送，成功返回时兜底标记完成
      const key = s.sessionId + '|down|' + remote
      if (transfers.has(key)) {
        const t = transfers.get(key)
        if (!t.done && !t.error) {
          t.done = true
          if (!t.total) t.total = t.transferred
          renderTransfers()
          setTimeout(() => {
            transfers.delete(key)
            renderTransfers()
          }, 8000)
        }
      }
      const out = res && (res.localPath || res.path) ? ' → ' + (res.localPath || res.path) : ''
      toast('已下载 ' + name + out, 'success')
    } catch (e) {
      const key = s.sessionId + '|down|' + remote
      if (transfers.has(key)) {
        const t = transfers.get(key)
        t.error = err(e)
        t.done = true
        renderTransfers()
      }
      toast(err(e), 'error')
    }
  }

  async function sftpUpload() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const picked = await api.pickLocalFile({ kind: 'file', access: 'read' })
    if (!picked?.id) return
    const base = picked.name || 'upload.bin'
    const remoteDir = s.sftp.path || '.'
    // 宿主 createWriteStream 需要完整远程文件路径，不能只传目录
    const remotePath = joinPath(remoteDir, base)
    trackTransfer(s.sessionId, 'up', remotePath)
    try {
      const res = await api.sftpUpload(s.sessionId, picked.id, remotePath)
      if (res && res.ok === false) throw new Error(res.error || res.message || '上传失败')
      // 宿主若无 ssh.transfer 推送，成功返回时兜底标记完成
      const key = s.sessionId + '|up|' + remotePath
      if (transfers.has(key)) {
        const t = transfers.get(key)
        if (!t.done && !t.error) {
          t.done = true
          if (!t.total) t.total = t.transferred
          renderTransfers()
          setTimeout(() => {
            transfers.delete(key)
            renderTransfers()
          }, 8000)
        }
      }
      toast('已上传 ' + base, 'success')
      await sftpRefresh()
    } catch (e) {
      const key = s.sessionId + '|up|' + remotePath
      if (transfers.has(key)) {
        const t = transfers.get(key)
        t.error = err(e)
        t.done = true
        renderTransfers()
      }
      toast(err(e), 'error')
    }
  }

  /* —— sftp 增强：新建文件夹 / 重命名 / 删除 / 权限（HOST_LAG 降级） —— */
  /** 统一降级文案：宿主方法缺失时提示更新壳子 */
  function sftpHostLag(e) {
    const msg = err(e)
    if (msg.includes('功能未就绪') || !api.hasHostSsh()) {
      return '功能未就绪（更新壳子后可用）'
    }
    return msg
  }

  async function sftpMkdir() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const name = await promptDialog('新建文件夹', '名称', '')
    if (name == null || !String(name).trim()) return
    const dirName = String(name).trim()
    try {
      const res = await api.sftpMkdir(s.sessionId, joinPath(s.sftp.path || '.', dirName))
      if (res && res.ok === false) throw new Error(res.error || res.message || '创建失败')
      toast('已创建 ' + dirName, 'success')
      await sftpRefresh()
    } catch (e) {
      toast(sftpHostLag(e), 'error')
    }
  }

  async function sftpRename() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const name = s.sftp.selected
    if (!name) {
      toast('请先选择条目', 'warn')
      return
    }
    const next = await promptDialog('重命名', '', name)
    if (next == null || !String(next).trim() || String(next).trim() === name) return
    const newName = String(next).trim()
    try {
      const res = await api.sftpRename(
        s.sessionId,
        joinPath(s.sftp.path || '.', name),
        joinPath(s.sftp.path || '.', newName)
      )
      if (res && res.ok === false) throw new Error(res.error || res.message || '重命名失败')
      s.sftp.selected = newName
      toast('已重命名', 'success')
      await sftpRefresh()
    } catch (e) {
      toast(sftpHostLag(e), 'error')
    }
  }

  async function sftpDelete() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const name = s.sftp.selected
    if (!name) {
      toast('请先选择条目', 'warn')
      return
    }
    const entry = (s.sftp.entries || []).find((e) => e.name === name)
    const isDir = !!(
      entry &&
      (entry.isDir || entry.isDirectory || entry.type === 'dir' || entry.type === 'd')
    )
    // 目录递归删除需二次确认
    let recursive = false
    if (isDir) {
      const ok = await confirmDialog(
        '「' + name + '」是目录，将递归删除其全部内容。继续？',
        { title: '删除目录', okText: '递归删除', danger: true }
      )
      if (!ok) return
      recursive = true
    } else {
      const ok = await confirmDialog('删除「' + name + '」？', {
        title: '删除',
        okText: '删除',
        danger: true,
      })
      if (!ok) return
    }
    try {
      const res = await api.sftpDelete(s.sessionId, joinPath(s.sftp.path || '.', name), recursive)
      if (res && res.ok === false) throw new Error(res.error || res.message || '删除失败')
      if (s.sftp.selected === name) s.sftp.selected = ''
      toast('已删除 ' + name, 'success')
      await sftpRefresh()
    } catch (e) {
      toast(sftpHostLag(e), 'error')
    }
  }

  async function sftpChmod() {
    const s = activeSession()
    if (!s || !s.sessionId) {
      toast('请先连接', 'warn')
      return
    }
    const name = s.sftp.selected
    if (!name) {
      toast('请先选择条目', 'warn')
      return
    }
    const input = await promptDialog('权限（八进制，如 0644 / 0755）', '0644', '0644')
    if (input == null || !String(input).trim()) return
    const mode = String(input).trim()
    if (!/^0?[0-7]{3,4}$/.test(mode)) {
      toast('权限格式无效：请输入 0644 这类八进制', 'warn')
      return
    }
    try {
      const res = await api.sftpChmod(s.sessionId, joinPath(s.sftp.path || '.', name), mode)
      if (res && res.ok === false) throw new Error(res.error || res.message || 'chmod 失败')
      toast('已设置 ' + name + ' → ' + mode, 'success')
      await sftpRefresh()
    } catch (e) {
      toast(sftpHostLag(e), 'error')
    }
  }

  /** SFTP 条目右键菜单（含增强操作；宿主方法未就绪时置灰） */
  function sftpEntryMenuItems(entry) {
    if (!entry) return null
    const s = activeSession()
    const raw = api.raw
    const hasMkdir = typeof raw?.ssh?.sftp?.mkdir === 'function'
    const hasRename = typeof raw?.ssh?.sftp?.rename === 'function'
    const hasDelete = typeof raw?.ssh?.sftp?.delete === 'function'
    const hasChmod = typeof raw?.ssh?.sftp?.chmod === 'function'
    const isDir = !!(entry.isDir || entry.isDirectory || entry.type === 'dir' || entry.type === 'd')
    return [
      {
        primary: true,
        label: '下载' + (isDir ? '（文件 only）' : ''),
        disabled: isDir,
        onAct: () => void sftpDownload(),
      },
      { label: '上传到此目录', onAct: () => void sftpUpload() },
      { sep: true },
      { label: '新建文件夹', disabled: !hasMkdir, onAct: () => void sftpMkdir() },
      { label: '重命名', disabled: !hasRename, onAct: () => void sftpRename() },
      {
        label: '删除' + (isDir ? '（递归）' : ''),
        danger: true,
        disabled: !hasDelete,
        onAct: () => void sftpDelete(),
      },
      { label: '权限…', disabled: !hasChmod, onAct: () => void sftpChmod() },
      { sep: true },
      {
        label: '复制路径',
        onAct: async () => {
          try {
            await api.copyText(joinPath(s?.sftp?.path || '.', entry.name))
            toast('已复制', 'success')
          } catch (e) {
            toast(err(e), 'error')
          }
        },
      },
    ]
  }

  function joinPath(dir, name) {
    if (!dir || dir === '.') return name
    if (dir.endsWith('/')) return dir + name
    return dir + '/' + name
  }

  /* —— 传输进度（宿主 ssh.transfer 事件驱动：文件名 + 百分比 + 字节，done 后淡出） —— */
  const transfers = new Map() // key → { id, name, direction, transferred, total, done, error, ts }

  /** direction 归一化：upload/up → 'up'；download/down → 'down' */
  function normDirection(d) {
    const s = String(d || '').toLowerCase()
    if (s === 'up' || s === 'upload' || s === 'put' || s === 'write') return 'up'
    return 'down'
  }

  function transferKey(payload) {
    const path = String(payload?.path || '')
    return String(payload?.sessionId || '') + '|' + normDirection(payload?.direction) + '|' + path
  }

  function transferBaseName(p) {
    return String(p || '').split('/').filter(Boolean).pop() || String(p || '')
  }

  /** 上传/下载发起时先落一条「排队中」记录，事件到达后无缝衔接 */
  function trackTransfer(sessionId, direction, path) {
    transfers.set(sessionId + '|' + direction + '|' + path, {
      id: store.uid('xfer'),
      name: transferBaseName(path),
      direction,
      transferred: 0,
      total: 0,
      done: false,
      error: '',
      ts: Date.now(),
    })
    renderTransfers()
  }

  /** 处理宿主 ssh.transfer 事件：{ sessionId, direction, path, transferred, total, done?, error? } */
  function onTransferEvent(payload) {
    const d = payload || {}
    if (!d.path) return
    const key = transferKey(d)
    const dir = normDirection(d.direction)
    const cur =
      transfers.get(key) ||
      {
        id: store.uid('xfer'),
        name: transferBaseName(d.path),
        direction: dir,
        total: 0,
        ts: Date.now(),
      }
    cur.direction = dir
    cur.transferred = Number(d.transferred) || 0
    if (d.total) cur.total = Number(d.total)
    cur.done = d.done === true
    cur.error = d.error ? String(d.error) : ''
    cur.ts = Date.now()
    transfers.set(key, cur)
    renderTransfers()
    // done/error 8s 后清理淡出的条目
    if (cur.done || cur.error) {
      setTimeout(() => {
        transfers.delete(key)
        renderTransfers()
      }, 8000)
    }
  }

  /** SFTP 面板内底部浮层（动态 DOM，class 沿用 sftp-* 命名风格） */
  function renderTransfers() {
    const panel = $('panel-sftp')
    if (!panel) return
    let box = document.getElementById('sftp-transfers')
    if (!transfers.size) {
      if (box) box.remove()
      return
    }
    if (!box) {
      box = document.createElement('div')
      box.className = 'sftp-transfers'
      box.id = 'sftp-transfers'
      panel.appendChild(box)
    }
    const items = Array.from(transfers.values()).sort((a, b) => b.ts - a.ts).slice(0, 6)
    box.innerHTML = items
      .map((t) => {
        const pct = t.total > 0 ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0
        const arrow = t.direction === 'up' ? '↑' : '↓'
        const state = t.error
          ? '<span class="xfer-state error">失败</span>'
          : t.done
            ? '<span class="xfer-state ok">完成</span>'
            : '<span class="xfer-state">' + pct + '%</span>'
        return (
          '<div class="xfer-item' +
          (t.done || t.error ? ' done' : '') +
          '" data-xfer="' +
          escapeHtml(t.id) +
          '">' +
          '<div class="xfer-row"><span class="xfer-dir">' +
          arrow +
          '</span><span class="xfer-name" title="' +
          escapeHtml(t.name) +
          '">' +
          escapeHtml(t.name) +
          '</span>' +
          state +
          '<span class="xfer-bytes">' +
          fmtBytes(t.transferred) +
          (t.total > 0 ? ' / ' + fmtBytes(t.total) : '') +
          '</span></div>' +
          '<div class="xfer-bar' +
          (t.error ? ' error' : '') +
          '"><i style="width:' +
          (t.error ? 100 : pct) +
          '%"></i></div>' +
          (t.error ? '<div class="xfer-error">' + escapeHtml(t.error) + '</div>' : '') +
          '</div>'
        )
      })
      .join('')
  }

  function fmtMtime(m) {
    if (m == null || m === '' || m === 0) return ''
    if (typeof m === 'number' && isFinite(m)) {
      const ts = m > 1e12 ? m : m * 1000
      try {
        return new Date(ts).toLocaleString()
      } catch {
        return String(m)
      }
    }
    return String(m)
  }

  function renderSftp() {
    const body = $('sftp-list')
    const pathInput = $('sftp-path')
    const meta = $('sftp-meta')
    const s = activeSession()
    if (!body) return
    if (!s) {
      body.innerHTML = '<div class="empty">无会话</div>'
      return
    }
    if (pathInput && document.activeElement !== pathInput) pathInput.value = s.sftp.path || '.'
    if (meta) {
      meta.textContent =
        s.sftp.error ||
        (s.sftp.entries && s.sftp.entries.length
          ? s.sftp.entries.length + ' 项' + (s.sftp.selected ? ' · 已选 ' + s.sftp.selected : '')
          : '')
    }
    const entries = s.sftp.entries || []
    if (!entries.length) {
      body.innerHTML =
        '<div class="empty">' +
        (s.sftp.error ? escapeHtml(s.sftp.error) : s.sessionId ? '空目录' : '未连接') +
        '</div>'
      return
    }
    body.innerHTML =
      '<table><thead><tr><th>名称</th><th>大小</th><th>时间</th></tr></thead><tbody>' +
      entries
        .map((e, idx) => {
          const isDir = e.isDir || e.isDirectory || e.type === 'dir' || e.type === 'd'
          const selected = s.sftp.selected === e.name
          return (
            '<tr data-idx="' +
            idx +
            '"' +
            (selected ? ' class="selected"' : '') +
            '><td class="name ' +
            (isDir ? 'dir' : '') +
            '"><span class="f-icon">' +
            (isDir ? '▸' : '·') +
            '</span><span>' +
            escapeHtml(e.name) +
            '</span></td><td class="size">' +
            (isDir ? '—' : fmtBytes(e.size)) +
            '</td><td class="mtime">' +
            escapeHtml(fmtMtime(e.mtime ?? e.modifiedAt)) +
            '</td></tr>'
          )
        })
        .join('') +
      '</tbody></table>'
    body.onclick = (ev) => {
      const tr = ev.target.closest('tr[data-idx]')
      if (!tr) return
      const e = entries[Number(tr.dataset.idx)]
      if (!e) return
      const isDir = e.isDir || e.isDirectory || e.type === 'dir' || e.type === 'd'
      s.sftp.selected = e.name
      if (isDir) {
        s.sftp.path = joinPath(s.sftp.path || '.', e.name)
        s.sftp.selected = ''
        void sftpRefresh()
      } else {
        renderSftp()
      }
    }
    // 条目右键：新建文件夹 / 重命名 / 删除 / 权限等增强操作
    bindCtx(body, (ev) => {
      const tr = ev.target.closest('tr[data-idx]')
      if (tr) {
        const e = entries[Number(tr.dataset.idx)]
        if (e) {
          // 右键即选中该条目，后续动作直接作用于它
          s.sftp.selected = e.name
          return sftpEntryMenuItems(e)
        }
      }
      return null
    })
  }

  /* ========== completion（跟随终端输入，不单独命令框） ========== */
  function terminalCommand() {
    const s = activeSession()
    return s?.term?.readCommand?.()?.text || ''
  }

  function getCompletion() {
    if (!completionController) completionController = window.SshCompletion.create({
      getSession: activeSession,
      getSources: () => ({
        shortcuts: window.SshWorkbenchBridge?.completionShortcuts?.(),
        hasCommandRegistry: !!window.SshWorkbenchBridge?.completionShortcuts,
        profileId: activeSession()?.profileId,
        environment: store.findProfile(activeSession()?.profileId)?.env,
        history: store.state.history,
        snippets: store.state.snippets,
        fontSize: store.state.ui.fontSize,
        preferences: store.state.ui.completion,
      }),
      send: (session, data) => api.sshWrite(session.sessionId, data),
      readDirectory: input => api.sftpList(input.sessionId, input.path),
      readCommands: input => api.sshExec(input),
      onStatus: renderHintMeta,
      onError: error => toast(api.errMessage(error), 'error'),
    })
    return completionController
  }

  function runCompletion(force = false) {
    return getCompletion().run(force)
  }

  function renderHintMeta() {
    const meta = $('hint-meta')
    if (!meta) return
    const cmd = terminalCommand()
    const s = activeSession()
    const profile = s ? store.findProfile(s.profileId) : null
    const danger = dict.matchDanger(cmd, profile?.env)
    const bits = []
    if (danger) bits.push('<span class="badge danger">' + escapeHtml(danger.reason) + '</span>')
    if (!hostSshReady && api.raw) bits.push('<span>功能未就绪</span>')
    if (s && s.status !== 'connected' && cmd.trim()) bits.push('<span>未连接</span>')
    meta.dataset.state = bits.length ? 'warning' : 'hint'
    if (s && s.status === 'connected') bits.push('<span>直接在终端输入，回车执行</span>')
    meta.innerHTML = bits.join(' ')
    meta.title = meta.textContent.replace(/\s+/g, ' ').trim()
  }

  async function submitHint(cmdOverride, target = activeSession()) {
    return commandActions.execute(cmdOverride ?? terminalCommand(), target)
  }

  /* ========== left tree ========== */
  function renderLeft() {
    const tree = $('tree')
    if (!tree) return
    const ui = store.state.ui

    const filterRow = $('filter-row')
    if (filterRow) {
      const showFilters =
        document.activeElement === $('search-input') ||
        !!(ui.filterEnv || ui.filterRecent || ui.filterFavorite || ui.filterTag || (ui.search || '').trim())
      if (!showFilters) {
        filterRow.innerHTML = ''
      } else {
        const envNames = { prod: '生产', staging: '预发', dev: '开发' }
        const envs = ['', 'prod', 'staging', 'dev']
        filterRow.innerHTML =
          envs
            .map(
              (e) =>
                '<button class="chip ' +
                (ui.filterEnv === e ? 'active' : '') +
                '" data-filter="env" data-value="' +
                e +
                '">' +
                (envNames[e] || '全部') +
                '</button>'
            )
            .join('') +
          '<button class="chip ' +
          (ui.filterRecent ? 'active' : '') +
          '" data-filter="recent">最近</button>' + '<button class="chip ' + (ui.filterFavorite ? 'active' : '') + '" data-filter="favorite">收藏</button>'
      }
      filterRow.onclick = (ev) => {
        const btn = ev.target.closest('.chip')
        if (!btn) return
        const kind = btn.dataset.filter
        if (kind === 'env') store.setUi({ filterEnv: btn.dataset.value || '' })
        else if (kind === 'recent') store.setUi({ filterRecent: !ui.filterRecent })
        else if (kind === 'favorite') store.setUi({ filterFavorite: !ui.filterFavorite })
        renderLeft()
      }
    }

    const searchInput = $('search-input')
    if (searchInput && document.activeElement !== searchInput) searchInput.value = ui.search || ''

    renderSelBar()

    if (!store.state.profiles.length) {
      tree.innerHTML =
        '<div class="empty">暂无连接<div class="empty-act"><button class="btn sm primary" data-act="empty-new-profile">新建连接</button></div></div>'
    } else {
      const visible = store.state.profiles.filter(store.matchesFilters)
      const ungrouped = visible.filter((p) => !(p.groupId && store.findGroup(p.groupId)))
      const html = []
      html.push(renderGroupNode('', '未分组', ungrouped, 0, null))
      const roots = store.childrenOf('')
      for (const g of roots) html.push(renderGroupNode(g.id, g.name, null, 0, g))
      tree.innerHTML = html.join('') || '<div class="empty">无匹配</div>'
    }

    tree.onclick = onTreeClick
    tree.ondblclick = event => { const card = event.target.closest('[data-profile]'); if (card) void connectProfile(store.findProfile(card.dataset.profile)) }
    tree.onkeydown = event => {
      const card = event.target.closest('[data-profile]'); if (!card) return
      if (event.key === 'Enter') { event.preventDefault(); void connectProfile(store.findProfile(card.dataset.profile)); return }
      const cards = [...tree.querySelectorAll('[data-profile]')], index = cards.indexOf(card)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : event.key === 'ArrowDown' ? Math.min(cards.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : -1
      if (next >= 0) { event.preventDefault(); cards[next].focus(); cards[next].scrollIntoView({ block: 'nearest' }) }
    }

    bindCtx(tree, (ev) => {
      const profileEl = ev.target.closest('[data-profile]')
      if (profileEl) return profileMenuItems(profileEl.dataset.profile)
      const groupEl = ev.target.closest('[data-group]')
      if (groupEl) return groupMenuItems(groupEl.dataset.group)
      return groupMenuItems('')
    })
  }

  function renderGroupNode(id, name, directProfiles, depth, group) {
    const ui = store.state.ui
    const collapsed = !!(ui.collapsedGroups || {})[id || '_root']
    const selected = ui.selectedGroupId === id
    const color = group?.color || ''
    const childGroups = group ? store.childrenOf(group.id) : store.childrenOf('')
    const searching = !!((ui.search || '').trim() || ui.filterEnv || ui.filterRecent || ui.filterFavorite || ui.filterTag)
    const isOpen = searching || !collapsed
    const profiles =
      directProfiles ||
      store.profilesInGroup(id).filter((p) => store.matchesFilters(p))
    const childCount = group
      ? childGroups.length + store.profilesInGroup(id).filter(store.matchesFilters).length
      : profiles.length

    let html =
      '<div class="group-block" data-group="' +
      escapeHtml(id) +
      '"><div class="group-row ' +
      (selected ? 'selected' : '') +
      '" data-act="select-group" data-id="' +
      escapeHtml(id) +
      '" style="padding-left:' +
      (6 + depth * 10) +
      'px"><span class="twisty" data-act="toggle-group" data-id="' +
      escapeHtml(id) +
      '">' +
      (childCount ? (isOpen ? '▾' : '▸') : '·') +
      '</span><span class="group-dot" style="' +
      (color ? 'background:' + escapeHtml(color) : '') +
      '"></span><span class="g-name">' +
      escapeHtml(name) +
      '</span>' +
      (childCount ? '<span class="g-count">' + childCount + '</span>' : '') +
      '</div>'

    if (isOpen) {
      const list = (directProfiles || store.profilesInGroup(id)).filter(store.matchesFilters)
      for (const p of list.slice().sort(store.sortProfiles)) {
        html += profileCardHtml(p, depth + 1)
      }
      if (group) {
        for (const cg of childGroups) {
          html += renderGroupNode(cg.id, cg.name, null, depth + 1, cg)
        }
      }
    }
    html += '</div>'
    return html
  }

  function profileCardHtml(p, depth) {
    const s = Array.from(sessions.values()).find((x) => x.profileId === p.id)
    const selected = store.state.ui.selectedProfileId === p.id
    const colorDot = p.color
      ? '<span class="group-dot" style="background:' + escapeHtml(p.color) + '"></span>'
      : ''
    return (
      '<div class="profile-card ' +
      (selected ? 'selected' : '') +
      '" data-profile="' +
      escapeHtml(p.id) +
      '" tabindex="0" role="button" aria-label="' + escapeHtml(profileTitle(p) + '，按 Enter 连接') + '" title="' + escapeHtml((p.username || '') + '@' + p.host + ':' + (p.port || 22)) + '" style="margin-left:' +
      (6 + depth * 6) +
      'px"><div class="row1">' +
      colorDot +
      '<span class="name">' +
      escapeHtml(profileTitle(p)) +
      '</span>' +
      (s && s.status === 'connected' ? '<span class="badge ok">在线</span>' : '') +
      '</div><div class="host">' +
      escapeHtml((p.username || '') + '@' + (p.host || '') + (p.port && p.port !== 22 ? ':' + p.port : '')) +
      '</div><div class="meta">' +
      (p.env ? '<span class="' + envClass(p.env) + '">' + escapeHtml(p.env) + '</span>' : '') +
      (p.jump?.host ? '<span class="badge">跳板</span>' : '') +
      '</div></div>'
    )
  }

  async function onTreeClick(ev) {
    const t = ev.target
    const actEl = t.closest('[data-act]')
    const card = t.closest('[data-profile]')
    const act = actEl?.dataset?.act
    const id = actEl?.dataset?.id

    if (t.dataset?.act === 'empty-new-profile' || t.dataset?.act === 'empty-new') {
      openProfileForm(null)
      return
    }

    if (act === 'toggle-group') {
      ev.stopPropagation()
      const collapsed = { ...(store.state.ui.collapsedGroups || {}) }
      const key = id || '_root'
      collapsed[key] = !collapsed[key]
      store.setUi({ collapsedGroups: collapsed })
      renderLeft()
      return
    }
    if (act === 'select-group') {
      store.setUi({ selectedGroupId: id || '', selectedProfileId: '' })
      renderLeft()
      renderTopStatus()
      updateFab()
      return
    }

    if (card) {
      store.setUi({ selectedProfileId: card.dataset.profile })
      document.querySelectorAll('#tree [data-profile]').forEach(row => row.classList.toggle('selected', row.dataset.profile === card.dataset.profile))
      renderSelBar()
      renderTopStatus()
      updateFab()
    }
  }

  /* ========== profile form ========== */
  let formMode = null
  let formProfileId = null

  function openProfileForm(profile) {
    formMode = profile ? 'edit' : 'create'
    formProfileId = profile ? profile.id : null
    const p = profile || {
      id: '',
      name: '',
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      privateKeyHint: '',
      secretRef: '',
      jump: {},
      keepAliveSec: 30,
      timeoutMs: 20000,
      term: 'xterm-256color',
      cols: 120,
      rows: 32,
      env: 'dev',
      color: '',
      groupId: store.state.ui.selectedGroupId || '',
      note: '',
      fingerprintPolicy: 'tofu',
    }

    $('form-title').textContent = profile ? '编辑连接' : '新建连接'
    $('f-name').value = p.name || ''
    $('f-host').value = p.host || ''
    $('f-port').value = p.port || 22
    $('f-username').value = p.username || ''
    $('f-auth').value = p.authType || 'password'
    setKeyField($('f-keypath'), p)
    $('f-proxy-type').value = p.proxy?.type || ''
    $('f-proxy-host').value = p.proxy?.host || ''
    $('f-proxy-port').value = p.proxy?.port || 1080
    $('f-proxy-user').value = p.proxy?.username || ''
    $('f-proxy-password').value = ''
    updateProxyFields(p)
    $('f-tags').value = (p.tags || []).join(', ')
    $('f-favorite').checked = !!p.favorite
    $('f-jumps').value = (p.jumps || []).map(hop => store.state.profiles.find(x => x.host === hop.host && x.username === hop.username && Number(x.port || 22) === Number(hop.port || 22))?.name || `${hop.username}@${hop.host}:${hop.port || 22}`).join('\n')
    $('f-password').value = ''
    $('f-passphrase').value = ''
    $('f-env').value = p.env || 'dev'
    setColorValue(p.color || '')
    $('f-note').value = p.note || ''
    $('f-keepalive').value = p.keepAliveSec || 30
    $('f-timeout').value = p.timeoutMs || 20000
    $('f-term').value = p.term || 'xterm-256color'
    $('f-cols').value = p.cols || 120
    $('f-rows').value = p.rows || 32
    $('f-fp').value = p.fingerprintPolicy || 'tofu'
    $('f-form-error').classList.remove('show')
    $('form-test-status').textContent = ''
    const adv = $('adv-block')
    if (adv) adv.open = false

    updateSecretState(p)
    updateAuthFields()
    const gid = p.groupId || ''
    $('f-group').dataset.former = gid
    setGroupSelectValue(gid)
    initJumpFormFields(p.jump || null)
    $('form-root').classList.add('show')
    // 回填走原生 .value，kit 触发器标签需要显式同步
    syncSelectLabels()
  }

  function updateSecretState(p) {
    const el = $('secret-state')
    const hasRef = !!(p && p.secretRef)
    el.innerHTML =
      (hasRef ? '<span class="badge ok">密码已保存</span>' : '<span class="badge">未保存密码</span>') +
      (hasRef
        ? ' <button type="button" class="btn sm danger" id="btn-clear-secret">清除</button>'
        : '')
    const clearBtn = $('btn-clear-secret')
    if (clearBtn) {
      clearBtn.onclick = async () => {
        const prof = formProfileId ? store.findProfile(formProfileId) : null
        if (prof?.secretRef) {
          try {
            await api.vaultRemove(prof.secretRef)
          } catch {
            /* ignore */
          }
          store.upsertProfile({ ...prof, secretRef: undefined })
          updateSecretState(store.findProfile(formProfileId))
        }
      }
    }
  }

  function updateAuthFields() {
    const auth = $('f-auth').value
    $('f-keypath-wrap').style.display = auth === 'key' ? '' : 'none'
    $('f-password-wrap').style.display = auth === 'password' ? '' : 'none'
    $('f-passphrase-wrap').style.display = auth === 'key' ? '' : 'none'
    updateJumpAuthFields()
  }

  function updateProxyFields(profile) {
    $('f-proxy-fields').hidden = !$('f-proxy-type').value
    const current = profile || (formProfileId ? store.findProfile(formProfileId) : null)
    const root = $('proxy-secret-state')
    root.replaceChildren()
    const text = document.createElement('span'); text.textContent = current?.proxy?.secretRef ? '代理密码已保存' : '未保存代理密码'
    root.append(text)
    if (current?.proxy?.secretRef) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn sm danger'; clear.textContent = '清除代理密码'
      clear.onclick = async () => {
        try {
          await api.vaultRemove(current.proxy.secretRef)
          const latest = store.findProfile(current.id)
          if (latest) store.upsertProfile({ ...latest, proxy: { ...latest.proxy, secretRef: undefined } })
          updateProxyFields()
        } catch (error) { toast('清除失败：' + err(error), 'error') }
      }
      root.append(clear)
    }
  }

  // Saving and testing share the same connection draft so their route/auth never diverge.
  function readConnectionDraft(id, existing) {
    const username = $('f-username').value.trim(), authType = $('f-auth').value
    const jumpNames = $('f-jumps').value.split('\n').map(x => x.trim()).filter(Boolean)
    const jumps = jumpNames.map(name => {
      const item = store.state.profiles.find(p => p.id !== id && p.name === name) || existing?.jumps?.find(h => `${h.username}@${h.host}:${h.port || 22}` === name)
      return item ? { host: item.host, port: item.port, username: item.username, authType: item.authType, privateKeyHandleId: item.privateKeyHandleId, privateKeyHint: item.privateKeyHint, secretRef: item.secretRef } : null
    })
    if (jumps.length > 8 || jumps.some(x => !x)) throw new Error('跳板链最多 8 层，每行必须匹配一个已有连接名称。')
    let proxy
    const type = $('f-proxy-type').value
    if (type) {
      const host = $('f-proxy-host').value.trim(), port = Number($('f-proxy-port').value), proxyUser = $('f-proxy-user').value.trim()
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请填写代理主机和有效端口（1–65535）。')
      const old = existing?.proxy
      const sameCredentialScope = old?.host === host && old?.port === port && old?.type === type && old?.username === proxyUser
      proxy = { type, host, port, username: proxyUser, secretRef: proxyUser && sameCredentialScope ? old.secretRef : undefined }
    }
    return {
      id, host: $('f-host').value.trim(), port: Number($('f-port').value) || 22, username, authType,
      secretRef: (existing?.authType || 'password') === authType ? existing?.secretRef : undefined,
      privateKeyHandleId: $('f-keypath').dataset.handleId || undefined, privateKeyHint: $('f-keypath').value || undefined,
      keepAliveSec: Number($('f-keepalive').value) || 30, timeoutMs: Number($('f-timeout').value) || 20000,
      term: $('f-term').value.trim() || 'xterm-256color', cols: Number($('f-cols').value) || 120, rows: Number($('f-rows').value) || 32,
      fingerprintPolicy: $('f-fp').value || 'tofu', jump: currentJumpDraft(username, existing?.jump?.secretRef) || undefined,
      jumps: jumps.length ? jumps : undefined, proxy,
    }
  }

  async function completePayloadCredentials(payload) {
    const keyTargets = [payload, ...(payload.jumps?.length ? payload.jumps : payload.jump ? [payload.jump] : [])]
    for (const target of keyTargets) {
      delete target.privateKeyPath; delete target.agentPath
      if (target.authType !== 'key' || api.hasLocalFileHandle(target.privateKeyHandleId)) continue
      toast(`请选择并授权 ${target.username}@${target.host} 使用的私钥文件`)
      const picked = await api.pickLocalFile({ kind: 'file', access: 'read' })
      if (!picked?.id) return false
      target.privateKeyHandleId = picked.id
      const saved = store.state.profiles.find(p => p.id === target.profileId || (p.host === target.host && p.username === target.username && Number(p.port || 22) === Number(target.port || 22)))
      if (saved) { saved.privateKeyHandleId = picked.id; saved.privateKeyHint = picked.displayPath || picked.name }
    }
    if ((payload.authType || 'password') === 'password' && !payload.secretRef && !payload.password && !payload.ephemeralSecret) {
      const secret = await promptDialog('登录密码', payload.username + '@' + payload.host, '', { secret: true, note: '仅本次使用，不保存' })
      if (!secret) return false
      payload.ephemeralSecret = secret
    }
    for (const hop of payload.jumps?.length ? payload.jumps : payload.jump ? [payload.jump] : []) {
      if ((hop.authType || 'password') === 'password' && !hop.secretRef && !hop.ephemeralSecret) {
        const secret = await promptDialog('跳板密码', hop.username + '@' + hop.host, '', { secret: true, note: '仅本次使用，不保存' })
        if (!secret) return false
        hop.ephemeralSecret = secret
      }
    }
    if (payload.proxy?.username && !payload.proxy.secretRef && !payload.proxy.ephemeralSecret) {
      const secret = await promptDialog('代理密码', payload.proxy.username + '@' + payload.proxy.host, '', { secret: true, note: '仅本次使用，不保存' })
      if (!secret) return false
      payload.proxy.ephemeralSecret = secret
    }
    return true
  }

  function updateJumpAuthFields() {
    const auth = $('f-jump-auth')?.value || 'password'
    const wrap = $('f-jump-keypath-wrap')
    if (wrap) wrap.style.display = auth === 'key' ? '' : 'none'
  }

  /* ========== 颜色色卡 ========== */
  const COLOR_SWATCHES = [
    '#5b8cff', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
    '#ec4899', '#f43f5e', '#ef4444', '#f97316', '#f59e0b',
    '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
    '#64748b',
  ]

  function normalizeHexColor(hex) {
    const v = String(hex || '').trim()
    if (!v) return ''
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase()
    }
    return ''
  }

  function setColorValue(hex) {
    const input = $('f-color')
    if (!input) return
    const norm = normalizeHexColor(hex)
    input.value = hex || norm || ''
    const native = $('f-color-native')
    if (native && norm) native.value = norm
    renderColorSwatches()
  }

  function renderColorSwatches() {
    const wrap = $('f-color-swatches')
    if (!wrap) return
    const cur = normalizeHexColor($('f-color')?.value)
    wrap.innerHTML = COLOR_SWATCHES.map((c) => {
      const active = c === cur ? ' active' : ''
      return (
        '<button type="button" class="swatch' +
        active +
        '" data-color="' +
        c +
        '" style="background:' +
        c +
        '" title="' +
        c +
        '" aria-label="' +
        c +
        '"></button>'
      )
    }).join('')
    wrap.onclick = (ev) => {
      const btn = ev.target.closest('.swatch')
      if (!btn) return
      const next = btn.dataset.color
      const curNow = normalizeHexColor($('f-color')?.value)
      setColorValue(curNow === next ? '' : next)
    }
  }

  /* ========== 自定义下拉（挂 body，避免 modal overflow 裁切原生 select） ========== */
  const GROUP_NEW_SENTINEL = '__new_group__'
  const JUMP_MANUAL_SENTINEL = '__manual_jump__'
  let activeDropdown = null

  function closeDropdown() {
    if (!activeDropdown) return
    try {
      activeDropdown.el.remove()
    } catch {
      /* ignore */
    }
    activeDropdown.trigger?.classList.remove('open')
    activeDropdown.trigger?.setAttribute('aria-expanded', 'false')
    activeDropdown = null
  }

  function openDropdown(trigger, items, onSelect, currentValue) {
    if (!trigger) return
    if (activeDropdown && activeDropdown.trigger === trigger) {
      closeDropdown()
      return
    }
    closeDropdown()
    const el = document.createElement('div')
    el.className = 'cs-dropdown'
    el.setAttribute('role', 'listbox')
    if (!items.length) {
      el.innerHTML = '<div class="cs-option cs-empty">暂无选项</div>'
    } else {
      el.innerHTML = items
        .map((it) => {
          const selected = String(it.id) === String(currentValue ?? '') ? ' selected' : ''
          const color = it.color
            ? '<span class="cs-dot" style="background:' + escapeHtml(it.color) + '"></span>'
            : ''
          const hint = it.hint
            ? '<span class="cs-opt-hint">' + escapeHtml(it.hint) + '</span>'
            : ''
          return (
            '<div class="cs-option' +
            selected +
            '" role="option" data-id="' +
            escapeHtml(String(it.id)) +
            '" data-action="' +
            escapeHtml(it.action || '') +
            '">' +
            color +
            '<span class="cs-opt-label">' +
            escapeHtml(it.label) +
            '</span>' +
            hint +
            '</div>'
          )
        })
        .join('')
    }
    document.body.appendChild(el)
    const rect = trigger.getBoundingClientRect()
    const panelW = Math.max(rect.width, 160)
    const maxW = Math.min(Math.max(panelW, 200), Math.max(180, window.innerWidth - 16))
    el.style.minWidth = Math.min(panelW, maxW) + 'px'
    el.style.maxWidth = maxW + 'px'
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - maxW - 8))
    el.style.left = left + 'px'
    const estH = Math.min(280, items.length * 34 + 8)
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    if (spaceBelow >= Math.min(estH, 160) || spaceBelow >= spaceAbove) {
      el.style.top = Math.min(rect.bottom + 4, window.innerHeight - 40) + 'px'
      el.style.maxHeight = Math.max(96, spaceBelow) + 'px'
    } else {
      el.style.bottom = Math.max(8, window.innerHeight - rect.top + 4) + 'px'
      el.style.maxHeight = Math.max(96, spaceAbove) + 'px'
    }
    trigger.classList.add('open')
    trigger.setAttribute('aria-expanded', 'true')
    activeDropdown = { el, trigger }

    el.addEventListener('click', (ev) => {
      const opt = ev.target.closest('.cs-option')
      if (!opt || opt.classList.contains('cs-empty')) return
      const id = opt.dataset.id || ''
      const action = opt.dataset.action || ''
      closeDropdown()
      if (typeof onSelect === 'function') onSelect(id, action)
    })
  }

  document.addEventListener('pointerdown', (ev) => {
    if (!activeDropdown) return
    if (activeDropdown.el.contains(ev.target)) return
    if (activeDropdown.trigger?.contains(ev.target)) return
    closeDropdown()
  })
  window.addEventListener('blur', () => closeDropdown())
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeDropdown()
  })

  /**
   * 原生 select 增强：隐藏原生控件、代之以 .cs-trigger 自定义下拉，
   * 消除 Chromium 原生弹层遮挡选项/深色下白底白字的问题。
   * 通过覆盖实例 value 属性 + 派发 change，保持既有 .value 读写与监听完全兼容。
   */
  /* ========== 下拉：原生 select 由 plugin-kit upgradeSelects 统一升级 ==========
     kit 在载入时隐藏原生 select 并生成 .pk-select 触发器；.value 写入与 change 事件
     契约不变。动态写入 value 后调用 window.PluginKit?.upgradeSelects() 同步选中标签。 */
  function syncSelectLabels() {
    try {
      window.PluginKit?.upgradeSelects?.()
    } catch {
      /* kit 未就绪时静默：label 由下次 DOM 变化的 MutationObserver 兜底 */
    }
  }

  function groupLabelFor(id) {
    if (!id) return '未分组'
    if (id === GROUP_NEW_SENTINEL) return '＋ 新建分组…'
    const g = store.findGroup(id)
    return g ? g.name : '未分组'
  }

  function setGroupSelectValue(id) {
    const btn = $('f-group')
    if (!btn) return
    const val = id || ''
    btn.dataset.value = val
    btn.dataset.former = val
    const lab = btn.querySelector('.cs-label')
    if (lab) lab.textContent = groupLabelFor(val)
  }

  function groupSelectItems() {
    const flat = [{ id: '', label: '未分组', hint: '' }]
    const walk = (parentId, depth) => {
      for (const g of store.childrenOf(parentId)) {
        flat.push({
          id: g.id,
          label: '　'.repeat(depth) + g.name,
          hint: '',
          color: g.color || '',
        })
        walk(g.id, depth + 1)
      }
    }
    walk('', 0)
    flat.push({ id: GROUP_NEW_SENTINEL, label: '＋ 新建分组…', hint: '', action: 'new-group' })
    return flat
  }

  function renderGroupSelect() {
    const btn = $('f-group')
    if (!btn) return
    setGroupSelectValue(btn.dataset.former || btn.dataset.value || '')
  }

  async function handleGroupSelect(id) {
    if (id === GROUP_NEW_SENTINEL) {
      const former = $('f-group')?.dataset.former || ''
      const name = await promptDialog('新建分组', '名称', '')
      if (!name || !name.trim()) {
        setGroupSelectValue(former)
        return
      }
      const trimmed = name.trim()
      const dup = store.state.groups.find((g) => g.name === trimmed)
      if (dup) {
        toast('分组已存在，已选中', 'warn')
        setGroupSelectValue(dup.id)
        return
      }
      const group = {
        id: store.uid('grp'),
        name: trimmed,
        parentId: '',
        color: '',
        sort: store.state.groups.length,
        collapsed: false,
      }
      store.upsertGroup(group)
      renderLeft()
      setGroupSelectValue(group.id)
      toast('已新建分组「' + trimmed + '」', 'success')
      return
    }
    setGroupSelectValue(id)
  }

  /* ========== 跳板机：从已有连接选择 + 手动微调 ========== */
  function setJumpSelectValue(id, label) {
    const btn = $('f-jump-profile')
    if (!btn) return
    btn.dataset.value = id || ''
    const lab = btn.querySelector('.cs-label')
    if (lab) lab.textContent = label || '不使用跳板'
  }

  function clearJumpFields() {
    if ($('f-jump-host')) $('f-jump-host').value = ''
    if ($('f-jump-port')) $('f-jump-port').value = 22
    if ($('f-jump-user')) $('f-jump-user').value = ''
    if ($('f-jump-auth')) $('f-jump-auth').value = 'password'
    setKeyField($('f-jump-keypath'), {})
    updateJumpAuthFields()
    syncSelectLabels()
  }

  function fillJumpFromProfile(jp) {
    if (!jp) return
    $('f-jump-host').value = jp.host || ''
    $('f-jump-port').value = jp.port || 22
    $('f-jump-user').value = jp.username || ''
    const auth = jp.authType || (jp.privateKeyHandleId || jp.privateKeyHint ? 'key' : 'password')
    $('f-jump-auth').value = auth
    setKeyField($('f-jump-keypath'), jp)
    updateJumpAuthFields()
    syncSelectLabels()
  }

  function matchJumpProfile(jump) {
    if (!jump || !jump.host) return null
    if (jump.profileId) {
      const byId = store.findProfile(jump.profileId)
      if (byId && byId.id !== formProfileId) return byId
    }
    return (
      store.state.profiles.find(
        (p) =>
          p.id !== formProfileId &&
          p.host === jump.host &&
          (Number(p.port) || 22) === (Number(jump.port) || 22) &&
          (!jump.username || p.username === jump.username)
      ) || null
    )
  }

  function initJumpFormFields(jump) {
    const matched = matchJumpProfile(jump)
    if (!jump || !jump.host) {
      setJumpSelectValue('', '不使用跳板')
      clearJumpFields()
      return
    }
    $('f-jump-host').value = jump.host || ''
    $('f-jump-port').value = jump.port || 22
    $('f-jump-user').value = jump.username || ''
    $('f-jump-auth').value = jump.authType || (jump.privateKeyHandleId || jump.privateKeyHint ? 'key' : 'password')
    setKeyField($('f-jump-keypath'), jump)
    updateJumpAuthFields()
    syncSelectLabels()
    if (matched) setJumpSelectValue(matched.id, matched.name || '跳板连接')
    else setJumpSelectValue(JUMP_MANUAL_SENTINEL, '手动填写')
  }

  function jumpSelectItems() {
    const items = [
      { id: '', label: '不使用跳板', hint: '' },
      { id: JUMP_MANUAL_SENTINEL, label: '手动填写…', hint: '' },
    ]
    for (const p of store.state.profiles) {
      if (p.id === formProfileId) continue
      const hint = (p.username || '') + '@' + (p.host || '')
      items.push({ id: p.id, label: p.name || p.host || p.id, hint, color: p.color || '' })
    }
    return items
  }

  function handleJumpSelect(id) {
    if (id === '') {
      setJumpSelectValue('', '不使用跳板')
      clearJumpFields()
      return
    }
    if (id === JUMP_MANUAL_SENTINEL) {
      setJumpSelectValue(JUMP_MANUAL_SENTINEL, '手动填写')
      return
    }
    const jp = store.findProfile(id)
    if (!jp) {
      setJumpSelectValue('', '不使用跳板')
      clearJumpFields()
      return
    }
    setJumpSelectValue(jp.id, jp.name || jp.host)
    fillJumpFromProfile(jp)
  }

  function currentJumpDraft(usernameFallback, fallbackSecretRef) {
    const host = $('f-jump-host')?.value.trim() || ''
    if (!host) return null
    const selected = $('f-jump-profile')?.dataset.value || ''
    const jp = selected && selected !== JUMP_MANUAL_SENTINEL ? store.findProfile(selected) : null
    return {
      profileId: jp?.id || undefined,
      host,
      port: Number($('f-jump-port')?.value) || jp?.port || 22,
      username: $('f-jump-user')?.value.trim() || jp?.username || usernameFallback || '',
      authType: $('f-jump-auth')?.value || jp?.authType || (jp?.privateKeyHandleId || jp?.privateKeyHint ? 'key' : 'password'),
      privateKeyHandleId: $('f-jump-keypath')?.dataset.handleId || undefined,
      privateKeyHint: $('f-jump-keypath')?.value || undefined,
      secretRef: jp?.secretRef || fallbackSecretRef || undefined,
    }
  }

  function setKeyField(inputEl, profile) {
    if (!inputEl) return
    inputEl.value = profile.privateKeyHint || profile.privateKeyPath || ''
    inputEl.dataset.handleId = api.hasLocalFileHandle(profile.privateKeyHandleId) ? profile.privateKeyHandleId : ''
  }

  async function browseLocalFile(inputEl) {
    try {
      const picked = await api.pickLocalFile({ kind: 'file', access: 'read' })
      if (picked?.id && inputEl) {
        inputEl.value = picked.displayPath || picked.name
        inputEl.dataset.handleId = picked.id
        return picked.id
      }
    } catch (error) { toast(err(error), 'error') }
    return null
  }

  async function saveProfileForm() {
    const errEl = $('f-form-error')
    const name = $('f-name').value.trim()
    const host = $('f-host').value.trim()
    const username = $('f-username').value.trim()
    const env = $('f-env').value
    if (!name || !host || !username) {
      errEl.textContent = '名称 / 主机 / 用户名必填'
      errEl.classList.add('show')
      return
    }
    if (env === 'prod') {
      const dup = store.state.profiles.find(
        (p) => p.id !== formProfileId && p.env === 'prod' && p.name === name
      )
      if (dup) {
        const cont = await confirmDialog('生产环境已有同名连接，仍要保存？', {
          title: '名称冲突',
          okText: '仍要保存',
        })
        if (!cont) return
      }
    }

    const existing = formProfileId ? store.findProfile(formProfileId) : null
    const id = formProfileId || store.uid('prof')
    const authType = $('f-auth').value
    const groupId = $('f-group').dataset.value || ''
    if (groupId === GROUP_NEW_SENTINEL) {
      errEl.textContent = '请先完成分组选择'
      errEl.classList.add('show')
      return
    }

    let connection
    try { connection = readConnectionDraft(id, existing) }
    catch (error) { errEl.textContent = err(error); errEl.classList.add('show'); return }
    const profile = {
      ...(existing || {}),
      id,
      name,
      ...connection,
      env,
      tags: [...new Set($('f-tags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean))],
      favorite: $('f-favorite').checked,
      color: normalizeHexColor($('f-color').value) || undefined,
      groupId,
      note: $('f-note').value.trim() || '',
      fingerprintPolicy: $('f-fp').value || 'tofu',
      lastConnectedAt: existing?.lastConnectedAt,
    }

    try {
      const proxyPassword = $('f-proxy-password').value
      if (profile.proxy?.username && proxyPassword) {
        if (!api.hasVault()) throw new Error('功能未就绪，无法保存代理密码')
        const result = await api.vaultSet('profile:' + id + ':proxy', proxyPassword)
        if (!result.secretRef) throw new Error('代理密码保存失败')
        profile.proxy.secretRef = result.secretRef
      }
      if (authType === 'password') {
        const pw = $('f-password').value
        if (pw) {
          if (!api.hasVault()) {
            errEl.textContent = '功能未就绪，无法保存密码'
            errEl.classList.add('show')
            return
          }
          const { secretRef } = await api.vaultSet('profile:' + id + ':auth', pw)
          if (!secretRef) throw new Error('密码保存失败')
          // 只存 secretRef，不落明文
          profile.secretRef = secretRef
        }
      } else if (authType === 'key') {
        const pp = $('f-passphrase').value
        if (pp) {
          if (!api.hasVault()) {
            errEl.textContent = '功能未就绪，无法保存密钥口令'
            errEl.classList.add('show')
            return
          }
          const { secretRef } = await api.vaultSet('profile:' + id + ':auth', pp)
          if (!secretRef) throw new Error('密钥口令保存失败')
          profile.secretRef = secretRef
        }
      }
    } catch (e) {
      const msg = err(e)
      if (isPerm(e)) errEl.textContent = '功能未就绪：无保存密码权限'
      else if (msg.includes('功能未就绪')) errEl.textContent = msg
      else errEl.textContent = '密码保存失败：' + msg
      errEl.classList.add('show')
      return
    }

    delete profile.password
    delete profile.passphrase

    store.upsertProfile(profile)
    closeDropdown()
    $('form-root').classList.remove('show')
    store.setUi({ selectedProfileId: id })
    renderLeft()
    renderTopStatus()
    updateFab()
    toast(formMode === 'edit' ? '已保存' : '已创建', 'success')
  }

  /* ========== drawer body ========== */
  function renderRight() {
    const body = $('right-body')
    if (!body) return
    const tab = store.state.ui.rightTab || 'history'
    document.querySelectorAll('.drawer-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab)
    })
    const scopeEl = $('right-scope')
    if (scopeEl) {
      // kit upgradeSelects 已接管显示：原生 select 常驻隐藏，显隐切换作用在兄弟 .pk-select 包裹层
      // （kit 把包裹层插在 select 之后：insertAdjacentElement('afterend')，故不能用 closest）
      const next = scopeEl.nextElementSibling
      const scopeWrap = next?.classList?.contains('pk-select') ? next : null
      if (scopeWrap) scopeWrap.style.display = tab === 'history' ? '' : 'none'
      else scopeEl.style.display = tab === 'history' ? '' : 'none'
    }

    if (tab === 'snippets') {
      const q = ($('right-search')?.value || '').trim().toLowerCase()
      const list = store.state.snippets
        .filter(
          (s) =>
            !q ||
            ((s.title || '') + ' ' + (s.command || '') + ' ' + (s.tags || []).join(''))
              .toLowerCase()
              .includes(q)
        )
        .sort(
          (a, b) =>
            (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.sort || 0) - (b.sort || 0)
        )
      body.innerHTML =
        list
          .map(
            (s) =>
              '<div class="snip-item" data-snip="' +
              escapeHtml(s.id) +
              '" title="右键操作"><div class="cmd">' +
              escapeHtml(s.command) +
              '</div><div class="meta"><span>' +
              escapeHtml(s.title || '') +
              '</span>' +
              (s.tags || []).map((t) => '<span>#' + escapeHtml(t) + '</span>').join('') +
              '</div></div>'
          )
          .join('') || '<div class="empty">暂无常用</div>'
    } else {
      const scope = store.state.ui.historyScope || 'current'
      const q = ($('right-search')?.value || store.state.ui.historyQuery || '').trim()
      let list = store.state.history
      const pid = activeSession()?.profileId
      if (scope === 'current' && pid) list = list.filter((h) => h.profileId === pid)
      if (q) {
        const lower = q.toLowerCase()
        list = list.filter((h) => (h.command || '').toLowerCase().includes(lower))
      }
      body.innerHTML =
        list
          .slice(0, 200)
          .map(
            (h) =>
              '<div class="hist-item" data-hist="' +
              escapeHtml(h.id) +
              '" title="右键操作"><div class="cmd">' +
              escapeHtml(h.command || '') +
              '</div><div class="meta"><span>' +
              fmtRelTime(h.ts) +
              '</span></div></div>'
          )
          .join('') || '<div class="empty">暂无历史</div>'
    }
  }

  async function fillHint(cmd, target = activeSession()) {
    store.setUi({ centerTab: 'term' })
    renderCenterTabs()
    window.dispatchEvent(new Event('ssh-activate-terminal'))
    return commandActions.insert(cmd, target)
  }

  async function runHint(cmd, target = activeSession()) {
    window.dispatchEvent(new Event('ssh-activate-terminal'))
    return submitHint(cmd, target)
  }

  /* ========== center views ========== */
  function renderCenterTabs() {
    const tab = store.state.ui.centerTab || 'term'
    const chip = $('view-chip')
    const label = $('view-chip-label')
    $('panel-term').classList.toggle('active', tab === 'term')
    $('panel-metrics').classList.toggle('active', tab === 'metrics')
    $('panel-sftp').classList.toggle('active', tab === 'sftp')
    if (chip) {
      if (tab === 'term') {
        chip.hidden = true
      } else {
        chip.hidden = false
        if (label) label.textContent = tab === 'metrics' ? '监控' : 'SFTP'
      }
    }
    if (tab === 'term') {
      const s = activeSession()
      if (s?.term) s.term.fit && s.term.fit()
    }
    if (tab === 'metrics') renderMetrics()
    if (tab === 'sftp') renderSftp()
    store.setUi({ centerTab: tab })
  }

  function renderSessionTabs() {
    const el = $('session-tabs')
    if (!el) return
    el.setAttribute('role', 'tablist'); el.setAttribute('aria-label', 'SSH 会话')
    let html = ''
    for (const s of sessions.values()) {
      const p = store.findProfile(s.profileId)
      const title = s.title || (p ? profileTitle(p) : s.profileId)
      html +=
        '<div class="session-tab ' +
        (s.tabId === activeSessionId ? 'active' : '') +
        '" draggable="true" data-tab="' +
        escapeHtml(s.tabId) +
        '" role="tab" tabindex="' + (s.tabId === activeSessionId ? '0' : '-1') + '" aria-selected="' + (s.tabId === activeSessionId) + '" title="' + escapeHtml(title + ' · ' + (p ? p.username + '@' + p.host : s.profileId) + ' · ' + statusLabel(s.status)) + '"><span class="status-dot ' +
        escapeHtml(s.status) +
        '"></span><span class="title">' +
        escapeHtml(title) +
        '</span>' + (s.pinned ? '<span class="wb-tab-pinned" title="已固定 · 右键取消固定" aria-label="已固定">固定</span>' : '<button class="close-x" data-close="' +
        escapeHtml(s.tabId) +
        '" title="关闭">×</button>') + '</div>'
    }
    html += '<div class="wb-session-actions"><button data-terminal-command="split-horizontal" title="左右分屏">左右分屏</button><button data-terminal-command="split-vertical" title="上下分屏">上下</button><button data-terminal-command="unsplit" title="合并分屏">合并</button></div>'
    el.innerHTML = html
    el.querySelectorAll('[data-tab]').forEach(tab => {
      tab.onkeydown = event => {
        if (event.target !== tab) return
        const tabs = [...el.querySelectorAll('[data-tab]')], index = tabs.indexOf(tab)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1
        if (next >= 0) { event.preventDefault(); setActiveTab(tabs[next].dataset.tab); el.querySelector('[aria-selected="true"]')?.focus() }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveTab(tab.dataset.tab) }
      }
      tab.ondragstart = event => { event.dataTransfer.setData('application/x-enest-ssh-tab', tab.dataset.tab); event.dataTransfer.effectAllowed = 'move' }
      tab.ondragover = event => { if (event.dataTransfer.types.includes('application/x-enest-ssh-tab')) event.preventDefault() }
      tab.ondrop = event => { event.preventDefault(); const from = event.dataTransfer.getData('application/x-enest-ssh-tab'), target = tab.dataset.tab; if (!sessions.has(from) || from === target) return; const order = [...sessions.keys()].filter(id => id !== from); order.splice(order.indexOf(target), 0, from); const values = order.map(id => sessions.get(id)); sessions.clear(); for (const value of values) sessions.set(value.tabId, value); orderPinnedTabs(); persistWorkspace(); renderSessionTabs() }
    })
    el.onclick = (ev) => {
      const action = ev.target.closest('[data-terminal-command]'); if (action) { window.dispatchEvent(new CustomEvent('ssh-terminal-command', { detail: action.dataset.terminalCommand })); return }
      const close = ev.target.closest('[data-close]')
      if (close) {
        void closeTab(close.dataset.close)
        return
      }
      const tab = ev.target.closest('[data-tab]')
      if (tab) {
        setActiveTab(tab.dataset.tab)
        store.setUi({ centerTab: 'term' })
        renderCenterTabs()
      }
    }
  }

  /* ========== import / export ========== */
  async function exportAssets(stripSecrets) {
    const profiles = store.state.profiles.map((p) => {
      const copy = store.clone(p)
      if (stripSecrets !== false) {
        delete copy.secretRef
      if (copy.proxy) copy.proxy = { ...copy.proxy, secretRef: undefined, ephemeralSecret: undefined }
        if (copy.jump) copy.jump = { ...copy.jump, secretRef: undefined }
        if (copy.jumps) copy.jumps = copy.jumps.map(hop => ({ ...hop, secretRef: undefined, ephemeralSecret: undefined }))
      }
      return copy
    })
    const data = {
      format: 'enest.ssh.export',
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles,
      groups: store.state.groups,
      tags: store.allTags(),
    }
    const ok = await downloadJson('enest-ssh-connections.json', data)
    try {
      await api.copyText(JSON.stringify(data, null, 2))
    } catch {
      /* ignore */
    }
    if (ok) toast('已导出', 'success')
  }

  async function importAssets() {
    const text = await promptDialog('导入 JSON', '', '')
    if (text == null || !text.trim()) return
    let data
    try {
      data = JSON.parse(text)
    } catch (e) {
      toast(err(e), 'error')
      return
    }
    const profiles = Array.isArray(data) ? data : data.profiles || []
    const groups = Array.isArray(data) ? [] : data.groups || []
    const mode = (await confirmDialog('merge 合并？取消则询问 replace', {
      title: '导入模式',
      okText: 'merge',
      cancelText: '选择 replace',
    }))
      ? 'merge'
      : await confirmDialog('整库替换？', {
          title: 'replace',
          okText: 'replace',
          danger: true,
        })
        ? 'replace'
        : null
    if (!mode) return

    if (mode === 'replace') {
      store.state.profiles = []
      store.state.groups = []
    }
    for (const g of groups) {
      if (!g || !g.id) continue
      const exists = store.state.groups.find(
        (x) => x.id === g.id || (x.name === g.name && (x.parentId || '') === (g.parentId || ''))
      )
      if (!exists) store.upsertGroup(g)
    }
    let merged = 0
    for (const p of profiles) {
      if (!p || !p.host) continue
      const key = (p.name || '') + '|' + p.host + '|' + (p.username || '')
      const found = store.state.profiles.find(
        (x) => x.name + '|' + x.host + '|' + (x.username || '') === key
      )
      if (found && mode === 'merge') {
        const next = { ...found, ...p, id: found.id, secretRef: found.secretRef || p.secretRef }
        store.upsertProfile(next)
        merged++
      } else if (!found || mode === 'replace') {
        store.upsertProfile({ ...p, id: p.id || store.uid('prof') })
      }
    }
    await store.flushAll()
    renderLeft()
    toast('导入完成 ' + merged, 'success')
  }

  async function exportSnippets() {
    downloadJson('enest-ssh-snippets.json', {
      format: 'enest.ssh.snippets',
      version: 1,
      snippets: store.state.snippets,
    })
    try {
      await api.copyText(JSON.stringify(store.state.snippets, null, 2))
    } catch {
      /* ignore */
    }
  }

  /* ========== bind UI ========== */
  function bindUi() {
    // 原生 select 的升级由 plugin-kit（entry.js 引入）自动完成，这里无需再增强
    $('btn-toggle-side').onclick = () => toggleSidebar()
    $('rail-new').onclick = () => openProfileForm(null)
    $('rail-search').onclick = () => {
      setSidebarCollapsed(false)
      setTimeout(() => $('search-input')?.focus(), 50)
    }
    $('rail-drawer').onclick = () => toggleDrawer()
    $('rail-more').onclick = (ev) => showMenuFromEl(ev.currentTarget, sideMoreItems())

    $('btn-drawer-close').onclick = () => setDrawerOpen(false)
    $('drawer-scrim').onclick = () => setDrawerOpen(false)
    $('btn-drawer-more').onclick = (ev) => showMenuFromEl(ev.currentTarget, drawerMoreItems())

    $('fab').onclick = () => void fabAction()

    $('search-input').addEventListener('input', (e) => {
      store.setUi({ search: e.target.value })
      renderLeft()
    })
    $('search-input').addEventListener('focus', () => renderLeft())
    $('search-input').addEventListener('blur', () => setTimeout(() => renderLeft(), 120))

    $('f-auth').addEventListener('change', updateAuthFields)
    const jumpAuthEl = $('f-jump-auth')
    if (jumpAuthEl) jumpAuthEl.addEventListener('change', updateJumpAuthFields)

    const groupBtn = $('f-group')
    if (groupBtn) {
      groupBtn.addEventListener('click', (ev) => {
        ev.preventDefault()
        openDropdown(groupBtn, groupSelectItems(), handleGroupSelect, groupBtn.dataset.value || '')
      })
    }
    const jumpBtn = $('f-jump-profile')
    if (jumpBtn) {
      jumpBtn.addEventListener('click', (ev) => {
        ev.preventDefault()
        openDropdown(jumpBtn, jumpSelectItems(), handleJumpSelect, jumpBtn.dataset.value || '')
      })
    }

    const keyBrowse = $('btn-keypath-browse')
    if (keyBrowse) {
      keyBrowse.addEventListener('click', async (ev) => {
        ev.preventDefault()
        await browseLocalFile($('f-keypath'))
      })
    }
    const jumpKeyBrowse = $('btn-jump-key-browse')
    if (jumpKeyBrowse) {
      jumpKeyBrowse.addEventListener('click', async (ev) => {
        ev.preventDefault()
        await browseLocalFile($('f-jump-keypath'))
      })
    }

    const colorHex = $('f-color')
    const colorNative = $('f-color-native')
    const colorClear = $('btn-color-clear')
    if (colorHex) {
      colorHex.addEventListener('change', () => setColorValue(colorHex.value))
      colorHex.addEventListener('input', () => renderColorSwatches())
    }
    if (colorNative) {
      colorNative.addEventListener('input', () => setColorValue(colorNative.value))
    }
    if (colorClear) {
      colorClear.addEventListener('click', (ev) => {
        ev.preventDefault()
        setColorValue('')
      })
    }

    $('btn-form-cancel').onclick = () => {
      closeDropdown()
      $('form-root').classList.remove('show')
    }
    $('btn-form-cancel-foot').onclick = () => {
      closeDropdown()
      $('form-root').classList.remove('show')
    }
    $('f-proxy-type').onchange = () => updateProxyFields()
    $('btn-form-save').onclick = () => void saveProfileForm()
    $('btn-form-test').onclick = async () => {
      const status = $('form-test-status')
      let draft
      try { draft = readConnectionDraft(formProfileId || 'draft', formProfileId ? store.findProfile(formProfileId) : null) }
      catch (error) { status.textContent = err(error); return }
      if (!draft.host || !draft.username) {
        status.textContent = '请填写主机与用户名'
        return
      }
      if (!api.hasHostSsh()) {
        status.textContent = '功能未就绪'
        return
      }
      status.textContent = '测试中…'
      try {
        const mainSecret = draft.authType === 'key' ? $('f-passphrase').value : draft.authType === 'password' ? $('f-password').value : ''
        const payload = buildConnectPayload(draft)
        if (mainSecret) payload.ephemeralSecret = mainSecret
        if (payload.proxy && $('f-proxy-password').value) payload.proxy.ephemeralSecret = $('f-proxy-password').value
        if (!(await completePayloadCredentials(payload))) { status.textContent = '已取消测试'; return }
        if (api.raw?.ssh?.test) {
          const res = await api.sshTest(payload)
          status.textContent =
            (res?.latencyMs ?? res?.latency ?? '?') +
            ' 毫秒 · ' +
            (res?.fingerprint || '') +
            ' · ' +
            (res?.server || res?.banner || '')
          return
        }
        // 宿主无 ssh.test：connect + 断开 作为可达性/认证测试
        const t0 = Date.now()
        const res = await api.sshConnect(payload)
        const latency = Date.now() - t0
        const sid = res && (res.sessionId || res.id)
        if (sid) {
          try {
            await api.sshDisconnect(sid)
          } catch {
            /* ignore */
          }
        }
        status.textContent =
          latency +
          ' 毫秒 · ' +
          (res?.fingerprint || '连接成功') +
          (res?.serverIdent ? ' · ' + res.serverIdent : '')
      } catch (e) {
        status.textContent = api.friendlyConnectError(e)
      }
    }

    $('btn-view-back').onclick = () => {
      store.setUi({ centerTab: 'term' })
      renderCenterTabs()
    }
    $('btn-view-close').onclick = () => {
      store.setUi({ centerTab: 'term' })
      renderCenterTabs()
    }

    // Workbench command registry owns shortcuts; terminal Ctrl keys pass through.
    const metricsToggle = $('metrics-toggle')
    if (metricsToggle) {
      metricsToggle.onclick = async () => {
        const s = activeSession()
        if (!s) return
        if (s.metricsOn) {
          await stopMetrics(s)
          store.setUi({ monitorOn: false })
        } else {
          syncMetricsInterval()
          await startMetrics(s)
        }
        renderMetrics()
      }
    }
    $('metrics-interval').value = monitorIntervalMs()
    $('metrics-interval').addEventListener('change', (e) => {
      const v = Number(e.target.value) || monitorIntervalMs()
      store.setUi({ monitorIntervalMs: v })
      e.target.value = v
    })

    $('btn-sftp-refresh').onclick = () => void sftpRefresh()
    // F5：SFTP 面板可见时刷新目录（保留既有行为）
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'F5') return
      const panel = $('panel-sftp')
      if (!panel || !panel.classList.contains('active')) return
      ev.preventDefault()
      void sftpRefresh()
    })
    $('btn-sftp-up').onclick = async () => {
      const s = activeSession()
      if (!s) return
      const cur = s.sftp.path || '.'
      const parts = cur.replace(/\/+$/, '').split('/')
      parts.pop()
      s.sftp.path = parts.join('/') || '/'
      $('sftp-path').value = s.sftp.path
      await sftpRefresh()
    }
    $('sftp-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void sftpRefresh()
    })

    document.querySelector('.drawer-tabs').onclick = (ev) => {
      const b = ev.target.closest('button[data-tab]')
      if (!b) return
      store.setUi({ rightTab: b.dataset.tab })
      renderRight()
    }
    $('right-search').addEventListener('input', () => {
      store.setUi({ historyQuery: $('right-search').value })
      renderRight()
    })
    $('right-scope').value = store.state.ui.historyScope || 'current'
    syncSelectLabels()
    $('right-scope').addEventListener('change', (e) => {
      store.setUi({ historyScope: e.target.value })
      renderRight()
    })

    $('right-body').onclick = async (ev) => {
      const hist = ev.target.closest('[data-hist]')
      if (hist) {
        const h = store.state.history.find((x) => x.id === hist.dataset.hist)
        if (h) await fillHint(h.command)
        return
      }
      const snip = ev.target.closest('[data-snip]')
      if (snip) {
        const s = store.state.snippets.find((x) => x.id === snip.dataset.snip)
        if (s) await fillHint(s.command)
      }
    }

    bindCtx($('right-body'), (ev) => {
      const hist = ev.target.closest('[data-hist]')
      if (hist) return historyItemMenuItems(hist.dataset.hist)
      const snip = ev.target.closest('[data-snip]')
      if (snip) return snippetMenuItems(snip.dataset.snip)
      return null
    })

    bindCtx($('session-tabs'), (ev) => {
      const tab = ev.target.closest('[data-tab]')
      if (tab) return sessionTabMenuItems(tab.dataset.tab)
      return [
        { primary: true, label: '新建连接', onAct: () => openProfileForm(null) },
        { label: '历史', onAct: () => toggleDrawer() },
      ]
    })

    try {
      api.raw?.onBeforeClose?.(() => store.flushAll())
      api.raw?.onDestroy?.(() => completionController?.dispose())
    } catch {
      /* ignore */
    }
  }

  /* ========== boot ========== */
  async function boot() {
    if (window.EnestTips) window.EnestTips.bindIconTips()
    bindUi()
    bindSshEvents()
    await initPluginTheme()
    try {
      await api.setTitle('SSH')
    } catch {
      /* optional */
    }

    hostSshReady = api.hasHostSsh()

    try {
      await store.loadAll()
    } catch (e) {
      toast('加载失败：' + err(e), 'error')
    }

    setSidebarCollapsed(!!store.state.ui.sidebarCollapsed, false)
    setDrawerOpen(!!store.state.ui.drawerOpen, false)

    restoreWorkspace()

    renderLeft()
    renderRight()
    renderSessionTabs()
    renderCenterTabs()
    mountActiveTerminal()
    renderHintMeta()
    renderTopStatus()
    updateFab()

    if (!api.raw) toast('预览模式：功能未就绪', 'warn')
    else if (!hostSshReady) toast('功能未就绪', 'warn')

    window.SshWorkbenchBridge = { sessions, activeSession, setActiveTab, connectProfile, closeTab, openProfileForm, renderLeft, renderSessionTabs, setTerminalLayout, mountActiveTerminal, termFocus, runCompletion, fillHint, runHint, navigateHistory: (direction, target) => { getCompletion().hide(); return commandActions.history(direction, target) }, completionVisible: () => getCompletion().isOpen(), completionMove: delta => getCompletion().move(delta), completionAccept: () => getCompletion().accept(), openTermSearch, startMetrics, stopMetrics, promptDialog, confirmDialog, showContextMenu, showMoreMenu: (el) => showMenuFromEl(el, sideMoreItems()), toggleDrawer, openCollection, setDrawerOpen, setSidebarCollapsed, api, store }
    window.dispatchEvent(new Event('ssh-workbench-ready'))
    setInterval(renderTopStatus, 30000)
  }

  void boot()
})()
