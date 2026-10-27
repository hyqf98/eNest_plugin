/**
 * cursors.mjs —— 各工具的自定义光标（SVG data-URI）
 * 钢笔尖带热点；橡皮为空心圆随尺寸变化；canvas cursor 不能用外链，data-URI 合法。
 */

const svg = (w, h, body) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`

/** 钢笔尖：笔尖朝左下，热点 (2, h-2) */
export function penCursor(color = '#1e1e1e') {
  const body = `
    <g transform="translate(1.5,1.5)">
      <path d="M2 26 L6 12 L14 4 L24 14 L16 22 Z" fill="${color}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M6 12 L14 4 L16 6 L8 14 Z" fill="#8a8f98"/>
      <circle cx="2" cy="26" r="1.6" fill="#ffffff"/>
    </g>`
  return { cursor: `url("${svg(30, 30, body)}") 2 28, crosshair` }
}

/** 荧光笔：宽头笔 */
export function highlighterCursor(color = '#ffd43b') {
  const body = `
    <g transform="translate(1.5,1.5)">
      <rect x="8" y="3" width="12" height="16" rx="2.5" transform="rotate(35 14 11)" fill="${color}" stroke="#ffffff" stroke-width="1.6"/>
      <path d="M6 26 L10 20 L15 24 L11 28 Z" fill="${color}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
    </g>`
  return { cursor: `url("${svg(32, 32, body)}") 5 28, crosshair` }
}

/** 橡皮：空心圆环，直径 = size（屏幕像素），热点在圆心 */
export function eraserCursor(size, color = '#5b6470') {
  const d = Math.max(10, Math.min(80, Math.round(size)))
  const body = `<circle cx="${d / 2}" cy="${d / 2}" r="${d / 2 - 1.5}" fill="rgba(255,255,255,0.18)" stroke="${color}" stroke-width="1.5"/><circle cx="${d / 2}" cy="${d / 2}" r="1" fill="${color}"/>`
  return { cursor: `url("${svg(d, d, body)}") ${d / 2} ${d / 2}, cell` }
}

/** 图形工具：细十字 */
export function crossCursor(color = '#5b6470') {
  const body = `<path d="M12 3v18M3 12h18" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/><path d="M12 3v18M3 12h18" stroke="#fff" stroke-width="0.6" stroke-linecap="round" opacity="0.9"/>`
  return { cursor: `url("${svg(24, 24, body)}") 12 12, crosshair` }
}

/** 文字：I-beam */
export function textCursor() {
  return { cursor: 'text' }
}

/** 抓手（空格平移） */
export function grabCursor() {
  const body = `<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0-1v-.5a1.5 1.5 0 0 1 3 0V10m0-.5a1.5 1.5 0 0 1 3 0V11m0-1a1.5 1.5 0 0 1 3 0v5.5a5.5 5.5 0 0 1-5.5 5.5H13a6 6 0 0 1-6-6v-4a1.5 1.5 0 0 1 2-1.4" fill="none" stroke="#3a4048" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0-1v-.5a1.5 1.5 0 0 1 3 0V10m0-.5a1.5 1.5 0 0 1 3 0V11m0-1a1.5 1.5 0 0 1 3 0v5.5a5.5 5.5 0 0 1-5.5 5.5H13a6 6 0 0 1-6-6v-4a1.5 1.5 0 0 1 2-1.4" fill="none" stroke="#fff" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"/>`
  return { cursor: `url("${svg(28, 28, body)}") 12 12, grab` }
}

export function toolCursor(tool, settings, theme) {
  switch (tool) {
    case 'pen': return penCursor(settings.color || theme.ink).cursor
    case 'highlighter': return highlighterCursor(theme.highlighter).cursor
    case 'eraser': return eraserCursor(settings.eraserSize * (settings._zoom || 1)).cursor
    case 'rect': case 'ellipse': case 'line': case 'arrow': return crossCursor().cursor
    case 'text': return textCursor().cursor
    default: return 'default'
  }
}
