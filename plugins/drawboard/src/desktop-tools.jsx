import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Slider } from './ui/index.jsx'
import { createDesktopTransport } from './js/desktopTransport.mjs'
import { DESKTOP_TOOLS } from './js/desktopController.mjs'
import { THEMES } from './js/theme.mjs'
import './css/main.css'
import './css/desktop.css'
import './js/desktopFont.mjs'

/** 收起球 → hover/点击展开完整面板；面板失焦/移出收缩。展开由后端调窗口 bounds，收到 ack 才切换形态。 */
function DesktopTools() {
  const [state, setState] = useState({ tool: 'pen', drawing: false, settings: {}, error: '' })
  const [ready, setReady] = useState(false), [expanded, setExpanded] = useState(false), bridge = useRef(null)
  const theme = THEMES[state.settings.theme] || THEMES.paper
  const sizeKey = state.tool === 'eraser' ? 'eraserSize' : state.tool === 'highlighter' ? 'highlightWidth' : 'strokeWidth'
  const sizeRange = sizeKey === 'eraserSize' ? [6, 80, 2] : sizeKey === 'highlightWidth' ? [4, 40, 2] : [.5, 12, .5]
  const send = data => void bridge.current?.post(data).catch(error => setState(previous => ({ ...previous, error: error.message })))
  const setExpand = value => { if (value !== expanded) send({ type: 'expand', value }) }
  useEffect(() => {
    const api = window.enestAux
    if (!api) return
    let disposed = false, timer
    const accept = data => {
      if (disposed) return
      if (data?.type === 'tools') setState(data)
      else if (data?.type === 'ready-ack') { setReady(true); clearInterval(timer) }
      else if (data?.type === 'expand-ack') setExpanded(Boolean(data.value))
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
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); expanded ? setExpand(false) : send({ type: 'operate' }) } }
    window.addEventListener('keydown', onKey)
    return () => { disposed = true; clearInterval(timer); off(); transport.dispose(); window.removeEventListener('keydown', onKey) }
  }, [expanded])
  // 展开态下点击面板外（转到桌面/其他窗口）自动收起，回到球形态常驻。
  useEffect(() => { if (expanded) window.addEventListener('blur', () => setExpand(false), { once: true }) }, [expanded])
  return <div className={`db-desktop-tools${expanded ? ' db-desktop-expanded' : ''}`} data-paper-theme={theme.id}
    style={{ '--tool-paper': theme.paper, '--tool-ink': theme.ink }}>
    {!expanded && <button className="db-desktop-ball" aria-label="展开画板工具" onClick={() => setExpand(true)}
      onDoubleClick={() => send({ type: 'close' })} title="画板工具（双击关闭）">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L15.5 5.5a2.1 2.1 0 013 3L8 19l-4 1z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M13.5 7.5l3 3" stroke="currentColor" strokeWidth="1.7"/></svg>
      <span className="db-desktop-ball-dot" style={{ background: state.settings.color || theme.ink }} />
    </button>}
    {expanded && <>
      <header className="db-desktop-drag"><strong>桌面画板</strong><span>{state.drawing ? '正在绘制 · Esc 结束' : '桌面可正常操作'}</span>
        <Button size="sm" variant="ghost" onClick={() => setExpand(false)} aria-label="收起为悬浮球">收起</Button>
        <Button size="sm" variant="ghost" onClick={() => send({ type: 'close' })} aria-label="关闭桌面画板">关闭</Button>
      </header>
      <div className="db-desktop-toolset" role="toolbar" aria-label="绘图工具"
        onMouseLeave={() => { if (!state.drawing) setExpand(false) }}>
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
    </>}
    {state.error && <div className="db-desktop-error" role="alert">{state.error}</div>}
  </div>
}

createRoot(document.getElementById('root')).render(<DesktopTools />)
