import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Slider } from './ui/index.jsx'
import { createDesktopTransport } from './js/desktopTransport.mjs'
import { DESKTOP_TOOLS, BLOOM_RADIUS } from './js/desktopController.mjs'
import { THEMES } from './js/theme.mjs'
import './css/main.css'
import './css/desktop.css'
import './js/desktopFont.mjs'

/** 每个花瓣的图标（24×24 线性 path），与 DESKTOP_TOOLS 顺序一一对应。 */
const PETAL_ICONS = {
  select: 'M5 3l14 8-6 1.6L10.4 19 5 3z',
  pen: 'M4 20l1-4L15.5 5.5a2.1 2.1 0 013 3L8 19l-4 1z',
  highlighter: 'M7 14l6-6 4 4-6 6H7v-4zm10-8l3 3',
  eraser: 'M8 20h11M5.5 16.5l7-7 5 5-4.5 4.5H7z',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z',
  line: 'M4 20L20 4',
  arrow: 'M4 20L20 4M20 4h-7M20 4v7',
  text: 'M5 5h14M12 5v14M9 19h6',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5'
}

/** 判定「按下后算拖动」的最小位移（px）：小于它仍按单击处理。 */
const DRAG_THRESHOLD = 4

/**
 * 一颗球，点一下开花（工具沿圆周像花瓣铺开），再点一下收回。
 *
 * 拖动：球本身就是拖拽把手——按下记录起点，移动超过阈值就按指针位移
 * 连续更新窗口 bounds（辅助窗口无法用 `-webkit-app-region: drag`：
 * 那是系统拖窗区，会把指针事件全部交给原生，onClick 永远不触发）。
 * 松手时若位移没超过阈值，视为单击 → 切换展开/收起。
 */
