;(() => {
  const api = window.enest || window.zapi,
    $ = (id) => document.getElementById(id),
    esc = PluginKit.escape
  let snapshot = null,
    busy = false,
    editId = '',
    legacy = null,
    ready = false
  let journalVersion = '',
    lastPhaseKey = ''
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
      if (!snapshot || snapshot.state.status === 'idle') $('task').value = value
    },
    onAction: (action) => {
      if (action === 'submit') void toggle()
    },
  })
  const day = (ts) => new Date(ts).toLocaleDateString(),
    phaseLabels = { focus: '专注', break: '短休息', longBreak: '长休息' }

  // —— WebAudio 合成提示音：无外部资产。专注完成上行双音，休息结束下行双音 ——
  let audioCtx = null
  function chime(kind) {
    if (!kit.settings.sound) return
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') void audioCtx.resume()
      const now = audioCtx.currentTime,
        steps = kind === 'focus-done' ? [523.25, 783.99] : [659.25, 440]
      steps.forEach((freq, i) => {
        const osc = audioCtx.createOscillator(),
          gain = audioCtx.createGain(),
          t0 = now + i * 0.16
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5)
        osc.connect(gain).connect(audioCtx.destination)
        osc.start(t0)
        osc.stop(t0 + 0.55)
      })
    } catch {
      /* 音频不可用不影响计时 */
    }
  }

  function applySettings() {
    if (!snapshot || snapshot.state.status === 'idle') {
      const preset = String(kit.settings.preset || '')
      if (/^\d+,\d+$/.test(preset)) {
        const [f, r] = preset.split(',')
        $('focus-min').value = f
        $('break-min').value = r
      } else {
        $('focus-min').value = kit.settings.focusMin
        $('break-min').value = kit.settings.breakMin
      }
    }
  }
  function markPreset() {
    const key = $('focus-min').value + ',' + $('break-min').value
    document
      .querySelectorAll('[data-preset]')
      .forEach((b) => b.classList.toggle('chosen', b.dataset.preset === key))
  }
  function render() {
    if (!snapshot) return
    const s = snapshot.state,
      opts = s.options,
      ms =
        s.status === 'idle'
          ? Number($('focus-min').value) * 60000
          : s.remainingMs,
      seconds = Math.ceil(ms / 1000)
    $('time').textContent =
      String(Math.floor(seconds / 60)).padStart(2, '0') +
      ':' +
      String(seconds % 60).padStart(2, '0')
    $('status').textContent =
      s.status === 'idle'
        ? '准备开始'
        : s.status === 'running'
          ? phaseLabels[s.phase] + '进行中'
          : '已暂停 · ' + phaseLabels[s.phase]
    $('cycle').textContent = '第 ' + s.cycle + ' 轮'
    $('toggle').textContent =
      s.status === 'running'
        ? '暂停'
        : s.status === 'paused'
          ? '继续计时'
          : '开始专注'
    $('toggle').disabled = busy || !ready
    $('stop').disabled = busy || s.status === 'idle'
    $('skip').disabled = busy || s.status === 'idle'
    $('task').disabled = s.status !== 'idle'
    if (s.status !== 'idle') $('task').value = opts.task
    $('focus-min').disabled = s.status !== 'idle'
    $('break-min').disabled = s.status !== 'idle'
    document
      .querySelectorAll('[data-preset]')
      .forEach((b) => (b.disabled = s.status !== 'idle'))
    document
      .querySelectorAll('[data-phase]')
      .forEach((el) =>
        el.classList.toggle('active', el.dataset.phase === s.phase),
      )
    $('clock').classList.toggle('is-rest', s.phase !== 'focus')
    const total =
      (s.phase === 'focus'
        ? opts.focusMin
        : s.phase === 'break'
          ? opts.breakMin
          : opts.longBreakMin) * 60000
    $('ring').style.strokeDashoffset = String(
      339.292 * (1 - Math.min(1, Math.max(0, ms / total))),
    )
    // 阶段完成（autoStart 开→running 继续；关→paused 等确认）时按完成阶段播提示音
    const phaseKey = s.phase + '|' + s.cycle + '|' + s.status
    if (
      ready &&
      lastPhaseKey &&
      lastPhaseKey !== phaseKey &&
      s.status !== 'idle'
    ) {
      const prevPhase = lastPhaseKey.split('|')[0]
      if (prevPhase !== s.phase)
        chime(prevPhase === 'focus' ? 'focus-done' : 'break-done')
    }
    lastPhaseKey = phaseKey
    renderJournal()
  }
  function renderJournal() {
    const version =
      day(Date.now()) +
      '|' +
      JSON.stringify(snapshot.records) +
      '|' +
      JSON.stringify(legacy)
    if (version === journalVersion) return
    journalVersion = version
    const records = snapshot.records,
      completed = records.filter((r) => r.counted),
      now = Date.now(),
      today = completed.filter((r) => day(r.endedAt) === day(now)),
      weekStart = new Date()
    weekStart.setHours(0, 0, 0, 0)
    weekStart.setDate(weekStart.getDate() - 6)
    const week = completed.filter((r) => r.endedAt >= weekStart.getTime()),
      minutes = Math.round(
        today.reduce((sum, r) => sum + r.durationMs, 0) / 60000,
      )
    $('today-count').textContent = today.length
    $('today-min').textContent = minutes
    $('week-count').textContent = week.length
    $('quick-today').textContent =
      `今日 ${today.length} 次专注 · ${minutes} 分钟`
    const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart)
        d.setDate(d.getDate() + i)
        return {
          date: d,
          count: completed.filter((r) => day(r.endedAt) === day(d)).length,
        }
      }),
      max = Math.max(1, ...days.map((d) => d.count))
    $('week').innerHTML = days
      .map(
        (d, i) =>
          `<div class="day ${i === 6 ? 'today' : ''}" title="${esc(day(d.date))} · ${d.count} 次"><div class="bar" style="height:${Math.max(3, (d.count / max) * 62)}px"></div><span>${['日', '一', '二', '三', '四', '五', '六'][d.date.getDay()]}</span></div>`,
      )
      .join('')
    $('records').innerHTML = records.length
      ? records
          .slice(0, 100)
          .map(
            (r) =>
              `<div class="record"><div class="body"><div class="record-title">${esc(r.task || phaseLabels[r.phase])}</div><div class="record-meta">${new Date(r.endedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${{ completed: '已完成', skipped: '已跳过', stopped: '已停止' }[r.outcome]}${r.counted ? '' : ' · 不计统计'}</div></div><span class="record-time">${Math.round(r.durationMs / 60000)}′</span><button data-edit="${esc(r.id)}">编辑</button><button data-delete="${esc(r.id)}" aria-label="删除记录">×</button></div>`,
          )
          .join('')
      : emptyState()
    if (legacy?.count) {
      $('legacy').hidden = false
      $('legacy').textContent =
        `旧版本统计已保留：${legacy.date} 完成 ${legacy.count} 次（无明细）`
    }
  }
  function emptyState() {
    // 纯 SVG 插画：静止的番茄轮廓 + 呼吸刻度线，不引入循环动画
    return `<div class="empty"><svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="54" r="30" fill="none" stroke="var(--line)" stroke-width="2.5"/><circle cx="48" cy="54" r="21" fill="none" stroke="var(--focus)" stroke-width="2" stroke-dasharray="4 6" stroke-linecap="round" opacity=".7"/><path d="M48 24c-3-6-9-8-13-7 2 5 6 8 10 9m3-2c0-5 2-9 6-11 1 5-1 9-4 12" fill="none" stroke="var(--focus)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 45c2-6 7-10 12-11" fill="none" stroke="var(--focus)" stroke-width="2" stroke-linecap="round" opacity=".45"/></svg>第一段专注，从现在开始。<br>完成后会在这里留下记录。</div>`
  }
  async function call(method, ...args) {
    if (!api?.focusTimer?.[method]) {
      kit.toast('当前壳版本不支持后台计时，请更新 eNest', 'error')
      return
    }
    busy = true
    render()
    try {
      snapshot = await api.focusTimer[method](...args)
      render()
    } catch (e) {
      kit.toast(e.message, 'error')
    } finally {
      busy = false
      render()
    }
  }
  async function toggle() {
    if (!ready || busy) return
    const s = snapshot.state
    if (s.status === 'running') return call('pause')
    if (s.status === 'paused') return call('resume')
    const focus = Number($('focus-min').value),
      rest = Number($('break-min').value)
    if (
      !Number.isFinite(focus) ||
      focus < 1 ||
      focus > 180 ||
      !Number.isFinite(rest) ||
      rest < 1 ||
      rest > 60
    ) {
      kit.toast('专注需为 1–180 分钟，短休息需为 1–60 分钟', 'error')
      return
    }
    await call('start', {
      ...kit.settings,
      focusMin: focus,
      breakMin: rest,
      task: $('task').value.trim(),
    })
  }
  $('toggle').onclick = () => void toggle()
  $('stop').onclick = () => void call('stop')
  $('skip').onclick = () => void call('skip')
  document.querySelectorAll('[data-preset]').forEach(
    (b) =>
      (b.onclick = () => {
        const [f, r] = b.dataset.preset.split(',')
        $('focus-min').value = f
        $('break-min').value = r
        // 预设持久化：写壳设置，重启后沿用（基础设置能力，无新增权限）
        void api?.settings?.set?.('preset', b.dataset.preset).catch(() => {})
        markPreset()
        render()
      }),
  )
  $('focus-min').oninput = () => {
    markPreset()
    render()
  }
  $('records').onclick = (e) => {
    const edit = e.target.closest('[data-edit]'),
      del = e.target.closest('[data-delete]')
    if (edit) {
      const r = snapshot.records.find((r) => r.id === edit.dataset.edit)
      editId = r.id
      $('record-task').value = r.task
      $('record-min').value = Math.round(r.durationMs / 30000) / 2
      $('record-counted').checked = r.counted
      $('record-counted').disabled =
        r.phase !== 'focus' || r.outcome !== 'completed'
      $('record-dialog').showModal()
    }
    if (del && confirm('删除这条专注记录？'))
      void call('updateRecord', del.dataset.delete, { deleted: true })
  }
  $('cancel-edit').onclick = () => $('record-dialog').close()
  $('record-form').onsubmit = async (e) => {
    e.preventDefault()
    const durationMs = Number($('record-min').value) * 60000
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10800000)
      return
    await call('updateRecord', editId, {
      task: $('record-task').value,
      durationMs,
      counted: $('record-counted').checked,
    })
    $('record-dialog').close()
  }
  $('export').onclick = () => {
    const csv = (value) => '"' + String(value).replace(/"/g, '""') + '"'
    const rows = [
      ['任务', '阶段', '结束时间', '分钟', '结果', '计入统计'],
      ...snapshot.records.map((r) => [
        r.task,
        phaseLabels[r.phase],
        new Date(r.endedAt).toISOString(),
        r.durationMs / 60000,
        r.outcome,
        r.counted ? '是' : '否',
      ]),
    ]
    kit
      .saveText(
        '专注记录.csv',
        '\uFEFF' + rows.map((row) => row.map(csv).join(',')).join('\n'),
      )
      .catch((e) => kit.toast(e.message, 'error'))
  }
  document.addEventListener('keydown', (e) => {
    if (
      e.code === 'Space' &&
      !e.isComposing &&
      !e.target.closest('input,textarea,select,button,dialog')
    ) {
      e.preventDefault()
      void toggle()
    }
  })
  kit.onSettings(() => {
    applySettings()
    render()
  })
  api?.focusTimer?.onChange?.((value) => {
    snapshot = value
    render()
  })
  const initialized = (async () => {
    await kit.ready
    applySettings()
    try {
      if (!api?.focusTimer) throw Error('请更新 eNest 以使用后台番茄计时')
      snapshot = await api.focusTimer.get()
      legacy = await kit.load('pomo_stats_v1', null)
      if (legacy && !(await kit.load('pomo_stats_v1_backup', null)))
        await kit.save('pomo_stats_v1_backup', legacy)
      ready = true
      markPreset()
      render()
    } catch (e) {
      $('hint').textContent = e.message
      $('toggle').disabled = true
      kit.toast(e.message, 'error')
    }
  })()
  api?.onEnter?.(async ({ payload }) => {
    await initialized
    if (snapshot?.state.status !== 'idle') return
    const text =
      typeof payload === 'string'
        ? payload
        : payload?.type === 'text'
          ? payload.text
          : ''
    if (typeof text === 'string' && text) $('task').value = text.slice(0, 500)
  })
  api?.onBeforeClose?.(() => initialized)
})()
