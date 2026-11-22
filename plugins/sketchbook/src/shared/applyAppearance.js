/**
 * 把宿主外观快照应用到本文档根节点。
 *
 * 宿主只为「壳渲染层」和内置首页注入样式；插件首页是隔离页面，必须自己把
 * snapshot.tokens / fonts / components / layout 写成 CSS 变量。这里只实现公开契约
 * （见 docs/site/plugin/themes.md 的 appearanceStyleProperties），不读宿主私有设置。
 */
import { setAttribute, setStyle } from '../../lib/dom.js'

const TOKEN_KEYS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3',
  '--accent', '--ok', '--danger', '--border', '--border-strong', '--link',
]

/** 与 manifest 的声明色板一致；沿用旧 id，避免重装后丢失已存的色板选择。 */
export const SKETCH_PALETTES = [
  {
    id: 'warmSand', name: '暖沙日光',
    stops: ['linear-gradient(135deg, #fffefb, #eee7db)', 'color-mix(in srgb, var(--accent) 34%, transparent)'],
    css: 'radial-gradient(ellipse 54% 46% at 6% 8%, rgba(251,146,60,.30), transparent 66%), radial-gradient(ellipse 44% 40% at 94% 6%, rgba(253,224,71,.34), transparent 68%), radial-gradient(ellipse 64% 50% at 68% 99%, rgba(168,162,158,.34), transparent 74%), linear-gradient(152deg, #fffefb 0%, #f8f4ec 42%, #eee7db 100%)',
    wash: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
  },
  {
    id: 'morningMist', name: '晨雾中性',
    stops: ['linear-gradient(135deg, #fdfdfc, #e3e1dc)', 'color-mix(in srgb, var(--accent) 34%, transparent)'],
    css: 'radial-gradient(ellipse 54% 44% at 14% 10%, rgba(168,162,158,.24), transparent 70%), radial-gradient(ellipse 48% 42% at 88% 86%, rgba(198,194,189,.40), transparent 72%), radial-gradient(ellipse 42% 36% at 52% 44%, rgba(255,255,255,.9), transparent 66%), linear-gradient(160deg, #fdfdfc 0%, #f1f0ed 50%, #e3e1dc 100%)',
    wash: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
  },
  {
    id: 'terracotta', name: '陶土纸感',
    stops: ['linear-gradient(135deg, #fffaf4, #eddbc4)', 'color-mix(in srgb, var(--accent) 34%, transparent)'],
    css: 'radial-gradient(ellipse 48% 44% at 8% 20%, rgba(234,88,12,.24), transparent 68%), radial-gradient(ellipse 50% 42% at 92% 12%, rgba(251,146,60,.28), transparent 70%), radial-gradient(ellipse 56% 44% at 60% 94%, rgba(253,230,138,.36), transparent 72%), linear-gradient(155deg, #fffaf4 0%, #f7ebda 46%, #eddbc4 100%)',
    wash: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
  },
  {
    id: 'coolMist', name: '冷雾青灰',
    stops: ['linear-gradient(135deg, #fcfdfe, #dbe3ea)', 'color-mix(in srgb, var(--accent) 34%, transparent)'],
    css: 'radial-gradient(ellipse 50% 44% at 10% 12%, rgba(125,211,252,.30), transparent 70%), radial-gradient(ellipse 48% 42% at 90% 16%, rgba(94,234,212,.24), transparent 70%), radial-gradient(ellipse 58% 46% at 64% 94%, rgba(148,163,184,.36), transparent 74%), linear-gradient(158deg, #fcfdfe 0%, #ecf0f4 50%, #dbe3ea 100%)',
    wash: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
  },
]

/** 宿主额外光效默认关闭；不透明原生页面自己绘制桌面织物纹与漂移。 */
export const SKETCH_BACKGROUND = {
  media: null, kind: 'gradient', palette: 'warmSand', color: '#f8f4ec',
  opacity: 0.9, fit: 'cover', effect: 'none', texture: 'paper',
  intensity: 0.42, speed: 0.6, direction: 24, warmth: 0.2, grain: 0.14, scale: 1, wash: 0.18,
}

const bounded = (value, fallback, min = 0, max = 1) => Number.isFinite(value)
  ? Math.min(max, Math.max(min, value)) : fallback

/** 只消费宿主已验证的颜色绘制，不把媒体 URL 或任意 CSS 当作桌面。 */
function backgroundProperties(background = {}) {
  const palette = SKETCH_PALETTES.find(item => item.id === background.palette) ?? SKETCH_PALETTES[0]
  const paint = background.media?.type === 'color' ? background.media.value : background.kind === 'color' ? background.color : null
  const safePaint = typeof paint === 'string' && paint.length <= 1024
    && !/[;{}<>\\\\]|url\s*\(/i.test(paint) && CSS.supports('background', paint)
  return {
    // 桌面色洗：色板自带的一层不规则铺色，叠在 --bg 之上
    '--sk-desk-paint': background.kind === 'none' ? 'none' : safePaint ? paint : palette.css,
    '--sk-desk-opacity': String(bounded(background.opacity ?? background.media?.opacity, 0.9)),
    '--sk-desk-tooth': String(0.3 + bounded(background.grain, 0.14) * 1.6),
    '--sk-wash-strength': String(bounded(background.intensity, 0.42) * 0.34),
    '--sk-wash-duration': `${(20 / bounded(background.speed, 0.6, 0.25, 2)).toFixed(2)}s`,
  }
}

/** 只监听可见性，无计时器或逐帧 JS；页面卸载时由入口显式解除。 */
export function observeDocumentVisibility() {
  const root = document.documentElement
  const sync = () => { setAttribute(root, 'data-sk-visible', !document.hidden) }
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

  setAttribute(root, 'data-theme', mode)
  setAttribute(root, 'data-appearance-theme', appearance.theme?.id ?? '')
  setAttribute(root, 'data-appearance-layout', layout.variant ?? '')
  setAttribute(root, 'data-anim', animation.effective ?? 'medium')
  setAttribute(root, 'data-sk-continuous', animation.continuous !== false)
  setAttribute(root, 'data-sk-background', background.kind === 'none' ? 'none' : 'paper')
  setStyle(root, 'color-scheme', mode)

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

  for (const key of appliedKeys) if (!(key in vars)) setStyle(root, key, null)
  for (const [key, value] of Object.entries(vars)) setStyle(root, key, value)
  appliedKeys = new Set(Object.keys(vars))

  const hasMedia = Boolean(appearance.background?.media?.value)
  if (root.classList.contains('has-bg-media') !== hasMedia) root.classList.toggle('has-bg-media', hasMedia)

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
