/** backend.call 包装：统一错误转 Error，宿主 API 缺失时给出可读提示。 */
const api = () => window.enest || window.zapi

export function backendReady() {
  return Boolean(api()?.backend?.call)
}

export async function call(method, args = []) {
  const host = api()
  if (!host?.backend?.call) throw new Error('后端接口不可用，请更新 eNest 壳子后重试')
  return host.backend.call(method, args)
}

export const backend = {
  providers: (options = {}) => call('providers', [options]),
  search: (query, options = {}) => call('search', [query, options]),
  abort: () => call('abort').catch(() => {}),
  open: path => call('open', [path]),
  reveal: path => call('reveal', [path]),
  trash: path => call('trash', [path]),
  readText: (path, maxBytes) => call('readText', [path, maxBytes]),
  readImage: (path, maxBytes) => call('readImage', [path, maxBytes])
}
