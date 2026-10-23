/**
 * 局域网传件主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 网络（api.net.share.*）与文件（api.localFiles.*）调用原样复用；
 * 业务核心 util.mjs / history.mjs 未改动；vendor qrcode.min.js 仍在 index.html 加载。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtBytes, fmtTime, fmtRemain } from '../js/util.mjs'
import { loadHistory, pushHistory, recordFromShare, historyLine, historyMeta } from '../js/history.mjs'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)

const DURATIONS = [5, 10, 30, 60]

export function App() {
  const kitRef = useRef(null)

  const [mode, setModeState] = useState('send') // send | receive
  const [picked, setPicked] = useState([])      // { handleId, name, size }
  const [minutes, setMinutes] = useState(10)
  const [share, setShare] = useState(null)      // LanShareStatus
  const [logs, setLogs] = useState([])
  const [history, setHistory] = useState([])
  const [deviceName, setDeviceName] = useState('')
  const [recvDir, setRecvDir] = useState('')
  const [statusText, setStatusText] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const status = useCallback((text) => setStatusText(text || ''), [])

  const shareRef = useRef(share)
  shareRef.current = share
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const historyRef = useRef(history)
  historyRef.current = history
  const logsRef = useRef(logs)
  logsRef.current = logs

  const timerRef = useRef(null)
  const offRequestRef = useRef(null)
  const offStoppedRef = useRef(null)
  const nameTimerRef = useRef(null)

  /* —— 分享中：倒计时/计数渲染（等价原 tick） —— */
  useEffect(() => {
    if (!share) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [share])

  /* —— 模式分段（setState 直驱 aria-selected / hidden，等价原 setMode） —— */

  /* —— 待发送队列（等价原 renderPicked） —— */
  const queueTotal = picked.length
    ? `${picked.length} 个文件 · 共 ${fmtBytes(picked.reduce((sum, p) => sum + p.size, 0))}`
    : ''

  const removePicked = useCallback((handleId) => {
    setPicked((prev) => prev.filter((p) => p.handleId !== handleId))
  }, [])

  const addFiles = useCallback(async (handlesOrFiles, selected = false) => {
    const list = Array.from(handlesOrFiles || [])
    if (!list.length) return
    const kit = kitRef.current
    try {
      const handles = selected ? list : await api.localFiles.fromDrop(list)
      let added = 0
      setPicked((prev) => {
        const next = [...prev]
        for (const h of handles) {
          if (h.kind !== 'file') continue
          if (next.some((p) => p.handleId === h.id)) continue
          if (next.some((p) => p.name === h.name && p.size === h.size)) continue
          next.push({ handleId: h.id, name: h.name, size: h.size })
          added++
        }
        return next
      })
      status(added ? `已加入 ${added} 个文件` : '文件已在队列中')
    } catch (err) {
      kit?.toast(err?.message || '拖入失败', 'error')
    }
  }, [status])

  const pickFiles = useCallback(() => {
    api.localFiles.pick({ kind: 'file', access: 'read', multiple: true })
      .then((handles) => addFiles(handles, true))
      .catch((error) => kitRef.current?.toast(error.message, 'error'))
  }, [addFiles])

  /* —— 投放区拖拽（等价原 bindDrop，depth 计数保留） —— */
  const [armed, setArmed] = useState(false)
  const dropDepth = useRef(0)
  const onDropZone = {
    onDragOver: (e) => { e.preventDefault(); setArmed(true) },
    onDragEnter: (e) => { e.preventDefault(); dropDepth.current++; setArmed(true) },
    onDragLeave: () => { dropDepth.current = Math.max(0, dropDepth.current - 1); if (!dropDepth.current) setArmed(false) },
    onDrop: (e) => {
      e.preventDefault(); dropDepth.current = 0; setArmed(false)
      void addFiles(e.dataTransfer?.files)
    },
    onClick: (e) => { if (e.target === e.currentTarget || e.target.closest('.dz-title,.dz-sub,.dz-glyph')) pickFiles() },
    onKeyDown: (e) => {
      if (e.defaultPrevented || e.isComposing || e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles() }
    },
  }

  /* —— 二维码绘制（等价原 drawQr，canvas 逻辑原样） —— */
  const qrCanvasRef = useRef(null)
  const drawQr = useCallback((url) => {
    const canvas = qrCanvasRef.current
    if (!canvas) return
    try {
      const qr = window.qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      const count = qr.getModuleCount()
      const scale = Math.max(2, Math.floor(124 / (count + 8)))
      const size = (count + 8) * scale
      const ctx = canvas.getContext('2d')
      canvas.width = size
      canvas.height = size
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, size)
      ctx.fillStyle = '#000000'
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale)
        }
      }
    } catch {
      status('二维码生成失败（地址过长），可复制下方链接手动输入')
    }
  }, [status])

  const shareUrls = useCallback((s) => {
    if (!s) return []
    const ips = s.ips.length ? s.ips : ['127.0.0.1']
    return ips.map((ip) => `http://${ip}:${s.port}/d/${s.files[0].id}?code=${s.code}`)
  }, [])

  /* —— 历史（storage v2，兼容 v1；等价原 loadAndRenderHistory/saveHistory） —— */
  const renderHistoryFrom = useCallback(async () => {
    const kit = kitRef.current
    if (!kit) return
    setHistory(loadHistory(await kit.load('history', [])))
  }, [])

  const saveHistory = useCallback(async (done) => {
    const kit = kitRef.current
    if (!kit) return
    const next = pushHistory(historyRef.current, recordFromShare(done))
    setHistory(next)
    historyRef.current = next
    await kit.save('history', { v: 2, entries: next }).catch(() => {})
    // 停止时回填真实下载次数
    setTimeout(async () => {
      const cur = await api.net.share.status(done.shareId).catch(() => null)
      const row = historyRef.current.find((h) => h.shareId === done.shareId)
      if (row && cur) {
        const patched = historyRef.current.map((h) => (h.shareId === done.shareId ? { ...h, downloads: cur.downloads } : h))
        setHistory(patched)
        historyRef.current = patched
        await kit.save('history', { v: 2, entries: patched }).catch(() => {})
      }
    }, 800)
  }, [])

  /* —— 停止轮询与订阅（等价原 stopTick） —— */
  const stopTick = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    offRequestRef.current?.(); offRequestRef.current = null
    offStoppedRef.current?.(); offStoppedRef.current = null
  }, [])

  const finishShareRef = useRef(null)

  const startShare = useCallback(async () => {
    const pickedNow = pickedRef.current
    if (!pickedNow.length) return
    const kit = kitRef.current
    try {
      const started = await api.net.share.start({
        files: pickedNow.map((p) => ({ handleId: p.handleId })),
        minutes,
      })
      setShare(started)
      setLogs([])
      offRequestRef.current = api.net.share.onRequest((event) => {
        if (event.shareId !== started.shareId) return
        setLogs((prev) => [...prev, { file: event.file, ip: event.ip, ts: event.ts }])
      })
      offStoppedRef.current = api.net.share.onStopped((event) => {
        if (event.shareId !== started.shareId) return
        finishShareRef.current?.(event.reason === 'expired' ? '分享已到期，自动关闭' : '分享已停止')
      })
      timerRef.current = setInterval(async () => {
        // 到期兜底：宿主停止后 status 查不到也结束
        if (Date.now() >= started.expiresAt + 1500) {
          const cur = await api.net.share.status(started.shareId).catch(() => null)
          if (!cur || cur.stopped) finishShareRef.current?.('分享已到期，自动关闭')
        }
      }, 1000)
      void saveHistory(started)
      try { if (api.notify) await api.notify({ title: '局域网传件已开启', body: `取件码 ${started.code}，${minutes} 分钟内有效` }) } catch { /* notify 可能被拒 */ }
    } catch (err) {
      kit?.toast(err?.message || '启动分享失败', 'error')
    }
  }, [minutes, saveHistory])

  const finishShare = useCallback((message) => {
    stopTick()
    setShare(null)
    setPicked([])
    setStatusText('')
    if (message) {
      kitRef.current?.toast(message, 'info')
      try { if (api.notify) void api.notify({ title: '局域网传件', body: message }) } catch { /* ignored */ }
    }
  }, [stopTick])
  finishShareRef.current = finishShare

  /* —— 设备名 / 接收目录（等价原 bindPrefs，400ms 防抖保留） —— */
  const onDeviceNameInput = useCallback((e) => {
    const value = e.target.value
    setDeviceName(value)
    clearTimeout(nameTimerRef.current)
    nameTimerRef.current = setTimeout(() => {
      void kitRef.current?.save('deviceName', value.trim().slice(0, 24)).catch(() => {})
    }, 400)
  }, [])

  const pickDir = useCallback(() => {
    api.localFiles.pick({ kind: 'directory', access: 'read' })
      .then(async (handles) => {
        const dir = handles?.find((h) => h.kind === 'directory')
        if (!dir) return
        const next = dir.displayPath || dir.name || '已选择的目录'
        setRecvDir(next)
        await kitRef.current?.save('recvDir', next).catch(() => {})
        kitRef.current?.toast('已记住接收目录', 'success')
      })
      .catch((error) => kitRef.current?.toast(error.message, 'error'))
  }, [])

  const onPickDirClick = useCallback(() => { void pickDir() }, [pickDir])

  /* —— Quick / 桌面双形态（等价原 kit.onMode） —— */
  const modeRef = useRef(null)
  modeRef.current = (nextMode) => {
    document.documentElement.dataset.mode = nextMode
    if (nextMode === 'quick') {
      const live = shareRef.current != null
      void api.ui.setHeight(live ? 560 : 430).catch(() => {})
    }
  }

  /* —— 宿主适配器：PluginKit 一次初始化，回调用 latest-ref 桥接 —— */
  const startRef = useRef(startShare)
  startRef.current = startShare

  useEffect(() => {
    const kit = window.PluginKit.create({ title: '局域网传件', height: 480 })
    kitRef.current = kit
    kit.onMode((nextMode) => modeRef.current?.(nextMode))
    // 关闭前尽力停止分享（宿主 scope 释放也会兜底）
    if (api?.onBeforeClose) {
      api.onBeforeClose(() => {
        const cur = shareRef.current
        if (cur) return api.net.share.stop(cur.shareId).catch(() => {})
      })
    }
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      await renderHistoryFrom()
      if (!alive) return
      setDeviceName(String(await kit.load('deviceName', '') || ''))
      setRecvDir(String(await kit.load('recvDir', '') || ''))
    })()
    return () => {
      alive = false
      stopTick()
    }
  }, [renderHistoryFrom, stopTick])

  /* —— 分享中实时渲染二维码（等价原 renderLive 中的 drawQr） —— */
  const urls = shareUrls(share)
  useEffect(() => {
    if (share && urls[0]) drawQr(urls[0])
  }, [share, urls, drawQr])

  const send = mode === 'send'
  const logRows = logs.slice(-50).reverse()

  return (
    <main className="lan-app">
      <header className="app-head">
        <div className="brand">
          <h1>局域网传件</h1>
          <span className="tagline">同一网络 · 到期自动关闭</span>
        </div>
        <div className="mode-seg" role="tablist" aria-label="发送或接收">
          <button id="mode-send" type="button" className="mode-btn" role="tab" aria-selected={send}
            onClick={() => setModeState('send')}>发送</button>
          <button id="mode-receive" type="button" className="mode-btn" role="tab" aria-selected={!send}
            onClick={() => setModeState('receive')}>接收</button>
        </div>
      </header>

      <div className="layout">
        {/* 主舞台：发送（投放 / 分享中） */}
        <section className="stage panel" id="send-panel" role="tabpanel" aria-label="发送" hidden={!send}>
          {/* 待发送：大投放区 */}
          {!share ? (
            <div id="idle-view" className="view">
              <div id="drop-zone" className={'drop-zone' + (armed ? ' armed' : '')} tabIndex={0} role="button" aria-label="拖入或选择文件" {...onDropZone}>
                <svg className="dz-glyph" viewBox="0 0 48 48" aria-hidden="true">
                  <path d="M24 30V10m0 0l-8 8m8-8l8 8" />
                  <path d="M10 32v4a4 4 0 0 0 4 4h20a4 4 0 0 0 4-4v-4" />
                </svg>
                <p className="dz-title">把文件拖到这里</p>
                <p className="dz-sub">仅本机局域网可见 · 6 位取件码门禁 · 到期自动关闭</p>
                <button id="pick-btn" type="button" className="btn primary"
                  onClick={(e) => { e.stopPropagation(); pickFiles() }}>选择文件</button>
              </div>
              <ul id="picked-list" className="picked-list" hidden={picked.length === 0}>
                {picked.map((item) => (
                  <li key={item.handleId}>
                    <span className="f-name" title={item.name}>{item.name}</span>
                    <span className="f-size">{fmtBytes(item.size)}</span>
                    <button type="button" aria-label={`移除 ${item.name}`}
                      onClick={() => removePicked(item.handleId)}>移除</button>
                  </li>
                ))}
              </ul>
              <div id="queue-bar" className="queue-bar" hidden={picked.length === 0}>
                <span id="queue-total" className="queue-total pk-mono">{queueTotal}</span>
                <div className="duration-row">
                  <span className="field-label">有效时长</span>
                  <div className="segmented" id="duration" role="group" aria-label="分享时长">
                    {DURATIONS.map((min) => (
                      <button key={min} type="button" data-min={min} aria-pressed={minutes === min}
                        onClick={() => setMinutes(min)}>{min} 分</button>
                    ))}
                  </div>
                  <button id="start-btn" type="button" className="btn primary" disabled={picked.length === 0}
                    onClick={() => void startShare()}>开始分享</button>
                </div>
              </div>
            </div>
          ) : (
            /* 分享中：码 + 二维码 + 地址 + 状态 + 日志 */
            <div id="live-view" className="view">
              <div className="live-grid">
                <div className="qr-block">
                  <canvas id="qr-canvas" ref={qrCanvasRef} width="148" height="148" aria-label="下载二维码"></canvas>
                  <span className="qr-caption">手机扫码即下</span>
                </div>
                <div className="live-info">
                  <div className="code-block">
                    <span className="field-label">取件码</span>
                    <span id="share-code" className="code-value pk-mono">{share.code}</span>
                    <button id="copy-code" type="button" className="btn ghost"
                      onClick={() => { void kitRef.current?.copy(share.code) }}>复制</button>
                  </div>
                  <ul id="addr-list" className="addr-list pk-mono">
                    {urls.map((url) => (
                      <li key={url}>
                        <a href="#" title={`${url}（点击复制）`}
                          onClick={(e) => { e.preventDefault(); void kitRef.current?.copy(url) }}>{url.replace(/^http:\/\//, '')}</a>
                      </li>
                    ))}
                  </ul>
                  <div className="live-meter">
                    <div className="meter-cell">
                      <span className="meter-label">剩余</span>
                      <span id="countdown" className="meter-value pk-mono">{fmtRemain(share.expiresAt - now)}</span>
                    </div>
                    <div className="meter-cell">
                      <span className="meter-label">下载</span>
                      <span id="dl-count" className="meter-value pk-mono">{`${share.downloads} 次`}</span>
                    </div>
                    <div className="meter-cell">
                      <span className="meter-label">连接</span>
                      <span id="conn-count" className="meter-value pk-mono">{String(share.activeConnections ?? 0)}</span>
                    </div>
                    <button id="stop-btn" type="button" className="btn danger" onClick={async () => {
                      if (!shareRef.current) return
                      try { await api.net.share.stop(shareRef.current.shareId) } catch { finishShare('分享已停止') }
                    }}>停止分享</button>
                  </div>
                </div>
              </div>
              <div className="log-block">
                <p className="block-title">下载请求</p>
                <ul id="req-log" className="req-log pk-mono">
                  {logRows.length === 0 ? (
                    <li className="empty">暂无下载请求，等待手机扫码</li>
                  ) : logRows.map((item, i) => (
                    <li key={`${item.ts}-${i}`}>
                      <span className="r-file" title={item.file}>{item.file}</span>
                      <span className="r-ip">{item.ip}</span>
                      <span className="r-ip">{fmtTime(item.ts)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>

        {/* 接收面板（本机作为接收端说明 + 接收目录记忆） */}
        <section className="panel" id="receive-panel" role="tabpanel" aria-label="接收" hidden={send}>
          <div className="view">
            <p className="block-title">在本机接收</p>
            <ol className="steps">
              <li>请发送方开启分享并出示二维码</li>
              <li>浏览器打开地址，输入取件码即可下载</li>
              <li>本插件不做接收端服务，接收经系统浏览器完成</li>
            </ol>
            <p className="block-title">接收目录</p>
            <div className="recv-dir">
              <span id="recv-dir" className={'recv-dir-value pk-mono' + (recvDir ? '' : ' empty')}
                title={recvDir || ''}>{recvDir || '未设置（使用浏览器默认下载目录）'}</span>
              <button id="pick-dir-btn" type="button" className="btn ghost" onClick={onPickDirClick}>选择目录</button>
            </div>
            <p className="hint">记忆常用接收目录，浏览器下载时可直接定位。</p>
          </div>
        </section>

        {/* 侧栏：设备名 + 历史 */}
        <aside className="side">
          <div className="panel device-panel">
            <p className="block-title">本机名称</p>
            <div className="device-row">
              <input id="device-name" className="device-input" type="text" maxLength={24}
                placeholder="如：Haijun 的 Mac" aria-label="设备自定义名称"
                value={deviceName} onInput={onDeviceNameInput} />
            </div>
            <p className="hint">仅用于历史记录与日志中辨识本机。</p>
          </div>
          <div className="panel history-panel">
            <div className="panel-head">
              <p className="block-title">分享历史</p>
              <button id="clear-history" type="button" className="btn ghost sm" hidden={history.length === 0}
                onClick={async () => {
                  setHistory([])
                  historyRef.current = []
                  await kitRef.current?.save('history', { v: 2, entries: [] }).catch(() => {})
                }}>清空</button>
            </div>
            <ul id="history-list" className="history-list">
              {history.slice(0, 12).map((entry) => (
                <li key={entry.id}>
                  <span className="h-files" title={entry.names}>{historyLine(entry)}</span>
                  <span className="h-meta">{historyMeta(entry)}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <p id="status" role="status" aria-live="polite" className="status-line">{statusText}</p>
    </main>
  )
}
