/**
 * markdown —— 本地图片目录解析（走宿主统一 API `shell.resolvePath`）。
 *
 * 用户可以在设置里手输 `~/图片`、`./assets`、裸相对路径或绝对路径。
 * 解析规则由宿主统一实现（跨 win32/posix），插件不自己拼 `~`。
 * 基准目录用 `data`（插件私有数据目录），这样 `./assets` 指向插件自己的
 * 持久化位置；留空或解析失败时回退到 backend 的默认 assets 目录，
 * 并把 error 交给调用方 toast。
 */

/** 相对路径的基准：插件私有 data 目录（宿主 shell.resolvePath 的 base） */
const BASE = 'data'

/**
 * @param {string} raw 用户输入（空 = 使用默认私有 assets）
 * @param {object} enestApi window.enest
 * @param {string} fallbackDir backend 报告的默认 assets 绝对路径（可空）
 * @returns {Promise<{ raw: string, path: string|null, exists: boolean, error: string|null, fallback: boolean }>}
 */
export async function resolveImageDir(raw, enestApi, fallbackDir) {
  const input = String(raw ?? '').trim()
  const api = enestApi || (typeof window !== 'undefined' ? (window.enest || window.zapi) : null)
  const fallback = await resolveFallback(api, fallbackDir)
  if (!input) {
    return { raw: '', path: fallback, exists: true, error: null, fallback: true }
  }
  const result = await resolveWith(api, input, BASE)
  if (!result || !result.path) {
    return {
      raw: input,
      path: fallback,
      exists: false,
      error: result?.error || '路径解析失败',
      fallback: true,
    }
  }
  return { raw: input, path: result.path, exists: result.exists === true, error: null, fallback: false }
}

/** 默认目录：优先用 backend 报告的 assets 绝对路径（与落盘位置一致） */
async function resolveFallback(api, fallbackDir) {
  if (fallbackDir) return fallbackDir
  const result = await resolveWith(api, '.', BASE)
  if (!result?.path) return null
  return joinAsset(result.path)
}

async function resolveWith(api, input, base) {
  if (!api?.shell?.resolvePath) return null
  try {
    return await api.shell.resolvePath({ input, base })
  } catch (e) {
    return { path: null, absolute: false, base: '', exists: false, error: e?.message || String(e) }
  }
}

/** data 目录 + /assets（分隔符跟随宿主返回的基准路径风格） */
function joinAsset(basePath) {
  const sep = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  return basePath.replace(/[\\/]+$/, '') + sep + 'assets'
}

/** 展示用：把解析结果压成一行文案 */
export function describeImageDir(info) {
  if (!info) return ''
  if (!info.raw) return `默认（插件私有 assets）：${info.path || '—'}`
  if (info.error) return `解析失败，已回退默认：${info.path || '—'}（${info.error}）`
  return `${info.path}${info.exists ? '' : '（目录不存在，保存图片时会自动创建）'}`
}
