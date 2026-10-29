import { CommandRegistry, createDialog, bindDockResize, loadMonaco, normalizeShortcut, escapeHtml as esc } from '@enest/plugin-kit/workbench'
import { createSshHost } from '@enest/ssh-backend/client'
import { RemoteFiles } from './files.js'
import { createWorkspaceNavigation } from './workspaceNavigation.js'
import { renderCompletionSettings } from './completionSettings.js'
import { isReservedSshShortcut, displaySshShortcut } from './shortcutPolicy.js'
import { PAPER_OPTIONS, applyPaper, normalizePaper } from './paper-theme.js'
import { publishResourceState } from './resource-state.js'

const host = createSshHost(window.enest || window.zapi)
const mac = /Mac/.test(navigator.platform)
const formatBytes = n => n == null ? '—' : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
const percentage = n => Number.isFinite(n) ? n.toFixed(1) + '%' : '采样中'
const PREFERENCES = 'ssh.preferences.v2'

export const isSshCompositionEvent = event => event.isComposing || event.keyCode === 229 || event.key === 'Process'

/** Terminal actions may be invoked from menus, but their keys belong to the focused terminal. */
export function canRouteSshShortcut(command, target, session) {
  return !command?.terminalShortcut || !!session?.term?.el?.contains(target)
}

