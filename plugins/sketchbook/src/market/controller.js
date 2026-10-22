/**
 * 素描本工作区控制器
 *
 * 只消费宿主注入的受限 enestWorkspace 桥：不读 shellApi、不读设置全量。
 * 协议要点（见 docs/site/plugin/home.md）：
 *   1. 先订阅 onAppearance / onCommand，再并发读取首屏数据；
 *   2. 渲染完成并过一帧后才 ready；收到 navigate 后再 ackNavigation；
 *   3. 隐藏预热视图不触发 rAF，所以绘制屏障必须与短定时器竞速；
 *   4. 一切异步返回都校验 generation / revision / 请求序号，过期即丢弃。
 */

const MAX_README_BYTES = 1024 * 1024
const PAINT_FALLBACK_MS = 60

/** 隐藏视图里 rAF 可能永不触发，用双 rAF 与定时器竞速，避免卡住 ready 握手。 */
function paintBarrier(custom) {
  const fallback = () => new Promise(resolve => {
    const hasRaf = typeof requestAnimationFrame === 'function'
    let frame = 0
    const done = () => { clearTimeout(timer); if (hasRaf) cancelAnimationFrame(frame); resolve() }
    if (hasRaf) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done) })
    const timer = setTimeout(done, PAINT_FALLBACK_MS)
  })
  return custom ? Promise.race([custom(), fallback()]) : fallback()
}

/** README 只允许目录条目的 readme 槽位，禁止任意 URL 与跨插件读取。 */
async function loadReadme(pluginId, url, signal) {
  const expected = `enest-home://catalog/${encodeURIComponent(pluginId)}/readme`
  if (url !== expected) throw new Error('unsupported readme resource')
  const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal })
  if (!response.ok) throw new Error('readme unavailable')
  const length = response.headers.get('content-length')
  if (length && Number(length) > MAX_README_BYTES) throw new Error('readme too large')
  const text = await response.text()
  if (text.length > MAX_README_BYTES) throw new Error('readme too large')
  return text.trim()
}

