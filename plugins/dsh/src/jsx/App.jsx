import { useCallback, useEffect, useRef, useState } from 'react'
import '@dsh/js/api.js'
import '@dsh/js/state.js'
import { Button } from '@dsh/ui/index.jsx'
import { SettingsView } from './SettingsView.jsx'
import { KernelSetupDialog } from './KernelSetupDialog.jsx'
import { IconGear, IconExternal, IconRestart, IconPlus, IconPower } from './icons.jsx'

const api = window.enest || window.zapi
const errorText = (error) => String(error?.message || error)

function pickText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(pickText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (value.content) return pickText(value.content)
    if (typeof value.summary === 'string') return value.summary
  }
  return ''
}

function renderEvent(event, index) {
  if (!event || typeof event !== 'object') return null
  const type = String(event.type ?? event.kind ?? '')
  const timestamp = event.timestamp || event.ts || event.time
  const meta = timestamp ? new Date(Number(timestamp) || timestamp).toTimeString().slice(0, 8) : type
  let body
  let className = 'evt'
  if (type === 'user/message') {
    className += ' evt-user'
    body = pickText(event.message ?? event).slice(0, 600)
  } else if (type === 'assistant/message') {
    body = pickText(event.message ?? event).slice(0, 1200)
  } else if (type === 'tool/call' || type === 'tool/result') {
    const name = String(event.name || event.tool || event.toolName || 'tool')
    const result = type === 'tool/result' ? event.ok === false || event.error != null ? ' 失败' : ' 完成' : ''
    body = <span className="tool-line">{name}{result}</span>
  } else if (type === 'turn/start' || type === 'turn/end') {
    body = <span className="tool-line">{type === 'turn/start' ? '开始处理' : '处理结束'}</span>
  } else if (!type || type === 'step/start' || type === 'step/end') {
    return null
  } else {
    body = <span className="tool-line">{type}</span>
  }
  return (
    <div key={index} className={className}>
      <span className="evt-meta">{meta}</span>
      <div className="evt-body">{body || '…'}</div>
    </div>
  )
}

function CockpitView({ state, onGoSettings, onGoShell, onNewSession, onPickSession, onSend }) {
  const running = Object.values(state.liveStatus).filter((status) => status === 'running').length
  const inputRef = useRef(null)
  const activityRef = useRef(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const activity = activityRef.current
    if (activity) activity.scrollTop = activity.scrollHeight
  }, [state.events, state.sdkError])

  const send = async () => {
    if (sending || !inputRef.current?.value.trim()) return
    setSending(true)
    try { await onSend(inputRef.current) } finally { setSending(false) }
  }

  return (
    <div className="cockpit dsh-enter">
      <header className="cockpit-head">
        <span className={`dot${running ? ' dot-run' : state.runtime?.available ? ' dot-ok' : ' dot-err'}`} />
        <span className="cockpit-title">DSH 驾驶舱</span>
        <span className="cockpit-sub">{running ? `${running} 个会话运行中` : state.runtime?.version ? `v${state.runtime.version}` : ''}</span>
        <span className="dsh-spacer" />
        <button className="icon-btn" title="新快速会话" aria-label="新快速会话" onClick={onNewSession}><IconPlus /></button>
        <button className="icon-btn" title="打开完全体" aria-label="打开完全体" onClick={onGoShell}><IconExternal /></button>
        <button className="icon-btn" title="管理中心" aria-label="管理中心" onClick={onGoSettings}><IconGear /></button>
      </header>
      <div className="sessions" aria-label="会话列表">
        {state.sessions.length ? state.sessions.map((session) => (
          <button
            key={session.sessionId}
            className={`session-chip${session.sessionId === state.currentSessionId ? ' active' : ''}`}
            aria-pressed={session.sessionId === state.currentSessionId}
            onClick={() => onPickSession(session.sessionId)}
          >
            <span className={`dot${state.liveStatus[session.sessionId] === 'running' ? ' dot-run' : ''}`} />
            <span className="chip-title">{session.title || session.sessionId}</span>
          </button>
        )) : <span className="evt-empty">暂无会话，可在下方开始快速对话。</span>}
      </div>
      <main className="activity" ref={activityRef}>
        {state.events.length ? state.events.map(renderEvent) : <p className="evt-empty">选择会话查看进度，或直接发起快速对话。</p>}
        {state.sdkError && (
          <div className="dsh-error" role="alert">
            <p>{state.sdkError}</p>
            <Button size="sm" onClick={onGoSettings}>管理运行环境</Button>
          </div>
        )}
      </main>
      <footer className="composer">
        <div className="composer-row">
          <textarea
            id="composer-input" ref={inputRef} aria-label="快速对话内容"
            placeholder="快速对话，Enter 发送，Shift+Enter 换行" rows={1}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            onInput={() => {
              const input = inputRef.current
              if (!input) return
              input.style.height = 'auto'
              input.style.height = `${Math.min(120, input.scrollHeight)}px`
            }}
          />
          <Button variant="primary" disabled={sending} onClick={() => void send()}>{sending ? '发送中' : '发送'}</Button>
        </div>
        <div className="composer-hint">{state.prefs.provider} / {state.prefs.model}</div>
      </footer>
    </div>
  )
}

