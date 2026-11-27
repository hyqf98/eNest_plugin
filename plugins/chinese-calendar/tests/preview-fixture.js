/**
 * 中国日历的浏览器预览夹具：在普通浏览器里伪造 window.enest，无需 eNest 宿主。
 * 只用于预览与界面截图，不进入构建产物。
 *
 * 网络：net.fetch 透传到浏览器 fetch（Open-Meteo / holiday-cn 均开 CORS），预览里天气与节假日是真的。
 * 主题：URL ?theme=dark|light 切换；按 T 键也可切换。
 * 模式：URL ?mode=quick|shell 决定初始布局。
 */
const params = new URLSearchParams(location.search)
const listeners = new Map()
const storageData = new Map()
// URL 预置偏好（截图/验收用）：?widget=today|countdown|mini  &prefs=<json>
const preset = Object.fromEntries(['widget', 'weekStart'].map(k => [k, params.get(k)]).filter(([, v]) => v))
if (params.get('prefs')) { try { Object.assign(preset, JSON.parse(params.get('prefs'))) } catch { /* 忽略非法 JSON */ } }
if (Object.keys(preset).length) storageData.set('plugin.prefs.v1', preset)
let mode = params.get('mode') === 'quick' ? 'quick' : 'shell'
let theme = params.get('theme') === 'dark' ? 'dark' : 'light'

const on = (name, cb) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb); return () => listeners.get(name)?.delete(cb) }
const emit = (name, payload) => { for (const cb of listeners.get(name) ?? []) cb(payload) }

function tokens(dark) {
  return {
    '--bg': dark ? '#17191b' : '#f6f6f4',
    '--surface': dark ? '#202326' : '#ffffff',
    '--surface-2': dark ? '#292d31' : '#eeefed',
    '--surface-3': dark ? '#33383d' : '#e5e7e4',
    '--text': dark ? '#f2f3f3' : '#292c2e',
    '--text-2': dark ? '#adb3b8' : '#666c70',
    '--text-3': dark ? '#7e878f' : '#82888b',
    '--border': dark ? 'rgba(242,243,243,0.09)' : 'rgba(41,44,46,0.08)',
    '--border-strong': dark ? 'rgba(242,243,243,0.16)' : 'rgba(41,44,46,0.16)',
    '--accent': dark ? '#e98654' : '#bd542b',
    '--accent-soft': dark ? 'rgba(233,134,84,0.16)' : 'rgba(189,84,43,0.12)',
    '--ok': dark ? '#77bfa4' : '#318469',
    '--ok-soft': dark ? 'rgba(119,191,164,0.16)' : 'rgba(49,132,105,0.12)',
    '--danger': dark ? '#e79589' : '#c54f46',
    '--danger-soft': dark ? 'rgba(231,149,137,0.16)' : 'rgba(197,79,70,0.12)',
    '--link': dark ? '#e98654' : '#bd542b',
  }
}

function appearance() {
  return {
    version: 2, revision: Date.now(), mode: theme,
    theme: { source: 'enest.builtin', id: 'default', name: '默认主题', version: 1, legacy: false },
    requestedMode: theme,
    tokens: tokens(theme === 'dark'),
    fonts: { body: 'Inter, PingFang SC, sans-serif', heading: 'Songti SC, serif', mono: 'Menlo, monospace', scale: 1 },
    components: { controlRadius: 8, cardRadius: 12, panelRadius: 10, borderWidth: 1 },
    background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
    layout: { variant: 'default', density: 1, gap: 12, sidebarWidth: 220, contentWidth: 1200, columns: 4 },
    animation: { requested: 'medium', effective: 'medium', continuous: false },
  }
}

function applyDom() {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  for (const [key, value] of Object.entries(tokens(theme === 'dark'))) root.style.setProperty(key, value)
}

window.enest = {
  getPluginId: () => 'com.github.eNest.chinese-calendar',
  getEnterCode: () => 'main',
  getLaunchMode: () => mode,
  getLaunchContext: () => ({ mode, code: 'main', payload: null }),
  onModeChange: cb => on('mode', cb),
  onEnter: cb => on('enter', cb),
  onOut: cb => on('out', cb),
  onDestroy: () => () => {},
  theme: {
    getAppearance: async () => appearance(),
    onAppearanceChange: cb => on('appearance', cb),
    getTokens: async () => ({ mode: theme, tokens: tokens(theme === 'dark') }),
  },
  ui: {
    setInputContext: () => {},
    openInShell: async () => { mode = 'shell'; emit('mode', mode) },
    focusSearch: async () => {},
    dismissQuick: async () => {},
    setHeight: async () => {},
    onThemeChange: cb => on('appearance', cb),
    toast: () => {},
  },
  quickInput: { configure: async () => {}, release: () => {}, escape: async () => {}, onChange: () => () => {}, onAction: () => () => {} },
  settings: { get: async () => null, set: async () => true, onChange: () => () => {} },
  storage: {
    get: async key => storageData.get(key) ?? null,
    set: async (key, value) => { storageData.set(key, structuredClone(value)); return true },
    remove: async key => { storageData.delete(key); return true },
    keys: async () => [...storageData.keys()],
    flush: async () => ({}),
    commit: async ops => { for (const op of ops) { if (op.op === 'set') storageData.set(op.key, structuredClone(op.value)); else storageData.delete(op.key) } return true },
  },
  net: {
    // 透传到真实网络：预览里看到的是真实天气与节假日数据
    fetch: async ({ url, timeoutMs = 15000 }) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }
      } catch (error) {
        throw new Error(`net.fetch ${error?.name === 'TimeoutError' ? 'timeout' : 'failed'}`)
      }
    },
  },
  shell: { openExternal: async url => { window.open(url, '_blank', 'noopener'); return true }, saveTextFile: async () => ({ ok: false }) },
  clipboard: { writeText: async () => true },
  mcp: { registerHandlers: async () => true },
  on,
  off: (name, cb) => listeners.get(name)?.delete(cb),
}

window.__preview = {
  mode(value) { mode = value; emit('mode', mode) },
  enter() { emit('enter', { mode, code: 'main', payload: null }) },
  theme(value) { theme = value === 'dark' ? 'dark' : 'light'; applyDom(); emit('appearance', appearance()) },
}

applyDom()
window.addEventListener('keydown', event => {
  if (event.key === 't' || event.key === 'T') window.__preview.theme(theme === 'dark' ? 'light' : 'dark')
})
