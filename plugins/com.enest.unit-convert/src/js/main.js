import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const FX_URL = 'https://open.er-api.com/v6/latest/USD'
const FAV_KEY = 'unit-convert.favorites.v1'
const PREF_KEY = 'unit-convert.prefs.v1'

let activeTab = 'length'
let fxRates = null
let fxFetchedAt = 0
let fxSource = '' // live | cache | fallback
let editingField = '' // 焦点所在输入（联动以它为主）
let radixValues = { 2: '0', 8: '0', 10: '0', 16: '0' }
let ready = false
let favorites = [] // ["length:km", "temp:F", ...]
let prefs = { precision: 12, scientific: false, lastTab: '' }

const kit = PluginKit.create({
  title: '单位与汇率',
  quickPlaceholder: '输入数值即时换算',
  height: 420,
  defaults: { baseCurrency: 'USD' },
})

const isSpecial = (tab) => tab === 'temp' || tab === 'radix' || tab === 'fx'
const favId = (tab, unit) => `${tab}:${unit}`
const isFav = (tab, unit) => favorites.includes(favId(tab, unit))
function toggleFav(tab, unit) {
  const id = favId(tab, unit)
  favorites = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id]
  kit.save(FAV_KEY, favorites).catch(() => {})
  renderRows(true)
}

// —— Tabs —— //
function renderTabs() {
  $('tabs').replaceChildren()
  for (const id of core.TAB_ORDER) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.role = 'tab'
    btn.setAttribute('aria-selected', String(activeTab === id))
    btn.dataset.tab = id
    btn.className = 'chip' + (activeTab === id ? ' active' : '')
    btn.textContent = core.CATEGORIES[id].name
    if (core.CATEGORIES[id].units.some((u) => isFav(id, u.id))) btn.classList.add('has-fav')
    $('tabs').append(btn)
  }
}

// —— 数值行（收藏单位置顶） ——//
function unitRows(tab) {
  if (tab === 'temp') return core.TEMP_UNITS.map((u) => ({ id: u.id, name: u.name }))
  if (tab === 'radix') return core.RADIX_BASES.map((b) => ({ id: String(b), name: `${b} 进制`, radix: b }))
  const units = core.CATEGORIES[tab].units
  return [...units].sort((a, b) => Number(isFav(tab, b.id)) - Number(isFav(tab, a.id)))
}

function renderRows(preserveEditing = true) {
  const keep = preserveEditing ? editingField : ''
  const rowsEl = $('rows')
  // 保留当前行值：模式切换 / 重渲染不丢用户输入
  const previous = {}
  rowsEl.querySelectorAll('[data-unit]').forEach((el) => (previous[el.dataset.unit] = el.value))
  rowsEl.replaceChildren()
  if (activeTab === 'radix') {
    for (const r of unitRows(activeTab)) {
      const label = document.createElement('label')
      label.className = 'row'
      const name = document.createElement('span')
      name.className = 'row-name'
      name.textContent = r.name
      const input = document.createElement('input')
      input.className = 'mono'
      input.dataset.radix = r.id
      input.value = radixValues[r.id] || ''
      input.spellcheck = false
      label.append(name, input)
      rowsEl.append(label)
    }
  } else {
    for (const r of unitRows(activeTab)) {
      const label = document.createElement('label')
      label.className = 'row' + (isFav(activeTab, r.id) ? ' faved' : '')
      const fav = document.createElement('button')
      fav.type = 'button'
      fav.className = 'fav-btn' + (isFav(activeTab, r.id) ? ' on' : '')
      fav.textContent = isFav(activeTab, r.id) ? '★' : '☆'
      fav.title = isFav(activeTab, r.id) ? '取消置顶' : '置顶常用'
      fav.setAttribute('aria-label', `${r.name}${isFav(activeTab, r.id) ? '取消置顶' : '置顶常用'}`)
      fav.setAttribute('aria-pressed', String(isFav(activeTab, r.id)))
      fav.addEventListener('click', () => toggleFav(activeTab, r.id))
      const name = document.createElement('span')
      name.className = 'row-name'
      name.textContent = r.name
      const input = document.createElement('input')
      input.className = 'mono'
      input.inputMode = 'decimal'
      input.dataset.unit = r.id
      input.value = previous[r.id] ?? ''
      input.placeholder = '0'
      input.spellcheck = false
      label.append(fav, name, input)
      rowsEl.append(label)
    }
  }
  editingField = keep
  renderPresets()
  renderFormula()
  $('fx-section').hidden = activeTab !== 'fx'
  $('rmb-section').hidden = activeTab !== 'fx'
  $('foot-note').textContent =
    activeTab === 'fx'
      ? fxSource === 'live'
        ? `汇率更新于 ${new Date(fxFetchedAt).toLocaleString()} · open.er-api.com`
        : fxSource === 'cache'
          ? `网络不可用，展示 ${new Date(fxFetchedAt).toLocaleString()} 的缓存汇率`
          : '网络不可用且无缓存，展示静态参考汇率（仅供参考）'
      : '修改任一行，其余即时联动 · ★ 置顶常用单位'
  if (activeTab === 'fx') void ensureFx()
}

