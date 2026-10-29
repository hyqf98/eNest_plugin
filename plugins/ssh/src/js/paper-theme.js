/**
 * paper-theme.js — 纸感手绘主题（与 database 插件同构，移植自 ai-canvas/src/js/theme.mjs）。
 * paper 偏好：auto | paper | cream | dark | board；auto 解析为浅色纸白纸/深色深纸。
 * 把解析结果写到 <html data-paper> 与 .app[data-paper]（CSS 令牌桥双挂点），
 * 并订阅系统明暗与宿主 data-theme 翻转。偏好持久化走 state.ui.paper（'ssh.ui' 键）。
 */

export const PAPER_OPTIONS = [
  { id: 'auto', label: '跟随明暗', desc: '浅色自动白纸、深色自动墨纸', swatch: ['#f7f3e8', '#26231e'] },
  { id: 'paper', label: '白纸', desc: '暖白纸面与棕墨描边', swatch: ['#f7f3e8', '#fffdf6', '#a61e1e'] },
  { id: 'cream', label: '米黄', desc: '旧纸色调，适合长时阅读', swatch: ['#f3e9d2', '#faf3e0', '#b0431f'] },
  { id: 'dark', label: '深色', desc: '深色纸与暖金墨线', swatch: ['#26231e', '#302c25', '#e0705c'] },
  { id: 'board', label: '黑板', desc: '墨绿板面与粉笔线条', swatch: ['#2c3a2f', '#344537', '#e8937a'] }
]

export function normalizePaper(value) {
  return PAPER_OPTIONS.some((option) => option.id === value) ? value : 'auto'
}

/** 把 auto 解析成具体纸面；宿主 data-theme 优先，其次系统偏好。 */
export function resolvePaper(paper) {
  if (paper !== 'auto') return paper
  const host = document.documentElement.dataset.theme || document.documentElement.dataset.scheme
  if (host === 'dark') return 'dark'
  if (host === 'light') return 'paper'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'paper'
}

/** 应用纸面到 <html> 与 .app；返回实际生效的纸面 id。 */
export function applyPaper(paper) {
  const resolved = resolvePaper(paper)
  const root = document.documentElement
  root.dataset.paper = resolved
  root.dataset.paperPref = paper
  for (const app of document.querySelectorAll('.app')) {
    app.dataset.paper = resolved
    app.dataset.paperPref = paper
  }
  // 终端/xterm 观察器与设置页复用既有事件通道重取 CSS 变量
  document.dispatchEvent(new CustomEvent('ssh-paper-theme', { detail: { paper: resolved } }))
  return resolved
}

/** 挂载入口：<html> 先落属性（首帧即有纸面），.app 由渲染后 observer 补挂。 */
export function mountPaper(getPref) {
  applyPaper(normalizePaper(getPref()))
  const rootObserver = new MutationObserver(() => applyPaper(normalizePaper(getPref())))
  rootObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  return rootObserver
}

/** 订阅系统明暗 + 宿主 data-theme/scheme 翻转（仅 auto 偏好需要重解析）。 */
export function watchPaperChanges(paper) {
  const reapply = () => { if ((paper() ?? 'auto') === 'auto') applyPaper('auto') }
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)')
  scheme?.addEventListener?.('change', reapply)
  const observer = new MutationObserver(reapply)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] })
  return () => {
    scheme?.removeEventListener?.('change', reapply)
    observer.disconnect()
  }
}