function ShellView({ state, onGoSettings, autoStartRef, kernelGuide }) {
  const web = state.status?.web
  const ready = Boolean(web?.running && web?.readyUrl)
  const [pending, setPending] = useState('')
  const run = async (action, operation) => {
    if (pending) return
    setPending(action)
    try { await operation() } catch (error) { window.DshApi.notice(errorText(error), 'error') } finally { setPending('') }
  }

  useEffect(() => {
    if (!state.ready || !autoStartRef.current) return
    autoStartRef.current = false
    // The first-run kernel guide owns the install flow; auto-start only once a runtime exists.
    if (kernelGuide) return
    if (state.runtime?.available) void run('start', () => window.DshState.ensureWeb())
  }, [state.ready, kernelGuide]) // eslint-disable-line react-hooks/exhaustive-deps

  const error = web?.lastError || state.webTail || state.statusError
  const booting = Boolean(state.webBooting || pending === 'start' || pending === 'restart')
  return (
    <div className="dsh-shell dsh-enter">
      <header className="shellbar">
        <span className={`dot${ready ? ' dot-ok' : booting ? ' dot-run' : error ? ' dot-err' : ''}`} />
        <span>DSH 完全体</span>
        <span className="port">{web?.running && web?.port ? `127.0.0.1:${web.port}` : booting ? '启动中' : '已停止'}{web?.profile ? ` / ${web.profile}` : ''}</span>
        <span className="sep" />
        <button
          className="icon-btn" title={web?.running ? '停止服务' : '启动服务'} aria-label={web?.running ? '停止服务' : '启动服务'} disabled={Boolean(pending)}
          onClick={() => void run(web?.running ? 'stop' : 'start', () => web?.running ? window.DshState.stopWeb() : window.DshState.ensureWeb())}
        ><IconPower /></button>
        <button className="icon-btn" title="重启服务" aria-label="重启服务" disabled={Boolean(pending)} onClick={() => void run('restart', () => window.DshState.restartWeb())}><IconRestart /></button>
        <button className="icon-btn" title="在浏览器打开" aria-label="在浏览器打开" disabled={!ready} onClick={() => void window.DshApi.openExternal(web.readyUrl)}><IconExternal /></button>
        <button className="icon-btn" title="管理中心" aria-label="管理中心" onClick={onGoSettings}><IconGear /></button>
      </header>
      {ready ? <iframe className="web-frame" title="DeepSeek Harness Web UI" src={web.readyUrl} allow="clipboard-read; clipboard-write" /> : (
        <main className="guide">
          <section className="guide-card" aria-live="polite">
            <h1 className="guide-title">{!state.ready ? '正在检测 DSH 内核' : !state.runtime?.available ? '尚未找到可用内核' : booting ? '正在启动 DSH' : error ? 'DSH 启动未完成' : 'DSH 已停止'}</h1>
            <p className="guide-text">{!state.runtime?.available ? '进入管理中心，检查内核安装与版本选择。' : booting ? '正在等待本地服务就绪，首次启动可能需要初始化 Profile。' : '启动将使用管理中心选择的 Profile。首选端口被占用时会自动换口。'}</p>
            {error && <pre className="guide-log dsh-error-text">{String(error).slice(-1600)}</pre>}
            <div className="guide-actions">
              <Button variant="primary" disabled={!state.ready || !state.runtime?.available || Boolean(pending) || state.webBooting} onClick={() => void run(error ? 'restart' : 'start', () => error ? window.DshState.restartWeb() : window.DshState.ensureWeb())}>{booting ? '启动中' : error ? '重新启动' : '启动服务'}</Button>
              <Button onClick={onGoSettings}>管理中心</Button>
            </div>
          </section>
        </main>
      )}
    </div>
  )
}

