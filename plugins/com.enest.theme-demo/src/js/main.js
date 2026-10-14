/**
 * main.js — 主题示例插件入口
 * 演示运行式注册：进入时 enest.theme.register 第 3 个主题包「墨绿」。
 * manifest 的 contributes.themePacks 已声明「暖沙 / 靛蓝」（声明式，无需运行）。
 * 壳子会把 source 强制绑为本插件 id；卸载时按 source 一并 GC。
 */
;(async function boot() {
  const api = window.enest || window.zapi
  const state = document.getElementById('runtime-state')
  if (!api) {
    if (state) {
      state.textContent = 'eNest API 不可用（浏览器直开）：仅能预览页面，无法注册主题包。'
      state.className = 'err'
    }
    return
  }

  try {
    await api.ui.setTitle('主题示例')
  } catch {
    /* 浏览器预览缺少宿主桥接时保留页面 */
  }

  // 运行时注册第 3 个主题包（id 与 manifest 两个不同）
  try {
    await api.theme.register({
      id: 'theme-demo.ink-green',
      name: '墨绿',
      mode: 'dark',
      tokens: {
        '--bg': '#152019',
        '--surface': '#1b2820',
        '--surface-2': '#233228',
        '--surface-3': '#2d4033',
        '--border': 'rgba(228,239,232,0.09)',
        '--border-strong': 'rgba(228,239,232,0.16)',
        '--text': '#e4efe8',
        '--text-2': '#a3b8ac',
        '--text-3': '#7a9184',
        '--accent': '#5fae87',
        '--ok': '#6fbf9f',
        '--danger': '#e08d85',
        '--link': '#5fae87'
      }
    })
    if (state) state.textContent = '墨绿主题包已注册：设置 → 外观 → 主题 下拉即时刷新。'
  } catch (e) {
    if (state) {
      state.textContent = '运行时注册失败：' + String(e?.message || e)
      state.className = 'err'
    }
  }
})()