function renderPresets() {
  $('presets').replaceChildren()
  if (activeTab === 'fx') return
  const eyebrow = document.createElement('span')
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = '常用换算'
  $('presets').append(eyebrow)
  for (const p of core.PRESETS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'preset'
    btn.dataset.preset = p.value
    btn.textContent = p.label
    $('presets').append(btn)
  }
}

/** 换算公式展示：焦点行 → 目标行 */
function renderFormula() {
  const el = $('formula')
  if (!el) return
  if (activeTab === 'radix' || activeTab === 'fx' || !editingField) {
    el.textContent = ''
    el.hidden = true
    return
  }
  const rows = unitRows(activeTab)
  const targets = rows.filter((r) => r.id !== editingField).slice(0, 3)
  const lines = targets.map((t) => core.formulaText(activeTab, editingField, t.id)).filter(Boolean)
  el.textContent = lines.join('　·　')
  el.hidden = !lines.length
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// —— 联动 ——//
$('rows').addEventListener('input', (e) => {
  const el = e.target
  if (el.dataset.unit) {
    editingField = el.dataset.unit
    const value = core.parseInput(core.normalizeDigits(el.value))
    const results = core.convertAll(activeTab, editingField, value, { precision: prefs.precision })
    $('rows').querySelectorAll('[data-unit]').forEach((input) => {
      if (input === el) return
      const v = results[input.dataset.unit]
      input.value = v === undefined || !Number.isFinite(v) ? '' : core.formatNumber(v, { scientific: prefs.scientific }).replace(/,/g, '')
    })
    renderFormula()
  } else if (el.dataset.radix) {
    editingField = el.dataset.radix
    const base = Number(el.dataset.radix)
    const n = core.parseRadix(core.normalizeDigits(el.value), base)
    $('rows').querySelectorAll('[data-radix]').forEach((input) => {
      if (input === el) return
      input.value = n === null || Number.isNaN(n) ? '' : core.formatRadix(n, Number(input.dataset.radix), { group: Number(input.dataset.radix) === 2 })
    })
  }
})
$('rows').addEventListener('focusin', (e) => {
  if (e.target.dataset?.unit || e.target.dataset?.radix) {
    editingField = e.target.dataset.unit || e.target.dataset.radix
    renderFormula()
  }
})

// —— 预设 ——//
$('presets').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]')
  if (!btn) return
  const m = btn.dataset.preset.match(/^([\d.]+)\s+(\S+)\s*=\s*([\d.]+)\s+(\S+)$/)
  if (!m) return
  const [, amount, fromUnit] = m
  for (const [tabId, cat] of Object.entries(core.CATEGORIES)) {
    const src = cat.units?.find((u) => u.id === fromUnit)
    if (src) {
      activeTab = tabId
      prefs.lastTab = tabId
      kit.save(PREF_KEY, prefs).catch(() => {})
      renderTabs()
      renderRows(false)
      const input = $('rows').querySelector(`[data-unit="${CSS.escape(fromUnit)}"]`)
      if (input) {
        input.value = amount
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
      }
      return
    }
  }
})