export function App() {
  const initialCode = api.getEnterCode?.()
  const [route, setRoute] = useState(initialCode === 'manage' ? 'settings' : 'main')
  const [mode, setMode] = useState(api.getLaunchMode?.() || 'shell')
  const [kernelGuide, setKernelGuide] = useState(false)
  const [, setRevision] = useState(0)
  const kitRef = useRef(null)
  const routeRef = useRef(route)
  const autoStartRef = useRef(initialCode !== 'manage')
  const inputSendingRef = useRef(false)
  routeRef.current = route
  const state = window.DshState.state

  const sendComposer = useCallback(async (input) => {
    const text = input?.value?.trim()
    if (!text || inputSendingRef.current) return
    inputSendingRef.current = true
    try {
      await window.DshState.sendPrompt(text)
      if (input.value.trim() === text) {
        input.value = ''
        input.style.height = 'auto'
      }
    } catch (error) {
      window.DshApi.notice(`发送失败：${errorText(error)}`, 'error')
    } finally {
      inputSendingRef.current = false
    }
  }, [])

  useEffect(() => {
    const kit = window.PluginKit.create({
      title: 'DSH 驾驶舱',
      quickPlaceholder: '快速对话，Enter 发送',
      height: 560,
      onQuery: (value) => {
        const input = document.getElementById('composer-input')
        if (input) {
          input.value = String(value ?? '').slice(0, 4000)
          if (value) input.focus()
        }
      },
      onAction: (action) => {
        if (action === 'submit' && routeRef.current === 'main') void sendComposer(document.getElementById('composer-input'))
      }
    })
    kitRef.current = kit
    const disposers = [window.DshState.subscribe(() => setRevision((revision) => revision + 1))]
    const offMode = api.onModeChange?.((next) => setMode(next))
    if (offMode) disposers.push(offMode)
    const offEnter = api.onEnter?.((event) => {
      if (event.mode) setMode(event.mode)
      if (event.code === 'manage') {
        autoStartRef.current = false
        setRoute('settings')
      }
    })
    if (offEnter) disposers.push(offEnter)
    const offClose = api.onBeforeClose?.(() => window.DshState.stopPolling())
    if (offClose) disposers.push(offClose)
    let disposed = false
    void window.DshState.boot().then(async () => {
      if (disposed) return
      window.DshState.startPolling()
      const guideMark = await window.DshApi.getPref('kernelGuide', '')
      if (!window.DshState.state.runtime?.available && !guideMark && routeRef.current === 'main') {
        setKernelGuide(true)
        return
      }
      if (routeRef.current === 'main' && api.getLaunchMode?.() === 'quick') {
        void window.DshState.ensureSdk().catch((error) => window.DshApi.notice(errorText(error), 'error'))
      }
    }).catch((error) => window.DshApi.notice(errorText(error), 'error'))
    return () => {
      disposed = true
      disposers.forEach((dispose) => dispose?.())
      window.DshState.stopPolling()
      kit.destroy?.()
    }
  }, [sendComposer])

  const goSettings = () => {
    autoStartRef.current = false
    setRoute('settings')
  }
  const closeKernelGuide = () => {
    setKernelGuide(false)
    autoStartRef.current = false
    void window.DshState.detect()
    void window.DshState.refreshStatus()
  }
  const overlay = kernelGuide && route !== 'settings' ? <KernelSetupDialog state={state} onClose={closeKernelGuide} /> : null
  if (route === 'settings') return <SettingsView state={state} onBack={() => setRoute('main')} />
  if (mode === 'quick') return (
    <>
      {overlay}
      <CockpitView
        state={state} onGoSettings={goSettings}
        onGoShell={() => void Promise.resolve(api.ui.openInShell()).catch((error) => window.DshApi.notice(errorText(error), 'error'))}
        onNewSession={() => void window.DshState.newQuickSession().catch((error) => window.DshApi.notice(errorText(error), 'error'))}
        onPickSession={(sessionId) => void window.DshState.loadSession(sessionId)}
        onSend={sendComposer}
      />
    </>
  )
  return (
    <>
      {overlay}
      <ShellView state={state} onGoSettings={goSettings} autoStartRef={autoStartRef} kernelGuide={kernelGuide} />
    </>
  )
}
