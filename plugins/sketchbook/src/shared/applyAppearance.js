/**
 * 把宿主外观快照应用到本文档根节点。
 *
 * 宿主只为「壳渲染层」和内置首页注入样式；插件首页是隔离页面，必须自己把
 * snapshot.tokens / fonts / components / layout 写成 CSS 变量。这里只实现公开契约
 * （见 docs/site/plugin/themes.md 的 appearanceStyleProperties），不读宿主私有设置。
 */

const TOKEN_KEYS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3',
  '--accent', '--ok', '--danger', '--border', '--border-strong', '--link',
]

/** 与 manifest 的声明色板一致；沿用旧 id，避免重装后丢失已存的色板选择。 */
export const SKETCH_PALETTES = [
  {
    id: 'markerStrokes', name: '纸灰',
    stops: ['color-mix(in srgb, var(--bg) 74%, #88928b)', 'color-mix(in srgb, var(--surface-2) 88%, #87938e)'],
    css: 'radial-gradient(ellipse 78% 86% at 12% 26%, color-mix(in srgb, var(--bg) 74%, #88928b), transparent 78%), linear-gradient(152deg, var(--bg), color-mix(in srgb, var(--surface-2) 88%, #87938e))',
    wash: ['#87958d', '#939e9a'],
  },
  {
    id: 'sketchPaper', name: '灰蓝',
    stops: ['color-mix(in srgb, var(--bg) 76%, #7c919c)', 'color-mix(in srgb, var(--surface-2) 84%, #7d909a)'],
    css: 'radial-gradient(ellipse 78% 86% at 12% 26%, color-mix(in srgb, var(--bg) 76%, #7c919c), transparent 78%), linear-gradient(152deg, var(--bg), color-mix(in srgb, var(--surface-2) 84%, #7d909a))',
    wash: ['#7c919c', '#8d9d9f'],
  },
  {
    id: 'chalkBoard', name: '鼠尾草',
    stops: ['color-mix(in srgb, var(--bg) 76%, #849789)', 'color-mix(in srgb, var(--surface-2) 84%, #7e9487)'],
    css: 'radial-gradient(ellipse 78% 86% at 12% 26%, color-mix(in srgb, var(--bg) 76%, #849789), transparent 78%), linear-gradient(152deg, var(--bg), color-mix(in srgb, var(--surface-2) 84%, #7e9487))',
    wash: ['#849789', '#96a397'],
  },
]

/** 宿主额外光效默认关闭；不透明原生页面自己绘制轻量纸面漂移。 */
export const SKETCH_BACKGROUND = {
  media: null, kind: 'gradient', palette: 'markerStrokes', color: '#e2e5e2',
  opacity: 0.76, fit: 'cover', effect: 'none', texture: 'paper',
  intensity: 0.46, speed: 0.65, direction: 24, warmth: 0.2, grain: 0.12, scale: 1, wash: 0.16,
}

const bounded = (value, fallback, min = 0, max = 1) => Number.isFinite(value)
  ? Math.min(max, Math.max(min, value)) : fallback

