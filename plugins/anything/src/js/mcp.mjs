/**
 * mcp.mjs —— Anything 文件搜索 MCP 工具处理器注册
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手
 * 逐一对比，不符即拒绝）。业务初始化后注册一次、不等页面可见：MCP 冷启动
 * 页面是隐藏的，不能等 onEnter。
 * handler 直接复用 backend.js 的 backend.call 通道，不引入新状态；MCP 结果
 * ≤1MiB —— readText/readImage 的 maxBytes 统一钳到 700KiB（base64 膨胀 4/3
 * 后仍留出余量），超出由后端拒绝而不是截断出半张图。
 */
import { backend, call } from './backend.js'

const READ_TEXT_MAX_BYTES = 700 * 1024
const READ_IMAGE_MAX_BYTES = 700 * 1024
const SORTS = ['relevance', 'name', 'mtime', 'size']

const ok = (text, structured, extraContent = []) => ({
  content: [{ type: 'text', text }, ...extraContent],
  ...(structured !== undefined ? { structuredContent: structured } : {})
})

const err = (message) => ({ isError: true, content: [{ type: 'text', text: `执行失败：${message}` }] })

/** 参数校验/后端业务失败与内部异常统一转 isError 文本，绝不弹交互框 */
function wrap(run) {
  return async (args) => {
    try {
      return await run(args || {})
    } catch (error) {
      return err(error?.message || String(error))
    }
  }
}

function pathArg(args) {
  const value = String(args.path ?? '').trim()
  if (!value) throw new Error('path 不能为空')
  return value
}

function intArg(value, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new Error('数值参数无效')
  return Math.max(min, Math.min(n, max))
}

/** dataUrl → MCP image content（mime + 原始 base64，不再经过 data: 前缀） */
function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!match) throw new Error('后端返回的图片数据无法解析')
  return { mimeType: match[1], data: match[2] }
}

export function registerAnythingMcp() {
  const api = window.enest || window.zapi
  if (!api?.mcp?.registerHandlers) return Promise.resolve(false)
  const handlers = {
    search: wrap(async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query 不能为空')
      const options = {}
      if (args.directory !== undefined && args.directory !== null) {
        const directory = String(args.directory).trim()
        if (!directory) throw new Error('directory 参数无效')
        options.directory = directory
      }
      options.limit = intArg(args.limit, { min: 1, max: 500, fallback: 100 })
      options.offset = intArg(args.offset, { min: 0, max: 100000, fallback: 0 })
      if (args.sort !== undefined && args.sort !== null) {
        if (!SORTS.includes(args.sort)) throw new Error('sort 参数无效')
        options.sort = args.sort
      }
      const res = await backend.search(query, options)
      return ok(
        `${res.provider} · 命中 ${res.total} 条 · 返回 ${res.results.length} 条${res.truncated ? '（已截断，可用 offset 翻页）' : ''}`,
        res
      )
    }),
    stat: wrap(async (args) => {
      const info = await call('stat', [pathArg(args)])
      return ok(`${info.isDirectory ? '目录' : '文件'} ${info.path} · ${info.size} B · ${new Date(info.mtimeMs).toISOString()}`, info)
    }),
    readText: wrap(async (args) => {
      const maxBytes = intArg(args.maxBytes, { min: 1024, max: READ_TEXT_MAX_BYTES, fallback: 131072 })
      const r = await backend.readText(pathArg(args), maxBytes)
      return {
        content: [{ type: 'text', text: r.content }],
        structuredContent: { encoding: r.encoding, truncated: r.truncated, size: r.size }
      }
    }),
    readImage: wrap(async (args) => {
      // 固定 700KiB 上限：base64 后约 933KiB，稳在 MCP 1MiB 结果限制内
      const r = await backend.readImage(pathArg(args), READ_IMAGE_MAX_BYTES)
      const { mimeType, data } = parseDataUrl(r.dataUrl)
      return {
        content: [{ type: 'image', data, mimeType }],
        structuredContent: { mimeType, size: r.size }
      }
    }),
    open: wrap(async (args) => {
      const target = pathArg(args)
      await backend.open(target)
      return ok(`已用系统默认方式打开：${target}`)
    }),
    reveal: wrap(async (args) => {
      const target = pathArg(args)
      await backend.reveal(target)
      return ok(`已在文件管理器中定位：${target}`)
    }),
    trash: wrap(async (args) => {
      const target = pathArg(args)
      await backend.trash(target)
      return ok(`已移入系统废纸篓（可在废纸篓中恢复）：${target}`, { trashed: target })
    })
  }
  return api.mcp.registerHandlers(handlers).then(() => true)
}
