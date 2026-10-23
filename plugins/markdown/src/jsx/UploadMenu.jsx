/**
 * markdown v2 —— 粘贴图片动作菜单（ask 模式弹层：上传图床/存本地/base64）。
 */
import { useEffect, useRef, useState } from 'react'

export function UploadMenu({ onHandle, uploading }) {
  const [dataUrl, setDataUrl] = useState(null)
  const [pos, setPos] = useState({ x: 40, y: 80 })
  const ref = useRef(null)

  useEffect(() => {
    const show = (e) => {
      const detail = e.detail
      setDataUrl(detail)
      setPos({ x: Math.max(24, (window.innerWidth - 300) / 2), y: 88 })
    }
    window.addEventListener('md-show-upload-menu', show)
    return () => window.removeEventListener('md-show-upload-menu', show)
  }, [])

  useEffect(() => {
    if (!dataUrl) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setDataUrl(null)
    }
    const esc = (e) => { if (e.key === 'Escape') setDataUrl(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [dataUrl])

  if (!dataUrl) return null
  const act = (action) => { setDataUrl(null); onHandle(dataUrl, action) }

  return (
    <div className="md-upload-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      <div className="md-upload-preview"><img src={dataUrl} alt="" /></div>
      <div className="md-upload-actions" role="group">
        <button className="pk-btn pk-btn-sm" disabled={uploading} onClick={() => act('upload')}>{uploading ? '上传中…' : '上传到图床'}</button>
        <button className="pk-btn pk-btn-sm" disabled={uploading} onClick={() => act('local')}>存本地 assets</button>
        <button className="pk-btn pk-btn-sm" disabled={uploading} onClick={() => act('base64')}>转 base64 内联</button>
        <button className="pk-btn pk-btn-sm" onClick={() => setDataUrl(null)}>取消</button>
      </div>
    </div>
  )
}
