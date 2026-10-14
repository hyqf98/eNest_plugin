import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const esc = PluginKit.escape
const KEY = 'totp_v1'

let entries = []
let query = ''
let selected = ''
let codes = new Map() // id → 当前验证码
let rafId = 0
let running = false
let editing = null
let restorePayload = null
let lastAutoCopied = '' // 周期接力自动复制去重

const kit = PluginKit.create({
  title: '验证器',
  quickPlaceholder: '搜索账号，回车出码复制',
  height: 420,
  defaults: { autoCopy: true },
})

const visible = () => {
  const q = query.trim().toLowerCase()
  const rows = entries.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  if (!q) return rows
  return rows.filter((e) => `${e.account} ${e.issuer} ${e.group}`.toLowerCase().includes(q))
}

async function persist() {
  await kit.save(KEY, { version: 1, entries })
}

// —— 渲染 —— //
function render() {
  const rows = visible()
  $('list').innerHTML = rows.length
    ? rows
        .map((e) => {
          const code = codes.get(e.id) || '·'.repeat(e.digits)
          const remain = core.remainingSeconds(Date.now(), e.period)
          return `<div class="entry ${selected === e.id ? 'selected' : ''}" role="listitem" data-id="${esc(e.id)}" tabindex="0" data-period="${e.period}">
  <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
    <circle class="ring-track" cx="18" cy="18" r="15.5" />
    <circle class="ring-arc" cx="18" cy="18" r="15.5" style="stroke-dashoffset: ${ringOffset(remain, e.period)}" data-arc="${e.id}" />
  </svg>
  <span class="remain mono" data-remain="${esc(e.id)}">${remain}</span>
  <div class="entry-main">
    <div class="entry-account">${esc(e.account)}</div>
    <div class="entry-meta">${e.issuer ? `<span>${esc(e.issuer)}</span>` : ''}<span>${esc(e.group)}</span></div>
  </div>
  <span class="code mono" data-code="${esc(e.id)}">${formatCode(code)}</span>
  <button class="entry-copy" data-copy="${esc(e.id)}" aria-label="复制验证码">复制</button>
  <button class="entry-menu" data-edit="${esc(e.id)}" aria-label="编辑">⋯</button>
</div>`
        })
        .join('')
    : `<div class="empty">${query ? '没有匹配的账号' : '还没有条目<br><small>点「添加」或粘贴 otpauth:// 链接</small>'}</div>`
  $('count').textContent = `${rows.length} 个账号`
}

function ringOffset(remain, period) {
  const C = 2 * Math.PI * 15.5
  return String(C * (1 - remain / period))
}

