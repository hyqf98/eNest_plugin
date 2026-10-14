import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const FX_URL = 'https://open.er-api.com/v6/latest/USD'

let activeTab = 'length'
let fxRates = null
let fxFetchedAt = 0
let fxSource = '' // live | cache | fallback
let editingField = '' // 焦点所在输入（联动以它为主）
let radixValues = { 2: '0', 8: '0', 10: '0', 16: '0' }
let ready = false

const kit = PluginKit.create({
  title: '单位与汇率',
  quickPlaceholder: '输入数值即时换算',
  height: 420,
  defaults: { baseCurrency: 'USD' },
})

const isSpecial = (tab) => tab === 'temp' || tab === 'radix' || tab === 'fx'

// —— Tabs —— //
function renderTabs() {
  $('tabs').innerHTML = core.TAB_ORDER.map(
    (id) =>
      `<button role="tab" aria-selected="${activeTab === id}" data-tab="${id}" class="chip ${activeTab === id ? 'active' : ''}">${core.CATEGORIES[id].name}</button>`,
  ).join('')
}

// —— 数值行 —— //
function unitRows(tab) {
  if (tab === 'temp') return core.TEMP_UNITS.map((u) => ({ id: u.id, name: u.name }))
  if (tab === 'radix') return core.RADIX_BASES.map((b) => ({ id: String(b), name: `${b} 进制`, radix: b }))
  return core.CATEGORIES[tab].units
}

function renderRows(preserveEditing = true) {
  const keep = preserveEditing ? editingField : ''
  const rows = unitRows(activeTab)
  // 保留当前行值：模式切换 / 重渲染不丢用户输入
  const previous = {}
  $('rows').querySelectorAll('[data-unit]').forEach((el) => (previous[el.dataset.unit] = el.value))
  if (activeTab === 'radix') {
    $('rows').innerHTML = rows
      .map(
        (r) => `<label class="row"><span class="row-name">${r.name}</span><input class="mono" inputmode="text" data-radix="${r.id}" value="${escapeAttr(radixValues[r.id] || '')}" spellcheck="false" /></label>`,
      )
      .join('')
  } else {
    $('rows').innerHTML = rows
      .map((r) => {
        const v = previous[r.id] ?? (r.id === keep ? '' : '')
        return `<label class="row"><span class="row-name">${r.name}</span><input class="mono" inputmode="decimal" data-unit="${r.id}" value="${escapeAttr(v)}" placeholder="0" spellcheck="false" /></label>`
      })
      .join('')
  }
  editingField = $('rows').querySelector(`[data-unit="${CSS.escape(keep)}"], [data-radix="${CSS.escape(keep)}"]`)?.dataset.unit || $('rows').querySelector(`[data-radix="${CSS.escape(keep)}"]`)?.dataset.radix || ''
  $('presets').innerHTML = activeTab === 'fx'
    ? ''
    : `<span class="eyebrow">常用换算</span>` +
      core.PRESETS.map((p) => `<button class="preset" data-preset="${p.value}">${p.label}</button>`).join('')
  $('fx-section').hidden = activeTab !== 'fx'
  $('rmb-section').hidden = activeTab !== 'fx' && activeTab !== 'mass'
  $('rmb-section').hidden = activeTab !== 'fx'
  $('foot-note').textContent =
    activeTab === 'fx'
      ? fxSource === 'live'
        ? `汇率更新于 ${new Date(fxFetchedAt).toLocaleString()} · open.er-api.com`
        : fxSource === 'cache'
          ? `网络不可用，展示 ${new Date(fxFetchedAt).toLocaleString()} 的缓存汇率`
          : '网络不可用且无缓存，展示静态参考汇率（仅供参考）'
      : '修改任一行，其余即时联动'
  if (activeTab === 'fx') void ensureFx()
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// —— 联动 —— //
$('rows').addEventListener('input', (e) => {
  const el = e.target
  if (el.dataset.unit) {
    editingField = el.dataset.unit
    const value = core.parseInput(core.normalizeDigits(el.value))
    const results = core.convertAll(activeTab, editingField, value)
    $('rows').querySelectorAll('[data-unit]').forEach((input) => {
      if (input === el) return
      const v = results[input.dataset.unit]
      input.value = v === undefined || !Number.isFinite(v) ? '' : core.formatNumber(v).replace(/,/g, '')
    })
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
  if (e.target.dataset.unit || e.target.dataset.radix) editingField = e.target.dataset.unit || e.target.dataset.radix
})
// 进制输入时为空则清空其它行
$('rows').addEventListener('change', () => {})

// —— 预设 —— //
$('presets').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]')
  if (!btn) return
  // 形如 "1 lb = 453.59 g"：等号左侧数量填入左侧单位行，右侧联动
  const m = btn.dataset.preset.match(/^([\d.]+)\s+(\S+)\s*=\s*([\d.]+)\s+(\S+)$/)
  if (!m) return
  const [, amount, fromUnit] = m
  // 切换到对应类目
  for (const [tabId, cat] of Object.entries(core.CATEGORIES)) {
    const src = cat.units?.find((u) => u.id === fromUnit)
    if (src) {
      activeTab = tabId
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

// —— Tabs 切换 —— //
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab
  if (!tab) return
  activeTab = tab
  editingField = ''
  renderTabs()
  renderRows(false)
})

// —— 汇率 —— //
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
  select.innerHTML = core.FX_CURRENCIES.map((c) => `<option value="${c.id}" ${c.id === base ? 'selected' : ''}>${c.id} ${c.name}</option>`).join('')
  if (!fxRates) {
    $('fx-rows').innerHTML = '<div class="empty small">正在获取汇率…</div>'
    return
  }
  const amount = core.parseInput(core.normalizeDigits($('fx-amount').value)) || 0
  const result = core.fxConvert(fxRates, base, amount)
  $('fx-rows').innerHTML = core.FX_CURRENCIES.map((c) => {
    if (c.id === base) return ''
    const v = result[c.id]
    return `<div class="row fx-row" data-fx="${c.id}" tabindex="0"><span class="row-name">${c.id} <span class="muted">${c.name}</span></span><span class="row-value mono">${core.formatNumber(v)}</span></div>`
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

// —— 人民币大写 —— //
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
  const lines = $('rows')
    .querySelectorAll('[data-unit], [data-radix]')
    .values()
  const parts = [...lines].map((input) => `${input.previousElementSibling?.textContent || input.dataset.unit || input.dataset.radix}: ${input.value}`).join('\n')
  void copyText(parts, '已复制全部结果')
}

// —— 启动 —— //
const booted = (async () => {
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
    // 载荷数字直接填入当前类目第一行
    const first = $('rows').querySelector('[data-unit]')
    if (first && core.parseInput(core.normalizeDigits(String(text))) !== NaN) {
      first.value = String(text)
      first.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  if (kit.mode === 'quick') $('rows')?.querySelector('input')?.focus()
})
