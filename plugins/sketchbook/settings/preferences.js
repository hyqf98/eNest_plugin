/**
 * 素描本 · 自绘设置页（零构建，隔离沙箱）
 *
 * 这里只有宿主注入的 window.enestSettings：
 *   getState() 读快照，onState() 订阅，action({type:'set'}) 写字段，action({type:'native'}) 进原生分组。
 * 字段 id 是一次性句柄，不能持久化、不能猜测，每次渲染都用当前快照的 id。
 *
 * 页面形态：左侧书签索引（分组），右侧一张活页纸；每行是"纸品调色台"式的
 * 标签 + 控件，滑块与颜色即时显示当前值，但只有真实点击才提交。
 *
 * 铁律：不在收到快照时回写值（会造成保存循环），不在页面加载时自动保存；
 * 只用真实点击触发 action，失败保留宿主后续快照为准。
 */

const api = window.enestSettings
const root = document.getElementById('settings-root')
if (!root) throw new Error('#settings-root is missing')


const state = {
  snapshot: null,
  busy: new Set(),
  status: '',
  statusKind: 'info',
  activeGroup: null,
  dirty: new Map(),
}

const listeners = () => render()

/** 快照里的字段是只读描述；这里只做展示态的本地镜像，真实值仍以宿主为准。 */
function fieldValue(field) {
  const pending = state.dirty.get(field.id)
  return pending === undefined ? field.value : pending
}

function setStatus(text, kind = 'info') {
  state.status = text
  state.statusKind = kind
  const node = root.querySelector('[data-status]')
  if (node) {
    node.textContent = text
    node.dataset.kind = kind
  }
}

async function commit(field, value) {
  if (!sinkRef || state.busy.has(field.id)) return
  state.busy.add(field.id)
  state.dirty.set(field.id, value)
  render()
  try {
    const result = await sinkRef.action({ type: 'set', fieldId: field.id, value })
    if (result?.ok) {
      state.dirty.delete(field.id)
      setStatus(`已记下「${field.label}」`, 'ok')
    } else {
      // 失败就退回宿主值，不能让界面停在没写进去的状态。
      state.dirty.delete(field.id)
      setStatus(result?.error || '这一笔没能落下，请再试一次。', 'error')
    }
  } catch {
    state.dirty.delete(field.id)
    setStatus('这一笔没能落下，请再试一次。', 'error')
  } finally {
    state.busy.delete(field.id)
    render()
  }
}

async function openNative(section) {
  try {
    const result = await sinkRef.action({ type: 'native', section: section.id })
    if (!result?.ok) setStatus(result?.error || '原生设置暂时无法打开。', 'error')
  } catch {
    setStatus('原生设置暂时无法打开。', 'error')
  }
}

/**
 * 桌面预设的缩略图。
 *
 * 宿主快照只给 label + value（`ThemeSettingsFieldDescriptor` 没有 preview 字段），
 * 所以设置页必须自己按预设 id 画缩略图。这里存的是与 plugin.json 一致的
 * 两段 paint；新增预设时同步这一张表即可（id 变了会退回纯文字页签）。
 */
const DESK_SWATCHES = {
  warmSand: 'linear-gradient(135deg, #fffefb, #eee7db)',
  morningMist: 'linear-gradient(135deg, #fdfdfc, #e3e1dc)',
  terracotta: 'linear-gradient(135deg, #fffaf4, #eddbc4)',
  coolMist: 'linear-gradient(135deg, #fcfdfe, #dbe3ea)',
}

/** 字段值 → 缩略图 paint；没有对应缩略图的预设返回 null。 */
const swatchFor = value => DESK_SWATCHES[String(value)] ?? null

/**
 * 桌面预设的完整背景（与 plugin.json 的 palettes[].css 一致）。
 * 快照不公开 background.palette 的 paint，所以设置页自己存一份；
 * 新增预设时这里和 DESK_SWATCHES 一起补。
 */