async function boot() {
  const bridge = window.SshWorkbenchBridge, store = bridge.store, app = document.querySelector('#app'), main = document.querySelector('.main'), workspace = document.querySelector('.workspace')
  if (!bridge || app.dataset.workbench) return
  app.dataset.workbench = 'ready'
  let mode = host?.getLaunchMode?.() || 'shell', view = 'terminal', tool = 'processes', toolRevision = 0, activeKey = '', prefs = { shortcuts: {}, monitorInterval: 5000, ...await host?.storage?.get(PREFERENCES) }, activeEditor = null, toolData = [], sampleBusy = false, lastSample = null, transferTimer = null, disposed = false
  const editors = new Map(), registry = new CommandRegistry()
  const toast = (message, type = 'info') => bridge.api.toast(message, type)
  const error = e => toast(e?.message || String(e), 'error')
  const safe = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(error)
  const request = (action, values = {}) => {
    if (!host?.ssh?.workbench) return Promise.reject(new Error('请更新宿主以使用 SSH 工作台'))
    return host.ssh.workbench({ action, sessionId: bridge.activeSession()?.sessionId, ...values })
  }
  const connected = () => !!bridge.activeSession()?.sessionId
  const sideActions = document.createElement('span'); sideActions.className = 'wb-connection-actions'
  sideActions.innerHTML = '<button data-create title="新建连接" aria-label="新建连接">＋</button><button data-import title="导入 OpenSSH config" aria-label="导入 OpenSSH config">↓</button>'
  document.querySelector('.side-head .spacer').after(sideActions)
  sideActions.querySelector('[data-create]').onclick = () => bridge.openProfileForm(null)
  sideActions.querySelector('[data-import]').onclick = safe(() => importConfig())

  const header = document.createElement('header'); header.className = 'wb-header'
  header.innerHTML = `<div class="wb-brand"><strong>SSH</strong><span class="wb-mode-label"></span></div><nav aria-label="工作区"><button data-view="terminal">终端</button><button data-view="files">文件</button><button data-view="resources">资源</button></nav><div class="wb-header-end"><button data-command="palette" title="快捷命令">命令 <kbd>${mac ? '⌘⇧P' : 'Ctrl⇧P'}</kbd></button><button class="wb-open-shell" data-command="desktop">在桌面展开 ↗</button></div>`
  app.before(header)
  const summary = document.createElement('div'); summary.className = 'wb-resource-strip'; summary.innerHTML = '<span>连接后显示服务器资源</span>'
  main.querySelector('.topbar').replaceWith(summary)
  const context = document.createElement('div'); context.className = 'wb-session-context'; context.innerHTML = '<span class="status-dot"></span><strong>SSH 工作区</strong><span class="wb-session-target">选择连接后开始</span><span class="wb-session-status"></span><button data-connect>连接</button><button data-hints>命令提示</button>'
  main.querySelector('.session-tabs').after(context)
  context.querySelector('[data-connect]').onclick = safe(async () => { const session = bridge.activeSession(); const profile = store.findProfile(session?.profileId || store.state.ui.selectedProfileId); if (profile) await bridge.connectProfile(profile); else navigation.revealConnections() })
  context.querySelector('[data-hints]').onclick = () => { void settings('completion') }
  const selectionActions = document.createElement('span'); selectionActions.className = 'wb-selection-actions'; selectionActions.hidden = true
  selectionActions.innerHTML = '<button data-insert-selection title="选中单行命令后填入，保留当前输入">填入选中</button><button data-execute-selection title="执行选中的单行命令">执行选中</button>'
  context.querySelector('[data-hints]').before(selectionActions)
  const selectedCommand = () => bridge.activeSession()?.term?.getSelection?.() || ''
  const selectionState = () => { selectionActions.hidden = !selectedCommand().trim() }
  window.addEventListener('ssh-selection-change', selectionState)
  window.addEventListener('ssh-workspace-change', selectionState)
  selectionActions.querySelector('[data-insert-selection]').onclick = safe(() => selectionCommand(false))
  selectionActions.querySelector('[data-execute-selection]').onclick = safe(() => selectionCommand(true))
  function selectionCommand(execute, commandText = selectedCommand(), target = bridge.activeSession()) { return execute ? bridge.runHint(commandText, target) : bridge.fillHint(commandText, target) }
  workspace.addEventListener('contextmenu', event => {
    if (!event.target.closest('.term-host')) return
    event.preventDefault(); const target = bridge.activeSession(), text = target?.term?.getSelection?.() || ''
    bridge.showContextMenu(event.clientX, event.clientY, [
      { label: '填入选中命令', disabled: !text.trim(), onAct: () => selectionCommand(false, text, target) },
      { label: '执行选中命令', disabled: !text.trim(), onAct: () => selectionCommand(true, text, target) },
      { label: '复制选中内容', disabled: !text, onAct: () => bridge.api.copyText(text) },
      { sep: true }, { label: '上一条远端历史 ↑', onAct: () => bridge.navigateHistory(-1, target) }, { label: '下一条远端历史 ↓', onAct: () => bridge.navigateHistory(1, target) },
      { sep: true }, { label: '显示命令提示', onAct: () => bridge.runCompletion(true) }, { label: '命令提示设置', onAct: () => settings('completion') },
    ])
  })
  document.querySelectorAll('#panel-metrics,#panel-sftp,#view-chip').forEach(el => el.classList.add('wb-legacy-hidden'))
  const filesElement = document.createElement('aside'); filesElement.className = 'wb-files'; workspace.append(filesElement)
  const fileResize = document.createElement('div'); fileResize.className = 'wb-file-resize'; workspace.append(fileResize)
  fileResize.setAttribute('aria-label', '远程文件面板宽度')
  bindDockResize(fileResize, filesElement, { axis: 'x', min: 250, max: 720, invert: true, onChange: width => { store.setUi({ filesWidth: width }); workspace.style.setProperty('--ssh-files-width', width + 'px'); editorPane.style.right = width + 'px'; fileResize.style.right = (width - 3) + 'px' } })
  filesElement.style.width = `${store.state.ui.filesWidth || 300}px`
  workspace.style.setProperty('--ssh-files-width', `${store.state.ui.filesWidth || 300}px`)
  const editorPane = document.createElement('section'); editorPane.className = 'wb-editor-pane'; workspace.append(editorPane)
  fileResize.style.right = ((store.state.ui.filesWidth || 300) - 3) + 'px'
  const fileObserver = new ResizeObserver(() => { fileResize.style.right = (filesElement.clientWidth - 3) + 'px'; editorPane.style.right = mode === 'quick' ? '0px' : filesElement.clientWidth + 'px' }); fileObserver.observe(filesElement)
  const dock = document.createElement('section'); dock.className = 'wb-dock'; main.append(dock)
  dock.innerHTML = `<div class="wb-dock-resize"></div><div class="wb-tool-tabs"><nav>${[['processes','进程'],['ports','端口'],['services','服务'],['docker','Docker'],['tunnels','隧道'],['transfers','传输'],['history','历史']].map(([id,label]) => `<button data-tool="${id}">${label}</button>`).join('')}</nav><button data-tool-close title="收起面板">⌄</button></div><div class="wb-tool-toolbar"><input type="search" placeholder="过滤当前列表" aria-label="过滤当前列表"><span class="wb-tool-status"></span><button data-tool-refresh>刷新</button></div><div class="wb-tool-body"></div>`
  bindDockResize(dock.querySelector('.wb-dock-resize'), dock, { axis: 'y', min: 150, max: 540, invert: true, onChange: height => store.setUi({ dockHeight: height }) })
  dock.style.height = `${store.state.ui.dockHeight || 240}px`
  const statusbar = document.createElement('footer'); statusbar.className = 'wb-statusbar'; statusbar.innerHTML = '<span class="wb-connection-state">未连接</span><button data-command="transfers">传输任务</button>'; main.append(statusbar)

  const files = new RemoteFiles(filesElement, { session: bridge.activeSession, request, error, message: toast, prompt: bridge.promptDialog, confirm: bridge.confirmDialog, menu: bridge.showContextMenu, copy: bridge.api.copyText, edit: path => safe(openFile)(path), inspect, transfers: () => openTool('transfers') })
  const navigation = createWorkspaceNavigation({ app, bridge, changeView, openSettings: () => void settings(), onLayout: () => requestAnimationFrame(() => bridge.activeSession()?.term?.fit()) })

  function changeView(next) {
    if (mode === 'panel') return
    if (next === 'connections') { navigation.revealConnections(); return }
    const settingsPage = main.querySelector('.wb-settings-page'); if (settingsPage) settingsPage.hidden = true
    view = next; app.dataset.view = view; document.documentElement.dataset.sshView = view
    navigation.setView(view)
    header.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false') })
    if (next === 'files') { if (!files.state.entries.length) void files.refresh(); else files.render(); if (activeEditor) void renderEditor() }
    if (next === 'resources') openTool(tool)
    if (next === 'terminal') { editorPane.classList.remove('open'); document.querySelector('#panel-term').classList.add('active'); requestAnimationFrame(() => { bridge.activeSession()?.term?.fit(); bridge.termFocus(); void host?.ui?.focus?.() }) }
  }
  function setMode(next) {
    mode = next; document.documentElement.dataset.launchMode = mode
    navigation.setMode(mode)
    if (mode === 'panel') return
    header.querySelector('.wb-mode-label').textContent = mode === 'quick' ? '快速连接' : '工作台'
    if (mode === 'quick') void host?.ui?.resize?.({ width: 720, height: 420 })
    changeView(view)
    if (!connected() && mode === 'quick') navigation.revealConnections()
    bridge.mountActiveTerminal()
    requestAnimationFrame(() => { bridge.activeSession()?.term?.fit(); for (const doc of editors.values()) doc.editor?.layout?.() })
  }
  host?.onModeChange?.(setMode)
  setMode(host?.getLaunchMode?.() || mode)
  header.querySelectorAll('[data-view]').forEach(button => button.onclick = () => changeView(button.dataset.view))
  header.querySelectorAll('[data-command]').forEach(button => button.onclick = () => safe(() => registry.run(button.dataset.command))())
  statusbar.querySelector('[data-command]').onclick = () => openTool('transfers')
  dock.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => openTool(button.dataset.tool))
  dock.querySelector('[data-tool-close]').onclick = () => { dock.classList.remove('open'); if (view === 'resources') changeView('terminal'); bridge.activeSession()?.term?.fit() }
  dock.querySelector('[data-tool-refresh]').onclick = safe(() => loadTool())
  dock.querySelector('input').oninput = () => renderTool()

  function inspect(title, content) { createDialog({ title, content: `<pre class="wb-inspect">${esc(content)}</pre>` }) }
  function command(id, label, run, shortcut = '', options = {}) { registry.register({ id, label, run: safe(run), shortcut, ...options }) }
  command('palette', '快捷命令列表', () => palette(), 'Mod+Shift+P', { inEditor: true })
  command('settings', 'SSH 插件设置', () => settings(), 'Mod+Shift+,', { inEditor: true })
  command('desktop', '在桌面展开', () => host.ui.openInShell())
  command('new', '新建连接', () => bridge.openProfileForm(null), 'Mod+Shift+N')
  command('import-ssh', '导入 OpenSSH config', importConfig)
  command('terminal', '返回终端', () => changeView('terminal'), 'Mod+Shift+T', { inEditor: true })
  command('files', '远程文件', () => changeView('files'), 'Mod+Shift+E')
  command('transfers', '传输任务', () => openTool('transfers'))
  command('history', '命令历史', () => palette('history'), 'Mod+Shift+H', { inEditor: true })
  command('find', '查找终端内容', () => bridge.openTermSearch(), mac ? 'Mod+F' : 'Mod+Shift+F', { inEditor: true, terminalShortcut: true })
  command('completion', '显示命令补全', () => { if (!bridge.activeSession()?.term?.readCommand?.()) return toast('先在空闲的 Bash / Zsh 提示符启用增强提示'); return bridge.runCompletion(true) }, 'Mod+Shift+Space', { inEditor: true, terminalShortcut: true })
  command('completion-previous', '选择上一条补全候选', () => bridge.completionMove(-1), 'Alt+ArrowUp', { inEditor: true, terminalShortcut: true, enabled: () => bridge.completionVisible() })
  command('completion-next', '选择下一条补全候选', () => bridge.completionMove(1), 'Alt+ArrowDown', { inEditor: true, terminalShortcut: true, enabled: () => bridge.completionVisible() })
  command('completion-accept', '填入选中的补全候选', () => bridge.completionAccept(), 'Alt+Enter', { inEditor: true, terminalShortcut: true, enabled: () => bridge.completionVisible() })
  bridge.completionShortcuts = () => Object.fromEntries([['trigger','completion'],['previous','completion-previous'],['next','completion-next'],['accept','completion-accept']].map(([key, id]) => [key, displaySshShortcut(registry.shortcut(id), mac)]))
  command('insert-selection', '填入终端选中命令', () => selectionCommand(false), 'Mod+Shift+I', { inEditor: true, terminalShortcut: true, enabled: connected })
  command('execute-selection', '执行终端选中命令', () => selectionCommand(true), 'Mod+Shift+R', { inEditor: true, terminalShortcut: true, enabled: connected })
  command('history-previous', '上一条远端历史', () => bridge.navigateHistory(-1), '', { inEditor: true, terminalShortcut: true, enabled: connected })
  command('history-next', '下一条远端历史', () => bridge.navigateHistory(1), '', { inEditor: true, terminalShortcut: true, enabled: connected })
  async function enableSessionHints() {
    const target = bridge.activeSession(), sessionId = target?.sessionId
    if (!sessionId) throw new Error('请先连接服务器')
    if (!await bridge.confirmDialog('请确认终端停在空闲的 Bash / Zsh 命令提示符。增强提示仅修改本次 shell，不写入服务器配置文件。', { title: '启用命令提示', okText: '启用' })) return
    if (bridge.activeSession() !== target || target.sessionId !== sessionId) throw new Error('目标会话已变化，请在当前会话重新启用提示')
    await request('shell.integrate', { sessionId })
    if (bridge.activeSession() === target && target.sessionId === sessionId) { changeView('terminal'); toast('已启用本次会话的命令提示') }
    return true
  }
  command('integration', '启用临时 Bash / Zsh 提示', enableSessionHints, '', { enabled: connected })
  command('split-session', '同一服务器新会话', async () => { const s = bridge.activeSession(), profile = store.findProfile(s?.profileId); if (profile) await bridge.connectProfile(profile, { newSession: true }) }, '', { enabled: connected })
  command('split-horizontal', '左右分屏终端', () => splitTerminal('horizontal'), 'Mod+Shift+\\', { enabled: connected, inEditor: true })
  command('split-vertical', '上下分屏终端', () => splitTerminal('vertical'), '', { enabled: connected })
  command('unsplit', '合并终端分屏', () => bridge.setTerminalLayout('single'), '', { enabled: connected })
  command('broadcast', '广播命令到多个会话', broadcast, '', { enabled: connected })
  command('export-log', '导出当前终端日志', async () => {
    const session = bridge.activeSession(), buffer = session?.term?.raw?.buffer?.active
    const content = buffer ? Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || '').join('\n') : session?.buffer || ''
    const result = await host.shell.saveTextFile({ defaultName: `ssh-${store.findProfile(session?.profileId)?.name || 'terminal'}.log`, content }); if (result?.ok) toast('终端日志已保存')
  }, '', { enabled: connected })
  command('clear', '清空终端显示', () => bridge.activeSession()?.term?.clear(), '', { enabled: connected })
  command('processes', '查看进程', () => openTool('processes'), '', { enabled: connected })
  command('ports', '查看监听端口', () => openTool('ports'), '', { enabled: connected })
  command('services', '管理服务', () => openTool('services'), '', { enabled: connected })
  command('docker', '管理 Docker 容器', () => openTool('docker'), '', { enabled: connected })
  for (const [id, key] of Object.entries(prefs.shortcuts || {})) try { if (!isReservedSshShortcut(key, mac, id)) registry.setBinding(id, key) } catch { /* invalid saved bindings retain their defaults */ }
  window.addEventListener('ssh-activate-terminal', () => changeView('terminal'))
  window.addEventListener('ssh-terminal-command', event => { void registry.run(event.detail) })
  document.addEventListener('keydown', event => {
    if (mode === 'panel' || isSshCompositionEvent(event) || event.defaultPrevented || event.target.closest?.('[data-binding]') || document.querySelector('dialog[open],.modal-root.show')) return
    // macOS Control belongs to the remote terminal; Mod shortcuts require Command.
    if (mac && event.ctrlKey && !event.metaKey) return
    const chord = normalizeShortcut(event), bound = registry.list().find(command => registry.shortcut(command.id) === chord)
    if (!canRouteSshShortcut(bound, event.target, bridge.activeSession())) return
    const inEditor = !!event.target.closest?.('.xterm,.wb-editor-pane,input,textarea')
    if (registry.handle(event, { inEditor })) event.stopImmediatePropagation()
  }, true)
  document.addEventListener('focusin', event => { void host?.ui?.setInputContext?.(event.target.closest('dialog,[role="dialog"]') ? 'overlay' : event.target.closest('.xterm,.term-fallback') ? 'terminal' : event.target.closest('.wb-editor-pane,input,textarea') ? 'editor' : 'workbench') })
  const authDialogs = new Map()
  host?.on('ssh.auth', event => {
    let answered = false
    const dialog = createDialog({ title: `服务器认证 · ${event.host}`, content: `<p>${esc(event.instructions || '请输入服务器请求的认证信息；回答只用于本次连接。')}</p><form class="wb-settings-form">${event.prompts.map((p,i) => `<label>${esc(p.prompt)}<input data-answer="${i}" type="${p.echo ? 'text' : 'password'}" autocomplete="off" required></label>`).join('')}<button class="btn primary">继续连接</button></form>`, onClose: () => { authDialogs.delete(event.sessionId); if (!answered) void request('auth.respond', { id: event.challengeId }).catch(() => {}) } })
    authDialogs.set(event.sessionId, dialog)
    dialog.body.querySelector('form').onsubmit = formEvent => { formEvent.preventDefault(); void safe(async () => { const answers = [...dialog.body.querySelectorAll('[data-answer]')].map(input => input.value); await request('auth.respond', { id: event.challengeId, answers }); answered = true; dialog.close() })() }
    dialog.body.querySelector('input')?.focus()
  })
  host?.on('ssh.error', event => { const dialog = authDialogs.get(event.sessionId); if (dialog) dialog.close() })

  async function splitTerminal(layout) {
    const original = bridge.activeSession()
    const others = [...bridge.sessions.values()].filter(s => s !== original && s.sessionId)
    const dialog = createDialog({ title: layout === 'horizontal' ? '左右分屏' : '上下分屏', content: `<p>选择另一会话并排显示；每个终端独立输入。</p><select class="wb-split-target"><option value="new">为当前服务器新建会话</option>${others.map(s => `<option value="${esc(s.tabId)}">${esc(s.title || store.findProfile(s.profileId)?.name || s.profileId)}</option>`).join('')}</select><button class="btn primary" data-split>分屏</button>` })
    dialog.body.querySelector('[data-split]').onclick = safe(async () => {
      const value = dialog.body.querySelector('select').value; dialog.close()
      const next = value === 'new' ? await bridge.connectProfile(store.findProfile(original.profileId), { newSession: true }) : bridge.sessions.get(value)
      if (next) { bridge.setTerminalLayout(layout, [original.tabId, next.tabId]); changeView('terminal') }
    })
  }
  async function importConfig() {
    const handles = await host.localFiles.pick({ kind: 'file' }); if (!handles?.length) return
    const result = await request('config.import', { localHandleId: handles[0].id })
    if (!result.profiles.length) return toast('未找到明确命名的 Host；通配 Host 仅作为默认配置', 'warn')
    const dialog = createDialog({ title: '导入 OpenSSH 连接', content: `<p>将导入 ${result.profiles.length} 个连接。私钥文件需在连接时重新选择授权，密码在连接时输入。</p><div class="wb-import-hosts">${result.profiles.map((p,i) => `<label><input type="checkbox" value="${i}" checked><strong>${esc(p.name)}</strong><small>${esc(p.username)}@${esc(p.host)}:${p.port} · ${p.authType === 'agent' ? 'SSH Agent' : p.authType === 'key' ? '私钥' : '密码'}${p.jumps?.length ? ` · ${p.jumps.length} 级跳板` : ''}</small></label>`).join('')}</div>${result.warnings.map(w => `<p class="wb-inline-error">${esc(w)}</p>`).join('')}<button class="btn primary" data-import>导入所选</button>` })
    dialog.body.querySelector('[data-import]').onclick = () => {
      const selected = [...dialog.body.querySelectorAll('input:checked')].map(el => result.profiles[Number(el.value)])
      for (const profile of selected) store.upsertProfile({ ...profile, id: store.uid('prof'), tags: ['OpenSSH'], groupId: '', env: 'dev' })
      dialog.close(); bridge.renderLeft(); toast(`已导入 ${selected.length} 个连接`)
    }
  }

  function palette(kind = 'all') {
    let current = 0, items = []
    const dialog = createDialog({ title: kind === 'history' ? '命令历史' : '快捷命令', className: 'wb-palette', content: '<input class="wb-palette-search" placeholder="搜索操作、常用命令或历史" aria-label="搜索命令"><div class="wb-palette-items" role="listbox"></div><small>↑ ↓ 循环选择 · Enter 选择 · Esc 关闭。历史与常用命令只填入，不自动执行。</small>' })
    const input = dialog.body.querySelector('input'), list = dialog.body.querySelector('[role=listbox]')
    function render() {
      const q = input.value.toLowerCase(), profileId = bridge.activeSession()?.profileId
      const commands = kind === 'history' ? [] : registry.list(q).filter(c => c.id !== 'palette').map(c => ({ label: c.label, detail: registry.shortcut(c.id), run: () => registry.run(c.id) }))
      const snippets = kind === 'history' ? [] : store.state.snippets.filter(s => `${s.title} ${s.command}`.toLowerCase().includes(q)).map(s => ({ label: s.title || s.command, detail: s.command, run: () => fillCommand(s.command) }))
      const history = store.state.history.filter(h => (!profileId || h.profileId === profileId) && h.command.toLowerCase().includes(q)).slice(0, 60).map(h => ({ label: h.command, detail: new Date(h.ts).toLocaleString(), run: () => fillCommand(h.command) }))
      items = [...commands, ...snippets, ...history]; current = Math.min(current, Math.max(0, items.length - 1))
      list.innerHTML = items.length ? items.map((x, i) => `<button role="option" aria-selected="${i === current}" data-index="${i}" class="${i === current ? 'selected' : ''}"><span>${esc(x.label)}</span><small>${esc(x.detail)}</small></button>`).join('') : '<div class="wb-empty">没有匹配的命令</div>'
      list.querySelectorAll('button').forEach(button => button.onclick = () => choose(Number(button.dataset.index)))
      list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
    }
    function choose(index) { const item = items[index]; if (item) { dialog.close(); void safe(item.run)() } }
    input.oninput = () => { current = 0; render() }
    input.onkeydown = event => {
      if (isSshCompositionEvent(event)) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); current = (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % (items.length || 1); render() }
      else if (event.key === 'Enter') { event.preventDefault(); choose(current) }
    }
    render(); input.focus()
  }
  async function fillCommand(text) {
    const session = bridge.activeSession()
    if (!session?.sessionId) throw new Error('请先连接服务器')
    if (/[\x00-\x1f\x7f]/.test(text)) {
      const dialog = createDialog({ title: '多行命令', content: `<p>这段命令包含换行或控制字符，请复制后检查，或使用广播面板明确执行。</p><pre class="wb-inspect">${esc(text)}</pre><button class="btn primary" data-copy>复制命令</button>` })
      dialog.body.querySelector('[data-copy]').onclick = safe(async () => { await bridge.api.copyText(text); dialog.close(); toast('命令已复制') })
      return
    }
    changeView('terminal')
    await bridge.fillHint(text)
  }
  async function broadcast() {
    const sessions = [...bridge.sessions.values()].filter(s => s.sessionId && s.status === 'connected')
    const dialog = createDialog({ title: '广播命令', content: `<p>独立执行通道，逐台返回结果；不会修改当前交互终端输入。</p><div class="wb-broadcast-targets">${sessions.map(s => `<label><input type="checkbox" value="${esc(s.sessionId)}">${esc(store.findProfile(s.profileId)?.name || s.profileId)}</label>`).join('')}</div><textarea class="wb-broadcast-command" rows="4" placeholder="输入要执行的命令"></textarea><button class="btn primary" data-run>执行到所选服务器</button><pre class="wb-inspect" data-result></pre>` })
    dialog.body.querySelector('[data-run]').onclick = safe(async () => {
      const targets = [...dialog.body.querySelectorAll('input:checked')].map(x => x.value), commandText = dialog.body.querySelector('textarea').value.trim()
      if (!targets.length || !commandText) throw new Error('请选择目标服务器并输入命令')
      if (!await bridge.confirmDialog(`将向 ${targets.length} 台服务器执行：\n${commandText}`, { title: '确认广播', okText: '执行', danger: true })) return
      const output = dialog.body.querySelector('[data-result]'); output.textContent = ''; dialog.body.querySelector('[data-run]').disabled = true
      await Promise.all(targets.map(async sessionId => {
        const session = sessions.find(s => s.sessionId === sessionId), name = store.findProfile(session.profileId)?.name || sessionId
        try { const result = await host.ssh.exec({ sessionId, command: commandText, timeoutMs: 30000 }); output.textContent += `${name} · exit ${result.exitCode}\n${result.stdout}${result.stderr}\n` }
        catch (e) { output.textContent += `${name} · ${e.message}\n` }
      })); dialog.body.querySelector('[data-run]').disabled = false
    })
  }

  function openTool(next) { tool = next; dock.classList.add('open'); dock.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool)); if (mode === 'quick' && !['history', 'transfers'].includes(tool) && view !== 'resources') { changeView('resources'); return }; void loadTool(); bridge.activeSession()?.term?.fit() }
  const transferStatuses = new Map()
  async function loadTool(silent = false) {
    const revision = ++toolRevision, selectedTool = tool, sessionId = bridge.activeSession()?.sessionId, body = dock.querySelector('.wb-tool-body'), scroll = body.scrollTop
    if (!silent) body.innerHTML = '<div class="wb-empty">正在读取…</div>'
    let data, platform
    try {
      if (selectedTool === 'history') data = store.state.history.filter(h => !bridge.activeSession() || h.profileId === bridge.activeSession().profileId)
      else if (selectedTool === 'transfers') {
        data = await request('transfer.list')
        for (const task of data) {
          if (task.status === 'completed' && transferStatuses.get(task.id) !== 'completed' && task.sessionId === sessionId) void files.refresh()
          transferStatuses.set(task.id, task.status)
        }
      }
      else if (selectedTool === 'tunnels') data = await request('tunnel.list')
      else if (!connected()) { toolData = []; body.innerHTML = '<div class="wb-empty">请先连接服务器</div>'; return }
      else {
        ;[data, platform] = await Promise.all([request(`system.${selectedTool}`, { sessionId }), lastSample ? Promise.resolve(lastSample) : request('system.snapshot', { sessionId })])
      }
      if (revision === toolRevision) { toolData = data; if (platform) lastSample = platform; renderTool(); if (silent) body.scrollTop = scroll }
    } catch (e) { if (revision === toolRevision) body.innerHTML = `<div class="wb-inline-error">${esc(e.message)}<p>请检查当前账号权限及服务器工具是否可用。</p></div>` }
  }
  function table(headers, rows) {
    const numeric = title => ['PID', 'CPU', '内存', '本地端口', '端口'].includes(title)
    const widths = headers.map(title => numeric(title) ? 90 : title === '操作' ? 260 : ['命令','来源 → 目标','说明','镜像','指纹'].includes(title) ? 280 : 160)
    const markup = document.createElement('template')
    markup.innerHTML = `<table class="wb-data-table" style="--table-width:${widths.reduce((sum, width) => sum + width, 0)}px"><colgroup>${widths.map(width => `<col style="width:${width}px">`).join('')}</colgroup><thead><tr>${headers.map(title => `<th scope="col" class="${numeric(title) ? 'numeric' : ''}">${esc(title)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
    for (const row of markup.content.querySelectorAll('tbody tr')) [...row.cells].forEach((cell, index) => { if (numeric(headers[index])) cell.classList.add('numeric'); if (headers[index] === '操作') cell.classList.add('actions'); else if (!cell.title) cell.title = cell.textContent })
    return markup.innerHTML
  }
  function renderTool() {
    const body = dock.querySelector('.wb-tool-body'), query = dock.querySelector('input').value.toLowerCase(), data = toolData.filter(x => JSON.stringify(x).toLowerCase().includes(query))
    dock.querySelector('.wb-tool-status').textContent = `${data.length} 项${lastSample?.platform ? ' · ' + ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows' })[lastSample.platform] : ''}`
    if (tool === 'tunnels') {
      body.innerHTML = `<div class="wb-table-actions"><button data-create-tunnel ${connected() ? '' : 'disabled'}>新建隧道</button><small>本地与远程监听均仅绑定 127.0.0.1</small></div>` + (data.length ? table(['方向', '本地端口', '目标', '操作'], data.map(x => `<tr><td>${x.direction === 'local' ? '本地转发' : '远程转发'}</td><td>${x.localPort}</td><td>${esc(x.remoteHost)}:${x.remotePort}</td><td><button data-close-tunnel="${esc(x.id)}">关闭</button></td></tr>`)) : '<div class="wb-empty">暂无隧道</div>')
      body.querySelector('[data-create-tunnel]').onclick = newTunnel
      body.querySelectorAll('[data-close-tunnel]').forEach(b => b.onclick = safe(async () => { await request('tunnel.close', { id: b.dataset.closeTunnel }); await loadTool() })); return
    }
    if (!data.length) { body.innerHTML = '<div class="wb-empty">暂无记录</div>'; return }
    const rows = data.slice(0, 2000)
    if (tool === 'processes') body.innerHTML = table(['PID','进程','用户','CPU','内存','操作'], rows.map(x => `<tr><td>${x.pid}</td><td title="${esc(x.name)}">${esc(x.name)}</td><td>${esc(x.user || '—')}</td><td>${x.cpuPercent == null ? '—' : x.cpuPercent.toFixed(1) + '%'}</td><td>${formatBytes(x.memoryBytes)}</td><td><button data-stop="${x.pid}" ${x.startTime && x.pid > 1 ? '' : 'disabled'}>${lastSample?.platform === 'win32' ? '终止' : '停止'}</button><button data-kill="${x.pid}" title="强制终止" ${x.startTime && x.pid > 1 ? '' : 'disabled'}>强制</button></td></tr>`))
    if (tool === 'ports') body.innerHTML = table(['协议','监听地址','端口','PID / 进程','操作'], rows.map(x => `<tr><td>${esc(x.protocol)}</td><td>${esc(x.address)}</td><td>${x.port}</td><td>${x.pid || '无权读取'} ${esc(x.process || '')}</td><td><button data-port-stop="${x.pid || ''}" ${x.pid > 1 ? '' : 'disabled'}>结束占用进程</button></td></tr>`))
    if (tool === 'services') body.innerHTML = table(['服务','状态','说明','操作'], rows.map((x,i) => `<tr><td>${esc(x.name)}</td><td>${esc(x.state)}</td><td>${esc(x.description || '')}</td><td>${['start','stop','restart'].map(op => `<button data-service="${i}" data-operation="${op}">${({ start:'启动',stop:'停止',restart:'重启' })[op]}</button>`).join('')}</td></tr>`))
    if (tool === 'docker') body.innerHTML = table(['容器','镜像','状态','端口','操作'], rows.map((x,i) => `<tr><td>${esc(x.Names)}</td><td>${esc(x.Image)}</td><td>${esc(x.Status)}</td><td>${esc(x.Ports)}</td><td>${['start','stop','restart','logs','inspect'].map(op => `<button data-docker="${i}" data-operation="${op}">${({ start:'启动',stop:'停止',restart:'重启',logs:'日志',inspect:'详情' })[op]}</button>`).join('')}</td></tr>`))
    if (tool === 'history') body.innerHTML = table(['命令','时间','操作'], rows.map((x,i) => `<tr><td><code>${esc(x.command)}</code></td><td>${new Date(x.ts).toLocaleString()}</td><td><button data-history="${i}">填入终端</button></td></tr>`))
    if (tool === 'transfers') body.innerHTML = table(['传输','来源 → 目标','进度','状态','操作'], rows.map(x => `<tr><td>${({ upload: '上传', download: '下载', copy: '服务器复制', move: '移动' })[x.direction] || x.direction}</td><td title="${esc(x.source)} → ${esc(x.destination)}">${esc(x.source.split(/[\\/]/).pop())} → ${esc(x.destination)}</td><td>${formatBytes(x.transferred)} / ${x.total ? formatBytes(x.total) : '计算中'}</td><td title="${esc(x.error || '')}">${({ queued:'等待中',running:'传输中',completed:'完成',failed:'失败',cancelled:'已取消' })[x.status]}${x.error ? `<small>${esc(x.error)}</small>` : ''}</td><td>${['running','queued'].includes(x.status) ? `<button data-cancel-transfer="${esc(x.id)}">取消</button>` : ['failed','cancelled'].includes(x.status) && x.canRetry !== false ? `<button data-retry-transfer="${esc(x.id)}">${x.resumable ? '校验并续传' : '重试'}</button>${x.resumable ? `<button data-restart-transfer="${esc(x.id)}">重新开始…</button>` : ''}${/已存在/.test(x.error || '') ? `<button data-overwrite-transfer="${esc(x.id)}">覆盖重试…</button>` : ''}` : ''}</td></tr>`))
    body.querySelectorAll('[data-stop],[data-kill],[data-port-stop]').forEach(button => button.onclick = safe(async () => {
      const sessionId = bridge.activeSession()?.sessionId
      const pid = Number(button.dataset.stop || button.dataset.kill || button.dataset.portStop), force = !!button.dataset.kill
      const processes = tool === 'ports' ? await request('system.processes') : toolData, process = processes.find(p => p.pid === pid)
      if (!process?.startTime) throw new Error('无法验证进程身份，请刷新列表')
      if (!await bridge.confirmDialog(`${lastSample?.platform === 'win32' ? 'Windows 将终止该进程。' : force ? '发送 SIGKILL，进程无法保存未完成的工作。' : '发送 SIGTERM，请求进程退出。'}\nPID ${pid} · ${process.name}`, { title: '确认结束进程', okText: '结束进程', danger: true })) return
      await request('process.signal', { sessionId, pid, startTime: process.startTime, signal: force ? 'KILL' : 'TERM', confirmed: true }); await loadTool()
    }))
    body.querySelectorAll('[data-service],[data-docker]').forEach(button => button.onclick = safe(async () => {
      const sessionId = bridge.activeSession()?.sessionId
      const isDocker = button.dataset.docker !== undefined, item = rows[Number(isDocker ? button.dataset.docker : button.dataset.service)], operation = button.dataset.operation
      if (!['logs','inspect'].includes(operation) && !await bridge.confirmDialog(`${button.textContent} ${item.Names || item.name}？`, { title: '确认服务器操作', okText: button.textContent, danger: operation !== 'start' })) return
      const result = await request(isDocker ? 'docker.action' : 'service.action', { sessionId, name: item.name, id: item.ID, operation, confirmed: true })
      if (['logs','inspect'].includes(operation)) inspect(`${item.Names} · ${button.textContent}`, result); else await loadTool()
    }))
    body.querySelectorAll('[data-history]').forEach(button => button.onclick = safe(() => fillCommand(rows[Number(button.dataset.history)].command)))
    body.querySelectorAll('[data-restart-transfer]').forEach(button => button.onclick = safe(async () => { if (!await bridge.confirmDialog('删除该任务的临时断点文件并从头开始？已成功传输的文件会保留。', { title: '重新开始传输', okText: '重新开始' })) return; await request('transfer.retry', { id: button.dataset.restartTransfer, operation: 'restart' }); await loadTool() }))
    body.querySelectorAll('[data-retry-transfer],[data-overwrite-transfer]').forEach(button => button.onclick = safe(async () => { const overwrite = !!button.dataset.overwriteTransfer; if (overwrite && !await bridge.confirmDialog('覆盖目标目录中的同名文件？已有文件将被替换。', { title: '覆盖重试', okText: '覆盖', danger: true })) return; await request('transfer.retry', { id: button.dataset.retryTransfer || button.dataset.overwriteTransfer, overwrite, confirmed: overwrite }); await loadTool() }))
    body.querySelectorAll('[data-cancel-transfer]').forEach(button => button.onclick = safe(async () => { await request('transfer.cancel', { id: button.dataset.cancelTransfer }); await loadTool() }))
  }
  function newTunnel() {
    const sessionId = bridge.activeSession()?.sessionId
    const dialog = createDialog({ title: '新建 SSH 隧道', content: '<form class="wb-settings-form"><label>方向<select name="direction"><option value="local">本地 → 服务器</option><option value="remote">服务器 → 本地</option></select></label><label>本地端口<input name="localPort" type="number" min="1" max="65535" required value="13306"></label><label>远程目标主机<input name="remoteHost" value="127.0.0.1" required></label><label>远程端口<input name="remotePort" type="number" min="1" max="65535" required value="3306"></label><small>反向转发目标固定为本机 127.0.0.1。若目标拒绝转发，请检查 sshd 配置。</small><button class="btn primary" type="submit">建立隧道</button></form>' })
    dialog.body.querySelector('form').onsubmit = event => { event.preventDefault(); void safe(async () => { const values = Object.fromEntries(new FormData(event.target)); await request('tunnel.open', { sessionId, ...values, localPort: Number(values.localPort), remotePort: Number(values.remotePort) }); dialog.close(); await loadTool() })() }
  }

  async function sample() {
    if (disposed || !connected() || sampleBusy || document.hidden) return
    const sessionId = bridge.activeSession().sessionId; sampleBusy = true
    publishResourceState({ loading: true })
    try {
      const value = await request('system.snapshot')
      if (disposed || bridge.activeSession()?.sessionId !== sessionId) return
      lastSample = value
      publishResourceState({ sample: value, sampledAt: value.ts || Date.now(), loading: false, error: '' })
      const network = value.net.reduce((sum,x) => sum + x.rxKbps + x.txKbps, 0)
      summary.innerHTML = `<button data-resource="processes"><span>CPU</span><strong>${percentage(value.cpuPercent)}</strong></button><button data-resource="processes"><span>内存</span><strong>${percentage(value.memPercent)}</strong><small>${formatBytes(value.memUsed)} / ${formatBytes(value.memTotal)}</small></button><button data-resource="disks"><span>磁盘</span><strong>${percentage(value.disks[0]?.usedPercent)}</strong></button><button data-resource="ports"><span>网络</span><strong>${network.toFixed(1)} KB/s</strong></button><span class="wb-platform">${({ linux:'Linux',darwin:'macOS',win32:'Windows' })[value.platform]}</span><button data-resource="ports">端口</button><button data-resource="processes">进程</button><button data-resource="integration">启用提示</button>`
      summary.querySelectorAll('[data-resource]').forEach(button => button.onclick = () => { const resource = button.dataset.resource; if (resource === 'integration') void registry.run('integration'); else if (resource === 'disks') inspect('磁盘使用', value.disks.map(d => `${d.mount} · ${percentage(d.usedPercent)} · ${formatBytes(d.used)} / ${formatBytes(d.total)}`).join('\n')); else openTool(resource) })
    } catch (e) {
      if (disposed || bridge.activeSession()?.sessionId !== sessionId) return
      publishResourceState({ loading: false, error: e?.message || '资源采集暂不可用' })
      summary.innerHTML = `<span class="wb-inline-error" title="${esc(e.message)}">资源采集暂不可用</span><button data-retry>重试</button><button data-integration>启用提示</button>`; summary.querySelector('[data-retry]').onclick = sample; summary.querySelector('[data-integration]').onclick = () => registry.run('integration')
    } finally {
      sampleBusy = false
      if (!disposed && connected() && bridge.activeSession()?.sessionId !== sessionId) void sample()
    }
  }
  function onWorkspaceChange(event) {
    const session = bridge.activeSession(), key = session?.sessionId || session?.tabId || ''
    const profile = store.findProfile(session?.profileId)
    context.querySelector('strong').textContent = session?.title || profile?.name || 'SSH 工作区'
    context.querySelector('.wb-session-target').textContent = profile ? `${profile.username}@${profile.host}:${profile.port || 22}` : '从左侧选择连接'
    context.querySelector('.wb-session-target').title = context.querySelector('.wb-session-target').textContent
    context.querySelector('.status-dot').className = `status-dot ${session?.status || ''}`
    context.querySelector('.wb-session-status').textContent = ({ connected: '已连接', connecting: '连接中', disconnected: '尚未重新连接', exited: '已退出' })[session?.status] || ''
    context.querySelector('[data-connect]').hidden = !!session?.sessionId || session?.status === 'connecting'
    context.querySelector('[data-hints]').disabled = !session?.sessionId
    statusbar.querySelector('.wb-connection-state').textContent = session ? `${store.findProfile(session.profileId)?.name || session.profileId} · ${session.status === 'connected' ? '已连接' : session.status === 'connecting' ? '连接中' : '未连接'}` : '未连接'
    statusbar.querySelector('.wb-connection-state').title = statusbar.querySelector('.wb-connection-state').textContent
    const changed = key !== activeKey
    publishResourceState({
      sessionId: session?.sessionId || null,
      name: session?.title || profile?.name || '',
      target: profile ? `${profile.username}@${profile.host}:${profile.port || 22}` : '',
      status: session?.status || 'idle',
      ...(changed ? { sample: null, sampledAt: 0, loading: connected(), error: '' } : {}),
    })
    if (changed) {
      activeKey = key; lastSample = null; toolRevision++; summary.innerHTML = connected() ? '<span>正在读取服务器资源…</span>' : '<span>连接后显示服务器资源</span>'
      if (mode !== 'panel') void files.refresh()
      void sample()
      if (mode !== 'panel' && dock.classList.contains('open')) void loadTool()
    }
    if (mode !== 'panel' && event?.detail?.connected) { if (app.dataset.compactNavigation === 'true') navigation.closeConnections(false); changeView('terminal') }
  }
  window.addEventListener('ssh-workspace-change', onWorkspaceChange)
  host?.on('ssh.exit', () => setTimeout(onWorkspaceChange, 0))
  onWorkspaceChange()
  bridge.refreshResources = sample
  let sampleTimer = setInterval(() => void sample(), Math.max(2000, Number(prefs.monitorInterval) || 5000))
  transferTimer = setInterval(() => { if (mode !== 'panel' && dock.classList.contains('open') && tool === 'transfers') void loadTool(true) }, 1000)
  host?.onOut?.(() => { /* Remote sessions and tasks remain alive; only visible work pauses. */ })
  host?.onDestroy?.(() => { disposed = true; delete bridge.refreshResources; clearInterval(sampleTimer); clearInterval(transferTimer); navigation.dispose(); fileObserver.disconnect(); for (const doc of editors.values()) doc.editor?.dispose?.() })
  host?.onEnter?.(event => { if (mode === 'panel') onWorkspaceChange(); else if (event.code === 'settings') void settings(); else if (event.code === 'files') changeView('files'); else onWorkspaceChange() })

  async function openFile(path) {
    const sessionId = bridge.activeSession()?.sessionId, key = `${sessionId}:${path}`
    if (!sessionId) throw new Error('请先连接服务器')
    if (!editors.has(key)) { const file = await request('files.read', { path }); editors.set(key, { key, path, sessionId, content: file.content, savedContent: file.content, hash: file.hash, dirty: false, editor: null, element: null }) }
    if (bridge.activeSession()?.sessionId !== sessionId) return
    activeEditor = key; changeView('files')
  }
  async function renderEditor() {
    const doc = editors.get(activeEditor); if (!doc) return
    const profile = store.findProfile([...bridge.sessions.values()].find(s => s.sessionId === doc.sessionId)?.profileId)
    editorPane.classList.add('open'); editorPane.innerHTML = `<div class="wb-editor-tabs">${[...editors.values()].map(x => `<button data-doc="${esc(x.key)}" title="${esc(x.path)}" class="${x.key === activeEditor ? 'active' : ''}">${esc(x.path.split('/').pop())}${x.dirty ? ' •' : ''}</button>`).join('')}<button data-save>保存</button><button data-reload>重新加载</button><button data-close>关闭</button></div><div class="wb-editor-path">${esc(profile?.name || doc.sessionId)} · ${esc(doc.path)}<span>保存前检查服务器版本 · UTF-8</span></div><div class="wb-editor-host"></div><div class="wb-editor-message"></div>`
    editorPane.querySelectorAll('[data-doc]').forEach(button => button.onclick = () => { activeEditor = button.dataset.doc; void renderEditor() })
    const target = editorPane.querySelector('.wb-editor-host')
    if (doc.element) { target.append(doc.element); doc.editor?.layout?.() }
    else {
      doc.element = document.createElement('div'); doc.element.className = 'wb-monaco-host'; target.append(doc.element)
      try {
        const { monaco } = await loadMonaco()
        doc.editor = monaco.editor.create(doc.element, { value: doc.content, language: /\.(json)$/.test(doc.path) ? 'json' : /\.(sh|bash|zsh)$/.test(doc.path) ? 'shell' : /\.(ya?ml)$/.test(doc.path) ? 'yaml' : 'plaintext', automaticLayout: true, minimap: { enabled: false }, fontSize: store.state.ui.fontSize || 13 })
        doc.editor.onDidChangeModelContent?.(() => { doc.content = doc.editor.getValue(); doc.dirty = doc.content !== doc.savedContent; const button = [...editorPane.querySelectorAll('[data-doc]')].find(x => x.dataset.doc === doc.key); if (button) button.textContent = doc.path.split('/').pop() + (doc.dirty ? ' •' : '') })
      } catch {
        const textarea = document.createElement('textarea'); textarea.value = doc.content; textarea.spellcheck = false; textarea.className = 'wb-code-fallback'; textarea.setAttribute('aria-label', '远程文件编辑器'); doc.element.append(textarea); textarea.oninput = () => { doc.content = textarea.value; doc.dirty = doc.content !== doc.savedContent }; editorPane.querySelector('.wb-editor-message').textContent = '基础文本编辑模式；构建 Monaco 后可使用语法高亮。'
      }
    }
    if (activeEditor !== doc.key) return
    editorPane.querySelector('[data-save]').onclick = safe(async () => { const savedContent = doc.content; const result = await request('files.write', { sessionId: doc.sessionId, path: doc.path, content: savedContent, expectedHash: doc.hash }); doc.hash = result.hash; doc.savedContent = savedContent; doc.dirty = doc.content !== savedContent; toast('已保存到服务器'); await renderEditor() })
    editorPane.querySelector('[data-reload]').onclick = safe(async () => { if (doc.dirty && !await bridge.confirmDialog('放弃本地未保存的修改，读取服务器版本？', { title: '重新加载', danger: true })) return; const value = await request('files.read', { sessionId: doc.sessionId, path: doc.path }); doc.content = doc.savedContent = value.content; doc.hash = value.hash; doc.dirty = false; doc.editor?.setValue?.(value.content); const textarea = doc.element.querySelector('textarea'); if (textarea) textarea.value = value.content })
    editorPane.querySelector('[data-close]').onclick = safe(async () => { if (doc.dirty && !await bridge.confirmDialog('文件尚未保存，放弃修改并关闭？', { title: '关闭文件', danger: true })) return; doc.editor?.dispose?.(); editors.delete(doc.key); activeEditor = [...editors.keys()].at(-1); if (activeEditor) await renderEditor(); else { editorPane.classList.remove('open'); changeView('terminal') } })
  }

  async function settings(section = 'terminal') {
    let existing = document.querySelector('.wb-settings-page'); if (existing) { existing.hidden = false; navigation.setView('settings'); if (section !== 'terminal') existing.querySelector(`[data-section="${section}"]`)?.click(); existing.querySelector('[data-back]').focus(); return }
    const returnFocus = document.activeElement
    const page = document.createElement('section'); page.className = 'wb-settings-page'; page.setAttribute('aria-label', 'SSH 设置'); main.append(page); navigation.setView('settings')
    page.innerHTML = `<header><button data-back>← 返回工作区</button><strong>SSH 设置</strong><span>仅作用于 SSH 插件</span></header><div class="wb-settings-layout"><nav>${[['appearance','界面主题'],['terminal','终端与历史'],['completion','命令提示'],['shortcuts','快捷键'],['monitor','资源监控'],['trust','可信服务器']].map(([id,label]) => `<button data-section="${id}">${label}</button>`).join('')}</nav><div class="wb-settings-content"></div></div>`
    const content = page.querySelector('.wb-settings-content')
    const close = () => { page.hidden = true; navigation.setView(view); if (returnFocus?.isConnected) returnFocus.focus(); else bridge.termFocus() }
    page.querySelector('[data-back]').onclick = close
    page.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } })
    async function show(next) {
      section = next; page.querySelectorAll('[data-section]').forEach(button => button.classList.toggle('active', button.dataset.section === next))
      if (next === 'appearance') {
        const paper = normalizePaper(store.state.ui.paper)
        content.innerHTML = `<h2>界面主题</h2><p>纸感手绘主题：墨色描边与纸面色板，仅作用于 SSH 插件界面；终端区保持等宽字体与自身底色。「跟随明暗」在浅色环境用白纸、深色环境用墨纸。</p><div class="wb-theme-options" role="group" aria-label="纸面界面主题">${PAPER_OPTIONS.map((item) => `<button type="button" class="wb-theme-option" data-paper-option="${item.id}" aria-pressed="${paper === item.id}"><span class="wb-theme-swatch" aria-hidden="true">${item.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span><span class="wb-theme-copy"><strong>${item.label}</strong><small>${item.desc}</small></span></button>`).join('')}</div>`
        content.querySelectorAll('[data-paper-option]').forEach((button) => button.onclick = () => {
          const next2 = normalizePaper(button.dataset.paperOption)
          store.setUi({ paper: next2 }, true)
          applyPaper(next2)
          content.querySelectorAll('[data-paper-option]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)))
        })
      }
      if (next === 'completion') renderCompletionSettings(content, { store, toast, integrate: enableSessionHints, connected, shortcuts: bridge.completionShortcuts })
      if (next === 'terminal') {
        content.innerHTML = `<h2>终端与历史</h2><form class="wb-settings-form"><label>终端字号<input name="fontSize" type="number" min="10" max="28" value="${store.state.ui.fontSize || 13}"></label><label><input type="checkbox" name="selectCopy" ${store.state.ui.selectCopy ? 'checked' : ''}>选中后复制</label><label><input type="checkbox" name="recordHistory" ${store.state.ui.recordHistory ? 'checked' : ''}>记录增强提示识别到的命令历史</label><label><input type="checkbox" name="maskHistory" ${store.state.ui.maskHistory ? 'checked' : ''}>历史中的常见密钥字段脱敏</label><p>历史仅采集明确的 Bash / Zsh 命令提示符。密码提示和全屏程序不参与采集。</p><button class="btn primary" type="submit">保存</button></form>`
        content.querySelector('form').onsubmit = event => { event.preventDefault(); const form = event.target; store.setUi({ fontSize: Math.min(28, Math.max(10, Number(form.fontSize.value))), selectCopy: form.selectCopy.checked, recordHistory: form.recordHistory.checked, maskHistory: form.maskHistory.checked }, true); for (const session of bridge.sessions.values()) session.term?.setFontSize(store.state.ui.fontSize); toast('设置已保存') }
      }
      if (next === 'shortcuts') {
        content.innerHTML = `<h2>快捷键</h2><p>当前平台使用 ${mac ? 'Command / Option' : 'Ctrl / Alt'}。点击输入框后按新组合键；Backspace 清除。系统保留组合与终端原生 Ctrl 键不应覆盖。</p><div class="wb-shortcut-list">${registry.list().map(command => `<label><span>${esc(command.label)}</span><input readonly data-binding="${command.id}" value="${esc(displaySshShortcut(registry.shortcut(command.id), mac))}" placeholder="未设置"></label>`).join('')}</div><button data-reset>恢复默认快捷键</button><h3>远端 shell 常用快捷键</h3><p><kbd>Ctrl+C</kbd> 中断 · <kbd>Ctrl+D</kbd> EOF / 退出 · <kbd>Ctrl+Z</kbd> 挂起 · <kbd>Ctrl+L</kbd> 清屏<br><kbd>Ctrl+A / E</kbd> 行首 / 行尾 · <kbd>Ctrl+U / K</kbd> 删至行首 / 行尾 · <kbd>Ctrl+W</kbd> 删前词 · <kbd>Ctrl+R</kbd> 搜索历史</p><small>这些按键原样发送给服务器；实际行为由远端 shell 决定。</small>`
        content.querySelectorAll('[data-binding]').forEach(input => input.onkeydown = event => {
          event.preventDefault(); event.stopPropagation(); if (event.isComposing || ['Meta','Control','Shift','Alt'].includes(event.key)) return
          const value = event.key === 'Backspace' && !event.metaKey && !event.ctrlKey ? '' : [event.metaKey || event.ctrlKey ? 'Mod' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join('+')
          if (isReservedSshShortcut(value, mac, input.dataset.binding)) { error(new Error(`此组合用于系统、远端终端或提示列表，请使用 ${mac ? 'Command' : 'Ctrl+Shift'} 组合键`)); return }
          try { registry.setBinding(input.dataset.binding, value); input.value = displaySshShortcut(value, mac); prefs.shortcuts = { ...registry.bindings }; void host.storage.set(PREFERENCES, prefs).catch(error) } catch (e) { error(e) }
        })
        content.querySelector('[data-reset]').onclick = () => { registry.bindings = {}; prefs.shortcuts = {}; void host.storage.set(PREFERENCES, prefs); void show('shortcuts') }
      }
      if (next === 'monitor') {
        content.innerHTML = `<h2>资源采集</h2><form class="wb-settings-form"><label>刷新间隔<select name="interval">${[2000,5000,10000,30000].map(n => `<option value="${n}" ${Number(prefs.monitorInterval) === n ? 'selected' : ''}>${n / 1000} 秒</option>`).join('')}</select></label><p>仅采集当前服务器。慢请求完成后才发起下一次，CPU 与网络速率按服务器独立计算。</p><button class="btn primary">保存</button></form>`
        content.querySelector('form').onsubmit = event => { event.preventDefault(); prefs.monitorInterval = Number(event.target.interval.value); clearInterval(sampleTimer); sampleTimer = setInterval(() => void sample(), prefs.monitorInterval); void host.storage.set(PREFERENCES, prefs); toast('刷新间隔已更新') }
      }
      if (next === 'trust') {
        content.innerHTML = '<h2>可信服务器</h2><p>首次连接记录指纹，后续指纹变化会阻止连接。移除前请通过其他渠道核实服务器身份。</p>'
        try { const hosts = await request('trust.list'); content.insertAdjacentHTML('beforeend', hosts.length ? table(['主机','指纹','首次连接','操作'], hosts.map((x,i) => `<tr><td>${esc(x.host)}:${x.port}</td><td><code>${esc(x.fingerprint)}</code></td><td>${new Date(x.firstSeen).toLocaleString()}</td><td><button data-forget="${i}">移除</button></td></tr>`)) : '<div class="wb-empty">尚无信任记录</div>'); content.querySelectorAll('[data-forget]').forEach(button => button.onclick = safe(async () => { const item = hosts[Number(button.dataset.forget)]; if (!await bridge.confirmDialog(`移除 ${item.host}:${item.port} 的已保存指纹？下次连接将重新建立信任。`, { title: '移除服务器信任', danger: true })) return; await request('trust.remove', { name: `${item.host}:${item.port}`, confirmed: true }); await show('trust') })) } catch (e) { content.insertAdjacentHTML('beforeend', `<p class="wb-inline-error">${esc(e.message)}</p>`) }
      }
    }
    page.querySelectorAll('[data-section]').forEach(button => button.onclick = () => void show(button.dataset.section))
    await show(section)
    page.querySelector('[data-back]').focus()
  }
  if (host?.getEnterCode?.() === 'settings') void settings()
}

if (window.SshWorkbenchBridge) void boot()
else window.addEventListener('ssh-workbench-ready', () => void boot(), { once: true })
