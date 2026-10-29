/** Unified connection-bound work tabs. Hidden panels retain drafts, selection and results. */
import { PAGES } from '@mw/pages/index.js'
import { KIND_META, kindDot, el, escapeHtml } from './components.js'
import api from './api.js'
import store from './store.js'
import { bindTaskApi } from './workspace.js'
import { SessionCoordinator } from './sessionCoordinator.js'
import { refreshStatus } from './status.js'

let appMode = 'shell'
const modules = new Map()
const surfacePanels = { shell: new Map(), quick: new Map() }
const sharedPanels = new Map()
const allPanels = () => [...Object.values(surfacePanels), sharedPanels]
let panels = surfacePanels.shell
const activatedConnections = new Set()
const sessions = new SessionCoordinator({
  open: (key, configuration) => api.openConnection(configuration.connection, { sessionKey: key, readOnly: configuration.readOnly }),
  close: key => api.closeConnection(key)
})
export const sessionKeyFor = connectionId => appMode === 'quick' ? `mw:quick:${connectionId}` : api.sessionKeyOf(connectionId)

export function setMode(mode) {
  const next = mode === 'quick' ? 'quick' : 'shell'
  if (appMode !== next) { for (const record of panels.values()) record.node.hidden = true }
  appMode = next
  panels = surfacePanels[next]
}
export function forgetSessionCaps(connectionId) {
  for (const key of [api.sessionKeyOf(connectionId), `mw:quick:${connectionId}`]) void sessions.invalidate(key)
  for (const collection of Object.values(surfacePanels)) for (const [id, record] of collection) if (record.connectionId === connectionId) disposePanel(id, collection)
}
function disposePanel(id, collection = panels) {
  const record = collection.get(id)
  if (!record) return
  record.alive = false
  try { record.instance?.destroy?.() } catch { /* Closing one page must not block others. */ }
  record.node.remove()
  collection.delete(id)
}
export function disposePanels() { for (const collection of allPanels()) for (const id of collection.keys()) disposePanel(id, collection) }

export async function ensureSession(connectionId) {
  const connection = store.getConnection(connectionId ?? store.activeTab)
  if (!connection) return null
  const info = await sessions.ensure(sessionKeyFor(connection.id), { connection, readOnly: appMode === 'quick' || !!connection.readOnly })
  return { caps: info?.capabilities || {}, queryModes: info?.messageQueryModes || null }
}

export function visiblePages(kind) { return PAGES.filter(page => !page.kinds || page.kinds.includes(kind)) }
function notifyNavigation() { document.dispatchEvent(new CustomEvent('mw-navigation-changed')) }

function renderTabs() {
  const root = document.getElementById('conn-tabs')
  root.replaceChildren()
  for (const task of store.tasks) {
    const connection = store.getConnection(task.connectionId)
    const page = task.pageId === 'settings' ? { title: '设置' } : PAGES.find(page => page.id === task.pageId)
    if ((!connection && task.pageId !== 'settings') || !page) continue
    const title = connection ? `${page.title} · ${connection.name}` : '插件设置'
    const tab = el('div', { class: `conn-tab${store.activeTask === task.id ? ' on' : ''}`, role: 'tab', tabindex: store.activeTask === task.id ? '0' : '-1', 'aria-selected': String(store.activeTask === task.id), 'aria-controls': `panel-${task.pageId === 'settings' ? 'shared' : appMode}-${task.id}`, 'data-task': task.id, title }, [
      connection ? el('span', { html: kindDot(connection.kind) }) : el('span', {}, '⚙'),
      el('span', { class: 'label' }, page.title),
      el('span', { class: 'tab-connection' }, connection?.name || ''),
      el('button', { class: 'x', 'aria-label': `关闭 ${title}`, title: '关闭标签', onclick: event => { event.stopPropagation(); closeTaskTab(task.id) } }, '×')
    ])
    tab.addEventListener('click', () => { store.activateTask(task.id); renderAll() })
    tab.addEventListener('keydown', event => {
      if (event.key === 'Delete') { event.preventDefault(); closeTaskTab(task.id); return }
      const tabs = [...root.querySelectorAll('[role=tab]')]
      let index = tabs.indexOf(tab)
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length
      else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length
      else if (event.key === 'Home') index = 0
      else if (event.key === 'End') index = tabs.length - 1
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tab.click(); return }
      else return
      event.preventDefault(); tabs[index].focus(); tabs[index].click()
      root.querySelector(`[data-task="${CSS.escape(store.activeTask)}"]`)?.focus()
    })
    root.append(tab)
  }
  if (!store.tasks.length) root.append(el('span', { class: 'tabs-placeholder' }, '工作区'))
}

export function closeTaskTab(id = store.activeTask) {
  const task = store.tasks.find(task => task.id === id)
  if (!task) return
  if (allPanels().some(collection => collection.get(id)?.instance?.beforeClose?.() === false)) return
  for (const collection of allPanels()) disposePanel(id, collection)
  store.closeTask(id)
  if (task.connectionId && !store.tasks.some(item => item.connectionId === task.connectionId)) closeSession(task.connectionId)
  renderAll()
}
function closeSession(connectionId) {
  forgetSessionCaps(connectionId)
  activatedConnections.delete(connectionId)
  void api.forgetConnection(connectionId)
}
export function closeConnTab(connectionId) {
  for (const task of [...store.tasks]) if (task.connectionId === connectionId) { disposePanel(task.id); store.closeTask(task.id) }
  store.closeTab(connectionId)
  closeSession(connectionId)
  renderAll()
}
export async function openConnTab(connectionId) { activateWithPage(connectionId) }
export function openSettings() { store.openTask(null, 'settings'); renderAll() }
export function activateWithPage(connectionId, pageId) {
  const connection = store.getConnection(connectionId)
  if (!connection) return
  const target = pageId || store.ui.lastPage[connectionId] || 'overview'
  if (!visiblePages(connection.kind).some(page => page.id === target)) return
  activatedConnections.add(connectionId)
  store.openTask(connectionId, target)
  renderAll()
}

