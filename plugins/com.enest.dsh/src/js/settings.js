/* DshSettings — 插件独立设置台（不复用壳子 settings）：
   Profile 管家 / 运行时与端口 / 版本与升级 / 备份 / 诊断 */
;(() => {
  const { esc, call, notice } = window.DshApi
  const { state } = window.DshState
  let section = 'profiles'
  let sectionData = {}

  const NAV = [
    { id: 'profiles', label: 'Profile 管家', icon: 'stack' },
    { id: 'runtime', label: '运行时与端口', icon: 'power' },
    { id: 'versions', label: '版本与升级', icon: 'up' },
    { id: 'backups', label: '备份', icon: 'archive' },
    { id: 'diagnostics', label: '诊断', icon: 'pulse' }
  ]
  const NAV_ICONS = {
    stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>',
    power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"/><line x1="12" y1="6" x2="12" y2="18"/><line x1="5" y1="21" x2="19" y2="21"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
  }
  const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return ''
    if (n < 1024) return `${n} B`
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(2)} GB`
  }
  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString()
    } catch {
      return ''
    }
  }
  async function guard(promise, okText) {
    try {
      const r = await promise
      if (okText) notice(okText)
      return r
    } catch (error) {
      notice(String(error.message || error), 'error')
      throw error
    }
  }

  // —— 各分区渲染 ——

  function renderProfiles() {
    const list = sectionData.profiles || []
    const backups = (sectionData.backups || []).filter((b) => b.scope === 'profile')
    const cards = list
      .map(
        (p, i) => `
      <div class="card dsh-enter" style="--index:${i}">
        <div class="card-head">
          <span class="card-title mono">${esc(p.name)}</span>
          ${p.builtin ? '<span class="tag">内置</span>' : '<span class="tag">自定义</span>'}
          ${p.reserved ? '<span class="tag tag-err">保留</span>' : ''}
        </div>
        <div class="card-body">
          bundles 有序栈（${p.bundles.length} 层）：
          <div class="stack-list">${p.bundles.map((b, idx) => `<div class="stack-item"><span class="ord">${idx + 1}</span><span>${esc(b)}</span></div>`).join('') || '<div class="stack-item">（空）</div>'}</div>
          ${p.patchLines ? `<div style="margin-top:6px">cordis.patch.yml ${p.patchLines} 行</div>` : ''}
          ${p.plugins?.length ? `<div style="margin-top:4px">out-of-tree 插件：<span class="mono">${esc(p.plugins.join(', '))}</span></div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-ghost" data-profile-backup="${esc(p.name)}">备份</button>
          ${!p.reserved ? `<button class="btn-ghost btn-danger" data-profile-delete="${esc(p.name)}">删除（先备份）</button>` : ''}
        </div>
      </div>`
      )
      .join('')
    const backupRows = backups
      .map(
        (b) => `<div class="sect-row" style="padding:6px 0">
          <span class="sect-value" style="flex:1">${esc(b.backupId)}${b.target ? ` → ${esc(b.target)}` : ''} · ${fmtBytes(b.sizeBytes)} · ${fmtTime(b.createdAt)}</span>
          <button class="btn-ghost" data-backup-restore="${esc(b.backupId)}">恢复</button>
          <button class="btn-ghost btn-danger" data-backup-delete="${esc(b.backupId)}">删除</button>
        </div>`
      )
      .join('')
    return `
      <h2 class="settings-title">Profile 管家</h2>
      <p class="settings-desc">$DSH_HOME/profiles 下的组合层可视化：bundles 栈、用户补丁、out-of-tree 插件。删除前自动快照。</p>
      <div class="sect">
        <div class="sect-row">
          <input class="field" id="profile-name" placeholder="新 profile 名（如 work）" style="width:200px">
          <select class="field" id="profile-template">
            ${['web', 'headless', 'sdk', 'sdk-minimal', 'acp'].map((t) => `<option value="${t}">${t}</option>`).join('')}
          </select>
          <button class="btn" id="profile-create">新增</button>
        </div>
      </div>
      ${cards || '<p class="evt-empty">尚无 profile — 启动一次完全体后会自动初始化 web 模板。</p>'}
      ${backups.length ? `<div class="sect"><div class="card-title" style="margin-bottom:6px">Profile 备份</div>${backupRows}</div>` : ''}`
  }

  function renderRuntime() {
    const st = state.status
    const web = st?.web
    const sdk = st?.sdk
    const prefs = state.prefs
    const procCard = (kind, info, runningLabel) => `
      <div class="card">
        <div class="card-head">
          <span class="dot ${info?.running ? 'dot-ok' : ''}"></span>
          <span class="card-title">${kind === 'web' ? 'Web 完全体进程' : 'SDK 快速对话进程'}</span>
          <span class="sect-value">${runningLabel}</span>
        </div>
        <div class="card-actions">
          <button class="btn-ghost" data-proc-start="${kind}">${info?.running ? '已在运行' : '启动'}</button>
          <button class="btn-ghost" data-proc-stop="${kind}">停止</button>
          ${kind === 'web' ? '<button class="btn-ghost" data-proc-restart="web">重启</button>' : ''}
        </div>
      </div>`
    const webLabel = web?.running
      ? `${web.port ? `127.0.0.1:${web.port}` : ''}${web.profile && web.profile !== 'web' ? ` · ${web.profile}` : ''}${web.portRetries ? ` · 换口重试 ${web.portRetries} 次` : ''}`
      : '未运行'
    const sdkLabel = sdk?.running ? (sdk.initialized ? `pid ${sdk.pid ?? ''}` : '初始化中…') : '未运行'
    return `
      <h2 class="settings-title">运行时与端口</h2>
      <p class="settings-desc">端口冲突时自动换空闲口重启并通知；插件关闭时进程与端口自动回收。</p>
      ${procCard('web', web, webLabel)}
      ${procCard('sdk', sdk, sdkLabel)}
      <div class="sect">
        <div class="sect-row">
          <span class="sect-label">端口策略</span>
          <select class="field" id="port-policy" style="width:120px">
            <option value="auto" ${prefs.webPortPolicy !== 'fixed' ? 'selected' : ''}>自动分配</option>
            <option value="fixed" ${prefs.webPortPolicy === 'fixed' ? 'selected' : ''}>固定端口</option>
          </select>
          <input class="field" id="port-fixed" type="number" value="${esc(String(prefs.webPort ?? 3080))}" style="width:100px" ${prefs.webPortPolicy !== 'fixed' ? 'disabled' : ''}>
          <button class="btn" id="port-save">保存</button>
        </div>
      </div>
      ${web?.lastError ? `<div class="sect"><div class="guide-log">${esc(web.lastError)}</div></div>` : ''}`
  }

  function renderVersions() {
    const installed = sectionData.installed || []
    const remote = sectionData.remote || []
    const progress = state.upgrading
    const installedRows = installed
      .map(
        (v) => `
        <div class="sect-row" style="padding:6px 0">
          <span class="dot ${v.active ? 'dot-run' : ''}"></span>
          <span class="sect-value" style="flex:1">v${esc(v.version)} · ${v.channel === 'bundled' ? '插件捆绑' : '热更新'}${v.active ? ' · 使用中' : ''}</span>
          ${v.channel === 'data' && !v.active ? `<button class="btn-ghost" data-ver-activate="${esc(v.version)}">切换</button><button class="btn-ghost btn-danger" data-ver-remove="${esc(v.version)}">移除</button>` : ''}
        </div>`
      )
      .join('')
    const remoteRows = remote
      .slice(0, 12)
      .map(
        (v) => `
        <div class="sect-row" style="padding:6px 0">
          <span class="sect-value" style="flex:1">v${esc(v.version)}${v.distTag ? ` · ${esc(v.distTag)}` : ''}${v.date ? ` · ${esc(v.date.slice(0, 10))}` : ''}${v.assetUrl ? '' : ' · 无预编译资产'}</span>
          ${installed.some((i) => i.version === v.version) ? '<span class="tag tag-ok">已装</span>' : v.assetUrl ? `<button class="btn-ghost" data-ver-download="${esc(v.version)}">下载</button>` : ''}
          ${v.assetUrl && !installed.some((i) => i.version === v.version) ? `<button class="btn" data-ver-upgrade="${esc(v.version)}">一键升级</button>` : ''}
        </div>`
      )
      .join('')
    return `
      <h2 class="settings-title">版本与升级</h2>
      <p class="settings-desc">dsh 迭代快：一键升级 = 停进程 → 全量备份 → 下载 → 激活 → 健康检查，失败自动回滚；切换旧版本即回退。</p>
      <div class="sect"><div class="card-title" style="margin-bottom:4px">本地版本</div>${installedRows || '<p class="evt-empty">无</p>'}</div>
      <div class="sect">
        <div class="sect-row" style="justify-content:space-between">
          <div class="card-title">可用版本</div>
          <button class="btn-ghost" id="ver-refresh">刷新</button>
        </div>
        <div id="remote-rows" class="dsh-enter">${remoteRows || '<p class="evt-empty">点击刷新获取</p>'}</div>
        ${progress ? `<div class="progress-track"><div class="progress-fill" style="width:${Number(progress.percent ?? 0)}%"></div></div><div class="progress-line">${esc(progress.phase)}${progress.detail ? ` · ${esc(progress.detail)}` : ''}${progress.percent != null ? ` · ${progress.percent}%` : ''}</div>` : ''}
      </div>`
  }

  function renderBackups() {
    const backups = (sectionData.backups || []).filter((b) => b.scope === 'home')
    const rows = backups
      .map(
        (b) => `
        <div class="sect-row" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="sect-value" style="flex:1">${esc(b.name || b.backupId)} · ${fmtBytes(b.sizeBytes)} · ${fmtTime(b.createdAt)}</span>
          <button class="btn-ghost" data-backup-restore="${esc(b.backupId)}">恢复</button>
          <button class="btn-ghost btn-danger" data-backup-delete="${esc(b.backupId)}">删除</button>
        </div>`
      )
      .join('')
    return `
      <h2 class="settings-title">备份</h2>
      <p class="settings-desc">$DSH_HOME 全量快照（profiles 配置 / 凭据 / 会话；排除 node_modules）。含 API 凭据，仅保存在本机。</p>
      <div class="sect">
        <button class="btn" id="backup-create">立即备份</button>
        ${rows || '<p class="evt-empty">暂无备份</p>'}
      </div>`
  }

  function renderDiagnostics() {
    const r = state.runtime || {}
    const tree = (sectionData.home || []).map((l) => `<div>${esc(l)}</div>`).join('')
    const logs = (sectionData.logs || []).map((l) => `<div>${esc(l)}</div>`).join('')
    return `
      <h2 class="settings-title">诊断</h2>
      <div class="sect">
        <div class="sect-row"><span class="sect-label">运行时</span><span class="sect-value">${esc(r.source ?? '')} ${r.version ? `v${esc(r.version)}` : ''} · ${esc(r.engine ?? '')}</span></div>
        <div class="sect-row"><span class="sect-label">runtime 路径</span><span class="sect-value">${esc(r.root ?? '')}</span></div>
        <div class="sect-row"><span class="sect-label">DSH_HOME</span><span class="sect-value">${esc(r.dshHome ?? '')}</span></div>
      </div>
      <div class="sect"><div class="card-title" style="margin-bottom:6px">DSH_HOME 布局</div><div class="guide-log">${tree || '（空）'}</div></div>
      <div class="sect">
        <div class="sect-row" style="justify-content:space-between"><div class="card-title">进程日志尾</div>
          <span><button class="btn-ghost" data-logs="web">web</button> <button class="btn-ghost" data-logs="sdk">sdk</button></span>
        </div>
        <div class="guide-log">${logs || '（无输出）'}</div>
      </div>`
  }

  const RENDERERS = {
    profiles: renderProfiles,
    runtime: renderRuntime,
    versions: renderVersions,
    backups: renderBackups,
    diagnostics: renderDiagnostics
  }

  // —— 事件绑定 ——

  function bind() {
    const root = document.getElementById('settings-main')
    root.querySelectorAll('[data-profile-backup]').forEach((n) =>
      n.addEventListener('click', async () => {
        await guard(call('profiles.backup', { name: n.dataset.profileBackup }), '已备份')
        await loadSection()
      })
    )
    root.querySelectorAll('[data-profile-delete]').forEach((n) =>
      n.addEventListener('click', async () => {
        if (!window.confirm(`删除 profile "${n.dataset.profileDelete}"？（会先自动备份）`)) return
        await guard(call('profiles.delete', { name: n.dataset.profileDelete }), '已删除（备份保留）')
        await loadSection()
      })
    )
    root.querySelectorAll('[data-backup-restore]').forEach((n) =>
      n.addEventListener('click', async () => {
        if (!window.confirm('恢复此备份？当前数据将被覆盖（进程会停止）。')) return
        await guard(call('backup.restore', { backupId: n.dataset.backupRestore }), '已恢复')
        await loadSection()
      })
    )
    root.querySelectorAll('[data-backup-delete]').forEach((n) =>
      n.addEventListener('click', async () => {
        await guard(call('backup.delete', { backupId: n.dataset.backupDelete }), '已删除')
        await loadSection()
      })
    )
    const createBtn = root.querySelector('#profile-create')
    if (createBtn)
      createBtn.addEventListener('click', async () => {
        const name = root.querySelector('#profile-name').value.trim()
        const template = root.querySelector('#profile-template').value
        if (!name) return
        await guard(call('profiles.create', { name, template }), `已创建 ${name}`)
        await loadSection()
      })
    root.querySelectorAll('[data-proc-start]').forEach((n) =>
      n.addEventListener('click', async () => {
        if (n.dataset.procStart === 'web') await guard(window.DshState.ensureWeb(), null)
        else await guard(window.DshState.ensureSdk(), null)
        await window.DshState.refreshStatus()
        rerenderSection()
      })
    )
    root.querySelectorAll('[data-proc-stop]').forEach((n) =>
      n.addEventListener('click', async () => {
        await guard(call(n.dataset.procStop === 'web' ? 'web.stop' : 'sdk.stop', {}), '已停止')
        await window.DshState.refreshStatus()
        rerenderSection()
      })
    )
    root.querySelectorAll('[data-proc-restart]').forEach((n) =>
      n.addEventListener('click', async () => {
        await guard(call('web.restart', {}), '重启中')
        await window.DshState.refreshStatus()
      })
    )
    const policySel = root.querySelector('#port-policy')
    if (policySel) {
      policySel.addEventListener('change', () => {
        root.querySelector('#port-fixed').disabled = policySel.value !== 'fixed'
      })
      root.querySelector('#port-save').addEventListener('click', async () => {
        state.prefs.webPortPolicy = policySel.value
        state.prefs.webPort = Number(root.querySelector('#port-fixed').value) || 3080
        await window.DshApi.setPref('webPortPolicy', state.prefs.webPortPolicy)
        await window.DshApi.setPref('webPort', state.prefs.webPort)
        notice('端口策略已保存（重启 web 进程后生效）')
      })
    }
    root.querySelectorAll('[data-ver-activate]').forEach((n) =>
      n.addEventListener('click', async () => {
        await guard(call('runtime.activate', { version: n.dataset.verActivate }), '已切换')
        await loadSection()
      })
    )
    root.querySelectorAll('[data-ver-remove]').forEach((n) =>
      n.addEventListener('click', async () => {
        await guard(call('runtime.remove', { version: n.dataset.verRemove }), '已移除')
        await loadSection()
      })
    )
    root.querySelectorAll('[data-ver-download]').forEach((n) =>
      n.addEventListener('click', async () => {
        notice('开始下载…')
        await guard(call('runtime.download', { version: n.dataset.verDownload }), '下载完成')
        await loadSection()
      })
    )
    root.querySelectorAll('[data-ver-upgrade]').forEach((n) =>
      n.addEventListener('click', async () => {
        if (!window.confirm(`一键升级到 ${n.dataset.verUpgrade}？将停止进程并做全量备份，失败自动回滚。`)) return
        await guard(call('upgrade.oneClick', { version: n.dataset.verUpgrade }), '升级完成')
        await window.DshState.detect()
        await loadSection()
      })
    )
    const verRefresh = root.querySelector('#ver-refresh')
    if (verRefresh) verRefresh.addEventListener('click', () => void loadSection())
    const backupCreate = root.querySelector('#backup-create')
    if (backupCreate)
      backupCreate.addEventListener('click', async () => {
        await guard(call('backup.create', { label: `手动快照 ${new Date().toLocaleString()}` }), '备份完成')
        await loadSection()
      })
    root.querySelectorAll('[data-logs]').forEach((n) =>
      n.addEventListener('click', async () => {
        sectionData.logs = await call('logs.tail', { kind: n.dataset.logs, lines: 60 })
        rerenderSection()
      })
    )
  }

  async function loadSection() {
    if (section === 'profiles') {
      const [profiles, backups] = await Promise.all([
        call('profiles.list', {}).catch(() => []),
        call('backup.list', {}).catch(() => [])
      ])
      sectionData = { profiles, backups }
    } else if (section === 'versions') {
      const [installed, remote] = await Promise.all([
        call('runtime.versions.list', {}).catch(() => []),
        call('runtime.versions.available', { limit: 15 }).catch(() => [])
      ])
      sectionData = { installed, remote }
    } else if (section === 'backups') {
      sectionData = { backups: await call('backup.list', {}).catch(() => []) }
    } else if (section === 'diagnostics') {
      const logs = await call('logs.tail', { kind: 'web', lines: 40 }).catch(() => [])
      const r = state.runtime || {}
      const home = [r.dshHome ?? '', r.dshHome ? '  profiles/' : '', r.dshHome ? '  storages/' : '']
      sectionData = { logs, home }
    }
    rerenderSection()
  }

  function rerenderSection() {
    const main = document.getElementById('settings-main')
    if (!main) return
    main.innerHTML = RENDERERS[section]()
    bind()
  }

  function render() {
    const root = document.getElementById('root')
    root.innerHTML = `
      <div class="settings dsh-enter">
        <nav class="settings-nav">
          ${NAV.map(
            (item) => `<button class="settings-nav-item ${item.id === section ? 'active' : ''}" data-nav="${item.id}">${NAV_ICONS[item.icon]}<span>${item.label}</span></button>`
          ).join('')}
          <span style="flex:1"></span>
          <button class="settings-nav-item" data-nav="__back">${BACK_ICON}<span>返回</span></button>
        </nav>
        <div class="settings-main" id="settings-main"></div>
      </div>`
    root.querySelectorAll('[data-nav]').forEach((n) =>
      n.addEventListener('click', () => {
        const id = n.dataset.nav
        if (id === '__back') {
          window.DshRouter.go('main')
          return
        }
        section = id
        root.querySelectorAll('[data-nav]').forEach((m) => m.classList.toggle('active', m.dataset.nav === id))
        void loadSection()
      })
    )
    void loadSection()
  }

  window.DshSettings = { render }
})()
