/**
 * backend.call 包装：统一错误转 Error；window.__preview（截图 fixture）或
 * 后端接口不可用时切换 demo 模式，返回写死的演示数据，界面保持完整可见。
 */
import { demo } from './demo.js'

const api = () => window.enest || window.zapi

export function demoMode() {
  return Boolean(window.__preview) || !api()?.backend?.call
}

export function backendReady() {
  return Boolean(api()?.backend?.call)
}

async function call(method, args = []) {
  if (demoMode()) {
    const handler = demo[method]
    if (typeof handler === 'function') return handler(...args)
    throw new Error(`演示模式不支持 ${method}`)
  }
  const host = api()
  if (!host?.backend?.call) throw new Error('后端接口不可用，请更新 eNest 壳子后重试')
  return host.backend.call(method, args)
}

export const backend = {
  snapshot: () => call('snapshot'),
  setVar: payload => call('setVar', [payload]),
  deleteVar: payload => call('deleteVar', [payload]),
  getSettings: () => call('getSettings'),
  setSettings: partial => call('setSettings', [partial]),
  listBackups: () => call('listBackups'),
  restoreBackup: file => call('restoreBackup', [file]),
  pathParts: scope => call('pathParts', [scope]),
  openManagedFolder: path => call('openManagedFolder', [{ path }])
}
