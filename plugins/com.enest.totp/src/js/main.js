import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const esc = PluginKit.escape
const KEY = 'totp_v1'

let entries = []
let query = ''
let selected = ''
let codes = new Map() // id → 当前验证码
let nextCodes = new Map() // id → 预生成的下一周期码（无缝切换）
let rafId = 0
let running = false
let editing = null
let restorePayload = null
let copiedFlash = '' // id → 复制成功闪现

const kit = PluginKit.create({
  title: '验证器',
  quickPlaceholder: '搜索账号，回车出码复制',
  height: 440,
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

const formatCode = (code) =>
  code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code

/** 环形进度（连续动画）：fraction = 已流逝比例；返回 stroke-dashoffset */
function ringOffset(remainMs, period) {
  const C = 2 * Math.PI * 15.5
  const fraction = Math.max(0, Math.min(1, remainMs / (period * 1000)))
  return C * (1 - fraction)
}

// —— 渲染 —— //
function render() {
  const rows = visible()
  const now = Date.now()
  $('list').innerHTML = rows.length
    ? rows
        .map((e) => {
          const code = codes.get(e.id) || '·'.repeat(e.digits)
          const remainMs = Math.max(0, core.nextCodeAt(now, e.period) - now)
          return `<div class="entry ${selected === e.id ? 'selected' : ''}" role="listitem" data-id="${esc(e.id)}" tabindex="0" data-period="${e.period}">
  <span class="ringbox">
    <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="ring-track" cx="18" cy="18" r="15.5" />
      <circle class="ring-arc" cx="18" cy="18" r="15.5" data-arc="${esc(e.id)}" />
    </svg>
    <span class="remain mono" data-remain="${esc(e.id)}">${Math.ceil(remainMs / 1000)}</span>
  </span>
  <div class="entry-main">
    <div class="entry-account">${esc(e.account)}</div>
    <div class="entry-meta">${e.issuer ? `<span>${esc(e.issuer)}</span>` : ''}<span>${esc(e.group)}</span></div>
  </div>
  <span class="code mono ${copiedFlash === e.id ? 'flashed' : ''}" data-code="${esc(e.id)}">${formatCode(code)}</span>
  <button class="entry-copy" data-copy="${esc(e.id)}" aria-label="复制验证码">复制</button>
  <button class="entry-menu" data-up="${esc(e.id)}" aria-label="上移" title="上移">↑</button>
  <button class="entry-menu" data-down="${esc(e.id)}" aria-label="下移" title="下移">↓</button>
  <button class="entry-menu entry-delete" data-edit="${esc(e.id)}" aria-label="编辑">编辑</button>
  <button class="entry-menu entry-delete" data-delete="${esc(e.id)}" aria-label="删除">删除</button>
</div>`
        })
        .join('')
    : `<div class="empty">${query ? '没有匹配的账号' : '还没有条目<br><small>点「添加」手动录入，或粘贴 otpauth:// 链接导入</small>'}</div>`
  $('count').textContent = `${rows.length} 个账号`
  // 立即把连续动画同步到当前帧
  syncRings(now)
}

/** 每帧更新：连续倒计时环 + 秒数 + 周期切换时无缝换码 */
function syncRings(now) {
  for (const e of entries) {
    const remainMs = Math.max(0, core.nextCodeAt(now, e.period) - now)
    const arc = document.querySelector(`[data-arc="${CSS.escape(e.id)}"]`)
    if (arc) {
      arc.style.strokeDashoffset = String(ringOffset(remainMs, e.period))
      arc.classList.toggle('urgent', remainMs <= 5000)
    }
    const remainEl = document.querySelector(`[data-remain="${CSS.escape(e.id)}"]`)
    if (remainEl) {
      remainEl.textContent = String(Math.ceil(remainMs / 1000))
      remainEl.classList.toggle('urgent', remainMs <= 5000)
    }
  }
}

/** 确保每个条目有当前码；周期切换时无缝换用预生成码，并预取下一个。返回是否有码发生变化 */
function refreshCodesFor(rowEntries, now) {
  let changed = false
  for (const e of rowEntries) {
    const deadline = core.nextCodeAt(now, e.period)
    if (!codes.has(e.id)) {
      void generateInto(codes, e, deadline)
      continue
    }
    if (codeDeadlines.get(e.id) !== deadline && nextCodes.has(e.id)) {
      // 周期已切换：启用预生成码，再预取下一个
      codes.set(e.id, nextCodes.get(e.id))
      codeDeadlines.set(e.id, deadline)
      nextCodes.delete(e.id)
      changed = true
    }
    if (!nextCodes.has(e.id)) void pregenerate(e, core.nextCodeAt(deadline, e.period))
  }
  return changed
}

const codeDeadlines = new Map() // id → 该码所属周期到期时间戳

async function generateInto(map, e, deadline) {
  try {
    const code = await core.totp(e.secret, { digits: e.digits, period: e.period, algorithm: e.algorithm, forTime: Date.now() })
    map.set(e.id, code)
    codeDeadlines.set(e.id, deadline)
    if (running) render()
  } catch {
    map.set(e.id, '')
  }
}

async function pregenerate(e, nextDeadline) {
  try {
    const code = await core.totp(e.secret, {
      digits: e.digits,
      period: e.period,
      algorithm: e.algorithm,
      counter: Math.floor(nextDeadline / 1000 / e.period),
    })
    nextCodes.set(e.id, code)
  } catch {
    nextCodes.set(e.id, '')
  }
}

// —— 倒计时循环（onOut / document.hidden 暂停，~250ms 主循环 + 环每帧同步）——//
async function tick() {
  if (!running) return
  const now = Date.now()
  const changed = refreshCodesFor(entries, now)
  if (changed) render()
  else syncRings(now)
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
async function copyCode(e, { silent = false } = {}) {
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
    if (!silent) {
      kit.toast(`已复制 ${formatCode(code)}`, 'success')
      flashCopied(e.id)
    }
  } catch (err) {
    kit.toast(err.message || '复制失败', 'error')
  }
}

function flashCopied(id) {
  copiedFlash = id
  const el = document.querySelector(`[data-code="${CSS.escape(id)}"]`)
  if (el) el.classList.add('flashed')
  setTimeout(() => {
    if (copiedFlash === id) {
      copiedFlash = ''
      el?.classList.remove('flashed')
    }
  }, 900)
}

// —— 删除（确认 + 可撤销）——//
let undoEntry = null
let undoTimer = 0

function deleteEntry(id) {
  const entry = entries.find((x) => x.id === id)
  if (!entry) return
  const index = entries.indexOf(entry)
  entries.splice(index, 1)
  codes.delete(id)
  nextCodes.delete(id)
  codeDeadlines.delete(id)
  undoEntry = { entry, index }
  void persist().catch((err) => kit.toast(err.message, 'error'))
  render()
  // 撤销提示（5 秒内有效）
  const undo = $('undo')
  $('undo-text').textContent = `已删除「${entry.account}」`
  undo.hidden = false
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => {
    undo.hidden = true
    undoEntry = null
  }, 5000)
}

$('undo').onclick = () => {
  if (!undoEntry) return
  entries.splice(Math.min(undoEntry.index, entries.length), 0, undoEntry.entry)
  undoEntry = null
  $('undo').hidden = true
  clearTimeout(undoTimer)
  void persist().catch(() => {})
  render()
}

// —— 排序：上移 / 下移 ——//
function moveEntry(id, delta) {
  const rows = visible()
  const index = rows.findIndex((x) => x.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= rows.length) return
  const all = entries.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  const a = all[index]
  all[index] = all[target]
  all[target] = a
  all.forEach((e, i) => (e.sortOrder = i + 1))
  void persist().catch((err) => kit.toast(err.message, 'error'))
  render()
}

// —— 列表交互 ——//
$('list').onclick = (e) => {
  const edit = e.target.closest('[data-edit]')
  if (edit) {
    e.stopPropagation()
    return openEditor(entries.find((x) => x.id === edit.dataset.edit))
  }
  const del = e.target.closest('[data-delete]')
  if (del) {
    e.stopPropagation()
    return deleteEntry(del.dataset.delete)
  }
  const up = e.target.closest('[data-up]')
  if (up) {
    e.stopPropagation()
    return moveEntry(up.dataset.up, -1)
  }
  const down = e.target.closest('[data-down]')
  if (down) {
    e.stopPropagation()
    return moveEntry(down.dataset.down, 1)
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

// —— 搜索 ——//
$('search').oninput = (e) => {
  query = e.target.value
  kit.setQuery(query)
  render()
}

// —— 编辑器 ——//
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
  PluginKit.upgradeSelects() // 直接改 select.value 后同步自定义下拉标签
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
    nextCodes.delete(normalized.id)
    codeDeadlines.delete(normalized.id)
    $('editor').close()
    void persist().catch((err) => kit.toast(err.message, 'error'))
    render()
  } catch (err) {
    $('editor-error').textContent = err.message
    $('editor-error').hidden = false
  }
}

// —— 粘贴 otpauth 导入（支持多行 / 批量）——//
$('paste-uri').onclick = async () => {
  try {
    const text = await api.clipboard.readText()
    importUris(text)
  } catch (err) {
    kit.toast(err.message, 'error')
  }
}

function importUris(text) {
  const lines = String(text ?? '')
    .split(/\s+/)
    .filter((line) => line.startsWith('otpauth://'))
  if (!lines.length) {
    try {
      // 单条裸 secret 也接受：无 otpauth 链接时按 base32 校验后手工入账
      const secret = String(text ?? '').trim()
      core.base32Decode(secret)
      openEditorWithSecret(secret)
      return
    } catch {
      return kit.toast('剪贴板中没有可导入的 otpauth 链接或 base32 密钥', 'error')
    }
  }
  let ok = 0
  const errors = []
  for (const line of lines) {
    try {
      entries.push(core.normalizeEntry(core.parseOtpauth(line)))
      ok++
    } catch (err) {
      errors.push(err.message)
    }
  }
  if (ok) {
    void persist().catch(() => {})
    render()
    kit.toast(errors.length ? `导入 ${ok} 条，失败 ${errors.length} 条` : `已导入 ${ok} 条`, errors.length ? 'warn' : 'success')
  } else {
    kit.toast(errors[0] || '导入失败', 'error')
  }
}

function openEditorWithSecret(secret) {
  openEditor(null)
  $('f-secret').value = secret
}

// —— 备份 / 恢复 ——//
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
      nextCodes.clear()
      codeDeadlines.clear()
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

// —— 生命周期：暂停/恢复倒计时 ——//
api?.onOut?.(() => stopLoop())
api?.onEnter?.(async () => {
  await booted
  startLoop()
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop()
  else if (entries.length) startLoop()
})

// —— 启动 ——//
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
