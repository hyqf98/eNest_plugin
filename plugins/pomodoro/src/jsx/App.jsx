/**
 * 番茄钟主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 计时核心走宿主 api.focusTimer（后台计时 / 系统通知语义不变），WebAudio 提示音复用；
 * 快照渲染（render/renderJournal）等价迁移为派生渲染 + latest-ref 桥接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const api = window.enest || window.zapi
const phaseLabels = { focus: '专注', break: '短休息', longBreak: '长休息' }
const day = (ts) => new Date(ts).toLocaleDateString()
const RING = 339.292

export function App() {
  const kitRef = useRef(null)
  const [snapshot, setSnapshot] = useState(null)
  const [task, setTask] = useState('')
  const [focusMin, setFocusMin] = useState('25')
  const [breakMin, setBreakMin] = useState('5')
  const [hint, setHint] = useState('关闭插件标签后继续计时。退出 eNest 后暂停，重启可继续。')
  const [legacy, setLegacy] = useState(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [todayStats, setTodayStats] = useState({ todayCount: 0, minutes: 0, weekCount: 0 })
  const [quickToday, setQuickToday] = useState('')

  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const busyRef = useRef(busy)
  busyRef.current = busy
  const readyRef = useRef(ready)
  readyRef.current = ready
  const focusRef = useRef(focusMin)
  focusRef.current = focusMin
  const breakRef = useRef(breakMin)
  breakRef.current = breakMin
  const taskRef = useRef(task)
  taskRef.current = task
  const journalVersionRef = useRef('')
  const lastPhaseKeyRef = useRef('')
  const audioRef = useRef(null)
  const editIdRef = useRef('')

  // —— WebAudio 合成提示音：无外部资产。专注完成上行双音，休息结束下行双音 ——
  const chime = useCallback((kind) => {
    if (!kitRef.current.settings.sound) return
    try {
      audioRef.current ||= new (window.AudioContext || window.webkitAudioContext)()
      if (audioRef.current.state === 'suspended') void audioRef.current.resume()
      const ctx = audioRef.current
      const now = ctx.currentTime
      const steps = kind === 'focus-done' ? [523.25, 783.99] : [659.25, 440]
      steps.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const t0 = now + i * 0.16
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t0)
        osc.stop(t0 + 0.55)
      })
    } catch {
      /* 音频不可用不影响计时 */
    }
  }, [])

  // —— 宿主调用（等价原 call()）——
  const call = useCallback(async (method, ...args) => {
    if (!api?.focusTimer?.[method]) {
      kitRef.current.toast('当前壳版本不支持后台计时，请更新 eNest', 'error')
      return
    }
    setBusy(true)
    try {
      setSnapshot(await api.focusTimer[method](...args))
    } catch (e) {
      kitRef.current.toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [])

  // —— 开始 / 暂停 / 继续（等价原 toggle()）——
  const toggle = useCallback(async () => {
    if (!readyRef.current || busyRef.current) return
    const s = snapshotRef.current.state
    if (s.status === 'running') return call('pause')
    if (s.status === 'paused') return call('resume')
    const focus = Number(focusRef.current)
    const rest = Number(breakRef.current)
    if (!Number.isFinite(focus) || focus < 1 || focus > 180 || !Number.isFinite(rest) || rest < 1 || rest > 60) {
      kitRef.current.toast('专注需为 1–180 分钟，短休息需为 1–60 分钟', 'error')
      return
    }
    await call('start', {
      ...kitRef.current.settings,
      focusMin: focus,
      breakMin: rest,
      task: taskRef.current.trim(),
    })
  }, [call])

  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  // —— 记录编辑 / 导出（等价原 handlers）——
  const openEdit = useCallback((r) => {
    editIdRef.current = r.id
    const dialog = document.getElementById('record-dialog')
    document.getElementById('record-task').value = r.task
    document.getElementById('record-min').value = Math.round(r.durationMs / 30000) / 2
    const counted = document.getElementById('record-counted')
    counted.checked = r.counted
    counted.disabled = r.phase !== 'focus' || r.outcome !== 'completed'
    dialog.showModal()
  }, [])

  const onRecordsClick = useCallback((e) => {
    const edit = e.target.closest('[data-edit]')
    const del = e.target.closest('[data-delete]')
    if (edit) {
      const r = snapshotRef.current.records.find((r) => r.id === edit.dataset.edit)
      openEdit(r)
    }
    if (del && confirm('删除这条专注记录？')) void call('updateRecord', del.dataset.delete, { deleted: true })
  }, [call, openEdit])

  const onRecordSubmit = useCallback(async (e) => {
    e.preventDefault()
    const durationMs = Number(document.getElementById('record-min').value) * 60000
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10800000) return
    await call('updateRecord', editIdRef.current, {
      task: document.getElementById('record-task').value,
      durationMs,
      counted: document.getElementById('record-counted').checked,
    })
    document.getElementById('record-dialog').close()
  }, [call])

  const exportCsv = useCallback(() => {
    const csv = (value) => '"' + String(value).replace(/"/g, '""') + '"'
    const rows = [
      ['任务', '阶段', '结束时间', '分钟', '结果', '计入统计'],
      ...snapshotRef.current.records.map((r) => [
        r.task,
        phaseLabels[r.phase],
        new Date(r.endedAt).toISOString(),
        r.durationMs / 60000,
        r.outcome,
        r.counted ? '是' : '否',
      ]),
    ]
    kitRef.current
      .saveText('专注记录.csv', '﻿' + rows.map((row) => row.map(csv).join(',')).join('\n'))
      .catch((e) => kitRef.current.toast(e.message, 'error'))
  }, [])

  const applyPreset = useCallback((value) => {
    const [f, r] = value.split(',')
    setFocusMin(f)
    setBreakMin(r)
    // 预设持久化：写壳设置，重启后沿用（基础设置能力，无新增权限）
    void api?.settings?.set?.('preset', value).catch(() => {})
  }, [])

  // —— 空状态插画（纯 SVG，等价原 emptyState）——
  const emptyArt = (
    <div className="empty">
      <svg viewBox="0 0 96 96" aria-hidden="true">
        <circle cx="48" cy="54" r="30" fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx="48" cy="54" r="21" fill="none" stroke="var(--focus)" strokeWidth="2" strokeDasharray="4 6" strokeLinecap="round" opacity=".7" />
        <path d="M48 24c-3-6-9-8-13-7 2 5 6 8 10 9m3-2c0-5 2-9 6-11 1 5-1 9-4 12" fill="none" stroke="var(--focus)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M33 45c2-6 7-10 12-11" fill="none" stroke="var(--focus)" strokeWidth="2" strokeLinecap="round" opacity=".45" />
      </svg>
      第一段专注，从现在开始。<br />完成后会在这里留下记录。
    </div>
  )

  // —— 宿主适配器 + 启动（latest-ref 桥接，等价原初始化段）——
  useEffect(() => {
    const kit = PluginKit.create({
      title: '番茄钟',
      quickPlaceholder: '为这次专注写个任务名称',
      height: 490,
      defaults: {
        focusMin: 25,
        breakMin: 5,
        longBreakMin: 15,
        longBreakEvery: 4,
        autoStart: false,
        notify: true,
        preset: '25,5',
        sound: true,
      },
      onQuery: (value) => {
        const snap = snapshotRef.current
        if (!snap || snap.state.status === 'idle') setTask(value)
      },
      onAction: (action) => {
        if (action === 'submit') void toggleRef.current()
      },
    })
    kitRef.current = kit
    kit.onSettings(() => {
      const snap = snapshotRef.current
      if (!snap || snap.state.status === 'idle') {
        const preset = String(kit.settings.preset || '')
        if (/^\d+,\d+$/.test(preset)) {
          const [f, r] = preset.split(',')
          setFocusMin(f)
          setBreakMin(r)
        } else {
          setFocusMin(String(kit.settings.focusMin))
          setBreakMin(String(kit.settings.breakMin))
        }
      }
    })
    const offChange = api?.focusTimer?.onChange?.((value) => setSnapshot(value))
    const offKey = (() => {
      const onKeyDown = (e) => {
        if (e.code === 'Space' && !e.isComposing && !e.target.closest('input,textarea,select,button,dialog')) {
          e.preventDefault()
          void toggleRef.current()
        }
      }
      document.addEventListener('keydown', onKeyDown)
      return () => document.removeEventListener('keydown', onKeyDown)
    })()
    const initialized = (async () => {
      await kit.ready
      try {
        if (!api?.focusTimer) throw Error('请更新 eNest 以使用后台番茄计时')
        setSnapshot(await api.focusTimer.get())
        const legacyData = await kit.load('pomo_stats_v1', null)
        setLegacy(legacyData)
        if (legacyData && !(await kit.load('pomo_stats_v1_backup', null))) await kit.save('pomo_stats_v1_backup', legacyData)
        setReady(true)
      } catch (e) {
        setHint(e.message)
        kit.toast(e.message, 'error')
      }
    })()
    const offEnter = api?.onEnter?.(async ({ payload }) => {
      await initialized
      if (snapshotRef.current?.state.status !== 'idle') return
      const text = typeof payload === 'string' ? payload : payload?.type === 'text' ? payload.text : ''
      if (typeof text === 'string' && text) setTask(text.slice(0, 500))
    })
    const offClose = api?.onBeforeClose?.(() => initialized)
    return () => {
      offChange?.()
      offKey()
      offEnter?.()
      offClose?.()
      kit.destroy?.()
    }
  }, [])

  // —— 快照派生渲染（等价原 render / renderJournal）——
  const s = snapshot?.state
  const records = snapshot?.records || []
  const opts = s?.options || {}

  // 阶段完成提示音（等价原 render 中 phaseKey 比对）。
  // 两个 effect 必须位于下方 !s 提前 return 之前：否则快照就绪前后 hooks 数量不一致（React #310）
  useEffect(() => {
    if (!s || !ready) return
    const phaseKey = s.phase + '|' + s.cycle + '|' + s.status
    if (lastPhaseKeyRef.current && lastPhaseKeyRef.current !== phaseKey && s.status !== 'idle') {
      const prevPhase = lastPhaseKeyRef.current.split('|')[0]
      if (prevPhase !== s.phase) chime(prevPhase === 'focus' ? 'focus-done' : 'break-done')
    }
    lastPhaseKeyRef.current = phaseKey
  }, [s, ready, chime])

  // 统计摘要（等价原 renderJournal 的统计段）
  useEffect(() => {
    if (!snapshot) return
    const completed = records.filter((r) => r.counted)
    const now = Date.now()
    const today = completed.filter((r) => day(r.endedAt) === day(now))
    const weekStart = new Date()
    weekStart.setHours(0, 0, 0, 0)
    weekStart.setDate(weekStart.getDate() - 6)
    const week = completed.filter((r) => r.endedAt >= weekStart.getTime())
    const minutes = Math.round(today.reduce((sum, r) => sum + r.durationMs, 0) / 60000)
    setTodayStats({ todayCount: today.length, minutes, weekCount: week.length })
    setQuickToday(`今日 ${today.length} 次专注 · ${minutes} 分钟`)
  }, [snapshot, records])

  if (!s) {
    // 等价原 render() 的 if (!snapshot) return：快照未就绪时呈现静态初始 DOM
    return (
      <div className="app">
        <header>
          <h1>番茄钟</h1>
          <span className="shell-only">一次只做一件事</span>
          <button data-open-settings>偏好设置</button>
        </header>
        <main className="workspace">
          <section className="focus-panel">
            <input id="task" className="task-input" maxLength={500} placeholder="这一次，想专注完成什么？"
              aria-label="专注任务" value={task} onChange={(e) => setTask(e.target.value)} />
            <div className="segmented" role="tablist" aria-label="阶段">
              {[['focus', '专注'], ['break', '短休息'], ['longBreak', '长休息']].map(([key, label]) => (
                <button key={key} data-phase={key} role="tab">{label}</button>
              ))}
            </div>
            <div className="clock" id="clock">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle className="track" cx="60" cy="60" r="54" fill="none" strokeWidth="2"></circle>
                <circle className="progress" id="ring" cx="60" cy="60" r="54" fill="none" strokeWidth="3"
                  strokeLinecap="round" strokeDasharray="339.292"></circle>
              </svg>
              <div className="clock-center">
                <span id="status">准备开始</span><span id="time">25:00</span>
                <span id="cycle">第 1 轮</span>
              </div>
            </div>
            <div className="controls">
              <button id="stop" title="停止本次计时">停止</button>
              <button id="toggle" className="primary" disabled={!ready}>开始专注</button>
              <button id="skip" title="跳过阶段，不计入完成">跳过</button>
            </div>
            <div className="presets" role="group" aria-label="时长预设">
              {[['25,5', '25 / 5 经典'], ['50,10', '50 / 10 深度'], ['15,3', '15 / 3 短冲刺']].map(([value, label]) => (
                <button key={value} data-preset={value}>{label}</button>
              ))}
            </div>
            <div className="configuration">
              <label>专注<input id="focus-min" type="number" min="1" max="180" value={focusMin}
                onInput={(e) => setFocusMin(e.target.value)} />分</label>
              <label>短休息<input id="break-min" type="number" min="1" max="60" value={breakMin}
                onInput={(e) => setBreakMin(e.target.value)} />分</label>
            </div>
            <div className="keys">
              <span><kbd>Space</kbd> 开始 / 暂停</span>
              <span><kbd>⌘</kbd><kbd>↵</kbd> quick 模式转完整窗口</span>
            </div>
            <div className="hint" id="hint">{hint}</div>
            <div className="quick-today quick-only" id="quick-today"></div>
          </section>
          <aside className="journal shell-only">
            <div className="journal-head">
              <h2>专注记录</h2>
              <button id="export">导出 CSV</button>
            </div>
            <div className="stats">
              <div><b id="today-count">0</b><span>今日完成</span></div>
              <div><b id="today-min">0</b><span>今日分钟</span></div>
              <div><b id="week-count">0</b><span>近七天完成</span></div>
            </div>
            <div className="week" id="week"></div>
            <div id="legacy" className="small" hidden></div>
            <div id="records"></div>
          </aside>
        </main>
      </div>
    )
  }
  const ms = s.status === 'idle'
    ? (Number(focusMin) || 25) * 60000
    : s.remainingMs
  const seconds = Math.ceil(ms / 1000)
  const timeText = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
  const statusText = s.status === 'idle' ? '准备开始' : s.status === 'running' ? phaseLabels[s.phase] + '进行中' : '已暂停 · ' + phaseLabels[s.phase]
  const toggleText = s.status === 'running' ? '暂停' : s.status === 'paused' ? '继续计时' : '开始专注'
  const total = s.status === 'idle' ? (Number(focusMin) || 25) * 60000
    : (s.phase === 'focus' ? opts.focusMin : s.phase === 'break' ? opts.breakMin : opts.longBreakMin) * 60000
  const ringOffset = RING * (1 - Math.min(1, Math.max(0, ms / total)))


  const derivedPresetKey = `${Number(focusMin) || focusMin},${Number(breakMin) || breakMin}`
  const weekStart = new Date()
  weekStart.setHours(0, 0, 0, 0)
  weekStart.setDate(weekStart.getDate() - 6)
  const completedRecords = records.filter((r) => r.counted)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return { date: d, count: completedRecords.filter((r) => day(r.endedAt) === day(d)).length }
  })
  const max = Math.max(1, ...days.map((d) => d.count))

  return (
    <div className="app">
      <header>
        <h1>番茄钟</h1>
        <span className="shell-only">一次只做一件事</span>
        <button data-open-settings>偏好设置</button>
      </header>
      <main className="workspace">
        <section className="focus-panel">
          <input
            id="task"
            className="task-input"
            maxLength={500}
            placeholder="这一次，想专注完成什么？"
            aria-label="专注任务"
            value={s && s.status !== 'idle' ? (opts.task || '') : task}
            disabled={s && s.status !== 'idle'}
            onChange={(e) => setTask(e.target.value)}
          />
          <div className="segmented" role="tablist" aria-label="阶段">
            {[['focus', '专注'], ['break', '短休息'], ['longBreak', '长休息']].map(([key, label]) => (
              <button key={key} data-phase={key} role="tab" className={s && s.phase === key ? 'active' : ''}>{label}</button>
            ))}
          </div>
          <div className={`clock${s && s.phase !== 'focus' ? ' is-rest' : ''}`} id="clock">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle className="track" cx="60" cy="60" r="54" fill="none" strokeWidth="2"></circle>
              <circle className="progress" id="ring" cx="60" cy="60" r="54" fill="none" strokeWidth="3"
                strokeLinecap="round" strokeDasharray="339.292"
                style={{ strokeDashoffset: String(ringOffset) }}></circle>
            </svg>
            <div className="clock-center">
              <span id="status">{statusText}</span><span id="time">{timeText}</span>
              <span id="cycle">{s ? '第 ' + s.cycle + ' 轮' : '第 1 轮'}</span>
            </div>
          </div>
          <div className="controls">
            <button id="stop" title="停止本次计时" disabled={busy || !s || s.status === 'idle'} onClick={() => void call('stop')}>停止</button>
            <button id="toggle" className="primary" disabled={busy || !ready} onClick={() => void toggle()}>{toggleText}</button>
            <button id="skip" title="跳过阶段，不计入完成" disabled={busy || !s || s.status === 'idle'} onClick={() => void call('skip')}>跳过</button>
          </div>
          <div className="presets" role="group" aria-label="时长预设">
            {[['25,5', '25 / 5 经典'], ['50,10', '50 / 10 深度'], ['15,3', '15 / 3 短冲刺']].map(([value, label]) => (
              <button key={value} data-preset={value}
                className={derivedPresetKey === value ? 'chosen' : ''}
                disabled={s && s.status !== 'idle'}
                onClick={() => { applyPreset(value) }}>{label}</button>
            ))}
          </div>
          <div className="configuration">
            <label>专注<input
              id="focus-min"
              type="number"
              min="1"
              max="180"
              value={focusMin}
              disabled={s && s.status !== 'idle'}
              onInput={(e) => setFocusMin(e.target.value)}
            />分</label>
            <label>短休息<input
              id="break-min"
              type="number"
              min="1"
              max="60"
              value={breakMin}
              disabled={s && s.status !== 'idle'}
              onInput={(e) => setBreakMin(e.target.value)}
            />分</label>
          </div>
          <div className="keys">
            <span><kbd>Space</kbd> 开始 / 暂停</span>
            <span><kbd>⌘</kbd><kbd>↵</kbd> quick 模式转完整窗口</span>
          </div>
          <div className="hint" id="hint">{hint}</div>
          <div className="quick-today quick-only" id="quick-today">{quickToday}</div>
        </section>
        <aside className="journal shell-only">
          <div className="journal-head">
            <h2>专注记录</h2>
            <button id="export" onClick={exportCsv}>导出 CSV</button>
          </div>
          <div className="stats">
            <div><b id="today-count">{todayStats.todayCount}</b><span>今日完成</span></div>
            <div><b id="today-min">{todayStats.minutes}</b><span>今日分钟</span></div>
            <div><b id="week-count">{todayStats.weekCount}</b><span>近七天完成</span></div>
          </div>
          <div className="week" id="week">
            {days.map((d, i) => (
              <div key={i} className={`day${i === 6 ? ' today' : ''}`} title={`${day(d.date)} · ${d.count} 次`}>
                <div className="bar" style={{ height: `${Math.max(3, (d.count / max) * 62)}px` }}></div>
                <span>{['日', '一', '二', '三', '四', '五', '六'][d.date.getDay()]}</span>
              </div>
            ))}
          </div>
          <div id="legacy" className="small" hidden={!(legacy && legacy.count)}>
            {legacy && legacy.count ? `旧版本统计已保留：${legacy.date} 完成 ${legacy.count} 次（无明细）` : ''}
          </div>
          <div id="records" onClick={onRecordsClick}>
            {records.length ? (
              records.slice(0, 100).map((r) => (
                <div className="record" key={r.id}>
                  <div className="body">
                    <div className="record-title">{r.task || phaseLabels[r.phase]}</div>
                    <div className="record-meta">
                      {new Date(r.endedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {({ completed: '已完成', skipped: '已跳过', stopped: '已停止' })[r.outcome]}{r.counted ? '' : ' · 不计统计'}
                    </div>
                  </div>
                  <span className="record-time">{Math.round(r.durationMs / 60000)}′</span>
                  <button data-edit={r.id}>编辑</button>
                  <button data-delete={r.id} aria-label="删除记录">×</button>
                </div>
              ))
            ) : (
              emptyArt
            )}
          </div>
        </aside>
      </main>
      <dialog id="record-dialog">
        <form id="record-form" onSubmit={(e) => void onRecordSubmit(e)}>
          <h3>编辑专注记录</h3>
          <label>任务<input id="record-task" maxLength={500} /></label>
          <label>实际专注分钟<input id="record-min" type="number" min="0" max="180" step="0.5" /></label>
          <label><span><input id="record-counted" type="checkbox" /> 计入完成统计</span></label>
          <div className="actions">
            <button type="button" id="cancel-edit" onClick={() => document.getElementById('record-dialog').close()}>取消</button>
            <button className="primary">保存</button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
