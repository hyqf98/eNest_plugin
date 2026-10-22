/**
 * 首页桥：优先使用宿主注入的 enestWorkspace，其次 enestHome（兼容别名）。
 *
 * 两者都不存在时，只有开发服务器（vite dev）才启用本地 mock，用于单独调样式；
 * 生产包不含这条路径，隔离页面缺少桥接时只会显示"桥接不可用"的静态提示。
 */
export function resolveBridge() {
  const real = window.enestWorkspace || window.enestHome
  if (real) return { bridge: real, mock: false }
  // 没有宿主桥时：vite dev 自动给演示数据；纯静态预览需显式 ?mock，
  // 避免生产隔离页面在缺少桥接时静默渲染假数据。
  const dev = Boolean(import.meta.env?.DEV)
  const asked = new URLSearchParams(location.search).has('mock')
  return { bridge: null, mock: dev || asked }
}
