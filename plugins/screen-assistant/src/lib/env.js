/** 宿主桥：插件页只拿到 window.enest（或兼容别名）。 */
export const host = window.enest || window.zapi

export function requireHost() {
  if (!host) throw new Error('屏幕助手需要在 eNest 中使用')
  return host
}

export const isQuick = () => host?.getLaunchMode?.() === 'quick'
