/* DshViews — 小窗驾驶舱 / 大桌面完全体 / 引导态渲染
   视觉纪律（taste-skills 05 极简）：发丝线分隔、排印对比、焰橙只用于
   选中指示与运行态、无投影、入场 12px 上移淡入级联。 */
;(() => {
  const { esc } = window.DshApi
  const { state } = window.DshState
  const $root = () => document.getElementById('root')

  const ICONS = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
  }

  function el(html) {
    const t = document.createElement('template')
    t.innerHTML = html.trim()
    return t.content.firstElementChild
  }

  // —— 事件投影：durable session event → 展示行 ——
  function pickText(value) {
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(pickText).filter(Boolean).join('\n')
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return value.text
      if (typeof value.content === 'string') return value.content
      if (value.content) return pickText(value.content)
      if (typeof value.summary === 'string') return value.summary
    }
    return ''
  }

  function renderEvent(ev, index) {
    if (!ev || typeof ev !== 'object') return ''
    const type = String(ev.type ?? ev.kind ?? '')
    const ts = ev.timestamp || ev.ts || ev.time
    const meta = ts ? new Date(Number(ts) || ts).toTimeString().slice(0, 8) : type
    let body = ''
    let cls = 'evt'
    if (type === 'user/message') {
      cls += ' evt-user'
      body = esc(pickText(ev.message ?? ev).slice(0, 600))
    } else if (type === 'assistant/message') {
      body = esc(pickText(ev.message ?? ev).slice(0, 1200))
    } else if (type === 'tool/call') {
      const name = ev.name || ev.tool || ev.toolName || 'tool'
      body = `<span class="tool-line">tool ${esc(String(name))}</span>`
    } else if (type === 'tool/result') {
      const name = ev.name || ev.tool || ev.toolName || 'tool'
      const ok = ev.ok !== false && ev.error == null
      body = `<span class="tool-line">tool ${esc(String(name))} ${ok ? '✓' : '✗'}</span>`
    } else if (type === 'turn/start') {
      body = '<span class="tool-line">turn 开始</span>'
    } else if (type === 'turn/end') {
      body = '<span class="tool-line">turn 结束</span>'
    } else if (type === 'step/start' || type === 'step/end') {
      return '' // 噪音行折叠
    } else if (type) {
      body = `<span class="tool-line">${esc(type)}</span>`
    } else {
      return ''
    }
    return `<div class="${cls} dsh-enter" style="--index:${index}"><span class="evt-meta">${esc(meta)}</span><div class="evt-body">${body || '<span class="tool-line">…</span>'}</div></div>`
  }

  // —— 小窗驾驶舱 ——
  function renderCockpit() {
    const root = $root()
    const s = state
    const running = Object.entries(s.liveStatus).filter(([, v]) => v === 'running').map(([k]) => k)
    const head = `
      <div class="cockpit-head">
        <span class="dot ${running.length ? 'dot-run' : s.runtime?.available ? 'dot-ok' : 'dot-err'}"></span>
        <span class="cockpit-title">DSH 驾驶舱</span>
        <span class="cockpit-sub">${running.length ? `${running.length} 个会话运行中` : s.runtime?.version ? `v${esc(s.runtime.version)}` : ''}</span>
        <span style="flex:1"></span>
        <button class="icon-btn" data-act="new-session" title="新快速会话">${ICONS.plus}</button>
        <button class="icon-btn" data-act="settings" title="设置">${ICONS.gear}</button>
      </div>`
    const chips = s.sessions.length
      ? s.sessions
          .map((item) => {
            const live = s.liveStatus[item.sessionId] === 'running'
            const active = item.sessionId === s.currentSessionId
            return `<button class="session-chip ${active ? 'active' : ''}" data-session="${esc(item.sessionId)}">
              <span class="dot ${live ? 'dot-run' : ''}" style="width:5px;height:5px"></span>
              <span class="chip-title">${esc(item.title || item.sessionId)}</span>
            </button>`
          })
          .join('')
      : '<span class="evt-empty">暂无会话 — 在下方开始快速对话，或在完全体里跑任务</span>'
    const events = s.events.length
      ? s.events.map((ev, i) => renderEvent(ev, i)).join('')
      : '<div class="evt-empty">选择上方会话查看进度，或直接在下方发起快速对话。</div>'
    const sdkErr = s.sdkError
      ? `<div class="evt"><span class="evt-meta">sdk</span><div class="evt-body"><span class="tool-line" style="color:var(--danger)">${esc(s.sdkError)}</span>
         <button class="btn-ghost" data-act="open-full" style="margin-left:8px;padding:2px 8px;font-size:11px">去完全体配置模型</button></div></div>`
      : ''
    root.innerHTML = `
      <div class="cockpit dsh-enter">
        ${head}
        <div class="sessions">${chips}</div>
        <div class="activity" id="activity">${events}${sdkErr}</div>
        <div class="composer">
          <div class="composer-row">
            <textarea id="composer-input" placeholder="快速对话… Enter 发送，Shift+Enter 换行" rows="1"></textarea>
            <button class="btn" id="composer-send">发送</button>
          </div>
          <div class="composer-hint">${esc(s.prefs.provider)} · ${esc(s.prefs.model)}</div>
        </div>
      </div>`
    const activity = root.querySelector('#activity')
    activity.scrollTop = activity.scrollHeight
    root.querySelector('#composer-send').addEventListener('click', () => void sendComposer())
    const input = root.querySelector('#composer-input')
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void sendComposer()
      }
    })
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = `${Math.min(120, input.scrollHeight)}px`
    })
    root.querySelectorAll('[data-session]').forEach((node) =>
      node.addEventListener('click', () => window.DshState.loadSession(node.dataset.session))
    )
    root.querySelectorAll('[data-act]').forEach((node) =>
      node.addEventListener('click', () => {
        if (node.dataset.act === 'settings') window.DshRouter.go('settings')
        if (node.dataset.act === 'open-full') window.DshRouter.go('shell')
        if (node.dataset.act === 'new-session') void window.DshState.newQuickSession()
      })
    )
  }

  async function sendComposer() {
    const input = document.getElementById('composer-input')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    input.style.height = 'auto'
    await window.DshState.ensureSdk()
    try {
      await window.DshState.sendPrompt(text)
    } catch (error) {
      window.DshApi.notice(`发送失败：${String(error.message || error)}`, 'error')
    }
  }

  // —— 大桌面（完全体） ——
  function renderShell() {
    const root = $root()
    const s = state
    const web = s.status?.web
    const ready = web?.running && web?.readyUrl
    const runtime = s.runtime
    if (runtime && !runtime.available) {
      renderGuide(runtime)
      return
    }
    const port = web?.port ? `127.0.0.1:${web.port}` : s.webBooting ? '启动中…' : '未运行'
    root.innerHTML = `
      <div class="dsh-enter" style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div class="shellbar">
          <span class="dot ${ready ? 'dot-ok' : s.webBooting ? 'dot-run' : web?.lastError ? 'dot-err' : ''}"></span>
          <span>DSH 完全体</span>
          <span class="port">${esc(String(port))}${web?.profile && web.profile !== 'web' ? ` · ${esc(web.profile)}` : ''}</span>
          <span class="sep"></span>
          <button class="icon-btn" data-act="restart" title="重启服务">${ICONS.restart}</button>
          <button class="icon-btn" data-act="browser" title="在浏览器打开">${ICONS.external}</button>
          <button class="icon-btn" data-act="settings" title="设置">${ICONS.gear}</button>
        </div>
        ${ready ? `<iframe class="web-frame" id="web-frame" src="${esc(web.readyUrl)}" allow="clipboard-read; clipboard-write"></iframe>` : renderShellBoot()}
      </div>`
    root.querySelectorAll('[data-act]').forEach((node) =>
      node.addEventListener('click', async () => {
        const act = node.dataset.act
        if (act === 'settings') window.DshRouter.go('settings')
        if (act === 'restart') {
          await window.DshApi.call('web.restart', {})
          window.DshState.commit({ webBooting: true })
        }
        if (act === 'browser' && web?.readyUrl) window.DshApi.openExternal(web.readyUrl)
      })
    )
    const bootBtn = root.querySelector('[data-boot]')
    if (bootBtn) bootBtn.addEventListener('click', () => void window.DshState.ensureWeb())
    const retryBtn = root.querySelector('[data-retry]')
    if (retryBtn) retryBtn.addEventListener('click', async () => {
      await window.DshState.refreshStatus()
      window.DshRouter.rerender()
    })
    if (!ready) void window.DshState.ensureWeb()
  }

  function renderShellBoot() {
    const err = state.status?.web?.lastError || state.webTail || ''
    return `
      <div class="guide">
        <div class="guide-card">
          <h2 class="guide-title">${state.webBooting ? '正在启动 DSH 完全体' : 'DSH Web 服务未运行'}</h2>
          <p class="guide-text">${state.webBooting ? '首次启动需要初始化 profile，通常 5–15 秒。' : '点击下方按钮启动本地 Web UI（随机空闲端口，token 自动注入）。'}</p>
          ${err ? `<div class="guide-log">${esc(err.slice(-1200))}</div>` : ''}
          <div class="guide-actions">
            <button class="btn" data-boot>启动服务</button>
            <button class="btn-ghost" data-retry>刷新状态</button>
          </div>
        </div>
      </div>`
  }

  // —— 引导态（无 runtime） ——
  function renderGuide(runtime) {
    const root = $root()
    root.innerHTML = `
      <div class="guide dsh-enter">
        <div class="guide-card">
          <h2 class="guide-title">未找到 DSH 运行时</h2>
          <p class="guide-text">本插件自带运行时（安装包即用）；若为开发加载或运行时被移除，可从插件仓库 Release 下载对应平台资产，或安装系统 dsh：<code>npm i -g @deepseek-ai/dsh</code></p>
          ${runtime?.error ? `<div class="guide-log">${esc(runtime.error)}</div>` : ''}
          <div class="guide-actions">
            <button class="btn" data-open-repo>获取运行时</button>
            <button class="btn-ghost" data-retry>重新检测</button>
          </div>
        </div>
      </div>`
    root.querySelector('[data-open-repo]').addEventListener('click', () =>
      window.DshApi.openExternal('https://github.com/hyqf98/eNest_plugin/releases')
    )
    root.querySelector('[data-retry]').addEventListener('click', async () => {
      await window.DshState.detect()
      window.DshRouter.rerender()
    })
  }

  window.DshViews = { renderCockpit, renderShell, renderGuide, ICONS }
})()