const DESK_PAINTS = {
  warmSand: 'radial-gradient(ellipse 54% 46% at 6% 8%, rgba(251,146,60,.30), transparent 66%), radial-gradient(ellipse 44% 40% at 94% 6%, rgba(253,224,71,.34), transparent 68%), radial-gradient(ellipse 64% 50% at 68% 99%, rgba(168,162,158,.34), transparent 74%), linear-gradient(152deg, #fffefb 0%, #f8f4ec 42%, #eee7db 100%)',
  morningMist: 'radial-gradient(ellipse 54% 44% at 14% 10%, rgba(168,162,158,.24), transparent 70%), radial-gradient(ellipse 48% 42% at 88% 86%, rgba(198,194,189,.40), transparent 72%), radial-gradient(ellipse 42% 36% at 52% 44%, rgba(255,255,255,.9), transparent 66%), linear-gradient(160deg, #fdfdfc 0%, #f1f0ed 50%, #e3e1dc 100%)',
  terracotta: 'radial-gradient(ellipse 48% 44% at 8% 20%, rgba(234,88,12,.24), transparent 68%), radial-gradient(ellipse 50% 42% at 92% 12%, rgba(251,146,60,.28), transparent 70%), radial-gradient(ellipse 56% 44% at 60% 94%, rgba(253,230,138,.36), transparent 72%), linear-gradient(155deg, #fffaf4 0%, #f7ebda 46%, #eddbc4 100%)',
  coolMist: 'radial-gradient(ellipse 50% 44% at 10% 12%, rgba(125,211,252,.30), transparent 70%), radial-gradient(ellipse 48% 42% at 90% 16%, rgba(94,234,212,.24), transparent 70%), radial-gradient(ellipse 58% 46% at 64% 94%, rgba(148,163,184,.36), transparent 74%), linear-gradient(158deg, #fcfdfe 0%, #ecf0f4 50%, #dbe3ea 100%)',
}

/* ── 控件：按字段类型构造，结构与壳的设置页一致（左标签 / 右控件） ── */

function colorControl(field) {
  const wrap = document.createElement('div')
  wrap.className = 'color-control'
  const input = document.createElement('input')
  input.type = 'color'
  const current = String(fieldValue(field) ?? '')
  input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#000000'
  input.disabled = state.busy.has(field.id)
  input.setAttribute('aria-label', field.label)
  const code = document.createElement('code')
  code.textContent = input.value
  input.addEventListener('input', () => { code.textContent = input.value })
  // 颜色选择器拖拽期间不提交，松手才落笔
  input.addEventListener('change', () => { void commit(field, input.value) })
  wrap.append(input, code)
  return { node: wrap, wide: true }
}

function switchControl(field) {
  const label = document.createElement('label')
  label.className = 'switch-control'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = fieldValue(field) === true
  input.disabled = state.busy.has(field.id)
  const glyph = document.createElement('i')
  glyph.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span')
  text.textContent = input.checked ? '开启' : '关闭'
  input.addEventListener('change', () => { void commit(field, input.checked) })
  label.append(input, glyph, text)
  return { node: label, wide: false }
}

function numberControl(field) {
  const wrap = document.createElement('div')
  wrap.className = 'slider-control'
  const value = Number(fieldValue(field))
  const min = Number(field.min ?? 0)
  const max = Number(field.max ?? 100)
  const step = Number(field.step ?? 1)
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(Number.isFinite(value) ? value : min)
  input.disabled = state.busy.has(field.id)
  input.setAttribute('aria-label', field.label)
  const out = document.createElement('output')
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0
  const paint = () => {
    const ratio = (Number(input.value) - min) / (max - min || 1)
    input.style.setProperty('--range-fill', `${Math.round(ratio * 1000) / 10}%`)
    out.textContent = Number(input.value).toFixed(decimals)
  }
  paint()
  input.addEventListener('input', paint)
  input.addEventListener('change', () => { void commit(field, Number(input.value)) })
  wrap.append(input, out)
  return { node: wrap, wide: true }
}

