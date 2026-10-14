/* 局域网传件 — localFiles 句柄白名单 → lan.share.start 限时服务 → 取件码/二维码/日志。
   QR 用 vendored qrcode-generator（同 com.enest.qrcode，MIT Kazuhiko Arase）。 */
;(function () {
  const api = window.enest || window.zapi
  const $ = (id) => document.getElementById(id)
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(2)} GB`
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
  const fmtRemain = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  const kit = window.PluginKit.create({ title: '局域网传件', height: 480 })

  // —— 状态 ——
  const state = {
    picked: [],      // { handleId, name, size }
    minutes: 10,
    share: null,     // lanShareStatus
    timer: null,     // 倒计时 interval
    logs: [],        // { file, ip, ts }
    offRequest: null,
    offStopped: null,
    history: []
  }

  const status = (text) => { $('status').textContent = text || '' }

  // —— 待发送队列 ——
  function renderPicked() {
    const list = $('picked-list')
    list.hidden = state.picked.length === 0
    $('duration-row').hidden = state.picked.length === 0
    list.innerHTML = ''
    for (const item of state.picked) {
      const li = document.createElement('li')
      const name = document.createElement('span')
      name.className = 'f-name'
      name.textContent = item.name
      name.title = item.name
      const size = document.createElement('span')
      size.className = 'f-size'
      size.textContent = fmtBytes(item.size)
      const del = document.createElement('button')
      del.textContent = '移除'
      del.addEventListener('click', () => {
        state.picked = state.picked.filter((p) => p.handleId !== item.handleId)
        renderPicked()
      })
      li.append(name, size, del)
      list.append(li)
    }
    $('start-btn').disabled = state.picked.length === 0
  }

  async function addDropped(files, selected = false) {
    const list = Array.from(files || [])
    if (!list.length) return
    try {
      const handles = selected ? list : await api.localFiles.fromDrop(list)
      for (const h of handles) {
        if (h.kind !== 'file') continue
        if (state.picked.some((p) => p.name === h.name && p.size === h.size)) continue
        state.picked.push({ handleId: h.id, name: h.name, size: h.size })
      }
      status(`已加入 ${handles.filter((h) => h.kind === 'file').length} 个文件`)
      renderPicked()
    } catch (err) {
      kit.toast(err?.message || '拖入失败', 'error')
    }
  }

  const pickFiles = () => void api.localFiles.pick({ kind: 'file', access: 'read', multiple: true }).then(handles => addDropped(handles, true)).catch(error => kit.toast(error.message, 'error'))
  function bindDrop() {
    const zone = $('drop-zone')
    let depth = 0
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('armed') })
    zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('armed') })
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; zone.classList.remove('armed')
      void addDropped(e.dataTransfer?.files)
    })
    zone.addEventListener('click', (e) => { if (e.target === zone) pickFiles() })
    $('pick-btn').addEventListener('click', (e) => { e.stopPropagation(); pickFiles() })
  }

  function bindDuration() {
    $('duration').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-min]')
      if (!btn) return
      state.minutes = Number(btn.dataset.min) || 10
      for (const b of $('duration').querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b === btn))
      }
    })
  }

  // —— 分享中 ——
  function drawQr(url) {
    const canvas = $('qr-canvas')
    try {
      const qr = window.qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      const count = qr.getModuleCount()
      const scale = Math.max(2, Math.floor(116 / (count + 8)))
      const size = (count + 8) * scale
      const ctx = canvas.getContext('2d')
      canvas.width = size
      canvas.height = size
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, size)
      ctx.fillStyle = '#000000'
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale)
        }
      }
    } catch {
      status('二维码生成失败（URL 过长），可手动输入地址')
    }
  }

  function renderLive() {
    $('idle-view').hidden = true
    $('live-view').hidden = false
    const share = state.share
    $('share-code').textContent = share.code
    // 地址列表：每个 ip 一个入口（含 ?code=，扫码即下）
    const addrList = $('addr-list')
    addrList.innerHTML = ''
    const primary = `http://${share.ips[0] || '127.0.0.1'}:${share.port}/d/${share.files[0].id}?code=${share.code}`
    for (const ip of share.ips.length ? share.ips : ['127.0.0.1']) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = `http://${ip}:${share.port}/d/…?code=${share.code}`
      a.title = `http://${ip}:${share.port}/d/${share.files[0].id}?code=${share.code}`
      a.addEventListener('click', (e) => {
        e.preventDefault()
        void kit.copy(`http://${ip}:${share.port}/d/${share.files[0].id}?code=${share.code}`)
      })
      li.append(a)
      addrList.append(li)
    }
    drawQr(primary)
    renderLogs()
    tick()
  }

  function tick() {
    if (!state.share) return
    const remain = state.share.expiresAt - Date.now()
    $('countdown').textContent = `剩余 ${fmtRemain(remain)}`
    $('dl-count').textContent = `已下载 ${state.share.downloads} 次 · ${state.share.files.length} 个文件`
  }

  function renderLogs() {
    const log = $('req-log')
    log.innerHTML = ''
    if (!state.logs.length) {
      const li = document.createElement('li')
      li.className = 'empty'
      li.textContent = '暂无下载请求'
      log.append(li)
      return
    }
    for (const item of state.logs.slice(-50).reverse()) {
      const li = document.createElement('li')
      const file = document.createElement('span')
      file.className = 'r-file'
      file.textContent = item.file
      file.title = item.file
      const ip = document.createElement('span')
      ip.className = 'r-ip'
      ip.textContent = item.ip
      const ts = document.createElement('span')
      ts.className = 'r-ip'
      ts.textContent = fmtTime(item.ts)
      li.append(file, ip, ts)
      log.append(li)
    }
  }

  function stopTick() {
    if (state.timer) { clearInterval(state.timer); state.timer = null }
    state.offRequest?.(); state.offRequest = null
    state.offStopped?.(); state.offStopped = null
  }

  async function startShare() {
    if (!state.picked.length) return
    $('start-btn').disabled = true
    try {
      const share = await api.net.share.start({
        files: state.picked.map((p) => ({ handleId: p.handleId })),
        minutes: state.minutes
      })
      state.share = share
      state.logs = []
      state.offRequest = api.net.share.onRequest((event) => {
        if (event.shareId !== share.shareId) return
        state.logs.push({ file: event.file, ip: event.ip, ts: event.ts })
        renderLogs()
      })
      state.offStopped = api.net.share.onStopped((event) => {
        if (event.shareId !== share.shareId) return
        finishShare(event.reason === 'expired' ? '分享已到期，自动关闭' : '分享已停止')
      })
      state.timer = setInterval(async () => {
        tick()
        // 到期兜底：宿主停止后 status 查不到也结束
        if (Date.now() >= share.expiresAt + 1500) {
          const cur = await api.net.share.status(share.shareId).catch(() => null)
          if (!cur || cur.stopped) finishShare('分享已到期，自动关闭')
        }
      }, 1000)
      renderLive()
      void saveHistory(share)
      // 系统通知（到期提醒由宿主 stop 触发 toast）
      try { if (api.notify) await api.notify({ title: '局域网传件已开启', body: `取件码 ${share.code}，${state.minutes} 分钟内有效` }) } catch { /* notify 可能被拒 */ }
    } catch (err) {
      kit.toast(err?.message || '启动分享失败', 'error')
      $('start-btn').disabled = false
    }
  }

  function finishShare(message) {
    stopTick()
    state.share = null
    $('idle-view').hidden = false
    $('live-view').hidden = true
    state.picked = []
    renderPicked()
    $('start-btn').disabled = false
    status('')
    if (message) {
      kit.toast(message, 'info')
      try { if (api.notify) void api.notify({ title: '局域网传件', body: message }) } catch { /* ignored */ }
    }
  }

  // —— 历史 ——
  async function loadHistory() {
    state.history = await kit.load('history', [])
    renderHistory()
  }

  function renderHistory() {
    const list = $('history-list')
    list.innerHTML = ''
    if (!state.history.length) {
      const li = document.createElement('li')
      li.className = 'empty'
      li.textContent = '还没有分享记录'
      list.append(li)
      $('clear-history').hidden = true
      return
    }
    for (const item of state.history.slice(0, 12)) {
      const li = document.createElement('li')
      const files = document.createElement('span')
      files.className = 'h-files'
      files.textContent = item.files
      files.title = item.files
      const meta = document.createElement('span')
      meta.className = 'h-meta'
      meta.textContent = `${new Date(item.ts).toLocaleString('zh-CN')} · 下载 ${item.downloads ?? 0} 次`
      li.append(files, meta)
      list.append(li)
    }
    $('clear-history').hidden = false
  }

  async function saveHistory(share) {
    state.history.unshift({
      files: share.files.map((f) => f.name).join('、').slice(0, 120),
      count: share.files.length,
      downloads: 0,
      ts: share.startedAt,
      shareId: share.shareId
    })
    state.history = state.history.slice(0, 50)
    await kit.save('history', state.history).catch(() => {})
    renderHistory()
    // 停止时回填真实下载次数
    const patch = async () => {
      const cur = await api.net.share.status(share.shareId).catch(() => null)
      const row = state.history.find((h) => h.shareId === share.shareId)
      if (row && cur) { row.downloads = cur.downloads; await kit.save('history', state.history).catch(() => {}); renderHistory() }
    }
    setTimeout(() => void patch(), 800)
  }

  // —— Quick / 桌面双形态 ——
  kit.onMode((mode) => {
    document.documentElement.dataset.mode = mode
    if (mode === 'quick') {
      const view = $('live-view').hidden ? 'idle' : 'live'
      void api.ui.setHeight(view === 'live' ? 560 : 420).catch(() => {})
    }
  })

  // —— 绑定 ——
  bindDrop()
  bindDuration()
  $('start-btn').addEventListener('click', () => void startShare())
  $('stop-btn').addEventListener('click', async () => {
    if (!state.share) return
    try { await api.net.share.stop(state.share.shareId) } catch { finishShare('分享已停止') }
  })
  $('copy-code').addEventListener('click', () => { if (state.share) void kit.copy(state.share.code) })
  $('clear-history').addEventListener('click', async () => {
    state.history = []
    await kit.save('history', []).catch(() => {})
    renderHistory()
  })
  // 关闭前尽力停止分享（宿主 scope 释放也会兜底）
  if (api.onBeforeClose) api.onBeforeClose(() => {
    if (state.share) return api.net.share.stop(state.share.shareId).catch(() => {})
  })

  renderPicked()
  void loadHistory()
})()