// —— Tabs 切换 ——//
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab
  if (!tab) return
  activeTab = tab
  prefs.lastTab = tab
  kit.save(PREF_KEY, prefs).catch(() => {})
  editingField = ''
  renderTabs()
  renderRows(false)
})

// —— 精度 / 科学计数 ——//
$('precision').onchange = (e) => {
  const n = Number(e.target.value) || 12
  prefs.precision = Math.max(4, Math.min(15, n))
  e.target.value = String(prefs.precision)
  kit.save(PREF_KEY, prefs).catch(() => {})
  replayEditing()
}
$('scientific').onclick = () => {
  prefs.scientific = !prefs.scientific
  $('scientific').setAttribute('aria-pressed', String(prefs.scientific))
  kit.save(PREF_KEY, prefs).catch(() => {})
  replayEditing()
}
function replayEditing() {
  if (!editingField) return
  const input = $('rows').querySelector(`[data-unit="${CSS.escape(editingField)}"]`)
  if (input) input.dispatchEvent(new Event('input', { bubbles: true }))
}

// —— 汇率 ——//
async function ensureFx() {
  renderFxRows()
  const cache = await kit.load('fx_cache', null)
  if (core.isCacheFresh(cache)) {
    fxRates = cache.rates
    fxFetchedAt = cache.fetchedAt
    fxSource = 'cache'
  } else if (cache?.rates) {
    fxRates = cache.rates
    fxFetchedAt = cache.fetchedAt
    fxSource = 'cache'
  } else {
    fxRates = core.FX_FALLBACK_RATES
    fxSource = 'fallback'
  }
  await refreshFx({ background: Boolean(cache?.rates) })
}

async function refreshFx({ background = false } = {}) {
  $('fx-state').textContent = '更新中…'
  try {
    const res = await api.net.fetch({ url: FX_URL, timeoutMs: 12000 })
    const parsed = core.parseFxResponse(res.body)
    fxRates = parsed.rates
    fxFetchedAt = parsed.fetchedAt
    fxSource = 'live'
    await kit.save('fx_cache', { rates: fxRates, fetchedAt: fxFetchedAt })
    if (!background) kit.toast('汇率已更新', 'success')
  } catch (err) {
    const cache = await kit.load('fx_cache', null)
    if (core.isCacheFresh(cache) || cache?.rates) {
      fxRates = cache.rates
      fxFetchedAt = cache.fetchedAt
      fxSource = 'cache'
      if (!background) kit.toast(`网络失败，使用 ${new Date(fxFetchedAt).toLocaleString()} 的缓存`, 'info')
    } else {
      fxRates = core.FX_FALLBACK_RATES
      fxSource = 'fallback'
      if (!background) kit.toast('网络失败，使用静态参考汇率', 'error')
    }
  }
  renderFxState()
  renderFxRows()
}

function renderFxState() {
  $('fx-state').textContent =
    fxSource === 'live'
      ? `更新于 ${new Date(fxFetchedAt).toLocaleTimeString()}`
      : fxSource === 'cache'
        ? `缓存 · ${new Date(fxFetchedAt).toLocaleString()}`
        : '静态参考汇率'
}

function renderFxRows() {
  const base = String(kit.settings.baseCurrency || 'USD')
  const select = $('fx-base')
  select.replaceChildren(
    ...core.FX_CURRENCIES.map((c) => {
      const opt = document.createElement('option')
      opt.value = c.id
      opt.textContent = `${c.id} ${c.name}`
      if (c.id === base) opt.selected = true
      return opt
    }),
  )
  PluginKit.upgradeSelects() // 动态重建 option 后立即同步自定义下拉的选中标签
  if (!fxRates) {
    $('fx-rows').innerHTML = '<div class="empty small">正在获取汇率…</div>'
    return
  }
  const amount = core.parseInput(core.normalizeDigits($('fx-amount').value)) || 0
  const result = core.fxConvert(fxRates, base, amount)
  $('fx-rows').innerHTML = core.FX_CURRENCIES.map((c) => {
    if (c.id === base) return ''
    const v = result[c.id]
    return `<div class="row fx-row" data-fx="${c.id}" tabindex="0"><span class="row-name">${c.id} <span class="muted">${escapeAttr(c.name)}</span></span><span class="row-value mono">${core.formatNumber(v, { scientific: prefs.scientific })}</span></div>`
  }).join('')
}

