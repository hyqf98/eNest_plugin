/**
 * main.jsx — 网络调试台 · React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心复用 ./core.js（纯逻辑，未改动）；backend 宿主 API 调用语义不变。
 * 会话数据流经 latest-ref 桥接（TCP 收流 / WS 帧高频回调直接读 refs）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import {
  DEFAULT_ENVS, EnvStore, envResolve, buildUrl,
  parseCurl, toCurl,
  runAssertions, ASSERT_TYPES,
  RingBuffer, formatHexDump,
  BUILTIN_DECODERS, applyDecoder,
  encodeSend, SEND_KINDS, base64Encode,
  formatBytes, formatMs, classifyStatus, netError,
  HistoryStore, CollectionStore, HISTORY_LIMIT,
  wsUrlKind, flattenJson, htmlPreview
} from '../js/core.js'

const api = window.enest || window.zapi
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const MODES = [['http', 'HTTP'], ['tcp', 'TCP'], ['ws', 'WebSocket']]
const RESP_PAGE = 512 * 1024

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function mergeChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}
let sessionSeq = 0
function newSessionData(kind) {
  return {
    id: `s-${++sessionSeq}`, kind,
    name: kind === 'http' ? 'HTTP' : kind === 'tcp' ? 'TCP' : 'WS',
    // http
    method: 'GET', url: '', headersKv: [], paramsKv: [],
    bodyKind: 'none', bodyText: '',
    asserts: [],
    resp: null, respView: 'pretty', paused: false,
    __subTab: 'params',
    // tcp
    host: '127.0.0.1', port: 8080, tls: false, timeoutMs: 10000,
    socketId: null, rx: new RingBuffer(), decoderId: 'hexdump', regexPattern: '',
    showTimestamp: false, sendKind: 'text', sendHistory: [], loopIv: 1000, loopCnt: 10,
    // ws
    wsUrl: '', wsFrames: [], wsPing: 0, wsPong: 0,
    wsView: 'text', wsPaused: false,
    // 运行时（不触发渲染）
    httpDispose: null, ws: null, loopTimer: null, loopLeft: 0, dirty: false, dropped: false
  }
}

export function App() {
  const kitRef = useRef(null)
  const dlgRef = useRef(null)
  const modeRef = useRef('shell')

  // —— 持久化 store（kit storage 包装，非渲染状态）——
  const envStoreRef = useRef(null)
  const historyRef = useRef(null)
  const collectionsRef = useRef(null)
  const customDecodersRef = useRef([])
  if (!envStoreRef.current) {
    envStoreRef.current = new EnvStore(DEFAULT_ENVS)
    historyRef.current = new HistoryStore()
    collectionsRef.current = new CollectionStore(null)
  }

  // —— 渲染状态（与原 renderXxx 触发的 DOM 输出对应）——
  const [tick, setTick] = useState(0)
  const [foot, setFoot] = useState('就绪')
  const [sessions, setSessions] = useState([])        // 渲染快照：[{id,kind,name}]
  const activeIdRef = useRef(null)
  const [activeId, setActiveId] = useState(null)
  const [envNames, setEnvNames] = useState([])
  const [envCurrent, setEnvCurrent] = useState('dev')
  const [envVersion, setEnvVersion] = useState(0)     // 环境变量编辑后强制刷新预览
  const [treeCollapsed, setTreeCollapsed] = useState(() => new Set())
  const [respPage, setRespPage] = useState(1)
  // 命令式会话实体（可变，latest-ref）
  const sessionsMapRef = useRef(new Map())

  const rerender = useCallback(() => setTick((t) => t + 1), [])
  const setStatus = useCallback((text) => setFoot(text), [])

  const getActive = () => sessionsMapRef.current.get(activeIdRef.current) ?? null

  function activeSessionOf(kind) {
    const cur = getActive()
    return cur && cur.kind === kind ? cur : null
  }

  function isSessionEmpty(s) {
    if (s.kind === 'http') return !s.url && !s.headersKv.length && !s.resp
    if (s.kind === 'tcp') return !s.socketId && !s.rx.length
    return !s.ws && !s.wsFrames.length
  }

  // —— 持久化（storage）——
  const persistAll = useCallback(async () => {
    const kit = kitRef.current
    if (!kit) return
    await Promise.allSettled([
      kit.save('netkit_envs', envStoreRef.current.toJSON()),
      kit.save('netkit_history', historyRef.current.toJSON()),
      kit.save('netkit_collections', collectionsRef.current.toJSON()),
      kit.save('netkit_decoders', customDecodersRef.current)
    ])
  }, [])

  // —— 会话生命周期 ——
  const stopLoop = useCallback((s) => {
    if (s.loopTimer) { clearTimeout(s.loopTimer); s.loopTimer = null }
  }, [])

  function syncSessions() {
    setSessions([...sessionsMapRef.current.values()].map((s) => ({ id: s.id, kind: s.kind, name: s.name })))
    setActiveId(activeIdRef.current)
  }

  const closeSessionQuiet = useCallback((s) => {
    stopLoop(s)
    s.httpDispose?.(); s.httpDispose = null; s.resp = null
    try { s.socketId && api?.net?.socket?.close?.(s.socketId) } catch { /* 已关 */ }
    try { s.ws?.close() } catch { /* 已关 */ }
    sessionsMapRef.current.delete(s.id)
  }, [stopLoop])

  const closeSession = useCallback((id) => {
    const s = sessionsMapRef.current.get(id)
    if (!s) return
    stopLoop(s)
    s.httpDispose?.(); s.httpDispose = null; s.resp = null
    try { s.socketId && api?.net?.socket?.close?.(s.socketId) } catch { /* 已关 */ }
    try { s.ws?.close() } catch { /* 已关 */ }
    sessionsMapRef.current.delete(id)
    if (activeIdRef.current === id) activeIdRef.current = sessionsMapRef.current.keys().next().value ?? null
    if (!activeIdRef.current) {
      const s2 = newSessionData('http')
      sessionsMapRef.current.set(s2.id, s2)
      activeIdRef.current = s2.id
    }
    syncSessions(); rerender()
  }, [rerender, stopLoop])

  function switchKind(kind) {
    const cur = getActive()
    if (cur && cur.kind === kind) return
    if (cur && isSessionEmpty(cur)) {
      const fresh = newSessionData(kind)
      fresh.id = cur.id
      closeSessionQuiet(cur)
      sessionsMapRef.current.set(fresh.id, fresh)
    } else {
      const s = newSessionData(kind)
      sessionsMapRef.current.set(s.id, s)
      activeIdRef.current = s.id
    }
    syncSessions(); rerender()
  }

  function addSession(kind) {
    const s = newSessionData(kind)
    sessionsMapRef.current.set(s.id, s)
    activeIdRef.current = s.id
    syncSessions(); rerender()
  }

  function activateSession(id) {
    activeIdRef.current = id
    syncSessions(); rerender()
  }

  // —— 环境变量 ——
  const currentVars = useCallback(() => envStoreRef.current.varsOf(envStoreRef.current.current), [])
  const pickEnv = (name) => {
    envStoreRef.current.pick(name)
    setEnvCurrent(envStoreRef.current.current)
    rerender()
  }

  // —— HTTP：发送（流式，逻辑与原 sendHttp/consumeChunk/finalizeHttp 等价）——
  const sendHttp = useCallback((s) => {
    const vars = currentVars()
    const urlRes = envResolve(buildUrl(s.url.trim(), s.paramsKv), vars)
    if (!urlRes.text) return
    if (urlRes.missing.length) {
      kitRef.current?.toast(`未定义环境变量：${urlRes.missing.join(', ')}`, 'error')
      return
    }
    const headers = {}
    for (const h of s.headersKv) {
      if (h.enabled !== false && h.key) headers[h.key] = envResolve(h.value ?? '', vars).text
    }
    let body
    if (s.method !== 'GET' && s.method !== 'HEAD' && s.bodyKind !== 'none') {
      body = s.bodyText
      if (s.bodyKind === 'json') body = envResolve(body, vars).text
    }
    s.httpDispose?.()
    s.httpDispose = null
    const started = performance.now()
    s.resp = { pending: true, status: 0, headers: {}, chunks: [], sseEvents: [], bytes: 0, reqId: null, early: [] }
    const response = s.resp
    s.asserts.forEach((a) => { a.result = null })
    setStatus('请求中…')
    rerender()

    const kit = kitRef.current
    const consumeChunk = (ev) => {
      if (!s.resp?.pending) return
      if (ev.error) {
        s.httpDispose?.(); s.httpDispose = null
        s.resp.pending = false
        s.resp.error = netError(ev.error)
        rerender()
        return
      }
      if (ev.done) {
        const elapsedMs = performance.now() - started
        s.httpDispose?.(); s.httpDispose = null
        s.resp.elapsedMs = elapsedMs
        s.resp.pending = false
        const bytes = new Uint8Array(s.resp.bytes ? mergeChunks(s.resp.chunks) : [])
        const text = new TextDecoder().decode(bytes)
        s.resp.bodyText = text
        try { s.resp.json = text ? JSON.parse(text) : undefined } catch { s.resp.json = undefined }
        if (s.asserts.length) {
          const results = runAssertions(s.asserts, { status: s.resp.status, elapsedMs, bodyText: text, json: s.resp.json })
          s.asserts.forEach((a, i) => { a.result = results[i] })
        }
        historyRef.current.push({ kind: 'http', method: s.method, url: s.url, status: s.resp.status, ms: Math.round(elapsedMs) })
        void persistAll()
        setStatus(`${s.method} ${s.resp.status} · ${formatMs(elapsedMs)} · ${formatBytes(s.resp.bytes)}`)
        rerender()
        return
      }
      if (s.resp.sse) {
        s.resp.sseEvents.push({ at: Date.now(), data: ev.chunk })
        s.resp.bytes += new TextEncoder().encode(ev.chunk).length
      } else {
        s.resp.chunks.push(base64ToBytes(ev.chunk))
        s.resp.bytes += (s.resp.chunks[s.resp.chunks.length - 1] || []).length
      }
      // 流式接收中节流重渲染（等价原 renderRespIncremental 200ms 合并）
      if (!s.paused) {
        if (!consumeChunk._timer) {
          consumeChunk._timer = setTimeout(() => {
            consumeChunk._timer = 0
            if (s.resp?.pending) rerender()
          }, 200)
        }
      }
    }
    const off = api?.net?.onChunk?.((ev) => {
      if (s.resp !== response) return
      if (s.resp.reqId === null) { s.resp.early.push(ev); return }
      if (ev.reqId !== s.resp.reqId) return
      consumeChunk(ev)
    })
    s.httpDispose = off
    api.net.fetch({
      url: urlRes.text,
      method: s.method,
      headers,
      body,
      stream: true,
      timeoutMs: 30000
    }).then((res) => {
      if (s.resp !== response) return
      s.resp.reqId = res.reqId
      s.resp.status = res.status
      s.resp.headers = res.headers
      s.resp.sse = (res.headers['content-type'] ?? '').includes('text/event-stream')
      const early = s.resp.early
      s.resp.early = []
      for (const ev of early) {
        if (ev.reqId === res.reqId) consumeChunk(ev)
      }
      rerender()
    }).catch((err) => {
      off?.()
      if (s.resp !== response) return
      s.httpDispose = null
      s.resp = { pending: false, error: netError(err?.message), status: 0, headers: {}, chunks: [], sseEvents: [], bytes: 0, early: [] }
      setStatus('请求失败')
      rerender()
    })
    void kit
  }, [currentVars, persistAll, rerender, setStatus])
  const sendHttpRef = useRef(sendHttp)
  sendHttpRef.current = sendHttp

  // —— TCP：连接 / 收流 / 发送 / 循环 ——
  const connectTcp = useCallback(async (s) => {
    if (!s.host || !s.port) { kitRef.current?.toast('请填写 host 与 port', 'warn'); return }
    setStatus('连接中…')
    try {
      const { socketId } = await api.net.socket.connect({ host: s.host, port: s.port, tls: s.tls, timeoutMs: s.timeoutMs })
      s.socketId = socketId
      s.rx.clear()
      setStatus(`已连接 ${s.host}:${s.port}`)
      kitRef.current?.toast('连接成功', 'success')
      const offData = api.net.onNetData((ev) => {
        if (ev.socketId !== socketId || !s.socketId) return
        s.rx.push(base64ToBytes(ev.chunk))
        s.dirty = true
        scheduleTcpRender(s)
      })
      const offClose = api.net.onNetClose((ev) => {
        if (ev.socketId !== socketId) return
        offData(); offClose()
        const wasCurrent = s.socketId === socketId
        s.socketId = null
        setStatus(`连接关闭：${netError(ev.reason)}`)
        kitRef.current?.toast(`连接已关闭（${ev.reason}）`, 'info')
        if (wasCurrent) rerender()
      })
      rerender()
    } catch (err) {
      setStatus('连接失败')
      kitRef.current?.toast(netError(err?.message), 'error')
    }
  }, [rerender, setStatus])

  const tcpTimerRef = useRef(0)
  function scheduleTcpRender(s) {
    if (tcpTimerRef.current || s.id !== activeIdRef.current) return
    tcpTimerRef.current = setTimeout(() => {
      tcpTimerRef.current = 0
      rerender()
    }, 40)
  }

  const doSend = useCallback(async (s, input) => {
    if (!input) return
    if (!s.socketId) { kitRef.current?.toast('未连接', 'warn'); return }
    try {
      const vars = currentVars()
      const resolved = envResolve(input, vars).text
      const bytes = encodeSend(resolved, s.sendKind)
      const { sent } = await api.net.socket.send(s.socketId, base64Encode(bytes))
      s.sendHistory.unshift({ kind: s.sendKind, text: input })
      if (s.sendHistory.length > 50) s.sendHistory.length = 50
      setStatus(`已发送 ${sent} B`)
      rerender()
    } catch (err) {
      kitRef.current?.toast(netError(err?.message), 'error')
    }
  }, [currentVars, rerender, setStatus])

  const stopLoopRef = useRef(stopLoop)
  stopLoopRef.current = stopLoop
  const toggleLoop = useCallback((s, iv, cnt, btnRef) => {
    if (s.loopTimer) {
      stopLoop(s)
      if (btnRef) btnRef.textContent = '循环发送'
      return
    }
    const input = duplexSendRef.current
    const text = input?.value
    if (!text) { kitRef.current?.toast('请先填写发送内容', 'warn'); return }
    const period = Math.max(50, Number(iv) || 1000)
    const total = Math.max(0, Number(cnt) || 0)
    s.loopLeft = total
    if (btnRef) btnRef.textContent = '停止'
    const tick = async () => {
      if (!s.socketId || !s.loopTimer) { stopLoop(s); if (btnRef) btnRef.textContent = '循环发送'; return }
      await doSend(s, text)
      if (total > 0) {
        s.loopLeft--
        if (s.loopLeft <= 0) { stopLoop(s); if (btnRef) btnRef.textContent = '循环发送'; return }
      }
      s.loopTimer = setTimeout(tick, period)
    }
    s.loopTimer = setTimeout(tick, period)
  }, [doSend, stopLoop])
  const duplexSendRef = useRef(null)
  const loopBtnRef = useRef(null)
  const wsSendRef = useRef(null)

  // —— WebSocket：连接 ——
  const connectWs = useCallback(async (s) => {
    const kind = wsUrlKind(s.wsUrl)
    if (kind === 'invalid') { kitRef.current?.toast('URL 需以 ws:// 或 wss:// 开头', 'warn'); return }
    const target = s.wsUrl.trim()
    try {
      s.wsPing = 0; s.wsPong = 0; s.wsFrames = []
      const { socketId } = await api.net.websocket.connect({ url: target })
      const disposers = []
      const ws = {
        readyState: 1,
        send(data) {
          let payload = data, binary = false
          if (typeof data !== 'string') {
            const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
            let encoded = ''
            for (const byte of bytes) encoded += String.fromCharCode(byte)
            payload = btoa(encoded)
            binary = true
          }
          void api.net.websocket.send(socketId, payload, binary).catch((error) => kitRef.current?.toast(error.message, 'error'))
        },
        close() {
          if (ws.readyState === 3) return
          ws.readyState = 3
          disposers.splice(0).forEach((dispose) => dispose())
          ws.onclose?.({ code: 1000 })
          void api.net.websocket.close(socketId).catch((error) => kitRef.current?.toast(error.message, 'error'))
        }
      }
      disposers.push(api.net.websocket.onMessage((event) => {
        if (event.socketId !== socketId) return
        const data = event.binary ? Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0)).buffer : event.data
        ws.onmessage?.({ data })
      }))
      disposers.push(api.net.websocket.onClose((event) => {
        if (event.socketId !== socketId) return
        ws.readyState = 3; disposers.splice(0).forEach((dispose) => dispose()); ws.onclose?.(event)
      }))
      s.ws = ws
      setStatus(`WS 已连接 ${target}`)
      ws.onclose = (ev) => {
        if (s.ws === ws) s.ws = null
        s.wsFrames.push({ dir: 'sys', at: Date.now(), text: `closed (${ev.code})` })
        setStatus('WS 已关闭')
        rerender()
      }
      ws.onerror = () => {
        kitRef.current?.toast('WS 错误：握手失败或证书无效', 'error')
      }
      ws.onmessage = (ev) => {
        if (s.wsPaused) return
        const isBin = ev.data instanceof ArrayBuffer
        const text = isBin ? `binary ${ev.data.byteLength}B\n` + formatHexDump(new Uint8Array(ev.data).subarray(0, 512)) : String(ev.data)
        s.wsFrames.push({ dir: 'in', at: Date.now(), text, bin: isBin ? new Uint8Array(ev.data) : null })
        if (s.wsFrames.length > 500) s.wsFrames.shift()
        rerender()
      }
      rerender()
    } catch (err) {
      kitRef.current?.toast(netError(err?.message), 'error')
    }
  }, [rerender, setStatus])

  // —— curl / 集合 / 对话框动作 ——
  const openCurlDialog = useCallback((s) => {
    promptDialog('导入 curl', '粘贴 curl 命令（支持 -X -H -d --data-raw -F -u -m 等）', (text) => {
      try {
        const req = parseCurl(text)
        s.method = req.method
        s.url = req.url
        s.headersKv = req.headers.map(([k, v]) => ({ key: k, value: v, enabled: true }))
        s.paramsKv = []
        s.bodyKind = req.bodyKind
        s.bodyText = req.body
        rerender()
        kitRef.current?.toast('curl 已解析', 'success')
      } catch (err) {
        kitRef.current?.toast(err.message, 'error')
      }
    }, true)
  }, [rerender])

  const exportCurl = useCallback((s) => {
    const vars = currentVars()
    const headers = s.headersKv.filter((h) => h.enabled !== false && h.key).map(([k, v] = []) => [k, envResolve(v ?? '', vars).text])
    const curl = toCurl({ method: s.method, url: envResolve(buildUrl(s.url, s.paramsKv), vars).text, headers, body: s.bodyKind !== 'none' ? s.bodyText : '' })
    void kitRef.current?.copy(curl)
  }, [currentVars])

  const saveToCollection = useCallback((s) => {
    if (!s.url) { kitRef.current?.toast('请先填写 URL', 'warn'); return }
    promptDialog('存入集合', '请求名称', (name) => {
      collectionsRef.current.add(collectionsRef.current.groups[0].id, {
        name: name || s.url, method: s.method, url: s.url,
        headersKv: structuredClone(s.headersKv), paramsKv: structuredClone(s.paramsKv),
        bodyKind: s.bodyKind, bodyText: s.bodyText
      })
      void persistAll()
      rerender()
      kitRef.current?.toast('已存入集合', 'success')
    })
  }, [persistAll, rerender])

  function collectionRequestItems(g, r) {
    return [
      { key: 'load', label: '载入到请求区', onSelect: () => loadCollectionRequest(r) },
      { key: 'copy-url', label: '复制 URL', onSelect: () => kitRef.current?.copy(r.url) },
      { sep: true },
      { key: 'delete', label: '删除请求', danger: true, onSelect: () => removeCollectionRequest(g, r) },
    ]
  }
  function collectionGroupItems(g) {
    return [
      { key: 'new', label: '新建请求', onSelect: () => newRequestInGroup(g) },
      { key: 'rename', label: '重命名分组', onSelect: () => renameGroup(g) },
      { sep: true },
      { key: 'delete', label: '删除分组', danger: true, disabled: collectionsRef.current.groups.length <= 1, onSelect: () => deleteGroup(g) },
    ]
  }
  function openCollectionMenu(source, items) {
    window.PluginKit.openMenu(source, items, (key) => {
      const action = items.find((item) => item.key === key)
      if (action && !action.disabled) void action.onSelect?.()
    }, { align: 'end' })
  }

  // —— 集合树动作（右键与可点击菜单共用目标项闭包）——
  const loadCollectionRequest = useCallback((r) => {
    let s = activeSessionOf('http')
    if (!s) s = addSessionQuiet('http')
    Object.assign(s, {
      method: r.method, url: r.url,
      headersKv: structuredClone(r.headersKv ?? []), paramsKv: structuredClone(r.paramsKv ?? []),
      bodyKind: r.bodyKind ?? 'none', bodyText: r.bodyText ?? ''
    })
    syncSessions(); rerender()
  }, [rerender]) // eslint-disable-line react-hooks/exhaustive-deps

  const removeCollectionRequest = useCallback((g, r) => {
    collectionsRef.current.remove(g.id, r.id)
    void persistAll(); rerender()
  }, [persistAll, rerender])

  const newRequestInGroup = useCallback((g) => {
    promptDialog('新建请求', '请求名称', (name) => {
      const cur = activeSessionOf('http')
      const url = cur?.url || ''
      collectionsRef.current.add(g.id, {
        name: name || url || '新请求', method: cur?.method || 'GET', url,
        headersKv: structuredClone(cur?.headersKv ?? []), paramsKv: structuredClone(cur?.paramsKv ?? []),
        bodyKind: cur?.bodyKind ?? 'none', bodyText: cur?.bodyText ?? ''
      })
      void persistAll(); rerender()
      kitRef.current?.toast('已新建请求', 'success')
    })
  }, [persistAll, rerender]) // eslint-disable-line react-hooks/exhaustive-deps

  const renameGroup = useCallback((g) => {
    promptDialog('重命名分组', g.name, (name) => {
      if (!name) return
      g.name = name
      void persistAll(); rerender()
    })
  }, [persistAll, rerender])

  const deleteGroup = useCallback((g) => {
    if (collectionsRef.current.groups.length <= 1) {
      kitRef.current?.toast('至少保留一个分组', 'warn')
      return
    }
    confirmDialog('删除分组', `删除分组「${g.name}」及其 ${g.requests.length} 个请求？`, () => {
      collectionsRef.current.removeGroup(g.id); void persistAll(); rerender()
    })
  }, [persistAll, rerender])

  /** 集合树右键：命中请求行 → 请求菜单；命中分组头 → 分组菜单；空白 → 新建分组 */
  function onTreeContextMenu(event) {
    const groups = collectionsRef.current.groups
    const itemEl = event.target.closest?.('[data-req-id]')
    const groupEl = event.target.closest?.('[data-group-id]')
    if (itemEl && groupEl) {
      const g = groups.find((x) => x.id === groupEl.dataset.groupId)
      const r = g?.requests.find((x) => x.id === itemEl.dataset.reqId)
      if (g && r) {
        event.preventDefault()
        openCollectionMenu(event, collectionRequestItems(g, r))
        return
      }
    }
    if (groupEl) {
      const g = groups.find((x) => x.id === groupEl.dataset.groupId)
      if (!g) return
      event.preventDefault()
      openCollectionMenu(event, collectionGroupItems(g))
      return
    }
    event.preventDefault()
    window.PluginKit.openMenu(event, [['new-group', '新建分组']], () => {
      promptDialog('新建分组', '分组名称', (name) => {
        if (name) { collectionsRef.current.addGroup(name); void persistAll(); rerender() }
      })
    }, { align: 'end' })
  }

  // —— 通用对话框（原生 dialog#dlg，等价原 promptDialog/confirmDialog）——
  const dlgHostRef = useRef(null)
  function promptDialog(title, desc, onSubmit, multiline = false) {
    const dlg = dlgHostRef.current
    if (!dlg) return
    const root = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'nk-dlg-head'
    const span = document.createElement('span'); span.textContent = title; head.append(span)
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.title = '关闭'; x.textContent = '✕'
    x.addEventListener('click', () => dlg.close())
    head.append(x)
    const body = document.createElement('div')
    body.className = 'nk-dlg-body'
    const note = document.createElement('div')
    note.className = 'pk-muted'
    note.textContent = desc
    const input = multiline ? document.createElement('textarea') : document.createElement('input')
    if (multiline) { input.rows = 5; input.className = 'nk-area' }
    else input.className = 'nk-input nk-mono'
    input.setAttribute('data-input-context', 'editor')
    const ok = document.createElement('button')
    ok.className = 'pk-btn pk-btn-primary'; ok.type = 'button'; ok.textContent = '确定'
    ok.addEventListener('click', () => { dlg.close(); onSubmit(input.value.trim()) })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || (e.metaKey || e.ctrlKey)) && !e.isComposing) {
        e.preventDefault(); dlg.close(); onSubmit(input.value.trim())
      }
    })
    body.append(note, input, ok)
    root.append(head, body)
    dlg.replaceChildren(root)
    dlg.showModal()
    input.focus()
  }
  function confirmDialog(title, desc, onOk) {
    const dlg = dlgHostRef.current
    if (!dlg) return
    const root = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'nk-dlg-head'
    const span = document.createElement('span'); span.textContent = title; head.append(span)
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.title = '关闭'; x.textContent = '✕'
    x.addEventListener('click', () => dlg.close())
    head.append(x)
    const body = document.createElement('div')
    body.className = 'nk-dlg-body'
    const note = document.createElement('div'); note.textContent = desc
    const row = document.createElement('div')
    row.className = 'nk-row nk-row-end'
    const cancel = document.createElement('button'); cancel.className = 'pk-btn'; cancel.type = 'button'; cancel.textContent = '取消'
    cancel.addEventListener('click', () => dlg.close())
    const ok = document.createElement('button'); ok.className = 'pk-btn pk-btn-danger'; ok.type = 'button'; ok.textContent = '删除'
    ok.addEventListener('click', () => { dlg.close(); onOk() })
    row.append(cancel, ok)
    body.append(note, row)
    root.append(head, body)
    dlg.replaceChildren(root)
    dlg.showModal()
  }

  // —— 历史面板 ——
  const openHistory = () => {
    const dlg = dlgHostRef.current
    if (!dlg) return
    const history = historyRef.current
    const root = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'nk-dlg-head'
    const span = document.createElement('span'); span.textContent = `历史（最近 ${Math.min(history.items.length, HISTORY_LIMIT)} 条）`; head.append(span)
    const clear = document.createElement('button'); clear.className = 'x pk-btn pk-btn-ghost pk-btn-sm'; clear.type = 'button'; clear.textContent = '清空'
    clear.addEventListener('click', () => { history.clear(); void persistAll(); rerender(); dlg.close() })
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.title = '关闭'; x.textContent = '✕'
    x.addEventListener('click', () => dlg.close())
    head.append(clear, x)
    const list = document.createElement('ul')
    list.className = 'nk-hist nk-dlg-body'
    if (!history.items.length) {
      const empty = document.createElement('div'); empty.className = 'nk-empty'; empty.textContent = '暂无历史'; list.append(empty)
    }
    for (const h of history.items) {
      const li = document.createElement('li')
      const m = document.createElement('span'); m.className = 'm'; m.textContent = h.method ?? '—'
      const u = document.createElement('span'); u.className = 'u'; u.textContent = h.url
      const s = document.createElement('span'); s.className = `s ${classifyStatus(h.status ?? 0)}`; s.textContent = h.status ? String(h.status) : 'ERR'
      const ms = document.createElement('span'); ms.className = 'pk-muted nk-mono'; ms.textContent = h.ms != null ? formatMs(h.ms) : ''
      li.append(m, u, s, ms)
      li.addEventListener('click', () => {
        const cur = activeSessionOf('http') ?? addSessionQuiet('http')
        cur.url = h.url
        dlg.close()
        syncSessions(); rerender()
      })
      list.append(li)
    }
    root.append(head, list)
    dlg.replaceChildren(root)
    dlg.showModal()
  }
  function addSessionQuiet(kind) {
    const s = newSessionData(kind)
    sessionsMapRef.current.set(s.id, s)
    activeIdRef.current = s.id
    return s
  }

  // —— 集合管理入口 ——
  const openSets = () => {
    const dlg = dlgHostRef.current
    if (!dlg) return
    const root = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'nk-dlg-head'
    const span = document.createElement('span'); span.textContent = '集合'; head.append(span)
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.title = '关闭'; x.textContent = '✕'
    x.addEventListener('click', () => dlg.close())
    head.append(x)
    const body = document.createElement('div')
    body.className = 'nk-dlg-body'
    for (const g of collectionsRef.current.groups) {
      const gRow = document.createElement('div')
      gRow.textContent = `${g.name}（${g.requests.length}）`
      body.append(gRow)
      for (const r of g.requests) {
        const row = document.createElement('div')
        row.className = 'nk-row'
        const m = document.createElement('span'); m.className = 'm nk-mono pk-muted'; m.textContent = r.method
        const u = document.createElement('span'); u.className = 'grow nk-mono'; u.textContent = r.url
        const del = document.createElement('button'); del.className = 'pk-btn pk-btn-danger pk-btn-sm'; del.type = 'button'; del.textContent = '删除'
        del.addEventListener('click', () => { collectionsRef.current.remove(g.id, r.id); void persistAll(); dlg.close(); rerender() })
        row.append(m, u, del)
        body.append(row)
      }
    }
    root.append(head, body)
    dlg.replaceChildren(root)
    dlg.showModal()
  }

  // —— 环境变量编辑对话框 ——
  const openEnvDialog = () => {
    const dlg = dlgHostRef.current
    if (!dlg) return
    const store = envStoreRef.current
    const root = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'nk-dlg-head'
    const span = document.createElement('span'); span.textContent = `环境变量 · ${store.current}`; head.append(span)
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.title = '关闭'; x.textContent = '✕'
    x.addEventListener('click', () => { void persistAll(); dlg.close(); rerender() })
    head.append(x)
    const body = document.createElement('div')
    body.className = 'nk-dlg-body'
    const note = document.createElement('div')
    note.className = 'pk-muted'
    note.textContent = '在 URL / Header / Body 中以 {{key}} 引用；按环境独立保存。'
    body.append(note)
    const kv = []
    for (const [k, v] of Object.entries(store.varsOf(store.current))) kv.push({ key: k, value: v, enabled: true })
    const kvBox = document.createElement('div')
    const renderKv = () => {
      kvBox.replaceChildren()
      if (!kv.length) {
        const empty = document.createElement('div'); empty.className = 'nk-empty'; empty.textContent = '暂无变量，点击下方添加'; kvBox.append(empty)
      }
      kv.forEach((pair, idx) => {
        const row = document.createElement('div'); row.className = 'nk-kv'
        const on = document.createElement('input'); on.type = 'checkbox'; on.checked = pair.enabled !== false
        on.title = on.checked ? '启用' : '禁用'
        on.addEventListener('change', () => { pair.enabled = on.checked })
        const k = document.createElement('input'); k.className = 'nk-input nk-mono'; k.placeholder = 'Key'; k.value = pair.key ?? ''
        k.setAttribute('data-input-context', 'editor')
        k.addEventListener('input', () => { pair.key = k.value })
        const v = document.createElement('input'); v.className = 'nk-input nk-mono'; v.placeholder = 'Value'; v.value = pair.value ?? ''
        v.setAttribute('data-input-context', 'editor')
        v.addEventListener('input', () => { pair.value = v.value })
        const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.title = '删除'; del.textContent = '✕'
        del.addEventListener('click', () => { kv.splice(idx, 1); renderKv() })
        row.append(on, k, v, del)
        kvBox.append(row)
      })
      const add = document.createElement('button'); add.className = 'pk-btn pk-btn-ghost pk-btn-sm nk-kv-add'; add.type = 'button'; add.textContent = '+ 添加'
      add.addEventListener('click', () => { kv.push({ key: '', value: '', enabled: true }); renderKv() })
      kvBox.append(add)
    }
    renderKv()
    body.append(kvBox)
    const save = document.createElement('button'); save.className = 'pk-btn pk-btn-primary'; save.type = 'button'; save.textContent = '保存'
    save.addEventListener('click', () => {
      const fresh = {}
      for (const p of kv) if (p.key && p.enabled !== false) fresh[p.key] = p.value ?? ''
      envStoreRef.current.vars[envStoreRef.current.current] = fresh
      envStoreRef.current.names = Object.keys(envStoreRef.current.vars)
      void persistAll()
      dlg.close()
      setEnvNames([...envStoreRef.current.names])
      setEnvVersion((v) => v + 1)
      rerender()
      kitRef.current?.toast('环境变量已保存', 'success')
    })
    body.append(save)
    root.append(head, body)
    dlg.replaceChildren(root)
    dlg.showModal()
  }

  // —— Quick 智能识别 ——
  const quickRoute = useCallback((raw) => {
    const q = String(raw ?? '').trim()
    if (!q) return
    let s = getActive()
    if (/^curl\s/i.test(q)) {
      if (s.kind !== 'http') { switchKind('http'); s = getActive() }
      try {
        const req = parseCurl(q)
        Object.assign(s, { method: req.method, url: req.url, headersKv: req.headers.map(([k, v]) => ({ key: k, value: v, enabled: true })), bodyKind: req.bodyKind, bodyText: req.body, paramsKv: [] })
        rerender()
        sendHttpRef.current(s)
        return
      } catch (err) { kitRef.current?.toast(err.message, 'error'); return }
    }
    if (/^https?:\/\//i.test(q)) {
      if (s.kind !== 'http') { switchKind('http'); s = getActive() }
      s.method = 'GET'
      s.url = q
      rerender()
      sendHttpRef.current(s)
      return
    }
    const m = /^([\w.-]+):(\d{1,5})$/.exec(q)
    if (m) {
      if (s.kind !== 'tcp') { switchKind('tcp'); s = getActive() }
      s.host = m[1]
      s.port = Number(m[2])
      rerender()
      void connectTcp(s)
      return
    }
    kitRef.current?.toast('输入 http(s):// 走 HTTP、host:port 探活、curl 开头解析发送', 'info')
  }, [connectTcp, rerender])
  const quickRouteRef = useRef(quickRoute)
  quickRouteRef.current = quickRoute

  // —— 生命周期 ——
  useEffect(() => {
    const kit = PluginKit.create({
      title: '网络调试台',
      quickPlaceholder: 'http(s)://… 即发 · host:port 探活 · curl 开头解析发送',
      height: 520
    })
    kitRef.current = kit
    modeRef.current = kit.mode
    kit.onMode((m) => { modeRef.current = m; rerender() })
    api?.onEnter?.((event) => {
      const q = String(event?.payload ?? '').trim()
      if (q) { kit.setQuery(q); quickRouteRef.current(q) }
    })
    api?.quickInput?.onAction?.((action) => {
      if (action === 'submit') {
        const value = document.querySelector('.pk-quickbar-input')?.value ?? ''
        quickRouteRef.current(value)
      }
    })
    api?.onBeforeClose?.(async () => {
      for (const s of sessionsMapRef.current.values()) {
        stopLoop(s)
        s.httpDispose?.(); s.httpDispose = null; s.resp = null
        try { s.socketId && api?.net?.socket?.close?.(s.socketId) } catch { /* 已关 */ }
        try { s.ws?.close() } catch { /* 已关 */ }
      }
      await persistAll()
    })
    let alive = true
    void (async () => {
      const kitInstance = kit
      try {
        const [envs, hist, cols, decs] = await Promise.all([
          kitInstance.load('netkit_envs', null),
          kitInstance.load('netkit_history', []),
          kitInstance.load('netkit_collections', null),
          kitInstance.load('netkit_decoders', [])
        ])
        if (!alive) return
        if (envs) Object.assign(envStoreRef.current.vars, envs)
        envStoreRef.current.names = Object.keys(envStoreRef.current.vars)
        historyRef.current.items = Array.isArray(hist) ? hist : []
        if (cols?.groups?.length) collectionsRef.current.groups = cols.groups
        if (Array.isArray(decs)) customDecodersRef.current.push(...decs.filter((d) => d?.id && typeof d?.code === 'string'))
      } catch { /* 首次运行无数据 */ }
      if (!alive) return
      setEnvNames([...envStoreRef.current.names])
      setEnvCurrent(envStoreRef.current.current)
      const s = newSessionData('http')
      sessionsMapRef.current.set(s.id, s)
      activeIdRef.current = s.id
      syncSessions()
      setStatus('就绪 · HTTP 流式 / TCP hexdump / WebSocket')
    })()
    return () => { alive = false; kit.destroy?.() }
  }, [persistAll, rerender, setStatus, stopLoop])

  // ============ 渲染（DOM 结构 / 类名与原 buildXxx 工厂一致） ============
  const active = getActive()
  const envStore = envStoreRef.current
  const collections = collectionsRef.current
  const customDecoders = customDecodersRef.current

  /** KV 键值对编辑器（等价原 buildKvEditor） */
  const renderKvEditor = (kv, onChange, emptyHint) => {
    const rows = kv.map((pair, idx) => (
      <div className="nk-kv" key={idx}>
        <input
          type="checkbox" checked={pair.enabled !== false}
          title={pair.enabled !== false ? '启用' : '禁用'}
          onChange={(e) => { pair.enabled = e.target.checked; onChange?.(); rerender() }}
        />
        <input
          className="nk-input nk-mono" placeholder="Key" value={pair.key ?? ''}
          data-input-context="editor"
          onInput={(e) => { pair.key = e.target.value; onChange?.() }}
        />
        <input
          className="nk-input nk-mono" placeholder="Value（支持 {{var}}）" value={pair.value ?? ''}
          data-input-context="editor"
          onInput={(e) => { pair.value = e.target.value; onChange?.() }}
        />
        <button className="del" type="button" title="删除" onClick={() => { kv.splice(idx, 1); rerender(); onChange?.() }}>✕</button>
      </div>
    ))
    return (
      <div>
        {!kv.length && <div className="nk-empty">{emptyHint ? `暂无${emptyHint}，点击下方添加` : '空'}</div>}
        {rows}
        <button className="pk-btn pk-btn-ghost pk-btn-sm nk-kv-add" type="button"
          onClick={() => { kv.push({ key: '', value: '', enabled: true }); rerender() }}>+ 添加</button>
      </div>
    )
  }

  /** Body 面板（等价原 buildBodyPane） */
  const renderBodyPane = (s) => {
    const kinds = [['none', '无'], ['json', 'JSON'], ['form', 'Form'], ['raw', 'Raw']]
    let errHidden = true
    let errMsg = ''
    if (s.bodyKind !== 'none' && s.bodyKind === 'json' && s.bodyText.trim()) {
      try {
        JSON.parse(envResolve(s.bodyText, currentVars()).text)
      } catch (e) {
        errMsg = 'JSON 校验失败：' + e.message
        errHidden = false
      }
    }
    return (
      <div className="nk-field">
        <div className="nk-seg">
          {kinds.map(([k, label]) => (
            <button key={k} type="button" data-k={k} className={s.bodyKind === k ? 'active' : ''}
              onClick={() => { s.bodyKind = k; rerender() }}>{label}</button>
          ))}
        </div>
        <textarea
          className="nk-area" rows={s.bodyKind === 'none' ? 1 : 6}
          placeholder={s.bodyKind === 'json' ? '{"key": "value"}（发送前自动校验）' : s.bodyKind === 'form' ? 'key=value&key2=value2' : '原始文本'}
          value={s.bodyText} data-input-context="editor" disabled={s.bodyKind === 'none'}
          onInput={(e) => { s.bodyText = e.target.value; rerender() }}
        />
        <div className="nk-error" hidden={errHidden}>{errMsg}</div>
      </div>
    )
  }

  /** 断言面板（等价原 buildAssertPane） */
  const renderAssertPane = (s) => (
    <div className="nk-asserts">
      {s.asserts.map((a, idx) => (
        <div className="nk-assert" key={idx}>
          <select className="nk-select" value={a.type} aria-label="断言类型"
            onChange={(e) => { a.type = e.target.value; rerender() }}>
            {Object.entries(ASSERT_TYPES).map(([t, meta]) => <option key={t} value={t}>{meta.label}</option>)}
          </select>
          <input className="nk-input nk-mono" placeholder="JSONPath（如 $.data.list[0].id）" value={a.target ?? ''}
            data-input-context="editor" onInput={(e) => { a.target = e.target.value }} />
          <input className="nk-input nk-mono" placeholder="期望值" value={a.expected ?? ''}
            data-input-context="editor" onInput={(e) => { a.expected = e.target.value }} />
          <span
            className={'res ' + (a.result ? (a.result.pass ? 'pass' : 'fail') : 'idle')}
            title={a.result ? `实际：${a.result.actual}` : '发送后自动执行'}
          >{a.result ? (a.result.pass ? 'pass' : 'fail') : '—'}</span>
          <button className="del" type="button" title="删除" onClick={() => { s.asserts.splice(idx, 1); rerender() }}>✕</button>
        </div>
      ))}
      <button className="pk-btn pk-btn-ghost pk-btn-sm" type="button"
        onClick={() => { s.asserts.push({ type: 'statusEq', target: '', expected: '200' }); rerender() }}>+ 添加断言</button>
    </div>
  )

  /** HTTP 构建卡（等价原 buildHttpBuilder；原版 preview 节点为游离 DOM 未挂载，不渲染） */
  const renderHttpBuilder = (s) => {
    const curTab = s.__subTab ?? 'params'
    const tabs = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['asserts', '断言']]
    return (
      <div className="nk-col">
        <div className="nk-card">
          <div className="nk-card-head">
            <span>请求构建</span>
            <span className="nk-spacer"></span>
            <MoreMenu
              ariaLabel="请求构建更多操作"
              items={[
                { key: 'curl-in', label: 'curl 导入', onSelect: () => openCurlDialog(s) },
                { key: 'curl-out', label: '导出 curl', onSelect: () => exportCurl(s) },
                { key: 'save', label: '存入集合', onSelect: () => saveToCollection(s) },
              ]}
            />
          </div>
          <div className="nk-card-body">
            <div className="nk-row">
              <select className="nk-select" aria-label="请求方法" value={s.method}
                onChange={(e) => { s.method = e.target.value; rerender() }}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="nk-input nk-mono grow" placeholder="https://api.example.com/path 或 {{host}}/path"
                value={s.url} data-input-context="editor"
                onInput={(e) => { s.url = e.target.value }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendHttpRef.current(s) } }}
              />
              <button className="pk-btn pk-btn-primary" type="button" onClick={() => sendHttpRef.current(s)}>发送</button>
            </div>
            <div className="nk-seg nk-seg-gap">
              {tabs.map(([t, label]) => (
                <button key={t} type="button" data-t={t} className={t === curTab ? 'active' : ''}
                  onClick={() => { s.__subTab = t; rerender() }}>{label}</button>
              ))}
            </div>
            <div>
              {curTab === 'params' && renderKvEditor(s.paramsKv, () => rerender(), '查询参数')}
              {curTab === 'headers' && renderKvEditor(s.headersKv, null, '请求头')}
              {curTab === 'body' && renderBodyPane(s)}
              {curTab === 'asserts' && renderAssertPane(s)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  /** 可折叠 JSON 树（等价原 buildJsonTree） */
  const renderJsonTree = (value) => {
    const rows = flattenJson(value, { maxDepth: 8, maxNodes: 4000 })
    const collapsed = renderJsonTree._collapsed ?? (renderJsonTree._collapsed = new Set())
    const out = []
    let hideDepth = null
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (hideDepth !== null && row.depth > hideDepth) continue
      hideDepth = null
      if (row.expandable) {
        out.push(
          <div className="nk-json-row" key={i} style={{ '--depth': String(row.depth) }}>
            <button className="nk-json-caret" type="button"
              onClick={() => {
                collapsed.has(row.path) ? collapsed.delete(row.path) : collapsed.add(row.path)
                rerender()
              }}>{collapsed.has(row.path) ? '▶' : '▼'}</button>
            <span className="nk-json-key">{row.key}: </span>
            <span className="nk-json-preview">{row.preview}</span>
          </div>
        )
        if (collapsed.has(row.path)) hideDepth = row.depth
      } else {
        const t = row.type === 'number' ? 't-num' : row.type === 'boolean' ? 't-bool' : row.type === 'null' ? 't-null' : 't-str'
        out.push(
          <div className="nk-json-row" key={i} style={{ '--depth': String(row.depth) }}>
            <span className="nk-json-caret"> </span>
            {row.key !== '$' && <span className="nk-json-key">{row.key}: </span>}
            <span className={`nk-json-val ${t}`}>{row.preview}</span>
          </div>
        )
      }
    }
    return <div className="nk-json">{out}</div>
  }

  /** 响应视图主体（等价原 renderRespView） */
  const renderRespView = (s) => {
    const r = s.resp
    if (s.respView === 'img') {
      const bytes = mergeChunks(r.chunks)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return <img className="nk-img-preview" alt="响应图片" src={`data:${r.headers['content-type'] ?? 'image/png'};base64,${btoa(bin)}`} />
    }
    if (s.respView === 'hex') {
      const total = r.chunks.reduce((n, c) => n + c.length, 0)
      const cap = RESP_PAGE * respPage
      const slice = mergeChunks(r.chunks).subarray(0, Math.min(total, cap))
      return (
        <>
          <pre className="nk-viewer nk-viewer-plain">{formatHexDump(slice)}</pre>
          {total > cap && (
            <button className="pk-btn pk-btn-sm" type="button"
              onClick={() => { setRespPage((p) => p + 1); rerender() }}>
              {`加载更多（已截取 ${formatBytes(cap)} / ${formatBytes(total)}）`}
            </button>
          )}
        </>
      )
    }
    const text = r.bodyText ?? new TextDecoder().decode(mergeChunks(r.chunks))
    if (s.respView === 'pretty' && r.json !== undefined) {
      return renderJsonTree(r.json)
    }
    if (s.respView === 'html') {
      const pv = htmlPreview(text)
      if (pv.hasTable) {
        return (
          <table className="pk-table">
            <tbody>
              {pv.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )
      }
      return pv.title || pv.heads.join(' · ') || text.slice(0, 2000)
    }
    return text.length > 512 * 1024 ? text.slice(0, 512 * 1024) + '\n…（已截断，可保存查看全部）' : text
  }

  /** HTTP 响应列（等价原 buildHttpRespCol） */
  const renderHttpRespCol = (s) => {
    const r = s.resp
    const card = (children) => (
      <div className="nk-col">
        <div className="nk-card">{children}</div>
      </div>
    )
    if (!r) {
      return card(
        <>
          <div className="nk-card-head"><span>响应</span></div>
          <div className="nk-card-body nk-empty">发送请求后在此查看响应{'\n'}支持流式渲染 · SSE 逐事件 · 断言自动执行</div>
        </>
      )
    }
    if (r.error) {
      return card(
        <>
          <div className="nk-card-head"><span>响应</span></div>
          <div className="nk-error">{r.error}</div>
        </>
      )
    }
    const cls = classifyStatus(r.status)
    const ct = (r.headers['content-type'] ?? '')
    const isImg = ct.startsWith('image/')
    const views = isImg
      ? [['img', '图片'], ['hex', 'Hex']]
      : r.json !== undefined
        ? [['pretty', 'JSON'], ['raw', '文本'], ['html', 'HTML'], ['hex', 'Hex']]
        : ct.includes('html')
          ? [['html', 'HTML'], ['raw', '文本'], ['hex', 'Hex']]
          : [['raw', '文本'], ['hex', 'Hex']]
    if (!views.some(([k]) => k === s.respView)) s.respView = views[0][0]
    return card(
      <>
        <div className="nk-card-head">
          <div className="nk-badges">
            <span className={`nk-badge ${cls}`}>{r.pending ? '…' : `${r.status || '—'}`}</span>
            {r.sse && <span className="nk-badge accent">SSE</span>}
            {r.pending
              ? <span className="nk-badge neutral">接收中</span>
              : r.elapsedMs != null && <span className="nk-badge neutral">{formatMs(r.elapsedMs)}</span>}
            <span className="nk-badge neutral">{formatBytes(r.bytes ?? 0)}</span>
          </div>
          <span className="nk-spacer"></span>
          {r.pending && r.sse && (
            <button className="pk-btn pk-btn-ghost pk-btn-sm" type="button"
              onClick={() => { s.paused = !s.paused; rerender() }}>{s.paused ? '继续' : '暂停'}</button>
          )}
          {!r.pending && r.bodyText != null && (
            <MoreMenu
              buttonClassName="pk-btn-sm"
              ariaLabel="响应更多操作"
              items={[
                { key: 'copy', label: '复制响应', onSelect: () => void kitRef.current?.copy(r.bodyText) },
                { key: 'save', label: '保存为文件', onSelect: () => void kitRef.current?.saveText('response.txt', r.bodyText) },
              ]}
            />
          )}
        </div>
        <div className="nk-card-body">
          {r.pending && !r.sse && !r.chunks.length ? (
            <>
              <div className="nk-skeleton nk-skeleton-line"></div>
              <div className="nk-skeleton nk-skeleton-line"></div>
              <div className="nk-skeleton nk-skeleton-line"></div>
            </>
          ) : r.sse ? (
            <div className="nk-sse">
              {r.sseEvents.map((ev, i) => (
                <div className="nk-sse-item" key={i}>
                  <div className="t">{fmtTime(ev.at)}</div>
                  <div className="d">{ev.data}</div>
                </div>
              ))}
              {!r.sseEvents.length && r.pending && <div className="nk-empty">等待事件…</div>}
            </div>
          ) : (
            <>
              <div className="nk-seg">
                {views.map(([k, label]) => (
                  <button key={k} type="button" className={s.respView === k ? 'active' : ''}
                    onClick={() => { s.respView = k; rerender() }}>{label}</button>
                ))}
              </div>
              <div className="nk-viewer nk-viewer-gap">{renderRespView(s)}</div>
            </>
          )}
        </div>
      </>
    )
  }

  /** 集合树列（等价原 buildTreeCol；分组/请求右键菜单替代原 confirm-only） */
  const renderTreeCol = () => (
    <div className="nk-col nk-col-tree">
      <div className="nk-card">
        <div className="nk-card-head">
          <span>集合</span>
          <button className="pk-btn pk-btn-ghost pk-btn-sm" type="button"
            onClick={() => promptDialog('新建分组', '分组名称', (name) => {
              if (name) { collections.addGroup(name); void persistAll(); rerender() }
            })}>+ 分组</button>
        </div>
        <div className="nk-tree nk-card-body" onContextMenu={onTreeContextMenu}>
          {!collections.groups.length && (
            <div className="nk-tree-empty">{'暂无集合\n在请求区点击「存入集合」保存常用请求'}</div>
          )}
          {collections.groups.map((g) => (
            <div className="nk-tree-group" key={g.id} data-group-id={g.id}>
              <div className="nk-tree-group-head" data-row-actions>
                <button className="nk-tree-head" type="button" aria-expanded={!treeCollapsed.has(g.id)}
                  onClick={() => {
                    const next = new Set(treeCollapsed)
                    next.has(g.id) ? next.delete(g.id) : next.add(g.id)
                    setTreeCollapsed(next)
                  }}>
                  <span className="caret">{treeCollapsed.has(g.id) ? '▶' : '▼'}</span>
                  <span>{g.name}</span>
                  <span className="pk-muted"> {g.requests.length}</span>
                </button>
                <span className="pk-row-actions">
                  <MoreMenu buttonClassName="pk-btn-sm" ariaLabel={g.name + ' 分组操作'} items={collectionGroupItems(g)} />
                </span>
              </div>
              {!treeCollapsed.has(g.id) && g.requests.map((r) => (
                <div className="nk-tree-item" key={r.id} title={`${r.method} ${r.url}`} data-row-actions data-req-id={r.id}>
                  <button className="nk-tree-load" type="button" onClick={() => loadCollectionRequest(r)}>
                    <span className="m nk-mono">{r.method}</span>
                    <span className="nk-tree-url">{r.url}</span>
                  </button>
                  <span className="pk-row-actions nk-tree-actions">
                    <MoreMenu buttonClassName="pk-btn-sm" ariaLabel={(r.name || r.url || '请求') + ' 的更多操作'} items={collectionRequestItems(g, r)} />
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  /** TCP 面板（等价原 buildTcpPanel + buildDuplex + renderDuplexStream） */
  const renderTcpPanel = (s) => {
    const viewIds = [...BUILTIN_DECODERS.map((d) => [d.id, d.label.split('（')[0].split(' · ')[0]]), ...customDecoders.map((c) => [c.id, c.name])]
    if (!viewIds.some(([id]) => id === s.decoderId)) s.decoderId = 'hexdump'
    const bytes = s.rx.snapshot()
    let streamOut
    try {
      streamOut = s.decoderId === 'hexdump'
        ? formatHexDump(bytes)
        : applyDecoder(s.decoderId, bytes, customDecoders, { regexPattern: s.regexPattern })
    } catch (err) {
      streamOut = null
      var decodeError = `解码失败（策略 ${s.decoderId}）：${err.message}`
    }
    return (
      <div className="nk-col">
        <div className="nk-card">
          <div className="nk-card-head">
            <span>TCP</span>
            <input className="nk-input nk-mono nk-input-narrow" placeholder="host" value={s.host}
              data-input-context="editor" onInput={(e) => { s.host = e.target.value }} />
            <input className="nk-input nk-mono nk-input-xs" type="number" placeholder="port" value={s.port}
              data-input-context="editor" onInput={(e) => { s.port = Number(e.target.value) || 0 }} />
            <label className="nk-check">
              <input type="checkbox" checked={s.tls} onChange={(e) => { s.tls = e.target.checked; rerender() }} />TLS
            </label>
            <input className="nk-input nk-mono nk-input-xs" type="number" value={s.timeoutMs} title="连接超时（ms）"
              data-input-context="editor" onInput={(e) => { s.timeoutMs = Number(e.target.value) || 10000 }} />
            <button className="pk-btn pk-btn-primary" type="button" disabled={!!s.socketId} onClick={() => void connectTcp(s)}>
              {s.socketId ? '已连接' : '连接'}
            </button>
            <button className="pk-btn pk-btn-danger" type="button" disabled={!s.socketId}
              onClick={() => { try { api.net.socket.close(s.socketId) } catch { /* 已关 */ } }}>断开</button>
            {s.rx.dropped > 0 && <span className="nk-badge warn">{`环形丢弃 ${formatBytes(s.rx.dropped)}`}</span>}
          </div>
          <div className="nk-card-body nk-card-body-flush">
            {!s.socketId && !s.rx.length ? (
              <div className="nk-empty nk-empty-flush"
                dangerouslySetInnerHTML={{ __html: '尚未连接<br>连接后接收区默认以 Hex Dump 渲染<br>支持长度前缀 / 分隔符帧 / 正则 / 自定义 JS 解码器' }} />
            ) : (
              <div className="nk-duplex">
                <div className="nk-duplex-top">
                  <div className="nk-card-head">
                    <div className="nk-seg">
                      {viewIds.map(([id, label]) => (
                        <button key={id} type="button" data-v={id} title={BUILTIN_DECODERS.find((d) => d.id === id)?.label ?? `自定义：${label}`}
                          className={s.decoderId === id ? 'active' : ''}
                          onClick={() => { s.decoderId = id; rerender() }}>{label}</button>
                      ))}
                    </div>
                    <span className="nk-spacer"></span>
                    {s.decoderId === 'regex' && (
                      <input className="nk-input nk-mono nk-input-sm" placeholder={'正则（如 GET \\S+）'} value={s.regexPattern}
                        data-input-context="editor" onInput={(e) => { s.regexPattern = e.target.value; rerender() }} />
                    )}
                    <label className="nk-check">
                      <input type="checkbox" checked={s.showTimestamp}
                        onChange={(e) => { s.showTimestamp = e.target.checked; rerender() }} />时间戳
                    </label>
                    <button className="pk-btn pk-btn-ghost pk-btn-sm" type="button" onClick={() => { s.rx.clear(); rerender() }}>清空</button>
                  </div>
                  <div className="nk-stream">
                    <div className="nk-viewer nk-viewer-plain">
                      {decodeError ? (
                        <div className="nk-error">{decodeError}</div>
                      ) : s.rx.dropped ? (
                        <>
                          <div className="nk-error">{`缓冲超 4MB，已丢弃最旧 ${formatBytes(s.rx.dropped)} 数据`}</div>
                          {s.decoderId === 'hexdump' && s.showTimestamp ? (
                            <span className="nk-hexline"><span className="hx-time">{fmtTime(Date.now()) + ' '}</span><span className="hx-byte">{streamOut}</span></span>
                          ) : streamOut}
                        </>
                      ) : s.decoderId === 'hexdump' && s.showTimestamp ? (
                        <span className="nk-hexline"><span className="hx-time">{fmtTime(Date.now()) + ' '}</span><span className="hx-byte">{streamOut}</span></span>
                      ) : streamOut}
                    </div>
                  </div>
                </div>
                <div className="nk-duplex-bottom">
                  <div className="nk-row">
                    <select className="nk-select" value={s.sendKind} aria-label="发送编码"
                      onChange={(e) => { s.sendKind = e.target.value; rerender() }}>
                      {SEND_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </select>
                    <input ref={duplexSendRef} className="nk-input nk-mono grow"
                      placeholder={'发送内容（hex 用空格分隔；\\n \\t \\x41 转义可用）'}
                      data-input-context="editor"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.isComposing) {
                          e.preventDefault()
                          void doSend(s, e.target.value)
                          e.target.select()
                        }
                      }}
                    />
                    <button className="pk-btn pk-btn-primary" type="button" onClick={() => void doSend(s, duplexSendRef.current?.value ?? '')}>发送</button>
                  </div>
                  <div className="nk-loop pk-muted">
                    <span>循环：</span>
                    <input className="nk-input nk-mono" type="number" defaultValue={s.loopIv ?? 1000} min={50} title="间隔（ms）"
                      onInput={(e) => { s.loopIv = e.target.value }} />
                    <span>ms ×</span>
                    <input className="nk-input nk-mono" type="number" defaultValue={s.loopCnt ?? 10} min={0} title="次数（0 = 无限）"
                      onInput={(e) => { s.loopCnt = e.target.value }} />
                    <button ref={loopBtnRef} className="pk-btn" type="button"
                      onClick={() => toggleLoop(s, s.loopIv, s.loopCnt, loopBtnRef.current)}>循环发送</button>
                    <select className="nk-select" aria-label="发送历史" defaultValue=""
                      onChange={(e) => {
                        if (!e.target.value) return
                        const hit = s.sendHistory.find((h) => h.text === e.target.value)
                        if (hit) { s.sendKind = hit.kind; if (duplexSendRef.current) duplexSendRef.current.value = hit.text; rerender() }
                      }}>
                      <option value="">发送历史</option>
                      {s.sendHistory.slice(0, 20).map((h, i) => (
                        <option key={i} value={h.text}>{`${h.kind}: ${h.text.slice(0, 24)}`}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  /** WS 面板（等价原 buildWsPanel + buildWsFrames + renderWsFeed） */
  const renderWsPanel = (s) => {
    return (
      <div className="nk-col">
        <div className="nk-card">
          <div className="nk-card-head">
            <span>WS</span>
            <input className="nk-input nk-mono grow" placeholder="wss://host/path（ws:// 明文走宿主桥）"
              value={s.wsUrl} data-input-context="editor" onInput={(e) => { s.wsUrl = e.target.value }} />
            <button className="pk-btn pk-btn-primary" type="button" onClick={() => void connectWs(s)}>{s.ws ? '已连接' : '连接'}</button>
            <button className="pk-btn pk-btn-danger" type="button" disabled={!s.ws}
              onClick={() => { try { s.ws?.close() } catch { /* 已关 */ } }}>断开</button>
            <span className="nk-badge neutral">{`ping ${s.wsPing} / pong ${s.wsPong}`}</span>
          </div>
          <div className="nk-card-body nk-card-body-flush-col">
            {!s.ws && !s.wsFrames.length ? (
              <div className="nk-empty">{'尚未连接\nWebSocket 连接通过宿主权限与代理；明文连接需显式授权'}</div>
            ) : (
              <div className="nk-ws-body">
                <div className="nk-card-head">
                  <div className="nk-seg">
                    {['text', 'hex'].map((k) => (
                      <button key={k} type="button" className={s.wsView === k ? 'active' : ''}
                        onClick={() => { s.wsView = k; rerender() }}>{k === 'text' ? 'Text' : 'Hex'}</button>
                    ))}
                  </div>
                  <span className="nk-spacer"></span>
                  <button className="pk-btn pk-btn-ghost pk-btn-sm" type="button"
                    onClick={() => { s.wsPaused = !s.wsPaused; rerender() }}>{s.wsPaused ? '继续' : '暂停'}</button>
                  <button className="pk-btn pk-btn-ghost pk-btn-sm" type="button" onClick={() => { s.wsFrames = []; rerender() }}>清空</button>
                </div>
                <div className="nk-sse nk-sse-fill">
                  {s.wsFrames.slice(-200).map((f, i) => {
                    const dirLabel = f.dir === 'in' ? '↓ 收' : f.dir === 'out' ? '↑ 发' : '· '
                    const cls = f.dir === 'in' ? 'ok' : f.dir === 'out' ? 'accent' : 'neutral'
                    return (
                      <div className={`nk-sse-item ${cls}`} key={i}>
                        <div className="t">{`${fmtTime(f.at)} ${dirLabel}`}</div>
                        <div className={`d${f.dir === 'out' ? ' out' : ''}`}>{f.text}</div>
                      </div>
                    )
                  })}
                </div>
                <div className="nk-row nk-ws-send">
                  <input ref={wsSendRef} className="nk-input nk-mono grow" placeholder="发送文本（hex 视图下按 hex 字面发送）"
                    data-input-context="editor"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.isComposing) {
                        e.preventDefault()
                        e.target.nextElementSibling?.click()
                      }
                    }}
                  />
                  <button className="pk-btn pk-btn-primary" type="button"
                    onClick={() => {
                      const input = wsSendRef.current
                      if (!s.ws || s.ws.readyState !== 1) { kitRef.current?.toast('未连接', 'warn'); return }
                      const text = input.value
                      if (!text) return
                      if (s.wsView === 'hex') {
                        try {
                          const bytes = encodeSend(text, 'hex')
                          s.ws.send(bytes)
                          s.wsFrames.push({ dir: 'out', at: Date.now(), text: `[hex] ${text}` })
                        } catch (err) { kitRef.current?.toast(err.message, 'error'); return }
                      } else {
                        s.ws.send(text)
                        s.wsFrames.push({ dir: 'out', at: Date.now(), text })
                      }
                      input.value = ''
                      rerender()
                    }}>发送</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // mode 镜像到 <html data-mode>（kit 已负责），body 布局类名与原一致
  const bodyClass = modeRef.current === 'shell' ? 'nk-split' : 'nk-single'
  return (
    <main className="nk" id="app" data-tick={tick}>
      {/* 顶栏：模式切换 + 环境 + 会话 Tab */}
      <header className="nk-top">
        <h1 className="nk-logo">网络调试台</h1>
        <nav className="nk-modes" id="modes" aria-label="模式">
          {MODES.map(([kind, label]) => (
            <button key={kind} type="button" data-kind={kind} className={active?.kind === kind ? 'active' : ''}
              onClick={() => switchKind(kind)}>{label}</button>
          ))}
        </nav>
        <div className="nk-env shell-only" id="env-box">
          <select id="env-select" aria-label="环境" value={envCurrent}
            onChange={(e) => pickEnv(e.target.value)}>
            {envNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="nk-spacer"></div>
        <MoreMenu
          buttonClassName="shell-only"
          ariaLabel="更多操作"
          items={[
            { key: 'history', label: '请求历史', onSelect: openHistory },
            { key: 'sets', label: '集合管理', onSelect: openSets },
            { key: 'env', label: '编辑环境变量', onSelect: openEnvDialog },
          ]}
        />
      </header>

      {/* 会话 Tab（桌面多会话；Quick 单会话） */}
      <div className="nk-tabs shell-only" id="tabs" role="tablist">
        {sessions.map((s) => (
          <div key={s.id} className={'nk-tab' + (s.id === activeId ? ' active' : '')}>
            <button type="button" role="tab" className="nk-tab-select" aria-selected={s.id === activeId}
              onClick={() => activateSession(s.id)}>{s.name}</button>
            <button className="nk-tab-x" type="button" title="关闭会话" aria-label={'关闭 ' + s.name + ' 会话'}
              onClick={() => closeSession(s.id)}>✕</button>
          </div>
        ))}
        <button className="nk-tab-add" type="button" onClick={() => addSession('http')}>+ 新会话</button>
      </div>

      {/* 内容区 */}
      <section className={`nk-body ${bodyClass}`} id="body">
        {active && modeRef.current === 'shell' && active.kind === 'http' && (
          <>
            {renderTreeCol()}
            {renderHttpBuilder(active)}
            {renderHttpRespCol(active)}
          </>
        )}
        {active && modeRef.current === 'shell' && active.kind === 'tcp' && (
          <>
            {renderTreeCol()}
            <div className="nk-col nk-session">{renderTcpPanel(active)}</div>
          </>
        )}
        {active && modeRef.current === 'shell' && active.kind === 'ws' && (
          <>
            {renderTreeCol()}
            <div className="nk-col nk-session">{renderWsPanel(active)}</div>
          </>
        )}
        {active && modeRef.current === 'quick' && (
          <div className={`nk-col${active.kind === 'http' ? ' nk-quick-http' : ''}`}>
            {active.kind === 'http' ? <>{renderHttpBuilder(active)}{renderHttpRespCol(active)}</> : active.kind === 'tcp' ? renderTcpPanel(active) : renderWsPanel(active)}
          </div>
        )}
      </section>

      <footer className="nk-foot">
        <span id="foot-status">{foot}</span>
        <span className="nk-foot-hint">出站连接由宿主代理 · 单插件 8 并发 · 收流 4MB 环形缓冲</span>
      </footer>

      {/* 通用浮层宿主（原 index.html body 直挂 dialog#dlg） */}
      <dialog id="dlg" ref={(node) => { dlgHostRef.current = node; dlgRef.current = node }}></dialog>
    </main>
  )
}
