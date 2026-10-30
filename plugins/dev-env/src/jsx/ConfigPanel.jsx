/** 配置页：配置文件卡片 + 只读查看 Dialog（等宽 pre，4KB）。 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, DialogTitle } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { formatBytes } from '../js/format.js'

export function ConfigPanel({ selected, say }) {
  const [files, setFiles] = useState(null)
  const [viewing, setViewing] = useState(null) // { path, content }

  useEffect(() => {
    let alive = true
    setFiles(null)
    backend.configs(selected.family, selected.id)
      .then(result => { if (alive) setFiles(result.files ?? []) })
      .catch(error => { if (alive) { setFiles([]); say(`配置清单加载失败：${error.message}`, 'error') } })
    return () => { alive = false }
  }, [selected.family, selected.id, say])

  const view = useCallback(async (file) => {
    setViewing({ path: file.path, content: null })
    try {
      const result = await backend.configRead(file.path)
      setViewing({ path: file.path, content: result.content ?? '' })
    } catch (error) {
      setViewing({ path: file.path, content: `无法读取：${error.message}` })
    }
  }, [])

  if (files === null) return <div className="empty">正在加载配置清单…</div>
  if (files.length === 0) return <div className="empty">该环境没有已知配置文件</div>

  return (
    <div className="config-list">
      {files.map((file, index) => (
        <button key={file.path} type="button" className="config-card" disabled={!file.exists}
          style={{ '--i': Math.min(index, 16) }} onClick={() => void view(file)}>
          <span className={'config-dot' + (file.exists ? ' on' : '')} aria-hidden="true" />
          <span className="mono config-path">{file.path}</span>
          <span className="config-bytes">{file.exists ? formatBytes(file.bytes) : '不存在'}</span>
          <span className="config-action muted">{file.exists ? '查看' : ''}</span>
        </button>
      ))}

      <Dialog open={Boolean(viewing)} onOpenChange={open => { if (!open) setViewing(null) }}>
        <DialogContent className="dev-dialog wide">
          <DialogTitle className="mono dialog-path">{viewing?.path}</DialogTitle>
          <pre className="preview-pre">{viewing?.content === null ? '正在读取（前 4KB）…' : viewing?.content}</pre>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setViewing(null)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