export function createController(bridge, hooks = {}) {
  // 开发预览（本地 mock）没有 enest-home 协议，用注入的只读文本替身；生产路径不经过这里。
  const readme = hooks.loadReadme ?? loadReadme
  let state = {
    appearance: null,
    config: null,
    catalog: null,
    detail: null,
    detailStatus: 'idle',
    readme: null,
    quickResults: null,
    route: { page: 'catalog' },
    basePage: 'catalog',
    query: '',
    category: '全部',
    loading: true,
    refreshing: false,
    busy: new Set(),
    notice: null,
    visible: false,
  }
  const listeners = new Set()
  let disposed = false
  let bootstrapping = true
  const pending = []
  let navigationSeq = 0
  let detailSeq = 0
  let searchSeq = 0
  let refreshSeq = 0
  let searchTimer
  let readmeAbort
  let offAppearance
  let offCommand

  const patch = next => {
    if (disposed) return
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }
  const zh = (cn, en) => state.config?.locale === 'en-US' ? en : cn
  const afterPaint = () => paintBarrier(hooks.afterPaint)

  function acceptAppearance(snapshot) {
    if (disposed || !snapshot?.appearance) return false
    const generation = snapshot.generation ?? (state.appearance?.generation ?? 0)
    const previous = state.appearance
    if (previous && Number.isSafeInteger(generation) && generation < previous.generation) return false
    if (previous && snapshot.appearance.revision < previous.appearance.revision) return false
    const replaced = previous && (generation !== previous.generation ||
      snapshot.appearance.theme?.id !== previous.appearance.theme?.id ||
      snapshot.appearance.theme?.source !== previous.appearance.theme?.source)
    if (replaced) {
      navigationSeq++; detailSeq++
      cancelReadme()
    }
    patch({ appearance: snapshot, ...(replaced ? {
      generation, route: { page: state.basePage }, detail: null, detailStatus: 'idle', readme: null,
    } : {}) })
    hooks.applyAppearance?.(snapshot)
    return true
  }

  function acceptCatalog(catalog) {
    if (disposed || !catalog) return
    if (state.catalog && catalog.revision < state.catalog.revision) return
    patch({ catalog })
  }

  async function runSearch(query) {
    const text = query.trim()
    const seq = ++searchSeq
    if (!text) { patch({ quickResults: null }); return }
    try {
      const result = await bridge.search({ query: text, scope: 'all', limit: 6 })
      if (disposed || seq !== searchSeq) return
      patch({ quickResults: result })
    } catch {
      if (!disposed && seq === searchSeq) patch({ quickResults: null })
    }
  }

  function setQuery(query, { composing = false } = {}) {
    clearTimeout(searchTimer)
    searchSeq++
    patch({ query, quickResults: query === state.query && !composing ? state.quickResults : null })
    if (query.trim() && !composing) searchTimer = setTimeout(() => void runSearch(query), 90)
  }

  async function refreshCatalog() {
    const seq = ++refreshSeq
    patch({ refreshing: true, notice: null })
    try {
      const catalog = await bridge.refresh({ reason: 'manual' })
      if (!disposed && seq === refreshSeq) acceptCatalog(catalog)
    } catch {
      if (!disposed && seq === refreshSeq) patch({ notice: zh('刷新失败，本地目录仍然可用。', 'Refresh failed. The local catalog is still available.') })
    } finally {
      if (!disposed && seq === refreshSeq) patch({ refreshing: false })
    }
  }

  async function act(request) {
    const result = await bridge.action(request)
    if (!result?.ok) throw new Error(result?.error || zh('操作失败或已取消。', 'The action failed or was cancelled.'))
  }

  async function navigate(route) {
    try { await act({ type: 'navigate', route }) }
    catch (error) { patch({ notice: error.message }) }
  }

  async function openPlugin(pluginId) {
    try { await act({ type: 'openPlugin', pluginId }) }
    catch (error) { patch({ notice: error.message }) }
  }

  async function activateSearchHandle(handle) {
    try { await act({ type: 'activateSearchResult', handle }) }
    catch (error) { patch({ notice: error.message }) }
  }

  function cancelReadme() { readmeAbort?.abort(); readmeAbort = undefined }

  async function loadDetailReadme(detail, seq, generation) {
    if (!detail.readmeUrl) { patch({ readme: { status: 'empty' } }); return }
    const current = () => !disposed && seq === detailSeq && generation === state.generation &&
      state.route.page === 'detail' && state.detail?.pluginId === detail.pluginId
    const controller = new AbortController()
    readmeAbort = controller
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const text = await readme(detail.pluginId, detail.readmeUrl, controller.signal)
      if (current()) patch({ readme: text ? { status: 'ok', text } : { status: 'empty' } })
    } catch {
      if (current()) patch({ readme: { status: 'error' } })
    } finally {
      clearTimeout(timer)
      if (readmeAbort === controller) readmeAbort = undefined
    }
  }

  async function showDetail(pluginId) {
    const seq = ++detailSeq
    const generation = state.generation
    const current = () => !disposed && seq === detailSeq && generation === state.generation &&
      state.route.page === 'detail' && state.route.pluginId === pluginId
    cancelReadme()
    patch({ detail: null, detailStatus: 'loading', readme: { status: 'loading' } })
    try {
      const detail = await bridge.getDetail(pluginId)
      if (!current()) return false
      if (!detail || detail.pluginId !== pluginId) throw new Error('detail unavailable')
      patch({ detail, detailStatus: 'ready', readme: { status: detail.readmeUrl ? 'loading' : 'empty' } })
      void loadDetailReadme(detail, seq, generation)
      return true
    } catch {
      if (current()) patch({ detailStatus: 'error', readme: null })
      return false
    }
  }

  async function manage(request, pluginId) {
    if (state.busy.has(pluginId)) return
    patch({ busy: new Set([...state.busy, pluginId]), notice: null })
    try {
      await act(request)
      await refreshCatalogSilently()
      if (!disposed && state.route.page === 'detail' && state.route.pluginId === pluginId) {
        const seq = detailSeq
        const generation = state.generation
        const detail = await bridge.getDetail(pluginId)
        if (!disposed && seq === detailSeq && generation === state.generation &&
          state.route.page === 'detail' && state.route.pluginId === pluginId && detail?.pluginId === pluginId) patch({ detail })
      }
    } catch (error) {
      patch({ notice: error.message })
    } finally {
      patch({ busy: new Set([...state.busy].filter(id => id !== pluginId)) })
    }
  }

  async function refreshCatalogSilently() {
    try {
      const catalog = await bridge.refresh({ reason: 'boot' })
      if (!disposed) acceptCatalog(catalog)
    } catch { /* 本地目录仍是权威，静默失败 */ }
  }

  function routeAccepted(command) {
    if (!Number.isSafeInteger(command.generation) || !Number.isFinite(command.revision)) return false
    if (state.generation && command.generation !== state.generation) return false
    return command.revision >= (state.appearance?.appearance.revision ?? 0)
  }

  async function navigateWorkspace(command) {
    if (!routeAccepted(command)) return
    const seq = ++navigationSeq
    detailSeq++
    cancelReadme()
    const route = command.route
    patch({
      route, generation: command.generation, detail: null, detailStatus: route.page === 'detail' ? 'loading' : 'idle', readme: null,
      ...(route.page === 'detail' ? {} : { basePage: route.page }),
    })
    try {
      // 先渲染 loading；只有详情数据及其 DOM 就绪才成功 ACK，README 可继续异步。
      if (route.page === 'detail' && !await showDetail(route.pluginId)) throw new Error('detail unavailable')
      await afterPaint()
      if (disposed || seq !== navigationSeq) return
      await bridge.ackNavigation({ requestId: command.requestId, generation: command.generation, ok: true })
    } catch {
      if (!disposed && seq === navigationSeq) {
        await bridge.ackNavigation({ requestId: command.requestId, generation: command.generation, ok: false }).catch(() => undefined)
      }
    }
  }

  function handleCommand(command) {
    if (disposed || !command) return
    if (command.type === 'visibility') {
      patch({ visible: command.visible })
      hooks.applyVisibility?.(command.visible)
      return
    }
    if (bootstrapping) { if (pending.length < 32) pending.push(command); return }
    switch (command.type) {
      case 'navigate': void navigateWorkspace(command); break
      case 'openMarket': {
        if (!routeAccepted(command)) return
        navigationSeq++
        detailSeq++
        cancelReadme()
        setQuery('')
        patch({
          route: command.pluginId ? { page: 'detail', pluginId: command.pluginId } : { page: 'catalog' },
          basePage: 'catalog', generation: command.generation, detail: null,
          detailStatus: command.pluginId ? 'loading' : 'idle', readme: null,
        })
        if (command.pluginId) void showDetail(command.pluginId)
        break
      }
      case 'refresh': void refreshCatalog(); break
      case 'settingsChanged':
        void bridge.getConfig().then(config => { if (!disposed) patch({ config }) }).catch(() => undefined)
        break
      case 'install': {
        if (command.pluginId) {
          const busy = new Set(state.busy)
          if (command.status === 'queued' || command.status === 'progress') busy.add(command.pluginId)
          else busy.delete(command.pluginId)
          patch({ busy })
        }
        if (command.status === 'done' || command.status === 'error') void refreshCatalogSilently()
        if (command.status === 'error') patch({ notice: zh('安装失败，可在宿主查看详情或重试。', 'Installation failed. Check the host or retry.') })
        break
      }
      default: break
    }
  }

  async function start() {
    offAppearance = bridge.onAppearance(acceptAppearance)
    offCommand = bridge.onCommand(handleCommand)
    const [appearance, config, catalog] = await Promise.allSettled([
      bridge.getAppearance(), bridge.getConfig(), bridge.getCatalog(),
    ])
    if (disposed) return
    if (appearance.status === 'fulfilled') acceptAppearance(appearance.value)
    if (config.status === 'fulfilled') patch({ config: config.value })
    if (catalog.status === 'fulfilled') acceptCatalog(catalog.value)
    patch({ loading: false })
    if (!state.appearance) {
      patch({ notice: zh('外观服务暂时不可用，请从宿主重试。', 'Appearance is unavailable. Retry from the host.') })
      return
    }
    bootstrapping = false
    pending.splice(0).forEach(handleCommand)
    await afterPaint()
    if (!disposed) {
      await bridge.ready({
        revision: state.appearance.appearance.revision,
        workspaceVersion: 1,
        routes: ['catalog', 'installed', 'detail'],
      })
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    navigationSeq++; detailSeq++; searchSeq++; refreshSeq++
    clearTimeout(searchTimer)
    cancelReadme()
    pending.length = 0
    offAppearance?.(); offCommand?.(); listeners.clear()
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start, dispose,
    setQuery, setCategory: category => patch({ category }),
    navigate, openPlugin, activateSearchHandle, manage,
    refreshCatalog, dismissNotice: () => patch({ notice: null }),
  }
}
