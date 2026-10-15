/* 局域网传件 — 发送/接收双模式 + 投放队列 + 限时分享状态机 + 历史记录。
   storage 契约：history（v2 结构，兼容 v1 字符串/旧对象）、deviceName、recvDir。 */
import { fmtBytes, fmtTime, fmtRemain } from './util.mjs'
import { loadHistory, pushHistory, recordFromShare, historyLine, historyMeta } from './history.mjs'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)

const kit = window.PluginKit.create({ title: '局域网传件', height: 480 })

const state = {
  mode: 'send',    // send | receive
  picked: [],      // { handleId, name, size }
  minutes: 10,
  share: null,     // LanShareStatus
  timer: null,
  logs: [],
  offRequest: null,
  offStopped: null,
  history: [],
  deviceName: '',
  recvDir: ''
}

const status = (text) => { $('status').textContent = text || '' }

/* —— 模式分段 —— */
function setMode(mode) {
  state.mode = mode
  const send = mode === 'send'
  $('mode-send').setAttribute('aria-selected', String(send))
  $('mode-receive').setAttribute('aria-selected', String(!send))
  $('send-panel').hidden = !send
  $('receive-panel').hidden = send
}

/* —— 待发送队列 —— */
function renderPicked() {
  const list = $('picked-list')
  const has = state.picked.length > 0
  list.hidden = !has
  $('queue-bar').hidden = !has
  const total = state.picked.reduce((sum, p) => sum + p.size, 0)
  $('queue-total').textContent = has
    ? `${state.picked.length} 个文件 · 共 ${fmtBytes(total)}`
    : ''
  list.replaceChildren(...state.picked.map((item) => {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'f-name'
    name.textContent = item.name
    name.title = item.name
    const size = document.createElement('span')
    size.className = 'f-size'
    size.textContent = fmtBytes(item.size)
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = '移除'
    del.setAttribute('aria-label', `移除 ${item.name}`)
    del.addEventListener('click', () => {
      state.picked = state.picked.filter((p) => p.handleId !== item.handleId)
      renderPicked()
    })
    li.append(name, size, del)
    return li
  }))
  $('start-btn').disabled = !has
}

async function addFiles(handlesOrFiles, selected = false) {
  const list = Array.from(handlesOrFiles || [])
  if (!list.length) return
  try {
    const handles = selected ? list : await api.localFiles.fromDrop(list)
    let added = 0
    for (const h of handles) {
      if (h.kind !== 'file') continue
      if (state.picked.some((p) => p.handleId === h.id)) continue
      if (state.picked.some((p) => p.name === h.name && p.size === h.size)) continue
      state.picked.push({ handleId: h.id, name: h.name, size: h.size })
      added++
    }
    status(added ? `已加入 ${added} 个文件` : '文件已在队列中')
    renderPicked()
  } catch (err) {
    kit.toast(err?.message || '拖入失败', 'error')
  }
}

const pickFiles = () => api.localFiles.pick({ kind: 'file', access: 'read', multiple: true })
  .then((handles) => addFiles(handles, true))
  .catch((error) => kit.toast(error.message, 'error'))

function bindDrop() {
  const zone = $('drop-zone')
  let depth = 0
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('armed') })
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('armed') })
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('armed') })
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; zone.classList.remove('armed')
    void addFiles(e.dataTransfer?.files)
  })
  zone.addEventListener('click', (e) => { if (e.target === zone || e.target.closest('.dz-title,.dz-sub,.dz-glyph')) pickFiles() })
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles() } })
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

/* —— 分享中 —— */
function drawQr(url) {
  const canvas = $('qr-canvas')
  try {
    const qr = window.qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const count = qr.getModuleCount()
    const scale = Math.max(2, Math.floor(124 / (count + 8)))
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
    status('二维码生成失败（地址过长），可复制下方链接手动输入')
  }
}

function shareUrls() {
  const share = state.share
  if (!share) return []
  const ips = share.ips.length ? share.ips : ['127.0.0.1']
  return ips.map((ip) => `http://${ip}:${share.port}/d/${share.files[0].id}?code=${share.code}`)
}

