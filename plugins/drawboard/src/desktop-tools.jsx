import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Slider } from './ui/index.jsx'
import { createDesktopTransport } from './js/desktopTransport.mjs'
import { DESKTOP_TOOLS } from './js/desktopController.mjs'
import { THEMES } from './js/theme.mjs'
import './css/main.css'
import './css/desktop.css'
import './js/desktopFont.mjs'

function DesktopTools() {
  const [state, setState] = useState({ tool: 'pen', drawing: false, settings: {}, error: '' })
  const [ready, setReady] = useState(false), bridge = useRef(null)
  const theme = THEMES[state.settings.theme] || THEMES.paper
  const sizeKey = state.tool === 'eraser' ? 'eraserSize' : state.tool === 'highlighter' ? 'highlightWidth' : 'strokeWidth'
  const sizeRange = sizeKey === 'eraserSize' ? [6, 80, 2] : sizeKey === 'highlightWidth' ? [4, 40, 2] : [.5, 12, .5]
  const send = data => void bridge.current?.post(data).catch(error => setState(previous => ({ ...previous, error: error.message })))
  useEffect(() => {
    const api = window.enestAux
    if (!api) return
    let disposed = false, timer
    const accept = data => {
      if (disposed) return
      if (data?.type === 'tools') setState(data)
      else if (data?.type === 'ready-ack') { setReady(true); clearInterval(timer) }
    }
    const transport = createDesktopTransport(data => api.post(data), accept, error => setState(previous => ({ ...previous, error: error.message })))
    bridge.current = transport
    const off = api.onMessage(data => transport.accept(data))
    void api.getContext().then(context => {
      if (disposed) return
      accept(context.data)
      const hello = () => void transport.post({ type: 'ready' }).catch(() => {})
      hello(); timer = setInterval(hello, 1500)
    }).catch(error => setState(previous => ({ ...previous, error: error.message })))
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); send({ type: 'operate' }) } }
    window.addEventListener('keydown', onKey)
    return () => { disposed = true; clearInterval(timer); off(); transport.dispose(); window.removeEventListener('keydown', onKey) }
  }, [])
  return <div className="db-desktop-tools" data-paper-theme={theme.id} style={{ '--tool-paper': theme.paper, '--tool-ink': theme.ink }}>
    <header className="db-desktop-drag"><strong>桌面画板</strong><span>{state.drawing ? '正在绘制' : '桌面可正常操作'}</span>
      <Button size="sm" variant="ghost" onClick={() => send({ type: 'close' })} aria-label="关闭桌面画板">关闭</Button>
    </header>
    <div className="db-desktop-toolset" role="toolbar" aria-label="绘图工具">
      {DESKTOP_TOOLS.map(([key, label]) => <Button key={key} size="sm" pressed={state.drawing && key === state.tool}
        disabled={!ready} onClick={() => send({ type: 'tool', tool: key })}>{label}</Button>)}
      <Button size="sm" pressed={!state.drawing} onClick={() => send({ type: 'operate' })}>操作桌面</Button>
    </div>
    <div className="db-desktop-options">
      <label className="db-desktop-color">颜色 <input aria-label="画笔颜色" type="color" value={state.settings.color || theme.ink}
        onChange={event => send({ type: 'settings', color: event.target.value })} /></label>
      <span>粗细</span><Slider aria-label={sizeKey === 'eraserSize' ? '橡皮大小' : '画笔粗细'} min={sizeRange[0]} max={sizeRange[1]} step={sizeRange[2]} value={[state.settings[sizeKey] || sizeRange[0]]}
        onValueChange={([width]) => setState(previous => ({ ...previous, settings: { ...previous.settings, [sizeKey]: width } }))}
        onValueCommit={([width]) => send({ type: 'settings', width, sizeKey })} />
      <Button size="sm" variant="ghost" onClick={() => send({ type: 'undo' })}>撤销</Button>
      <Button size="sm" variant="ghost" onClick={() => send({ type: 'redo' })}>重做</Button>
      <Button size="sm" variant="ghost" onClick={() => send({ type: 'clear' })}>清空</Button>
      <Button size="sm" variant="ghost" onClick={() => send({ type: 'export' })}>导出</Button>
    </div>
    {state.error && <div className="db-desktop-error" role="alert">{state.error}</div>}
  </div>
}

createRoot(document.getElementById('root')).render(<DesktopTools />)
