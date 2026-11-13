/**
 * screen-assistant backend entry: webm → gif 转码（ffmpeg）。
 * 方法：gif.available / gif.convert。无第三方依赖，只调外部 ffmpeg。
 */
import { parentPort } from './parentPort'
import { gifAvailable, convertToGif, type GifConvertOptions } from './gif'

const port = parentPort
if (!port) throw new Error('screen-assistant service requires an Electron utility parent')

function convertOptions(value: unknown): GifConvertOptions {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('options 参数无效')
  const raw = value as Record<string, unknown>
  const options: GifConvertOptions = {}
  for (const key of ['fps', 'width', 'startMs', 'endMs'] as const) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error(`${key} 参数无效`)
    options[key] = item
  }
  return options
}

const methods: Record<string, (...args: never[]) => unknown> = {
  'gif.available': () => gifAvailable(),
  'gif.convert': (...args: never[]) => {
    const bytes = args[0] as unknown
    if (!(bytes instanceof ArrayBuffer)) throw new Error('录制内容必须是 ArrayBuffer')
    return convertToGif(bytes, convertOptions(args[1]))
  }
}

port.on('message', async ({ data: raw }) => {
  const data = raw as { id?: unknown; pluginId?: unknown; method?: unknown; args?: unknown } | undefined
  const { id, pluginId, method, args = [] } = data ?? {}
  if (!Number.isInteger(id) || typeof pluginId !== 'string' || typeof method !== 'string' || !Object.hasOwn(methods, method) || !Array.isArray(args)) return
  try {
    const result = await methods[method]!(...args as never[])
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