/** 只消费宿主已验证的颜色绘制，不把媒体 URL 或任意 CSS 当作纸面。 */
function backgroundProperties(background = {}) {
  const palette = SKETCH_PALETTES.find(item => item.id === background.palette) ?? SKETCH_PALETTES[0]
  const paint = background.media?.type === 'color' ? background.media.value : background.kind === 'color' ? background.color : null
  const safePaint = typeof paint === 'string' && paint.length <= 1024
    && !/[;{}<>\\\\]|url\s*\(/i.test(paint) && CSS.supports('background', paint)
  const paperPaint = background.kind === 'none' ? 'none' : safePaint ? paint : palette.css
  return {
    '--sk-paper-paint': paperPaint,
    '--sk-paper-opacity': String(bounded(background.opacity ?? background.media?.opacity, 0.76)),
    '--sk-wash-a': `color-mix(in srgb, var(--bg) 48%, ${palette.wash[0]})`,
    '--sk-wash-b': `color-mix(in srgb, var(--bg) 54%, ${palette.wash[1]})`,
    '--sk-drift-strength': String(0.3 + bounded(background.intensity, 0.46) * 0.5),
    '--sk-stripe-strength': String(0.16 + bounded(background.intensity, 0.46) * 0.18),
    '--sk-grain': background.texture === 'none' ? '0' : String(bounded(background.grain, 0.12)),
    '--sk-drift-duration': `${(18 / bounded(background.speed, 0.65, 0.25, 2)).toFixed(2)}s`,
  }
}

/** 只监听可见性，无计时器或逐帧 JS；页面卸载时由入口显式解除。 */
export function observeDocumentVisibility() {
  const root = document.documentElement
  const sync = () => { root.dataset.skVisible = String(!document.hidden) }
  sync()
  document.addEventListener('visibilitychange', sync)
  return () => {
    document.removeEventListener('visibilitychange', sync)
    delete root.dataset.skVisible
  }
}

let appliedKeys = new Set()
const fontFaces = new Map()

export function applyAppearance(appearance, resources) {
  if (!appearance) return
  const root = document.documentElement
  const { fonts = {}, components = {}, layout = {}, animation = {}, background = {} } = appearance
  const mode = appearance.mode
  const tokens = appearance.tokens ?? {}

  root.dataset.theme = mode
  root.dataset.appearanceTheme = appearance.theme?.id ?? ''
  root.dataset.appearanceLayout = layout.variant ?? ''
  root.dataset.anim = animation.effective ?? 'medium'
  root.dataset.skContinuous = String(animation.continuous !== false)
  root.dataset.skBackground = background.kind === 'none' ? 'none' : 'paper'
  root.style.colorScheme = mode

  const vars = {
    ...Object.fromEntries(TOKEN_KEYS.filter(key => tokens[key]).map(key => [key, tokens[key]])),
    ...backgroundProperties(background),
    '--font': fonts.body || '',
    '--font-heading': fonts.heading || fonts.body || '',
    '--font-mono': fonts.mono || '',
    '--appearance-font-scale': String(fonts.scale ?? 1),
    '--font-size-base': `${(14 * (fonts.scale ?? 1)).toFixed(2)}px`,
    '--appearance-control-radius': `${components.controlRadius ?? 10}px`,
    '--appearance-card-radius': `${components.cardRadius ?? 18}px`,
    '--appearance-panel-radius': `${components.panelRadius ?? 24}px`,
    '--appearance-border-width': `${components.borderWidth ?? 1}px`,
    '--appearance-density': String(layout.density ?? 1),
    '--appearance-gap': `${layout.gap ?? 16}px`,
    '--appearance-columns': String(Math.round(layout.columns ?? 3)),
    '--appearance-content-width': `${layout.contentWidth ?? 1440}px`,
    '--appearance-tab-opacity': String(layout.tabOpacity ?? 1),
  }

  for (const key of appliedKeys) if (!(key in vars)) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(vars)) {
    if (value) root.style.setProperty(key, value)
    else root.style.removeProperty(key)
  }
  appliedKeys = new Set(Object.keys(vars))

  const hasMedia = Boolean(appearance.background?.media?.value)
  root.classList.toggle('has-bg-media', hasMedia)

  const wanted = resources?.fonts ?? []
  for (const [family, entry] of fontFaces) {
    if (!wanted.some(font => font.family === family && font.url === entry.url)) {
      document.fonts.delete(entry.face)
      fontFaces.delete(family)
    }
  }
  for (const font of wanted) {
    if (fontFaces.get(font.family)?.url === font.url) continue
    if (!/^enest(?:-home)?:\/\/appearance\/font\/[a-f0-9]{64}$/.test(font.url)) continue
    const face = new FontFace(font.family, `url(${JSON.stringify(font.url)})`)
    fontFaces.set(font.family, { face, url: font.url })
    void face.load().then(loaded => { if (fontFaces.get(font.family)?.face === face) document.fonts.add(loaded) }).catch(() => undefined)
  }
}

export function releaseFonts() {
  for (const entry of fontFaces.values()) document.fonts.delete(entry.face)
  fontFaces.clear()
}