function selectControl(field) {
  const options = field.options ?? []
  const current = fieldValue(field)
  // 有缩略图（本包预设色板或宿主 preview）→ 纸样卡；纯文字短列表 → 胶囊分段。
  const withSwatch = options.map(option => ({ ...option, swatch: swatchFor(option.value) }))
  const anySwatch = withSwatch.some(option => option.swatch || option.preview?.kind === 'swatch')
  const cards = anySwatch
  const wrap = document.createElement('div')
  wrap.className = cards ? 'choice-cards' : 'segmented'
  if (!cards) wrap.setAttribute('role', 'group')

  for (const option of withSwatch) {
    const button = document.createElement('button')
    button.type = 'button'
    button.disabled = state.busy.has(field.id)
    if (cards) {
      // 卡片形态必须带上 .choice-card，否则缩略图与边框样式全部落空
      button.className = 'choice-card'
      if (option.value === current) button.classList.add('active')
      button.setAttribute('aria-pressed', String(option.value === current))
      const swatch = document.createElement('i')
      if (option.swatch) {
        swatch.style.background = option.swatch
      } else if (option.preview?.kind === 'swatch' && Array.isArray(option.preview.stops)) {
        swatch.style.background = `linear-gradient(135deg, ${option.preview.stops[0]} 0%, ${option.preview.stops[1]} 100%)`
      } else if (option.preview?.kind === 'asset' && typeof option.preview.src === 'string'
        && /^enest(?:-settings|-home|-quick)?:\/\//.test(option.preview.src)) {
        swatch.style.background = `center/cover no-repeat url("${option.preview.src}")`
      } else {
        swatch.hidden = true
      }
      const label = document.createElement('span')
      label.textContent = option.label
      button.append(swatch, label)
      if (option.description) {
        const small = document.createElement('small')
        small.textContent = option.description
        button.append(small)
      }
    } else {
      button.textContent = option.label
      if (option.value === current) button.classList.add('active')
      button.setAttribute('aria-pressed', String(option.value === current))
      if (option.description) button.title = option.description
    }
    button.addEventListener('click', () => { void commit(field, option.value) })
    wrap.append(button)
  }
  return { node: wrap, wide: cards }
}

/** 字段类型 → 控件；不支持的控件返回 null，由调用方显示回落提示。 */
function controlFor(field) {
  if (field.type === 'color') return colorControl(field)
  if (field.type === 'switch') return switchControl(field)
  if (field.type === 'number') return numberControl(field)
  if (field.type === 'select') return selectControl(field)
  return null
}

/** 一行字段：左标签 + 说明，右控件；与壳的 .field 结构一致。 */
function fieldRow(field) {
  const row = document.createElement('div')
  row.className = 'field'
  row.dataset.fieldId = field.id

  const text = document.createElement('div')
  text.className = 'field-text'
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = field.label
  text.append(label)
  if (field.help) {
    const desc = document.createElement('p')
    desc.className = 'desc'
    desc.textContent = field.help
    text.append(desc)
  }
  row.append(text)

  const control = controlFor(field)
  if (!control) {
    const note = document.createElement('span')
    note.className = 'desc'
    note.textContent = '这一项在原生设置里调整。'
    const holder = document.createElement('div')
    holder.className = 'field-control'
    holder.append(note)
    row.append(holder)
    return row
  }
  const holder = document.createElement('div')
  holder.className = `field-control${control.wide ? ' is-wide' : ''}`
  holder.append(control.node)
  row.append(holder)
  return row
}

/* ── 页面骨架：顶部 tab + 单列卡片（与壳的设置页一致） ── */
function buildShell(snapshot) {
  const page = document.createElement('section')
  page.className = 'page-settings'

  const shell = document.createElement('div')
  shell.className = 'settings-shell'

  const header = document.createElement('div')
  header.className = 'settings-header'
  const title = document.createElement('h1')
  title.textContent = '素描本'
  const subtitle = document.createElement('p')
  subtitle.textContent = '主题外观设置。系统、账号与安全仍由宿主原生界面负责。'
  header.append(title, subtitle)
  shell.append(header)

  const groups = snapshot.groups ?? []
  const active = state.activeGroup && groups.some(group => group.id === state.activeGroup)
    ? state.activeGroup : groups[0]?.id ?? null
  state.activeGroup = active

  const tabs = document.createElement('div')
  tabs.className = 'settings-tabs'
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '设置分组')
  for (const group of groups) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.dataset.group = group.id
    button.setAttribute('aria-selected', String(group.id === active))
    if (group.id === active) button.classList.add('active')
    button.textContent = group.title
    button.addEventListener('click', () => {
      state.activeGroup = group.id
      render()
    })
    tabs.append(button)
  }
  shell.append(tabs)

  const activeGroup = groups.find(group => group.id === active)
  if (activeGroup) {
    const card = document.createElement('section')
    card.className = 's-card'
    card.setAttribute('aria-label', activeGroup.title)
    const h2 = document.createElement('h2')
    h2.textContent = activeGroup.title
    card.append(h2)
    if (activeGroup.description) {
      const hint = document.createElement('p')
      hint.className = 'hint'
      hint.textContent = activeGroup.description
      card.append(hint)
    }
    for (const field of activeGroup.fields) card.append(fieldRow(field))

    const status = document.createElement('p')
    status.className = 'settings-status'
    status.dataset.status = ''
    status.dataset.kind = state.statusKind
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    status.textContent = state.status
    card.append(status)
    shell.append(card)
  }

  // 原生分组入口放在最后一张卡片里，不占顶部
  const native = snapshot.nativeSections ?? []
  if (native.length) {
    const card = document.createElement('section')
    card.className = 's-card'
    const h2 = document.createElement('h2')
    h2.textContent = '可信原生设置'
    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = '账号、权限、开发者与系统安全由宿主原生界面负责，主题不能替代。'
    card.append(h2, hint)
    const links = document.createElement('div')
    links.className = 'native-links'
    for (const section of native) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = section.title
      button.addEventListener('click', () => { void openNative(section) })
      links.append(button)
    }
    card.append(links)
    shell.append(card)
  }

  page.append(shell)
  return page
}