$('fx-refresh').onclick = () => void refreshFx()
$('fx-base').onchange = (e) => {
  kit.settings.baseCurrency = e.target.value
  void kit_ready_set('baseCurrency', e.target.value)
  renderFxRows()
}
async function kit_ready_set(key, value) {
  try {
    await api?.settings?.set?.(key, value)
  } catch {
    /* 未注册或不允许时静默 */
  }
}
$('fx-amount').oninput = () => renderFxRows()
$('fx-rows').onclick = (e) => {
  const row = e.target.closest('[data-fx]')
  if (!row) return
  void copyText(row.querySelector('.row-value').textContent, `${row.dataset.fx} 已复制`)
}
$('fx-rows').onkeydown = (e) => {
  if (e.key !== 'Enter') return
  const row = e.target.closest('[data-fx]')
  if (row) void copyText(row.querySelector('.row-value').textContent, `${row.dataset.fx} 已复制`)
}

// —— 人民币大写 ——//
$('rmb-input').oninput = () => {
  const raw = core.normalizeDigits($('rmb-input').value)
  const n = core.parseInput(raw)
  $('rmb-upper').textContent = core.toRmbUpper(n)
  $('rmb-cn').textContent = core.toChineseNumber(n)
}
document.querySelectorAll('[data-copy-target]').forEach((btn) => {
  btn.onclick = () => {
    const text = $(btn.dataset.copyTarget).textContent
    if (text && text !== '—') void copyText(text, '已复制')
  }
})

async function copyText(text, message) {
  try {
    await api.clipboard.writeText(text)
    kit.toast(message || '已复制', 'success')
  } catch (e) {
    kit.toast(e.message || '复制失败', 'error')
  }
}

$('copy-all').onclick = () => {
  const lines = $('rows').querySelectorAll('[data-unit], [data-radix]').values()
  const parts = [...lines]
    .map((input) => {
      const name = input.closest('.row')?.querySelector('.row-name')?.textContent || input.dataset.unit || input.dataset.radix
      return `${name}: ${input.value}`
    })
    .join('\n')
  void copyText(parts, '已复制全部结果')
}

// —— 启动 ——//
const booted = (async () => {
  const savedFav = await kit.load(FAV_KEY, [])
  if (Array.isArray(savedFav)) favorites = savedFav.filter((f) => typeof f === 'string' && f.includes(':')).slice(0, 24)
  const savedPrefs = await kit.load(PREF_KEY, {})
  if (savedPrefs && typeof savedPrefs === 'object') {
    if (Number.isFinite(Number(savedPrefs.precision))) prefs.precision = Math.max(4, Math.min(15, Number(savedPrefs.precision)))
    prefs.scientific = Boolean(savedPrefs.scientific)
    if (typeof savedPrefs.lastTab === 'string' && core.TAB_ORDER.includes(savedPrefs.lastTab)) prefs.lastTab = savedPrefs.lastTab
  }
  $('precision').value = String(prefs.precision)
  PluginKit.upgradeSelects() // 恢复精度设置后同步下拉触发器标签
  $('scientific').setAttribute('aria-pressed', String(prefs.scientific))
  if (prefs.lastTab) activeTab = prefs.lastTab
  await kit.ready
  ready = true
  renderTabs()
  renderRows(false)
  if (activeTab === 'fx') void ensureFx()
})()

kit.onMode(() => {
  if (!ready) return
  renderTabs()
  renderRows()
})

kit.onSettings(() => {
  if (!ready) return
  if (activeTab === 'fx') renderFxRows()
})

api?.onEnter?.(async (event) => {
  await booted
  const payload = event?.payload
  const text = typeof payload === 'string' ? payload : payload?.text
  if (text) {
    const first = $('rows').querySelector('[data-unit]')
    if (first && !Number.isNaN(core.parseInput(core.normalizeDigits(String(text))))) {
      first.value = String(text)
      first.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  if (kit.mode === 'quick') $('rows')?.querySelector('input')?.focus()
})