function renderContext(connection, task) {
  const root = document.getElementById('subnav')
  root.replaceChildren()
  if (task?.pageId === 'settings') { root.append(el('span', { class: 'context-connection' }, '界面主题、快捷键与输入提示')); return }
  if (!connection) return
  root.append(el('span', { class: 'context-connection', title: connection.name }, `${connection.name} · ${KIND_META[connection.kind]?.label || connection.kind}`))
  for (const page of visiblePages(connection.kind)) {
    root.append(el('button', { class: page.id === task.pageId ? 'on' : '', 'data-page': page.id, onclick: () => activateWithPage(connection.id, page.id) }, page.title))
  }
  root.append(el('span', { class: 'subnav-right' }, appMode === 'quick' || connection.readOnly ? '只读' : '可读写'))
}

async function mountSettings(task) {
  if (sharedPanels.has(task.id)) return
  const node = el('section', { class: 'page', id: `panel-shared-${task.id}`, role: 'tabpanel', 'data-page-panel': 'settings', 'aria-label': '中间件设置' })
  const record = { node, alive: true, instance: null }
  sharedPanels.set(task.id, record); document.getElementById('page-host').append(node)
  try {
    const module = await import('@mw/pages/settings.js')
    if (!record.alive) return
    record.instance = Object.create(module.default)
    record.instance.render(node, { store, api })
  } catch (error) { if (record.alive) node.textContent = `无法打开设置：${error.message}` }
}

async function mountTask(task, connection) {
  const key = `${appMode}:${JSON.stringify(connection)}`
  const existing = panels.get(task.id)
  if (existing?.key === key && !(existing.placeholder && activatedConnections.has(connection.id))) return
  if (existing) disposePanel(task.id)
  const node = el('section', { class: 'page', id: `panel-${appMode}-${task.id}`, role: 'tabpanel', 'data-page-panel': task.pageId, 'aria-label': `${connection.name} · ${task.pageId}` })
  const record = { node, key, connectionId: connection.id, alive: true, instance: null }
  panels.set(task.id, record)
  document.getElementById('page-host').append(node)
  if (!activatedConnections.has(connection.id)) {
    record.placeholder = true
    node.append(el('div', { class: 'workspace-empty' }, [
      el('h1', {}, '尚未重新读取'),
      el('p', {}, '标签与布局已恢复。连接后再读取当前页面的数据。'),
      el('button', { class: 'btn primary', 'data-resume-task': task.id, onclick: () => { activatedConnections.add(connection.id); disposePanel(task.id); renderAll() } }, '连接并读取')
    ]))
    return
  }
  node.innerHTML = '<div class="empty-cap" role="status">正在连接并读取工作区…</div>'
  const mode = appMode
  const sessionKey = sessionKeyFor(connection.id)
  try {
    const capabilities = await ensureSession(connection.id)
    if (!record.alive) return
    if (!modules.has(task.pageId)) modules.set(task.pageId, PAGES.find(page => page.id === task.pageId).page())
    const mod = await modules.get(task.pageId)
    if (!record.alive) return
    const instance = Object.create(mod.default || mod)
    record.instance = instance
    node.replaceChildren()
    const scopedApi = bindTaskApi(api, sessionKey, { isAlive: () => record.alive, mode, readOnly: connection.readOnly, kind: connection.kind })
    await instance.render(node, {
      api: scopedApi, store, conn: { ...connection }, sessionKey, ...capabilities, mode,
      isActive: () => record.alive && store.activeTask === task.id && appMode === mode,
      switchPage: pageId => activateWithPage(connection.id, pageId), refreshStatus
    })
  } catch (error) {
    if (!record.alive) return
    node.innerHTML = `<div class="empty-cap" role="alert"><p>${escapeHtml(error?.message || '工作区读取失败')}</p></div>`
    node.firstElementChild.append(el('button', { class: 'btn', onclick: () => { disposePanel(task.id); renderAll() } }, '重试连接'))
  }
}

export function renderAll() {
  for (const collection of allPanels()) for (const [id] of collection) if (!store.tasks.some(task => task.id === id)) disposePanel(id, collection)
  renderTabs()
  const task = store.tasks.find(task => task.id === store.activeTask)
  const connection = store.getConnection(task?.connectionId)
  renderContext(connection, task)
  for (const collection of allPanels()) for (const [id, panel] of collection) panel.node.hidden = id !== task?.id || collection !== panels && collection !== sharedPanels
  document.getElementById('workspace-empty')?.remove()
  if (task?.pageId === 'settings') {
    void mountSettings(task)
  } else if (task && connection) {
    void mountTask(task, connection)
  } else {
    const empty = el('div', { id: 'workspace-empty', class: 'workspace-empty' }, [el('h1', {}, '开始一个中间件任务'), el('p', {}, '从左侧选择连接，浏览 Topic、查看消息或编辑发送内容。'), el('button', { class: 'btn primary', onclick: () => import('./connections.js').then(module => module.openConnectionDrawer()) }, '新建连接')])
    document.getElementById('page-host').append(empty)
  }
  notifyNavigation()
  refreshStatus(connection || null)
}
