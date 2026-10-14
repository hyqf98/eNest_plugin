/** Color conversion and WCAG contrast math, shared by the UI and its tests. */
;(function (root) {
  const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n))
  const normalized = (c) => ({ r: Math.round(clamp(c.r, 0, 255)), g: Math.round(clamp(c.g, 0, 255)), b: Math.round(clamp(c.b, 0, 255)), a: clamp(c.a ?? 1) })
  function hslToRgb(h, s, l, a = 1) {
    h = ((h % 360) + 360) % 360 / 360
    const hue = (p, q, t) => {
      t = (t + 1) % 1
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    return normalized({ r: (s ? hue(p, q, h + 1 / 3) : l) * 255, g: (s ? hue(p, q, h) : l) * 255, b: (s ? hue(p, q, h - 1 / 3) : l) * 255, a })
  }
  function parse(input) {
    const value = String(input || '').trim().toLowerCase()
    if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    const hex = /^#?([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)
    if (hex) {
      const v = hex[1].length < 5 ? [...hex[1]].map((x) => x + x).join('') : hex[1]
      return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16), a: v.length === 8 ? parseInt(v.slice(6, 8), 16) / 255 : 1 }
    }
    const match = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(value)
    if (!match) return null
    const parts = match[2].replace(/\//g, ',').split(/[\s,]+/).filter(Boolean)
    if (parts.length < 3 || parts.length > 4 || parts.some((p) => !/^[+-]?(?:\d*\.)?\d+(?:%|deg|turn|rad)?$/.test(p))) return null
    const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1)
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || (parts[3] && /(?:deg|turn|rad)$/.test(parts[3]))) return null
    if (match[1].startsWith('rgb')) {
      if (parts.slice(0, 3).some((p) => /[a-z]/.test(p))) return null
      const rgb = parts.slice(0, 3).map((p) => Number.parseFloat(p) * (p.endsWith('%') ? 2.55 : 1))
      if (rgb.some((n) => n < 0 || n > 255.00001)) return null
      return normalized({ r: rgb[0], g: rgb[1], b: rgb[2], a: alpha })
    }
    if (!parts[1].endsWith('%') || !parts[2].endsWith('%') || parts[0].endsWith('%')) return null
    const s = Number.parseFloat(parts[1]) / 100
    const l = Number.parseFloat(parts[2]) / 100
    if (s < 0 || s > 1 || l < 0 || l > 1) return null
    let h = Number.parseFloat(parts[0])
    if (parts[0].endsWith('turn')) h *= 360
    if (parts[0].endsWith('rad')) h *= 180 / Math.PI
    return hslToRgb(h, s, l, alpha)
  }
  const alphaText = (a) => String(Math.round(a * 1000) / 1000)
  function hex(color) {
    const c = normalized(color)
    return '#' + [c.r, c.g, c.b, ...(c.a < 1 ? [Math.round(c.a * 255)] : [])].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  function rgb(color) {
    const c = normalized(color)
    return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alphaText(c.a)})` : `rgb(${c.r}, ${c.g}, ${c.b})`
  }
  function hsl(color) {
    const c = normalized(color), r = c.r / 255, g = c.g / 255, b = c.b / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2
    let h = 0, s = 0
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1))
      h = (max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
    }
    const values = `${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`
    return c.a < 1 ? `hsla(${values}, ${alphaText(c.a)})` : `hsl(${values})`
  }
  function composite(foreground, background = { r: 255, g: 255, b: 255, a: 1 }) {
    const f = normalized(foreground), b = normalized(background), a = f.a + b.a * (1 - f.a)
    return { r: a ? (f.r * f.a + b.r * b.a * (1 - f.a)) / a : 0, g: a ? (f.g * f.a + b.g * b.a * (1 - f.a)) / a : 0, b: a ? (f.b * f.a + b.b * b.a * (1 - f.a)) / a : 0, a }
  }
  function luminance(c) {
    const values = [c.r, c.g, c.b].map((v) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 })
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
  }
  function contrast(foreground, background) {
    const bg = composite(background)
    const fg = composite(foreground, bg)
    const l1 = luminance(fg), l2 = luminance(bg)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  function cssPalette(name, colors) {
    const slug = String(name).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'palette'
    return `:root {\n${colors.map((item, index) => `  --${slug}-${index + 1}: ${rgb(item.color || item)};`).join('\n')}\n}\n`
  }
  root.ColorMath = { parse, hex, rgb, hsl, contrast, composite, hslToRgb, normalized, cssPalette }
})(globalThis)