function render() {
  const snapshot = state.snapshot
  if (!snapshot) return
  const hadFocus = root.contains(document.activeElement)
  const keepGroup = state.activeGroup
  // 记住滚动位置：保存一个字段后整页重建，不该把用户弹回顶部。
  const scrollTop = root.scrollTop
  root.replaceChildren(buildShell(snapshot))
  root.scrollTop = scrollTop
  // 重建后把键盘焦点还给当前分组 tab，键盘用户不会丢失位置。
  if (hadFocus && keepGroup) {
    const tab = root.querySelector(`.settings-tabs button[data-group="${CSS.escape(keepGroup)}"]`)
    tab?.focus({ preventScroll: true })
  }
}

function accept(snapshot) {
  if (!snapshot || snapshot.version !== 1) return
  // 宿主每次写入都会推新快照；旧的本地待提交值已被确认或拒绝，统一清掉。
  state.snapshot = snapshot
  document.documentElement.dataset.theme = snapshot.appearance?.mode === 'dark' ? 'dark' : 'light'
  applyTokens(snapshot.appearance)
  render()
}

/** 设置页用当前主题的真实 token 上色，这样调色时的即时反馈就是最终效果。 */
function applyTokens(appearance) {
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(appearance?.tokens ?? {})) {
    if (/^--(bg|surface|surface-2|surface-3|text|text-2|text-3|accent|ok|danger|border|border-strong|link)$/.test(key)) {
      style.setProperty(key, value)
    }
  }
  const fonts = appearance?.fonts ?? {}
  if (fonts.heading) style.setProperty('--font-heading', fonts.heading)
  if (fonts.body) style.setProperty('--font', fonts.body)
  if (fonts.mono) style.setProperty('--font-mono', fonts.mono)
  style.setProperty('--appearance-font-scale', String(fonts.scale ?? 1))
  const components = appearance?.components ?? {}
  style.setProperty('--appearance-control-radius', `${components.controlRadius ?? 6}px`)
  style.setProperty('--appearance-card-radius', `${components.cardRadius ?? 3}px`)
  style.setProperty('--appearance-panel-radius', `${components.panelRadius ?? 4}px`)
  style.setProperty('--appearance-border-width', `${components.borderWidth ?? 2}px`)

  // 桌面渐变：设置页的背景与主页面用同一张，切换预设时这里也要跟着变。
  // 快照里的 appearance 不带 background（QuickThemeAppearance 只公开 tokens/fonts/
  // components/animation），所以这里按当前选中的预设 id 查本地色板表。
  const preset = currentDeskPreset()
  const paint = preset ? DESK_PAINTS[preset] : null
  if (paint) style.setProperty('--sk-desk-paint', paint)
}

/** 当前快照里「桌面」预设字段的值（没有该字段时返回 null）。 */
function currentDeskPreset() {
  for (const group of state.snapshot?.groups ?? []) {
    for (const field of group.fields) {
      if (field.type === 'select' && (field.options ?? []).some(o => DESK_SWATCHES[String(o.value)])) {
        return String(field.value)
      }
    }
  }
  return null
}