function renderLive() {
  $('idle-view').hidden = true
  $('live-view').hidden = false
  const share = state.share
  $('share-code').textContent = share.code
  const urls = shareUrls()
  const list = $('addr-list')
  list.replaceChildren(...urls.map((url) => {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = url.replace(/^http:\/\//, '')
    a.title = `${url}（点击复制）`
    a.addEventListener('click', (e) => { e.preventDefault(); void kit.copy(url) })
    li.append(a)
    return li
  }))
  drawQr(urls[0])
  renderLogs()
  tick()
}

function tick() {
  if (!state.share) return
  const share = state.share
  $('countdown').textContent = fmtRemain(share.expiresAt - Date.now())
  $('dl-count').textContent = `${share.downloads} 次`
  $('conn-count').textContent = String(share.activeConnections ?? 0)
}

function renderLogs() {
  const log = $('req-log')
  if (!state.logs.length) {
    log.replaceChildren()
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '暂无下载请求，等待手机扫码'
    log.append(li)
    return
  }
  log.replaceChildren(...state.logs.slice(-50).reverse().map((item) => {
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
    return li
  }))
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

/* —— 历史（storage v2，兼容 v1） —— */
async function loadAndRenderHistory() {
  state.history = loadHistory(await kit.load('history', []))
  renderHistory()
}

function renderHistory() {
  const list = $('history-list')
  list.replaceChildren()
  if (!state.history.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '还没有分享记录'
    list.append(li)
    $('clear-history').hidden = true
    return
  }
  const deviceSuffix = state.deviceName ? '' : ''
  list.replaceChildren(...state.history.slice(0, 12).map((entry) => {
    const li = document.createElement('li')
    const files = document.createElement('span')
    files.className = 'h-files'
    files.textContent = historyLine(entry)
    files.title = entry.names
    const meta = document.createElement('span')
    meta.className = 'h-meta'
    meta.textContent = historyMeta(entry) + deviceSuffix
    li.append(files, meta)
    return li
  }))
  $('clear-history').hidden = false
}

async function saveHistory(share) {
  state.history = pushHistory(state.history, recordFromShare(share))
  await kit.save('history', { v: 2, entries: state.history }).catch(() => {})
  renderHistory()
  // 停止时回填真实下载次数
  const patch = async () => {
    const cur = await api.net.share.status(share.shareId).catch(() => null)
    const row = state.history.find((h) => h.shareId === share.shareId)
    if (row && cur) {
      row.downloads = cur.downloads
      await kit.save('history', { v: 2, entries: state.history }).catch(() => {})
      renderHistory()
    }
  }
  setTimeout(() => void patch(), 800)
}

/* —— 设备名 / 接收目录 —— */
async function loadPrefs() {
  state.deviceName = String(await kit.load('deviceName', '') || '')
  $('device-name').value = state.deviceName
  state.recvDir = String(await kit.load('recvDir', '') || '')
  renderRecvDir()
}

function renderRecvDir() {
  const el = $('recv-dir')
  el.textContent = state.recvDir || '未设置（使用浏览器默认下载目录）'
  el.classList.toggle('empty', !state.recvDir)
  el.title = state.recvDir || ''
}

function bindPrefs() {
  let nameTimer
  $('device-name').addEventListener('input', () => {
    clearTimeout(nameTimer)
    nameTimer = setTimeout(() => {
      state.deviceName = $('device-name').value.trim().slice(0, 24)
      void kit.save('deviceName', state.deviceName).catch(() => {})
    }, 400)
  })
  $('pick-dir-btn').addEventListener('click', () => {
    api.localFiles.pick({ kind: 'directory', access: 'read' })
      .then(async (handles) => {
        const dir = handles?.find((h) => h.kind === 'directory')
        if (!dir) return
        state.recvDir = dir.displayPath || dir.name || '已选择的目录'
        await kit.save('recvDir', state.recvDir).catch(() => {})
        renderRecvDir()
        kit.toast('已记住接收目录', 'success')
      })
      .catch((error) => kit.toast(error.message, 'error'))
  })
}

/* —— Quick / 桌面双形态 —— */
kit.onMode((mode) => {
  document.documentElement.dataset.mode = mode
  if (mode === 'quick') {
    const live = !$('live-view').hidden
    void api.ui.setHeight(live ? 560 : 430).catch(() => {})
  }
})

/* —— 绑定 —— */
bindDrop()
bindDuration()
bindPrefs()
$('mode-send').addEventListener('click', () => setMode('send'))
$('mode-receive').addEventListener('click', () => setMode('receive'))
$('start-btn').addEventListener('click', () => void startShare())
$('stop-btn').addEventListener('click', async () => {
  if (!state.share) return
  try { await api.net.share.stop(state.share.shareId) } catch { finishShare('分享已停止') }
})
$('copy-code').addEventListener('click', () => { if (state.share) void kit.copy(state.share.code) })
$('clear-history').addEventListener('click', async () => {
  state.history = []
  await kit.save('history', { v: 2, entries: [] }).catch(() => {})
  renderHistory()
})
// 关闭前尽力停止分享（宿主 scope 释放也会兜底）
if (api.onBeforeClose) api.onBeforeClose(() => {
  if (state.share) return api.net.share.stop(state.share.shareId).catch(() => {})
})

setMode('send')
renderPicked()
void loadAndRenderHistory()
void loadPrefs()