function formatCode(code) {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

// —— 倒计时循环（onOut / document.hidden 暂停） ——//
async function tick() {
  if (!running) return
  const now = Date.now()
  let needRender = false
  for (const e of entries) {
    const remain = core.remainingSeconds(now, e.period)
    const next = codes.get(e.id)
    // 周期切换或首次：重新出码
    if (!next || remain === e.period || !codes.has(e.id)) {
      try {
        codes.set(e.id, await core.totp(e.secret, { digits: e.digits, period: e.period, algorithm: e.algorithm, forTime: now }))
      } catch {
        codes.set(e.id, '')
      }
      needRender = true
    }
    const arc = document.querySelector(`[data-arc="${CSS.escape(e.id)}"]`)
    if (arc) arc.style.strokeDashoffset = ringOffset(remain, e.period)
    const remainEl = document.querySelector(`[data-remain="${CSS.escape(e.id)}"]`)
    if (remainEl) {
      remainEl.textContent = remain
      remainEl.classList.toggle('urgent', remain <= 5)
    }
    // 下一条自动接力：剩余 ≤3s 且开启 autoCopy 时预取下一个码不复制；周期切换后复制
    if (kit.settings.autoCopy !== false && remain === e.period && lastAutoCopied !== `${e.id}:${now}`) {
      // 通过 enter 激活的条目才自动接力复制
      if (selected === e.id) {
        lastAutoCopied = `${e.id}:${now}`
        void copyCode(e, true)
      }
    }
  }
  if (needRender) render()
  rafId = setTimeout(() => void tick(), 250)
}

function startLoop() {
  if (running) return
  running = true
  void tick()
}
function stopLoop() {
  running = false
  clearTimeout(rafId)
}

// —— 复制 —— //
async function copyCode(e, silent = false) {
  let code = codes.get(e.id)
  if (!code) {
    try {
      code = await core.totp(e.secret, { digits: e.digits, period: e.period, algorithm: e.algorithm })
      codes.set(e.id, code)
    } catch (err) {
      return kit.toast(err.message, 'error')
    }
  }
  try {
    await api.clipboard.writeText(code)
    if (!silent) kit.toast(`已复制 ${formatCode(code)}`, 'success')
  } catch (err) {
    kit.toast(err.message || '复制失败', 'error')
  }
}

$('list').onclick = (e) => {
  const edit = e.target.closest('[data-edit]')
  if (edit) {
    e.stopPropagation()
    return openEditor(entries.find((x) => x.id === edit.dataset.edit))
  }
  const copy = e.target.closest('[data-copy]')
  if (copy) {
    e.stopPropagation()
    const entry = entries.find((x) => x.id === copy.dataset.copy)
    if (entry) return void copyCode(entry)
  }
  const row = e.target.closest('[data-id]')
  if (row) {
    selected = row.dataset.id
    const entry = entries.find((x) => x.id === selected)
    if (entry && kit.settings.autoCopy !== false) void copyCode(entry)
    render()
  }
}
$('list').onkeydown = (e) => {
  if (e.isComposing || e.key !== 'Enter') return
  const row = e.target.closest('[data-id]')
  if (row) {
    e.preventDefault()
    selected = row.dataset.id
    const entry = entries.find((x) => x.id === selected)
    if (entry) void copyCode(entry)
  }
}

// —— 搜索 —— //
$('search').oninput = (e) => {
  query = e.target.value
  kit.setQuery(query)
  render()
}

// —— 编辑器 —— //
function refreshGroupOptions() {
  $('group-options').innerHTML = [...new Set(entries.map((e) => e.group))].map((g) => `<option value="${esc(g)}"></option>`).join('')
}
function openEditor(entry) {
  editing = entry || null
  $('editor-title').textContent = entry ? '编辑条目' : '添加验证器'
  $('f-account').value = entry?.account || ''
  $('f-issuer').value = entry?.issuer || ''
  $('f-secret').value = entry?.secret || ''
  $('f-digits').value = String(entry?.digits || 6)
  $('f-period').value = String(entry?.period || 30)
  $('f-algo').value = entry?.algorithm || 'SHA1'
  $('f-group').value = entry?.group || '默认'
  $('editor-error').hidden = true
  refreshGroupOptions()
  $('editor').showModal()
  $('f-account').focus()
}
$('add').onclick = () => openEditor(null)
$('editor-cancel').onclick = () => $('editor').close()
$('editor-form').onsubmit = (e) => {
  e.preventDefault()
  try {
    const normalized = core.normalizeEntry(
      {
        ...(editing || {}),
        account: $('f-account').value,
        issuer: $('f-issuer').value,
        secret: $('f-secret').value,
        group: $('f-group').value,
        digits: Number($('f-digits').value),
        period: Number($('f-period').value),
        algorithm: $('f-algo').value,
      },
      editing?.id,
    )
    if (editing) {
      const i = entries.findIndex((x) => x.id === editing.id)
      if (i >= 0) entries[i] = normalized
    } else {
      entries.push(normalized)
      selected = normalized.id
    }
    codes.delete(normalized.id)
    $('editor').close()
    void persist().catch((err) => kit.toast(err.message, 'error'))
    render()
  } catch (err) {
    $('editor-error').textContent = err.message
    $('editor-error').hidden = false
  }
}

// —— 粘贴 otpauth 导入 —— //
$('paste-uri').onclick = async () => {
  try {
    const text = await api.clipboard.readText()
    const entry = core.parseOtpauth(text)
    entries.push(core.normalizeEntry(entry))
    void persist().catch(() => {})
    render()
    kit.toast('已导入', 'success')
  } catch (err) {
    kit.toast(err.message, 'error')
  }
}

// —— 加密备份 / 恢复 —— //
$('backup').onclick = () => {
  if (!entries.length) return kit.toast('还没有条目可备份', 'error')
  $('backup-title').textContent = '加密备份'
  $('backup-pass').value = ''
  $('backup-error').hidden = true
  $('backup-form').dataset.mode = 'backup'
  $('backup-dialog').showModal()
}
$('restore').onclick = async () => {
  try {
    const [f] = await api.localFiles.pick({ kind: 'file', access: 'read' })
    if (!f) return
    if (f.size > 2e6) throw new Error('备份文件过大')
    const text = await api.localFiles.read({ handleId: f.id, encoding: 'text', maxBytes: 2000000 })
    restorePayload = JSON.parse(text)
    if (restorePayload?.format !== 'enest-totp-backup') throw new Error('不是验证器备份文件')
    $('backup-title').textContent = '恢复备份'
    $('backup-error').hidden = true
    $('backup-pass').value = ''
    $('backup-form').dataset.mode = 'restore'
    $('backup-dialog').showModal()
  } catch (err) {
    kit.toast(err.message, 'error')
  }
}
$('backup-cancel').onclick = () => {
  restorePayload = null
  $('backup-dialog').close()
}
$('backup-form').onsubmit = async (e) => {
  e.preventDefault()
  const pass = $('backup-pass').value
  const mode = $('backup-form').dataset.mode
  try {
    if (mode === 'backup') {
      const json = await core.encryptBackup({ entries }, pass)
      const saved = await kit.saveText('验证器备份.json', json)
      if (saved) $('backup-dialog').close()
    } else {
      const payload = await core.decryptBackup(JSON.stringify(restorePayload), pass)
      const incoming = (payload.entries || []).map((x) => core.normalizeEntry(x))
      const known = new Set(entries.map((x) => x.id))
      for (const x of incoming) if (known.has(x.id)) x.id = crypto.randomUUID()
      entries.push(...incoming)
      await persist()
      codes.clear()
      render()
      kit.toast(`已恢复 ${incoming.length} 个条目`, 'success')
      restorePayload = null
      $('backup-dialog').close()
    }
  } catch (err) {
    $('backup-error').textContent = err.message
    $('backup-error').hidden = false
  }
}

// —— 生命周期：暂停/恢复倒计时 —— //
api?.onOut?.(() => stopLoop())
api?.onEnter?.(async () => {
  await booted
  startLoop()
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop()
  else if (entries.length) startLoop()
})

// —— 启动 —— //
const booted = (async () => {
  await kit.ready
  const data = await kit.load(KEY, null)
  if (data && Array.isArray(data.entries)) entries = data.entries.map((x) => core.normalizeEntry(x))
  render()
  startLoop()
})()

api?.onBeforeClose?.(async () => {
  stopLoop()
  if (!booted) return
  try {
    await persist()
  } catch {}
})

kit.onMode(() => {
  if (entries.length) render()
})
