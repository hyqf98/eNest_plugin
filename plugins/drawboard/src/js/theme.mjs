/**
 * theme.mjs —— 画板四套纸感主题 + 插件私有设置模型
 * 画布纸感独立于壳 UI 主题（ui.themeAware 只影响工具栏等 chrome）。
 */

export const THEMES = {
  paper: {
    id: 'paper',
    name: '草稿纸',
    paper: '#faf7ef',
    grid: '#c9d5e2',
    ink: '#2c3442',
    selection: '#3f6fb5',
    palette: ['#2c3442', '#c92a2a', '#d9480f', '#e67700', '#2b8a3e', '#1864ab', '#5f3dc4', '#a61e4d'],
    highlighter: '#ffd43b',
  },
  dark: {
    id: 'dark',
    name: '深色',
    paper: '#1e2227',
    grid: '#3a4048',
    ink: '#e8eaed',
    selection: '#6aa6ff',
    palette: ['#e8eaed', '#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#74c0fc', '#b197fc', '#f783ac'],
    highlighter: '#ffd43b',
  },
  cream: {
    id: 'cream',
    name: '米黄纸',
    paper: '#f6efe3',
    grid: '#d8cdb8',
    ink: '#3d2f1e',
    selection: '#b07d2b',
    palette: ['#3d2f1e', '#a61e1e', '#b45309', '#7c5c1e', '#3f6c34', '#1d5c8a', '#5b3e96', '#9d2a5b'],
    highlighter: '#f3d13a',
  },
  board: {
    id: 'board',
    name: '黑板',
    paper: '#22342c',
    grid: '#3c554a',
    ink: '#e6efe7',
    selection: '#8fd6a8',
    palette: ['#e6efe7', '#ff8787', '#ffc078', '#ffec99', '#b2f2bb', '#a5d8ff', '#d0bfff', '#ee99ca'],
    highlighter: '#ffe066',
  },
}

export const GRID_MODES = ['lines', 'squares', 'dots', 'none']
export const GRID_LABELS = { lines: '横线', squares: '方格', dots: '点阵', none: '无' }

export const DEFAULT_SETTINGS = {
  theme: 'paper',
  roughness: 1,        // 0 规整 ~ 2 更手绘
  grid: 'lines',       // lines | squares | dots | none
  strokeWidth: 2.5,    // 钢笔默认笔宽
  highlightWidth: 14,
  eraserSize: 12,
  color: null,         // null = 跟随主题默认墨色
  textureVersion: 2,   // 2 = 草稿纸改版后的纸面纹理模型（旧设置一次性迁到横线）
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const s = { ...DEFAULT_SETTINGS, ...source }
  if (!THEMES[s.theme]) s.theme = DEFAULT_SETTINGS.theme
  s.roughness = Math.min(2, Math.max(0, Number(s.roughness) || 0))
  if (!GRID_MODES.includes(s.grid)) s.grid = DEFAULT_SETTINGS.grid
  // 草稿纸改版：旧版本没有 textureVersion，纸面纹理一次性切到横线，之后尊重用户选择
  if ((Number(source.textureVersion) || 0) < 2) s.grid = DEFAULT_SETTINGS.grid
  s.textureVersion = 2
  s.strokeWidth = Math.min(12, Math.max(0.5, Number(s.strokeWidth) || DEFAULT_SETTINGS.strokeWidth))
  s.highlightWidth = Math.min(40, Math.max(4, Number(s.highlightWidth) || DEFAULT_SETTINGS.highlightWidth))
  s.eraserSize = Math.min(80, Math.max(6, Number(s.eraserSize) || DEFAULT_SETTINGS.eraserSize))
  return s
}

export function resolveInkColor(settings, theme) {
  return settings.color || theme.ink
}
