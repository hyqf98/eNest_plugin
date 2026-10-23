/** Navigation owns only presentation. Collapsing a pane never changes a live SSH session. */
export const sidebarWidth = value => Math.max(220, Math.min(360, Number(value) || 240))

const paths = {
  connections: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  terminal: '<path d="m5 6 6 6-6 6m9 0h5"/>',
  files: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  resources: '<path d="M4 19V9m8 10V4m8 15v-7"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
  snippets: '<path d="m8 5-5 7 5 7m8-14 5 7-5 7m-3-16-2 20"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
}
const icon = key => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key]}</svg>`

export function createWorkspaceNavigation({ app, bridge, changeView, openSettings, onLayout }) {
  const store = bridge.store, sidebar = app.querySelector('#sidebar'), rail = app.querySelector('#side-rail')
  const narrowQuery = matchMedia('(max-width: 719px)')
  let mode = 'shell', opened = false, returnFocus = null, drag = null, currentView = 'terminal', lastCompact, disposed = false
  let flyouts = []
  const sideBody = app.querySelector('#side-body')
  let overlayPosition = -1, overlayVelocity = 0, overlayTarget = -1, overlayFrame = 0, overlayTime = 0
  let width = sidebarWidth(store.state.ui.sidebarWidth)
  rail.setAttribute('aria-label', 'SSH 工作区导航')
  rail.innerHTML = [['connections','连接'],['terminal','终端'],['files','文件'],['resources','资源']].map(([id,label]) => `<button type="button" class="rail-btn" data-navigation="${id}" aria-label="${label}" data-tip="${label}">${icon(id)}</button>`).join('') + '<div class="rail-spacer"></div>' + [['history','历史'],['snippets','常用命令'],['settings','设置']].map(([id,label]) => `<button type="button" class="rail-btn" data-navigation="${id}" aria-label="${label}" data-tip="${label}">${icon(id)}</button>`).join('') + '<button type="button" class="rail-btn" id="rail-more" data-more aria-label="更多操作" data-tip="更多操作">⋯</button>'
  // 全插件唯一的「更多」入口：rail 在侧栏展开与收起两种状态下都存在，
  // 顶栏不再重复放 ⋯（会话级动作另有会话标签右键菜单）。
  rail.querySelector('[data-more]').onclick = event => bridge.showMoreMenu(event.currentTarget)
  const connectionButton = rail.querySelector('[data-navigation="connections"]')
  connectionButton.setAttribute('aria-controls', 'side-body')
  const resize = document.createElement('div'); resize.className = 'wb-sidebar-resize'; resize.tabIndex = 0; resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', '连接面板宽度'); resize.setAttribute('aria-orientation', 'vertical'); resize.setAttribute('aria-valuemin', '220'); resize.setAttribute('aria-valuemax', '360'); sidebar.append(resize)
  const scrim = document.createElement('button'); scrim.className = 'wb-navigation-scrim'; scrim.setAttribute('aria-label', '关闭连接面板'); scrim.hidden = true; app.append(scrim)
  const compact = () => mode === 'quick' || narrowQuery.matches
  function paintOverlay() {
    sideBody.style.transform = `translateX(${overlayPosition * 100}%)`
    sideBody.style.visibility = overlayTarget === -1 && overlayPosition <= -.999 ? 'hidden' : 'visible'
  }
  function moveOverlay(show) {
    overlayTarget = show ? 0 : -1
    sideBody.style.opacity = '1'
    const level = document.documentElement.dataset.anim || 'medium'
    if (level === 'low' || matchMedia('(prefers-reduced-motion: reduce)').matches) { cancelAnimationFrame(overlayFrame); overlayFrame = 0; overlayPosition = overlayTarget; overlayVelocity = 0; paintOverlay(); return }
    if (overlayFrame) return
    if (Math.abs(overlayPosition - overlayTarget) < .001) { overlayPosition = overlayTarget; paintOverlay(); return }
    overlayTime = performance.now()
    const step = now => {
      const dt = Math.min(.032, (now - overlayTime) / 1000); overlayTime = now
      const stiffness = level === 'high' ? 400 : 580, damping = 2 * Math.sqrt(stiffness)
      overlayVelocity += ((overlayTarget - overlayPosition) * stiffness - overlayVelocity * damping) * dt
      overlayPosition += overlayVelocity * dt
      if (Math.abs(overlayPosition - overlayTarget) < .001 && Math.abs(overlayVelocity) < .01) { overlayPosition = overlayTarget; overlayVelocity = 0; overlayFrame = 0; paintOverlay(); return }
      paintOverlay(); overlayFrame = requestAnimationFrame(step)
    }
    paintOverlay(); overlayFrame = requestAnimationFrame(step)
  }
  function hideFlyouts() { flyouts.forEach(flyout => flyout.hide()) }
  function layout() {
    const collapsed = compact() ? !opened : !!store.state.ui.sidebarCollapsed
    if (lastCompact !== compact() || !collapsed) hideFlyouts()
    lastCompact = compact()
    app.dataset.compactNavigation = String(compact()); app.dataset.sidebarOpen = String(!collapsed)
    sidebar.dataset.collapsed = collapsed ? '1' : '0'; app.classList.toggle('side-collapsed', collapsed)
    app.style.setProperty('--ssh-sidebar-width', `${width}px`)
    connectionButton.classList.toggle('active', !collapsed); connectionButton.setAttribute('aria-expanded', String(!collapsed))
    sideBody.inert = collapsed
    resize.setAttribute('aria-valuenow', String(width)); resize.tabIndex = collapsed || compact() ? -1 : 0
    scrim.hidden = !compact() || !opened
    if (compact()) moveOverlay(!collapsed)
    else { cancelAnimationFrame(overlayFrame); overlayFrame = 0; sideBody.style.removeProperty('transform'); sideBody.style.removeProperty('visibility'); sideBody.style.removeProperty('opacity') }
    onLayout?.()
  }
  function closeConnections(restoreFocus = true) {
    if (compact()) opened = false
    else store.setUi({ sidebarCollapsed: true })
    layout(); if (restoreFocus) (returnFocus?.isConnected ? returnFocus : connectionButton).focus()
  }
  function revealConnections() {
    hideFlyouts()
    returnFocus = document.activeElement
    if (compact()) opened = true
    else store.setUi({ sidebarCollapsed: false })
    layout(); app.querySelector('#search-input')?.focus()
  }
  function navigate(target) {
    hideFlyouts()
    if (target === 'connections') return revealConnections()
    if (compact()) closeConnections(false)
    if (target === 'settings') return openSettings()
    if (target === 'history' || target === 'snippets') return bridge.openCollection(target)
    return changeView(target)
  }
  for (const button of rail.querySelectorAll('[data-navigation]')) button.onclick = () => {
    const target = button.dataset.navigation
    if (target === 'connections' && app.dataset.sidebarOpen === 'true') return closeConnections()
    return navigate(target)
  }
  function flyoutItems() {
    const drawerOpen = app.querySelector('#drawer')?.classList.contains('open')
    const items = [
      { key: 'connections', label: '连接与搜索', hint: `${store.state.profiles.length} 个连接` },
      { key: 'terminal', label: '终端', checked: currentView === 'terminal' },
      { key: 'files', label: '文件', checked: currentView === 'files' },
      { key: 'resources', label: '资源', checked: currentView === 'resources' },
      'sep',
      { key: 'history', label: '命令历史', checked: drawerOpen && store.state.ui.rightTab === 'history' },
      { key: 'snippets', label: '常用命令', checked: drawerOpen && store.state.ui.rightTab === 'snippets' },
      { key: 'settings', label: '设置', checked: currentView === 'settings' },
      'sep',
      { key: 'new', label: '新建连接' }
    ]
    const profiles = [...store.state.profiles].sort((a, b) => Number(b.id === store.state.ui.selectedProfileId) - Number(a.id === store.state.ui.selectedProfileId) || Number(b.favorite) - Number(a.favorite))
    if (profiles.length) items.push('sep', ...profiles.slice(0, 6).map(profile => ({
      key: `connect:${profile.id}`, label: `打开 ${profile.name || profile.host || profile.id}`,
      checked: profile.id === bridge.activeSession()?.profileId, hint: profile.host || undefined,
      disabled: [...bridge.sessions.values()].some(session => session.profileId === profile.id && session.status === 'connecting')
    })))
    return items
  }
  function pickFlyout(key) {
    const item = flyoutItems().find(entry => entry.key === key)
    if (!item || item.disabled) return
    return Promise.resolve().then(async () => {
      if (key === 'new') return bridge.openProfileForm(null)
      if (!key.startsWith('connect:')) return navigate(key)
      const profile = store.findProfile(key.slice('connect:'.length))
      if (!profile) return
      store.setUi({ selectedProfileId: profile.id }); bridge.renderLeft()
      const session = [...bridge.sessions.values()].find(entry => entry.profileId === profile.id && entry.status === 'connected')
      if (session) bridge.setActiveTab(session.tabId)
      else await bridge.connectProfile(profile)
      navigate('terminal')
    }).catch(error => bridge.api.toast(error.message || String(error), 'error'))
  }
  if (window.PluginKit?.hoverFlyout) {
    const options = { enabled: () => !disposed && app.dataset.sidebarOpen === 'false', handleClick: false, onPick: pickFlyout, side: 'right', delay: 120, hideDelay: 300, ariaLabel: 'SSH 工作区导航与连接' }
    flyouts = [window.PluginKit.hoverFlyout(connectionButton, flyoutItems, options)]
  }
  scrim.onclick = () => closeConnections()
  function setWidth(value, persist = true) { width = sidebarWidth(value); layout(); if (persist) store.setUi({ sidebarWidth: width }) }
  resize.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); drag = { pointerId: event.pointerId, x: event.clientX, width }; resize.setPointerCapture(event.pointerId); app.classList.add('resizing-sidebar') }
  resize.onpointermove = event => { if (drag?.pointerId === event.pointerId) setWidth(drag.width + event.clientX - drag.x, false) }
  function stopResize(cancel = false) { if (!drag) return; const before = drag; drag = null; if (cancel) setWidth(before.width, false); else store.setUi({ sidebarWidth: width }); if (resize.hasPointerCapture(before.pointerId)) resize.releasePointerCapture(before.pointerId); app.classList.remove('resizing-sidebar') }
  resize.onpointerup = () => stopResize(); resize.onpointercancel = () => stopResize(true); resize.onlostpointercapture = () => stopResize()
  resize.onkeydown = event => { const value = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: 220, End: 360 }[event.key]; if (value !== undefined) { event.preventDefault(); setWidth(value) } }
  function onKey(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (drag) { event.preventDefault(); stopResize(true); resize.focus(); return }
    if (app.querySelector('#drawer.open') && !document.querySelector('.modal-root.show,dialog[open]')) { event.preventDefault(); bridge.setDrawerOpen(false); rail.querySelector(`[data-navigation="${store.state.ui.rightTab || 'history'}"]`)?.focus(); return }
    if (compact() && opened && !document.querySelector('.modal-root.show,dialog[open]')) { event.preventDefault(); closeConnections() }
  }
  function dispose() {
    if (disposed) return
    disposed = true
    flyouts.forEach(flyout => flyout.destroy()); flyouts = []
    document.removeEventListener('keydown', onKey, true); narrowQuery.removeEventListener('change', layout); window.removeEventListener('pagehide', dispose); stopResize(true); cancelAnimationFrame(overlayFrame)
  }
  document.addEventListener('keydown', onKey, true)
  narrowQuery.addEventListener('change', layout)
  window.addEventListener('pagehide', dispose)
  layout()
  return {
    setMode(next) { hideFlyouts(); mode = next; opened = false; layout() }, revealConnections, closeConnections,
    setView(view) { currentView = view; for (const button of rail.querySelectorAll('[data-navigation]')) if (button !== connectionButton) { const selected = button.dataset.navigation === view; button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'page' : 'false') } },
    dispose,
  }
}