function startupMessage(text) {
  const p = document.createElement('p')
  p.className = 'sk-settings-startup'
  p.textContent = text
  root.replaceChildren(p)
}

/**
 * 本地预览替身：仅在没有 enestSettings 的开发预览里使用。
 * 它从本包 manifest 的声明生成同样的字段描述（同 type/options/范围），
 * 让样式可以单独校验；生产页面永远不会走到这里。
 */
async function previewBridge() {
  const { loadPreviewTheme } = await import('../src/shared/previewTheme.js')
  const pack = await loadPreviewTheme()
  const listeners = new Set()
  const values = new Map()
  const widget = type => ({ switch: 'switch', select: 'select', slider: 'number', token: 'color', color: 'color', media: 'color', font: 'select' })[type] ?? null
  const snapshot = () => {
    const groups = pack.settings.groups.map(group => ({
      id: group.id,
      title: group.title,
      fields: group.fields.map((field, index) => {
        const type = widget(field.type)
        if (!type) return null
        const id = `p:${group.id}:${index}`
        const value = values.has(field.key) ? values.get(field.key) : field.default
        return {
          id, label: field.label, type,
          value: value ?? (type === 'color' ? '#000000' : null),
          ...(field.options ? { options: field.options.map(o => ({ label: o.label, value: o.value, description: o.description, preview: o.preview })) } : {}),
          ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.step !== undefined ? { step: field.step } : {}),
          __key: field.key,
        }
      }).filter(Boolean),
      __description: group.description,
    }))
    return {
      version: 1, revision: state.revision ?? 1, locale: 'zh-CN',
      appearance: { ...pack.variants.light, mode: 'light', tokens: { ...pack.tokens, ...pack.variants.light.tokens }, resources: { fonts: [] } },
      groups, nativeSections: [{ id: 'general', title: '系统、账号、性能与安全' }, { id: 'theme', title: '主题切换与本地媒体' }],
    }
  }
  return {
    ready() {},
    getState: async () => snapshot(),
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async action(action) {
      if (action?.type === 'set') {
        const field = snapshot().groups.flatMap(g => g.fields).find(f => f.id === action.fieldId)
        if (field?.__key) values.set(field.__key, action.value)
        state.revision = (state.revision ?? 1) + 1
        listeners.forEach(fn => fn(snapshot()))
        return { ok: true }
      }
      return { ok: true }
    },
  }
}

/**
 * 启动顺序是这套握手的关键：
 *   1. 拿到桥之后 **立刻 ready()**，不做任何可能抛错的准备工作；
 *   2. 再订阅、取首帧快照；
 *   3. 渲染失败只在页面内显示错误，绝不让握手失败。
 *
 * 宿主 8 秒内收不到 ready 就会判定主题设置不可用、回退系统设置。
 * 之前把 ready() 放在取快照之后，任何一步异常都会拖死握手 —— 表现就是
 * 设置页顶部出现"主题设置暂不可用"。
 */
let sinkRef = null

async function boot() {
  // 开发预览（vite dev 直开、无宿主桥）用本地替身；宿主内永远走真实桥。
  // 注意：这里不能挡在 ready() 前面 —— 只有在确实没有桥时才走替身。
  let bridge = api
  if (!bridge && import.meta.env?.DEV) {
    try { bridge = await previewBridge() } catch { bridge = null }
  }
  if (!bridge) {
    startupMessage('设置桥不可用，请从 eNest 内打开素描本设置。')
    return
  }
  sinkRef = bridge
  // 先握手：这一步不能有任何前置依赖
  try { bridge.ready() } catch { /* 宿主已回收，后面自然不会渲染 */ }

  let off = () => {}
  try {
    off = bridge.onState(accept)
  } catch { /* 订阅失败仍可尝试首帧 */ }

  // 首帧快照：失败时保留骨架并给一句提示，不抛到模块顶层
  bridge.getState()
    .then(accept)
    .catch(() => { startupMessage('暂时读不到设置，请重新打开设置页。') })

  window.addEventListener('pagehide', () => { try { off() } catch { /* 已卸载 */ } }, { once: true })
}

// 渲染期异常兜底：把错误留在页面里，不再让整个页面静默白屏
window.addEventListener('error', event => {
  if (state.snapshot) return
  startupMessage('设置页渲染出错：' + String(event.message || '').slice(0, 160))
})

boot()
