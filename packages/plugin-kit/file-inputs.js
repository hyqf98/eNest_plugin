/** Official-plugin adapter: DOM File objects contain only bytes returned by the authorized host API. */
const FILE_LIMIT = 32 * 1024 * 1024
const BATCH_LIMIT = 64 * 1024 * 1024
export async function readAuthorizedFiles(handles, { api = window.enest, maxBytes = FILE_LIMIT } = {}) {
  const files = (handles || []).filter(handle => handle.kind === 'file')
  if (files.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > BATCH_LIMIT) throw new Error('一次最多导入 20 个文件，总大小不超过 64 MB')
  const result = []
  for (const handle of files) {
    if (handle.size > maxBytes) throw new Error(`${handle.name} 超过允许大小`)
    const dataUrl = await api.localFiles.read({ handleId: handle.id, encoding: 'dataUrl', maxBytes })
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl)
    if (!match) throw new Error('宿主返回的文件数据格式无效')
    const binary = atob(match[2]), bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    result.push(new File([bytes], handle.name, { type: match[1] }))
  }
  return result
}
export async function readDroppedFiles(files, options = {}) {
  const api = options.api || window.enest
  const handles = await api.localFiles.fromDrop(Array.from(files || []))
  return readAuthorizedFiles(handles, { ...options, api })
}
export function bindFileInput(input, { api = window.enest, maxBytes = FILE_LIMIT, onError = error => api.ui.toast({ message: error.message, type: 'error' }) } = {}) {
  let busy = false
  const click = event => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    busy = true
    void (async () => {
      const handles = await api.localFiles.pick({ kind: 'file', access: 'read', multiple: input.multiple })
      if (!handles.length) return
      const files = await readAuthorizedFiles(input.multiple ? handles : handles.slice(0, 1), { api, maxBytes })
      if (!files.length) return
      const transfer = new DataTransfer()
      files.forEach(file => transfer.items.add(file))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })().catch(onError).finally(() => { busy = false })
  }
  input.addEventListener('click', click)
  return () => input.removeEventListener('click', click)
}