function DesktopTools() {
  const [state, setState] = useState({ tool: 'pen', drawing: false, settings: {}, error: '' })
  const [ready, setReady] = useState(false), [expanded, setExpanded] = useState(false), bridge = useRef(null)
  const [colorOpen, setColorOpen] = useState(false)
  /* 指针是否还在工具窗口内：blur 时用它区分「点花瓣导致焦点转移」和「真的移到桌面」。 */
  const [pointerInside, setPointerInside] = useState(true)
  /* 点花瓣后的一小段保护期：焦点刚交给画布窗口时 blur 与 pointerleave 可能乱序抵达。 */
  const petalGuardUntil = useRef(0)
  /* 拖动会话：起点、窗口原点、以及「是否已经真的移动过（用于抑制随后的 click）」。 */
  const drag = useRef(null)
  /* 拖动结束后浏览器还会补一次 click，用它把那次 click 压掉。 */
  const suppressClick = useRef(0)
  /* pointerup 已经处理完单击时置位，避免随后的 click 再切换一次。 */
  const settleClick = useRef(false)
  /* 展开流程进行中：防止连点把两次扩缩叠在一起。 */
  const expanding = useRef(false)
  /* 等待窗口尺寸到位的回调：后端 ack 一到就执行（播花开）。 */
  const pendingExpand = useRef(null)
  /* 组件是否还挂载：延时/异步回调回来时用它避免对已卸载组件 setState。 */
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const theme = THEMES[state.settings.theme] || THEMES.paper
  const sizeKey = state.tool === 'eraser' ? 'eraserSize' : state.tool === 'highlighter' ? 'highlightWidth' : 'strokeWidth'
  const sizeRange = sizeKey === 'eraserSize' ? [6, 80, 2] : sizeKey === 'highlightWidth' ? [4, 40, 2] : [.5, 12, .5]

  /**
   * 通道失效（插件重载 / 运行代次换代）时宿主会拒绝一切 post。
   * 这不是用户需要读懂的故障，而是「这个浮窗已经过期」——直接关掉自己。
   */
  const send = data => void bridge.current?.post(data).catch(error => {
    const message = String(error?.message ?? error)
    if (/Retired or foreign auxiliary sender|Auxiliary window not owned|owner is closing|Auxiliary owner/i.test(message)) {
      void window.enestAux?.close?.().catch(() => {})
      return
    }
    setState(previous => ({ ...previous, error: message }))
  })

  /**
   * 展开/收起：把「窗口几何」和「花开动画」的先后顺序理顺，避免整块跳变。
   *
   * 展开：先让后端把窗口扩到最终尺寸（球心在屏幕上不动），
   *       窗口真到位后再切 bloom 形态，花瓣在**完整画布**里从球心向外盛开。
   * 收起：先播收拢动画，动画走完再缩窗口（缩小时球早已收回中心）。
   *
   * 之前是本地立刻切 bloom、后端异步改窗口：花瓣先被 64×64 的视图裁掉，
   * 等原生 resize 到达时整块"啪"地跳出来——那一下就是硬编码般的跳。
   */
  const setExpand = value => {
    if (value === expanded || expanding.current) return
    const post = payload => void bridge.current?.post(payload).catch(error => {
      const message = String(error?.message ?? error)
      if (/Retired or foreign auxiliary sender|Auxiliary window not owned|Auxiliary owner/i.test(message)) return
      setState(previous => ({ ...previous, error: message }))
    })
    expanding.current = true

    if (!value) {
      // 收起：动画先走，260ms（与花瓣 transition 一致）后才缩窗口。
      setExpanded(false)
      window.setTimeout(() => { expanding.current = false; if (mounted.current) post({ type: 'expand', value: false }) }, 260)
      return
    }
    // 展开：等窗口扩好再渲染。ack 一到就放，另有 90ms 兜底——渲染层拿不到
    // 原生 resize 事件，ack 丢失时不能让用户点了没反应。
    let settled = false
    const bloom = () => {
      if (settled) return
      settled = true
      expanding.current = false
      if (mounted.current) setExpanded(true)
    }
    pendingExpand.current = bloom
    post({ type: 'expand', value: true })
    window.setTimeout(bloom, 90)
  }

  /** 关闭：正常路径交给后端；通道失效时窗口自己消失，别留下点不动的僵尸球。 */
  const closeAll = () => {
    const fallback = setTimeout(() => { void window.enestAux?.close?.().catch(() => {}) }, 700)
    void bridge.current?.post({ type: 'close' })
      .then(() => clearTimeout(fallback))
      .catch(() => { clearTimeout(fallback); void window.enestAux?.close?.().catch(() => {}) })
  }

  /* 首次就绪时让球亮一下：从 Quick 启动桌面画布时宿主不建 Tab，
     屏幕上唯一的变化就是这个球，没有高亮用户会以为缩写没生效。 */
  const [announce, setAnnounce] = useState(false)
  useEffect(() => {
    if (!ready) return
    setAnnounce(true)
    const timer = setTimeout(() => setAnnounce(false), 2600)
    return () => clearTimeout(timer)
  }, [ready])

  useEffect(() => {
    const api = window.enestAux
    if (!api) return
    let disposed = false, timer
    const accept = data => {
      if (disposed) return
      if (data?.type === 'tools') setState(data)
      else if (data?.type === 'ready-ack') { setReady(true); clearInterval(timer) }
      // 窗口尺寸已经落到最终大小：现在才播花开，花瓣不会被小窗口裁掉。
      else if (data?.type === 'expand-ack') {
        const finish = pendingExpand.current
        pendingExpand.current = null
        if (finish) finish()
        else setExpanded(Boolean(data.value))
      }
    }
    const transport = createDesktopTransport(data => api.post(data), accept, error => setState(previous => ({ ...previous, error: error.message })))
    bridge.current = transport
    const off = api.onMessage(data => transport.accept(data))
    void api.getContext().then(context => {
      if (disposed) return
      accept(context.data)
      // getContext 能返回就说明宿主侧 surface 与运行代次都有效，比等 ready-ack 可靠。
      setReady(true)
      const hello = () => void transport.post({ type: 'ready' }).catch(() => {})
      hello(); timer = setInterval(hello, 1500)
    }).catch(error => setState(previous => ({ ...previous, error: error.message })))
    // Esc：展开态先收回球；球态则切到「操作桌面」，让用户能点到下面的窗口。
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      expanded ? setExpand(false) : send({ type: 'operate' })
    }
    window.addEventListener('keydown', onKey)
    return () => { disposed = true; clearInterval(timer); off(); transport.dispose(); window.removeEventListener('keydown', onKey) }
  }, [expanded])

  // 展开态下指针离开窗口就收回球形态。点花瓣会先把焦点交给画布窗口（要接收手势），
  // 工具窗口随即 blur —— 所以 blur 只启动延迟判定，指针仍在窗口内就保持展开。
  useEffect(() => {
    if (!expanded) return
    let timer
    const onBlur = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (pointerInside || Date.now() < petalGuardUntil) return
        setExpand(false)
      }, 220)
    }
    window.addEventListener('blur', onBlur)
    return () => { clearTimeout(timer); window.removeEventListener('blur', onBlur) }
  }, [expanded, pointerInside])

  const color = state.settings.color || theme.ink

  /* ---------- 拖动：球本身既是按钮也是把手 ---------- */
  const onBallPointerDown = event => {
    if (event.button !== 0) return
    // 记录按下点作为拖动原点；capture 保证抬起时还在本元素上收到 pointerup。
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* synthetic events */ }
    drag.current = { id: event.pointerId, originX: event.screenX, originY: event.screenY, lastX: event.screenX, lastY: event.screenY, moved: false }
  }
  const onBallPointerMove = event => {
    const session = drag.current
    if (!session || session.id !== event.pointerId) return
    // 是否算拖动看「按下点到当前点」的总位移，而不是途中某一次抖动：
    // 手按住时轻微晃动不应把单击变成拖动。
    if (!session.moved) {
      const totalX = Math.abs(event.screenX - session.originX)
      const totalY = Math.abs(event.screenY - session.originY)
      if (totalX < DRAG_THRESHOLD && totalY < DRAG_THRESHOLD) return
      session.moved = true
    }
    // 指针事件的频率远高于显示帧：一帧内多次 move 合并成一次 IPC。
    // 后端每收到一条 move 就要 setBounds 一次，逐条发会打到辅助窗口的
    // 120 次/秒消息上限，窗口跟手会卡顿甚至丢帧。
    session.pendingX = event.screenX
    session.pendingY = event.screenY
    if (session.frame) return
    session.frame = requestAnimationFrame(() => {
      session.frame = 0
      if (drag.current !== session) return
      const dx = session.pendingX - session.lastX, dy = session.pendingY - session.lastY
      if (!dx && !dy) return
      session.lastX = session.pendingX
      session.lastY = session.pendingY
      void bridge.current?.post({ type: 'move', dx, dy }).catch(() => {})
    })
  }
  const onBallPointerUp = event => {
    const session = drag.current
    drag.current = null
    if (session?.frame) cancelAnimationFrame(session.frame)
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* capture may already be gone */ }
    if (!session || session.id !== event.pointerId) return
    // 拖动过 → 这次按下不算单击，并压掉紧随其后的 click（拖动结束也会派发一次）。
    if (session.moved) { suppressClick.current = Date.now() + 400; return }
    // 没拖动 → 单击：切换展开/收起。在这里做而不是只靠 onClick：
    // setPointerCapture 会让后续 click 的命中目标变化，某些合成点击序列只到 pointerup。
    settleClick.current = true
    setExpand(!expanded)
  }
  const onBallClick = () => {
    // pointerup 已经处理过的这次单击，click 不再重复切换。
    if (settleClick.current) { settleClick.current = false; return }
    // 刚拖完的那次 click 也不算切换。
    if (Date.now() < suppressClick.current) return
    setExpand(!expanded)
  }

  /**
   * 全部 12 个动作（10 个工具 + 操作桌面 + 关闭）沿完整圆周均分，每 30° 一片，
   * 从正上方 -90° 起顺时针，像一朵盛开的花。
   */
  const SLOTS = DESKTOP_TOOLS.length + 2
  const slot = (index) => {
    const degrees = -90 + (360 / SLOTS) * index
    const angle = degrees * (Math.PI / 180)
    return {
      x: Math.cos(angle) * BLOOM_RADIUS, y: Math.sin(angle) * BLOOM_RADIUS,
      // 每片错开一点起步自转，绽开时像花瓣各自舒展，而不是一整圈同步缩放。
      tilt: index % 2 ? -28 : 28,
      delay: index * 16
    }
  }
  const petals = DESKTOP_TOOLS.map(([key, label], index) => ({ key, label, icon: PETAL_ICONS[key], ...slot(index) }))
  const operate = slot(DESKTOP_TOOLS.length)
  const close = slot(DESKTOP_TOOLS.length + 1)

  /* 环心球：两种形态下位置相同，单击切换展开/收起，按住拖动移动窗口。 */
  const core = <button type="button" className={`db-bloom-core${expanded ? ' is-open' : ''}`}
    aria-label={expanded ? '收起画板工具' : '展开画板工具'} aria-expanded={expanded}
    title={expanded ? '单击收起 · 按住拖动位置' : '单击展开 · 按住拖动位置'}
    onPointerDown={onBallPointerDown} onPointerMove={onBallPointerMove} onPointerUp={onBallPointerUp}
    onPointerCancel={onBallPointerUp} onClick={onBallClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={PETAL_ICONS.pen} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M13.5 7.5l3 3" stroke="currentColor" strokeWidth="1.7"/></svg>
    <span className="db-desktop-ball-dot" style={{ background: color }} />
  </button>

  return <div className={`db-desktop-tools${expanded ? ' db-desktop-bloom' : ''}${announce ? ' db-desktop-announce' : ''}`}
    data-paper-theme={theme.id} style={{ '--tool-paper': theme.paper, '--tool-ink': theme.ink, '--tool-color': color }}
    onPointerEnter={() => setPointerInside(true)} onPointerLeave={() => setPointerInside(false)}>
    {/* 花瓣与环心球必须**始终挂载**，只切换祖先的 db-desktop-bloom 类。
        若用 `{expanded && ...}` 按需渲染，元素首次出现时浏览器把
        「起始 transform → 终态 transform」当成初始值直接绘制，
        transition 根本不会跑——这就是之前"硬生生跳出来"的真正原因。 */}
    <div className="db-bloom-ring" role="toolbar" aria-label="绘图工具" aria-hidden={!expanded}>
      {petals.map(petal => <button key={petal.key} type="button"
        className={`db-petal${state.drawing && state.tool === petal.key ? ' is-active' : ''}`}
        style={{ '--petal-x': `${petal.x}px`, '--petal-y': `${petal.y}px`, '--petal-delay': `${petal.delay}ms`, '--petal-tilt': `${petal.tilt ?? 0}deg` }}
        // 不用 disabled 拦截：ready 依赖后端回执，回执没到花瓣会永久变灰、点不动。
        // 点击照发，后端自己校验运行代次与交互资格，失败会在错误条显形。
        aria-disabled={!ready || undefined}
        tabIndex={expanded ? 0 : -1}
        title={petal.label} aria-label={petal.label} aria-pressed={state.drawing && state.tool === petal.key}
        onClick={() => { petalGuardUntil.current = Date.now() + 900; send({ type: 'tool', tool: petal.key }) }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={petal.icon} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="db-petal-label">{petal.label}</span>
      </button>)}
      {/* 「操作桌面」与「关闭」也是花瓣，必须留在 .db-bloom-ring 内：
          花瓣的 left/top 基准是最近定位祖先（ring = 窗口正中），放到 ring 外面
          会以窗口左上角为基准，整片花瓣直接飞到窗外。 */}
      <button type="button" className={`db-petal db-petal-text${state.drawing ? '' : ' is-active'}`}
        style={{ '--petal-x': `${operate.x}px`, '--petal-y': `${operate.y}px`, '--petal-delay': `${operate.delay}ms`, '--petal-tilt': `${operate.tilt ?? 0}deg` }}
        tabIndex={expanded ? 0 : -1}
        onClick={() => { petalGuardUntil.current = Date.now() + 900; send({ type: 'operate' }) }}
        title="切回桌面操作（不退出桌面画板）" aria-label="操作桌面">
        <span className="db-petal-glyph">桌</span><span className="db-petal-label">操作桌面</span>
      </button>
      <button type="button" className="db-petal db-petal-close"
        style={{ '--petal-x': `${close.x}px`, '--petal-y': `${close.y}px`, '--petal-delay': `${close.delay}ms`, '--petal-tilt': `${close.tilt ?? 0}deg` }}
        tabIndex={expanded ? 0 : -1}
        onClick={closeAll} title="关闭桌面画板" aria-label="关闭桌面画板">
        <span className="db-petal-glyph">×</span><span className="db-petal-label">关闭</span>
      </button>
    </div>

    {/* 环心球：常驻，位置在两个形态下相同。 */}
    {core}

    {/* 收起态专属的 × 入口：展开后关闭已在外环上，不需要重影。 */}
    <button type="button" className="db-desktop-ball-close" aria-label="关闭桌面画板" title="关闭桌面画板"
      tabIndex={expanded ? -1 : 0} onClick={closeAll}>×</button>

    {/* 颜色/粗细：点环心球上的色点展开，浮在环的空隙里，不额外占屏。 */}
    <button type="button" className="db-bloom-settings" aria-expanded={colorOpen} aria-label="画笔设置"
      tabIndex={expanded ? 0 : -1}
      title="画笔颜色与粗细" onClick={() => setColorOpen(value => !value)}>
      <span style={{ background: color }} />
    </button>
    {colorOpen && expanded && <div className="db-bloom-options" role="group" aria-label="画笔设置">
      <label className="db-desktop-color" title="画笔颜色">
        <input aria-label="画笔颜色" type="color" value={color} onChange={event => send({ type: 'settings', color: event.target.value })} />
      </label>
      <Slider aria-label={sizeKey === 'eraserSize' ? '橡皮大小' : '画笔粗细'} min={sizeRange[0]} max={sizeRange[1]} step={sizeRange[2]}
        value={[state.settings[sizeKey] || sizeRange[0]]}
        onValueChange={([width]) => setState(previous => ({ ...previous, settings: { ...previous.settings, [sizeKey]: width } }))}
        onValueCommit={([width]) => send({ type: 'settings', width, sizeKey })} />
    </div>}
    {/* 错误条只在展开态显示：收起态窗口只有 64×64，一条长文案会被挤到窗外。 */}
    {state.error && expanded && <div className="db-desktop-error" role="alert">{state.error}</div>}
  </div>
}

createRoot(document.getElementById('root')).render(<DesktopTools />)
