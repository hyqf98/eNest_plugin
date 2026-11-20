/**
 * backendBridge — 调本插件 Node 后端（backend.call），页面侧唯一入口。
 * 后端未就绪时给出可操作提示（授权 / 重启加载）。
 */

const CHUNK_B64 = 3_000_000   // 单块 base64 文本 ≤3MB，整请求含开销仍远低于 4MiB args 预算

function kit() {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) throw new Error('宿主后端通道不可用：请升级 eNest 或重新加载插件')
  return enest
}

/** 选择本机文件夹；取消返回 null */
export async function pickSaveDirectory() {
  return kit().backend.call('pickDirectory', [], { timeoutMs: 900_000 })
}

/**
 * 把一张图（dataUrl）写入已授权目录内的 name 文件。
 * 分块 base64 传给后端流式落盘。
 */
export async function saveAssetToDirectory({ handleId, name, dataUrl }) {
  const enest = kit()
  const comma = String(dataUrl ?? '').indexOf(',')
  if (comma < 0) throw new Error(`图片数据无效：${name}`)
  const b64 = String(dataUrl).slice(comma + 1)
  const { writeId, path } = await enest.backend.call('writeBegin', [{ handleId, name }])
  try {
    for (let offset = 0; offset < b64.length; offset += CHUNK_B64) {
      await enest.backend.call('writeChunk', [{ writeId, chunk: b64.slice(offset, offset + CHUNK_B64) }])
    }
    const done = await enest.backend.call('writeEnd', [{ writeId }])
    return done?.path ?? path
  } catch (error) {
    try { await enest.backend.call('writeAbort', [{ writeId }]) } catch { /* 尽力清理 */ }
    throw error
  }
}
